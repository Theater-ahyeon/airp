// src/core/pipeline/state-selector.ts
// State to prompt selection strategy: recency, relevance, pinned status, and budget.

import { StateSnapshot } from "../types/state.js";
import { estimateTokens } from "./token-estimator.js";

export interface StateItemCandidate {
  key: string;
  value: unknown;
  score: number;
  tokens: number;
  text: string;
}

export interface StateSelectionOptions {
  maxTokens: number;
  pinnedKeys?: string[];
  recentFloorHits?: Record<string, number>; // key -> floors since last read/write
  userQuery?: string;
  provider?: string;
}

export function selectActiveStates(
  state: StateSnapshot,
  options: StateSelectionOptions
): { selected: StateItemCandidate[]; renderedText: string; totalTokens: number } {
  const { maxTokens, pinnedKeys = [], recentFloorHits = {}, userQuery = "", provider = "conservative" } = options;

  const candidates: StateItemCandidate[] = [];
  const lowerQuery = userQuery.toLowerCase();

  for (const [key, val] of Object.entries(state)) {
    if (val === undefined || val === null) continue;
    const strVal = typeof val === "object" ? JSON.stringify(val) : String(val);
    const lineText = `- ${key}: ${strVal}`;
    const tokens = estimateTokens(lineText, provider);

    // Scoring
    const isPinned = pinnedKeys.includes(key);
    const pinScore = isPinned ? 1.0 : 0.0;

    const deltaFloors = recentFloorHits[key] ?? 99;
    const recencyScore = 1.0 / (1.0 + Math.log(1.0 + Math.max(0, deltaFloors)));

    const lowerKey = key.toLowerCase();
    const hitQuery = lowerQuery.includes(lowerKey) || (lowerQuery.length > 3 && lowerKey.includes(lowerQuery));
    const relevanceScore = hitQuery ? 1.0 : 0.0;

    const score = pinScore * 0.5 + relevanceScore * 0.3 + recencyScore * 0.2;

    candidates.push({
      key,
      value: val,
      score,
      tokens,
      text: lineText
    });
  }

  // Sort descending by score
  candidates.sort((a, b) => b.score - a.score);

  const selected: StateItemCandidate[] = [];
  let budgetRemaining = maxTokens;

  for (const cand of candidates) {
    if (cand.tokens <= budgetRemaining) {
      selected.push(cand);
      budgetRemaining -= cand.tokens;
    }
  }

  const renderedText = selected.map((c) => c.text).join("\n");
  const totalTokens = maxTokens - budgetRemaining;

  return { selected, renderedText, totalTokens };
}
