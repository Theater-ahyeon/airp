// src/core/importers/st-card-importer.ts
// Clean-room implementation of SillyTavern Character Card V2 JSON import.
// Converts ST v2 spec data into AIRP CharacterAttributes with immutable original preservation.

import { CharacterAttributes } from "../types/character.js";

export interface SillyTavernV2CardPayload {
  spec?: string;
  spec_version?: string;
  data: {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    tags?: string[];
    alternate_greetings?: string[];
    character_book?: {
      name?: string;
      description?: string;
      entries?: Array<{
        keys: string[];
        secondary_keys?: string[];
        content: string;
        enabled: boolean;
        insertion_order?: number;
        case_sensitive?: boolean;
        comment?: string;
      }>;
    };
  };
}

export interface CardImportResult {
  attributes: CharacterAttributes;
  alternateGreetings: string[];
  worldbookEntries: Array<{
    id: string;
    keys: string[];
    content: string;
    enabled: boolean;
    priority: number;
    mode: "keyword" | "always" | "tool_search";
  }>;
}

export function importSillyTavernV2Card(jsonRaw: unknown): CardImportResult {
  if (!jsonRaw || typeof jsonRaw !== "object") {
    throw new Error("Invalid character card JSON: root must be an object");
  }

  const raw = jsonRaw as Record<string, unknown>;
  const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as SillyTavernV2CardPayload["data"];

  if (!data.name || typeof data.name !== "string") {
    throw new Error("Invalid character card: missing required 'name' property");
  }

  const attributes: CharacterAttributes = {
    name: data.name.trim(),
    description: String(data.description ?? ""),
    personality: String(data.personality ?? ""),
    scenario: String(data.scenario ?? ""),
    firstMessage: String(data.first_mes ?? ""),
    mesExamples: String(data.mes_example ?? ""),
    systemPrompt: typeof data.system_prompt === "string" ? data.system_prompt : undefined,
    postHistoryInstructions:
      typeof data.post_history_instructions === "string" ? data.post_history_instructions : undefined,
    tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
    creatorNotes: typeof data.creator_notes === "string" ? data.creator_notes : undefined,
  };

  const alternateGreetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.map(String).filter((g) => g.trim().length > 0)
    : [];

  const worldbookEntries: CardImportResult["worldbookEntries"] = [];
  if (data.character_book && Array.isArray(data.character_book.entries)) {
    let autoIndex = 0;
    for (const e of data.character_book.entries) {
      if (!e || typeof e !== "object") continue;
      autoIndex++;
      worldbookEntries.push({
        id: `wb_${autoIndex}_${Math.random().toString(36).slice(2, 7)}`,
        keys: Array.isArray(e.keys) ? e.keys.map(String) : [],
        content: String(e.content ?? ""),
        enabled: e.enabled !== false,
        priority: typeof e.insertion_order === "number" ? e.insertion_order : 10,
        mode: (e.keys && e.keys.length > 0) ? "keyword" : "always",
      });
    }
  }

  return {
    attributes,
    alternateGreetings,
    worldbookEntries,
  };
}
