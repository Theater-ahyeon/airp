// src/core/types/worldbook.ts
// Core domain model: Worldbook / Lorebook dual-mode semantics.

export type WorldbookActivationMode = "keyword" | "tool_search" | "always";

export interface WorldbookEntry {
  id: string;
  keys: string[];
  secondaryKeys?: string[];
  content: string;
  comment?: string;
  enabled: boolean;
  priority: number;
  /** Dual-mode activation: keyword fallback or on-demand tool search */
  mode: WorldbookActivationMode;
  /** Token estimate caching */
  tokenBudget?: number;
}

export interface Worldbook {
  id: string;
  name: string;
  entries: WorldbookEntry[];
}

export function filterWorldbookEntries(
  worldbook: Worldbook,
  contextText: string,
  allowToolSearch: boolean
): { activeEntries: WorldbookEntry[]; searchableEntries: WorldbookEntry[] } {
  const activeEntries: WorldbookEntry[] = [];
  const searchableEntries: WorldbookEntry[] = [];

  const lowerContext = contextText.toLowerCase();

  for (const entry of worldbook.entries) {
    if (!entry.enabled) continue;

    if (entry.mode === "always") {
      activeEntries.push(entry);
      continue;
    }

    if (entry.mode === "tool_search" && allowToolSearch) {
      searchableEntries.push(entry);
      continue;
    }

    // Keyword matching
    const matched = entry.keys.some((k) => lowerContext.includes(k.toLowerCase()));
    if (matched) {
      activeEntries.push(entry);
    } else if (allowToolSearch) {
      searchableEntries.push(entry);
    }
  }

  // Sort active entries by priority descending
  activeEntries.sort((a, b) => b.priority - a.priority);

  return { activeEntries, searchableEntries };
}
