// src/core/memory/session-review.ts
// Session review and card-level memory consolidation.

import { CardLevelMemory, CardMemoryItem } from "../types/schema.js";

export interface SessionReviewInput {
  cardId: string;
  sessionId: string;
  sessionTitle?: string;
  finalState: Record<string, unknown>;
  rollingSummary?: string | null;
  existingCardMemory: CardLevelMemory;
}

export interface ReviewExtractedFact {
  key: string;
  value: string;
  confidence: number;
}

export class SessionReviewConsolidator {
  /**
   * Consolidates facts from a completed session into long-term card-level memory.
   * Merges duplicate keys by updating value and timestamps.
   */
  static consolidate(
    input: SessionReviewInput,
    extractedFacts: ReviewExtractedFact[]
  ): CardLevelMemory {
    const now = Date.now();
    const updatedMemories: CardMemoryItem[] = [...input.existingCardMemory.memories];

    for (const fact of extractedFacts) {
      const existingIdx = updatedMemories.findIndex((m) => m.key.toLowerCase() === fact.key.toLowerCase());
      if (existingIdx !== -1) {
        // Update existing memory
        updatedMemories[existingIdx] = {
          ...updatedMemories[existingIdx],
          value: fact.value,
          confidence: Math.max(updatedMemories[existingIdx].confidence, fact.confidence),
          sourceSessionId: input.sessionId,
          updatedAt: now
        };
      } else {
        // Insert new memory
        updatedMemories.push({
          id: `mem_${now}_${Math.random().toString(36).slice(2, 7)}`,
          key: fact.key,
          value: fact.value,
          confidence: fact.confidence,
          sourceSessionId: input.sessionId,
          createdAt: now,
          updatedAt: now
        });
      }
    }

    return {
      cardId: input.cardId,
      version: input.existingCardMemory.version + 1,
      updatedAt: now,
      memories: updatedMemories
    };
  }
}
