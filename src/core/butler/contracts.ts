// src/core/butler/contracts.ts
// Public ABI and contracts for Butler (Background Manager / Internal Plugin).

import { StateOp } from "../types/state.js";

export type DegradationTier = 1 | 2 | 3 | 4;
export type DegradationLabel = "tool-calling" | "json-mode" | "prompt-parse" | "disabled";

export interface EndpointCapability {
  tier: DegradationTier;
  label: DegradationLabel;
  detectedAt: number;
}

export interface ButlerInspectionInput {
  floorId: string;
  userMessage: string;
  assistantMessage: string;
  currentState: Record<string, unknown>;
  rollingSummary?: string | null;
}

export interface ButlerInspectionOutput {
  stateOps: Array<Omit<StateOp, "id" | "timestamp" | "floorId" | "branchId">>;
  suggestedSummary?: string;
  worldbookQueries?: string[];
  reasoning?: string;
  tokensUsed?: {
    input: number;
    output: number;
  };
}

/**
 * Public ABI definition that Butler consumes (Internal Plugin Principle).
 */
export interface ButlerHostABI {
  getLatestFloorState(cardId: string, sessionId: string): Promise<Record<string, unknown>>;
  appendStateOps(
    cardId: string,
    sessionId: string,
    floorId: string,
    branchId: string,
    ops: Array<Omit<StateOp, "id" | "timestamp" | "floorId" | "branchId">>
  ): Promise<void>;
  updateSummary(
    cardId: string,
    sessionId: string,
    branchId: string,
    upToFloorId: string,
    summary: string
  ): Promise<void>;
}
