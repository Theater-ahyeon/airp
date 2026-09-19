// src/core/butler/butler.ts
// Background Butler implementing four-tier degradation ladder, consistency protocol, and token tracking.

import {
  ButlerInspectionInput,
  ButlerInspectionOutput,
  DegradationTier,
  EndpointCapability,
  ButlerHostABI
} from "./contracts.js";
import { MockModelAdapter } from "../adapters/mock-model.js";

export interface ButlerModelRunner {
  run(tier: DegradationTier, prompt: string, systemPrompt?: string): Promise<{
    rawText: string;
    toolCallArgs?: Record<string, unknown>;
    tokensUsed: { input: number; output: number };
  }>;
}

export class ButlerService {
  private capability: EndpointCapability = {
    tier: 1,
    label: "tool-calling",
    detectedAt: Date.now()
  };

  /** Consistency protocol: in-flight butler floor jobs keyed by `${cardId}:${sessionId}:${floorId}` */
  private pendingJobs = new Map<string, Promise<ButlerInspectionOutput | null>>();

  constructor(
    private readonly hostAbi: ButlerHostABI,
    private readonly runner: ButlerModelRunner
  ) {}

  getCapability(): EndpointCapability {
    return { ...this.capability };
  }

  setCapability(cap: EndpointCapability): void {
    this.capability = cap;
  }

  /**
   * Consistency Protocol: Waits for Butler job on previous floor before assembling next prompt.
   */
  async waitForFloorSettlement(cardId: string, sessionId: string, priorFloorId: string): Promise<void> {
    const key = `${cardId}:${sessionId}:${priorFloorId}`;
    const pending = this.pendingJobs.get(key);
    if (pending) {
      try {
        await pending;
      } catch {
        // Explicit degradation, never crash prompt assembly
      } finally {
        this.pendingJobs.delete(key);
      }
    }
  }

  /**
   * Triggers asynchronous floor analysis and registers the promise into the consistency ledger.
   */
  scheduleFloorAnalysis(
    cardId: string,
    sessionId: string,
    branchId: string,
    input: ButlerInspectionInput
  ): Promise<ButlerInspectionOutput | null> {
    const key = `${cardId}:${sessionId}:${input.floorId}`;
    const task = this.executeAnalysis(cardId, sessionId, branchId, input);
    this.pendingJobs.set(key, task);
    return task;
  }

  private async executeAnalysis(
    cardId: string,
    sessionId: string,
    branchId: string,
    input: ButlerInspectionInput
  ): Promise<ButlerInspectionOutput | null> {
    if (this.capability.tier === 4) {
      // Tier 4: Disabled
      return null;
    }

    const systemPrompt = "You are the AIRP Background Butler. Extract structured state modifications and factual updates.";
    const userPrompt = `Floor: ${input.floorId}
User: ${input.userMessage}
Assistant: ${input.assistantMessage}
Current State: ${JSON.stringify(input.currentState)}`;

    try {
      const resp = await this.runner.run(this.capability.tier, userPrompt, systemPrompt);
      let parsedOutput: ButlerInspectionOutput | null = null;

      if (this.capability.tier === 1 && resp.toolCallArgs) {
        // Tier 1: Tool calling
        parsedOutput = this.parseToolCallingOutput(resp.toolCallArgs);
      } else if (this.capability.tier === 2) {
        // Tier 2: JSON mode
        parsedOutput = JSON.parse(resp.rawText) as ButlerInspectionOutput;
      } else if (this.capability.tier === 3) {
        // Tier 3: Prompt + parse
        const match = resp.rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = match ? match[1] : resp.rawText;
        parsedOutput = JSON.parse(jsonStr.trim()) as ButlerInspectionOutput;
      }

      if (parsedOutput && parsedOutput.stateOps && parsedOutput.stateOps.length > 0) {
        await this.hostAbi.appendStateOps(
          cardId,
          sessionId,
          input.floorId,
          branchId,
          parsedOutput.stateOps
        );
      }

      if (parsedOutput?.suggestedSummary) {
        await this.hostAbi.updateSummary(
          cardId,
          sessionId,
          branchId,
          input.floorId,
          parsedOutput.suggestedSummary
        );
      }

      if (parsedOutput) {
        parsedOutput.tokensUsed = resp.tokensUsed;
      }

      return parsedOutput;
    } catch {
      // Degrade gracefully without failing user dialogue
      return null;
    }
  }

  private parseToolCallingOutput(args: Record<string, unknown>): ButlerInspectionOutput {
    return {
      stateOps: Array.isArray(args.stateOps) ? (args.stateOps as ButlerInspectionOutput["stateOps"]) : [],
      suggestedSummary: typeof args.suggestedSummary === "string" ? args.suggestedSummary : undefined,
      worldbookQueries: Array.isArray(args.worldbookQueries) ? (args.worldbookQueries as string[]) : undefined
    };
  }
}
