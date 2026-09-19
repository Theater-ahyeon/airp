// src/core/pipeline/assembly-pipeline.ts
// Pluggable assembly pipeline with cache-aware block ordering and hash tracking.

import { CharacterCard } from "../types/character.js";
import { FloorMessage } from "../types/floor-tree.js";
import { Worldbook, filterWorldbookEntries } from "../types/worldbook.js";
import { StateSnapshot } from "../types/state.js";
import { estimateTokens } from "./token-estimator.js";
import { selectActiveStates } from "./state-selector.js";

export type BlockPriority = "P0" | "P1" | "P2" | "P3" | "P4" | "P5";

export interface AssemblyBlock {
  id: string;
  name: string;
  priority: BlockPriority;
  isStablePrefix: boolean; // Static / Cache anchor eligible
  content: string;
  tokens: number;
}

export interface AssemblyContext {
  character: CharacterCard;
  floorHistory: FloorMessage[];
  latestUserInput: string;
  worldbook?: Worldbook;
  state?: StateSnapshot;
  rollingSummary?: string;
  pinnedStateKeys?: string[];
  maxContextTokens: number;
  maxOutputTokens: number;
  provider?: string;
  allowToolSearch?: boolean;
}

export interface AssemblyResult {
  blocks: AssemblyBlock[];
  systemPrompt: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  totalPromptTokens: number;
  prefixHash: string; // SHA256 simulation / stable hash representation
  truncatedBlocks: string[];
}

/** Pure string hash for cache boundary comparison without crypto native imports */
export function computeStringHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export class AssemblyPipeline {
  assemble(ctx: AssemblyContext): AssemblyResult {
    const provider = ctx.provider ?? "conservative";
    const availableBudget = ctx.maxContextTokens - ctx.maxOutputTokens;
    const truncated: string[] = [];

    // --- Block 1: Base System Prompt & Rules (P0, Stable Prefix) ---
    const systemBaseText = [
      ctx.character.workingCopy.systemPrompt || "You are an expert roleplay narrator.",
      ctx.character.workingCopy.postHistoryInstructions || ""
    ].filter(Boolean).join("\n\n");

    const block1: AssemblyBlock = {
      id: "sys_base",
      name: "System Base Instructions",
      priority: "P0",
      isStablePrefix: true,
      content: systemBaseText,
      tokens: estimateTokens(systemBaseText, provider)
    };

    // --- Block 2: Character Core Definition (P1, Stable Prefix) ---
    const charDefText = [
      `[Character: ${ctx.character.workingCopy.name}]`,
      ctx.character.workingCopy.description ? `Description: ${ctx.character.workingCopy.description}` : "",
      ctx.character.workingCopy.personality ? `Personality: ${ctx.character.workingCopy.personality}` : "",
      ctx.character.workingCopy.scenario ? `Scenario: ${ctx.character.workingCopy.scenario}` : "",
      ctx.character.workingCopy.mesExamples ? `Examples:\n${ctx.character.workingCopy.mesExamples}` : ""
    ].filter(Boolean).join("\n");

    const block2: AssemblyBlock = {
      id: "char_core",
      name: "Character Core Definition",
      priority: "P1",
      isStablePrefix: true,
      content: charDefText,
      tokens: estimateTokens(charDefText, provider)
    };

    // --- Block 3: Static Worldbook Anchors (P1, Stable Prefix) ---
    // ST 扫描语义：当前输入 + 最近楼层文本（recent-first），条目 scanDepth 截取；
    // scenario 不参与扫描（ST 只扫消息），常驻条目不依赖扫描。
    let staticWorldText = "";
    let dynamicWorldText = "";
    if (ctx.worldbook) {
      const recentTexts = [ctx.latestUserInput];
      for (let i = ctx.floorHistory.length - 1; i >= 0 && recentTexts.length < 32; i--) {
        recentTexts.push(ctx.floorHistory[i].content);
      }
      const { activeEntries } = filterWorldbookEntries(
        ctx.worldbook,
        recentTexts,
        ctx.allowToolSearch ?? false,
        2
      );
      const staticParts: string[] = [];
      const dynamicParts: string[] = [];

      for (const e of activeEntries) {
        if (e.mode === "always") {
          staticParts.push(e.comment ? `[${e.comment}]\n${e.content}` : `[World Lore]\n${e.content}`);
        } else {
          dynamicParts.push(
            e.comment
              ? `[${e.comment}]\n${e.content}`
              : `[World Lore (Triggered): ${e.keys.join("/")}]\n${e.content}`
          );
        }
      }
      staticWorldText = staticParts.join("\n\n");
      dynamicWorldText = dynamicParts.join("\n\n");
    }

    const block3: AssemblyBlock = {
      id: "world_static",
      name: "Static Worldbook Anchors",
      priority: "P1",
      isStablePrefix: true,
      content: staticWorldText,
      tokens: estimateTokens(staticWorldText, provider)
    };

    // --- Block 4: Rolling Summary (P2, Semi-stable Prefix) ---
    const summaryText = ctx.rollingSummary ? `[Previous Story Summary]\n${ctx.rollingSummary}` : "";
    const block4: AssemblyBlock = {
      id: "rolling_summary",
      name: "Rolling Summary",
      priority: "P2",
      isStablePrefix: false,
      content: summaryText,
      tokens: estimateTokens(summaryText, provider)
    };

    // --- Block 5: Structured Memory States (P2, Semi-stable) ---
    let stateText = "";
    if (ctx.state && Object.keys(ctx.state).length > 0) {
      const { renderedText } = selectActiveStates(ctx.state, {
        maxTokens: 500,
        pinnedKeys: ctx.pinnedStateKeys,
        userQuery: ctx.latestUserInput,
        provider
      });
      stateText = renderedText ? `[Current Status & Known Facts]\n${renderedText}` : "";
    }

    const block5: AssemblyBlock = {
      id: "state_memory",
      name: "Structured Memory State",
      priority: "P2",
      isStablePrefix: false,
      content: stateText,
      tokens: estimateTokens(stateText, provider)
    };

    // --- Block 6: Dynamic Worldbook Hits (P3) ---
    const block6: AssemblyBlock = {
      id: "world_dynamic",
      name: "Dynamic Worldbook Hits",
      priority: "P3",
      isStablePrefix: false,
      content: dynamicWorldText,
      tokens: estimateTokens(dynamicWorldText, provider)
    };

    // --- Block 7: Latest User Turn (P0, Tail) ---
    const block7: AssemblyBlock = {
      id: "user_turn",
      name: "Latest User Input",
      priority: "P0",
      isStablePrefix: false,
      content: ctx.latestUserInput,
      tokens: estimateTokens(ctx.latestUserInput, provider)
    };

    // Calculate baseline budget needed by Critical P0 (System Base + User Input)
    const p0Tokens = block1.tokens + block7.tokens;
    if (p0Tokens > availableBudget) {
      throw new Error(`Context budget exceeded: critical P0 blocks need ${p0Tokens} tokens but total available is ${availableBudget}`);
    }

    let remainingBudget = availableBudget - p0Tokens;

    // Allocate P1 Character Core Definition
    let finalCharCore = block2.content;
    if (block2.tokens > remainingBudget) {
      truncated.push(block2.id);
      finalCharCore = "";
    } else {
      remainingBudget -= block2.tokens;
    }

    // Allocate P1 Static Worldbook (falls back to budget pruning)
    let finalStaticWorld = block3.content;
    if (block3.tokens > remainingBudget) {
      truncated.push(block3.id);
      finalStaticWorld = "";
    } else {
      remainingBudget -= block3.tokens;
    }

    // Allocate to Block 4 (Summary P2) & Block 5 (State P2)
    let finalSummary = block4.content;
    if (block4.tokens > remainingBudget) {
      truncated.push(block4.id);
      finalSummary = "";
    } else {
      remainingBudget -= block4.tokens;
    }

    let finalState = block5.content;
    if (block5.tokens > remainingBudget) {
      truncated.push(block5.id);
      finalState = "";
    } else {
      remainingBudget -= block5.tokens;
    }

    // Allocate to Block 6 (Dynamic Worldbook P3)
    let finalDynamicWorld = block6.content;
    if (block6.tokens > remainingBudget) {
      truncated.push(block6.id);
      finalDynamicWorld = "";
    } else {
      remainingBudget -= block6.tokens;
    }
    // Pack history in reverse chronological order
    const includedFloors: FloorMessage[] = [];
    const reversedHistory = [...ctx.floorHistory].reverse();

    for (const floor of reversedHistory) {
      const floorTokens = estimateTokens(floor.content, provider) + 4; // per-message frame overhead
      if (floorTokens <= remainingBudget) {
        includedFloors.unshift(floor);
        remainingBudget -= floorTokens;
      } else {
        truncated.push(`history_floor_${floor.id}`);
      }
    }

    // Compose System Prompt
    const systemParts = [
      block1.content,
      finalCharCore,
      finalStaticWorld,
      finalSummary,
      finalState,
      finalDynamicWorld
    ].filter(Boolean);

    const fullSystemPrompt = systemParts.join("\n\n---\n\n");

    // Compose Messages array
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: fullSystemPrompt }
    ];

    for (const fl of includedFloors) {
      messages.push({
        role: fl.role,
        content: fl.content
      });
    }

    messages.push({
      role: "user",
      content: ctx.latestUserInput
    });

    // Compute Stable Prefix Hash (Block 1 + Block 2 + Block 3)
    const stablePrefixText = [block1.content, block2.content, block3.content].join("::");
    const prefixHash = computeStringHash(stablePrefixText);

    const totalPromptTokens = availableBudget - remainingBudget;

    return {
      blocks: [block1, block2, block3, block4, block5, block6, block7],
      systemPrompt: fullSystemPrompt,
      messages,
      totalPromptTokens,
      prefixHash,
      truncatedBlocks: truncated
    };
  }
}
