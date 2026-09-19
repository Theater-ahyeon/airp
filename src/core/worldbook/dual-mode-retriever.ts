// src/core/worldbook/dual-mode-retriever.ts
// Dual-mode Worldbook retriever: Tool search priority + keyword fallback.

import { Worldbook, WorldbookEntry } from "../types/worldbook.js";

export interface RetrievalResult {
  toolRetrievedEntries: WorldbookEntry[];
  keywordMatchedEntries: WorldbookEntry[];
  allActiveEntries: WorldbookEntry[];
  tokensEstimated: number;
}

export class DualModeWorldbookRetriever {
  constructor(private readonly worldbook: Worldbook) {}

  /**
   * Search entries by queries (Tool Calling mode: Model initiates specific keyword/topic queries)
   */
  searchByQueries(queries: string[]): WorldbookEntry[] {
    const results: WorldbookEntry[] = [];
    const seenIds = new Set<string>();

    for (const q of queries) {
      const lowerQ = q.toLowerCase();
      for (const entry of this.worldbook.entries) {
        if (!entry.enabled || seenIds.has(entry.id)) continue;
        const matches =
          entry.keys.some((k) => lowerQ.includes(k.toLowerCase()) || k.toLowerCase().includes(lowerQ)) ||
          (entry.secondaryKeys && entry.secondaryKeys.some((sk) => lowerQ.includes(sk.toLowerCase())));
        if (matches) {
          seenIds.add(entry.id);
          results.push(entry);
        }
      }
    }
    return results;
  }

  /**
   * Performs dual-mode retrieval: tool-invoked queries first, plus keyword fallback scan across text.
   */
  retrieve(contextText: string, modelQueries?: string[]): RetrievalResult {
    const seenIds = new Set<string>();
    const toolEntries: WorldbookEntry[] = [];
    const keywordEntries: WorldbookEntry[] = [];

    // 1. Tool-retrieved entries
    if (modelQueries && modelQueries.length > 0) {
      for (const entry of this.searchByQueries(modelQueries)) {
        seenIds.add(entry.id);
        toolEntries.push(entry);
      }
    }

    // 2. Keyword fallback across current dialogue context
    const lowerContext = contextText.toLowerCase();
    for (const entry of this.worldbook.entries) {
      if (!entry.enabled || seenIds.has(entry.id)) continue;
      if (entry.mode === "always") {
        seenIds.add(entry.id);
        keywordEntries.push(entry);
        continue;
      }
      const matches = entry.keys.some((k) => lowerContext.includes(k.toLowerCase()));
      if (matches) {
        seenIds.add(entry.id);
        keywordEntries.push(entry);
      }
    }

    const allActive = [...toolEntries, ...keywordEntries].sort((a, b) => b.priority - a.priority);
    const tokensEstimated = allActive.reduce((acc, curr) => acc + (curr.tokenBudget ?? Math.ceil(curr.content.length * 0.8)), 0);

    return {
      toolRetrievedEntries: toolEntries,
      keywordMatchedEntries: keywordEntries,
      allActiveEntries: allActive,
      tokensEstimated
    };
  }
}
