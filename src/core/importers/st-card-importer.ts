// src/core/importers/st-card-importer.ts
// Clean-room implementation of SillyTavern Character Card V2/V3 JSON import.
// 字段面与激活语义从自有卡库 114 张真实卡 / 15123 条世界书条目普查推导（scripts/survey-card-fields.mjs）。
// 原版 JSON 由调用方整体保全（不可变原版）；本模块只负责投影出工作副本 + 世界书 + 兼容报告。

import { CharacterAttributes } from "../types/character.js";
import type { SecondaryKeyLogic, WorldbookEntry } from "../types/worldbook.js";
import { buildStCompatReport, StCompatReport } from "./compat-report.js";

/** ST world info selectiveLogic 数值语义（自卡库条目 extensions 普查确证）。 */
const SECONDARY_LOGIC_VALUES: Record<number, SecondaryKeyLogic> = {
  0: "AND_ANY",
  1: "NOT_ALL",
  2: "NOT_ANY",
  3: "AND_ALL",
};

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export interface CardImportResult {
  attributes: CharacterAttributes;
  alternateGreetings: string[];
  worldbookEntries: WorldbookEntry[];
  /** 世界书名称（character_book.name），保世界书存储用。 */
  worldbookName?: string;
  /** 字段级兼容报告：supported/preserved 清单。 */
  compatReport: StCompatReport;
}

export function importSillyTavernV2Card(jsonRaw: unknown): CardImportResult {
  if (!jsonRaw || typeof jsonRaw !== "object") {
    throw new Error("Invalid character card JSON: root must be an object");
  }

  const raw = jsonRaw as Record<string, unknown>;
  const data = (asRecord(raw.data) ?? raw) as Record<string, unknown>;

  if (typeof data.name !== "string" || data.name.length === 0) {
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

  const worldbookEntries: WorldbookEntry[] = [];
  let worldbookName: string | undefined;

  const book = asRecord(data.character_book);
  if (book) {
    if (typeof book.name === "string") worldbookName = book.name;
    if (Array.isArray(book.entries)) {
      let autoIndex = 0;
      for (const rawEntry of book.entries) {
        const e = asRecord(rawEntry);
        if (!e) continue;
        autoIndex++;
        const keys = Array.isArray(e.keys) ? e.keys.map(String) : [];
        const secondaryKeys = Array.isArray(e.secondary_keys) ? e.secondary_keys.map(String) : undefined;
        // ST constant（蓝灯）：无条件常驻 → mode "always"，无论是否有主键
        const isConstant = e.constant === true;
        // 条目 extensions 承载激活语义细目（普查：15116/15123 条目都有，部分卡在 entry 顶层）
        const ext = asRecord(e.extensions) ?? {};
        const rawLogic = ext.selectiveLogic ?? e.selectiveLogic;
        const logicNumber = typeof rawLogic === "number" ? rawLogic : undefined;
        worldbookEntries.push({
          id: `wb_${autoIndex}`,
          keys,
          secondaryKeys: secondaryKeys && secondaryKeys.length > 0 ? secondaryKeys : undefined,
          content: String(e.content ?? ""),
          comment: typeof e.comment === "string" ? e.comment : undefined,
          enabled: e.enabled !== false,
          priority: typeof e.insertion_order === "number" ? e.insertion_order : 10,
          mode: isConstant ? "always" : "keyword",
          secondaryLogic: logicNumber !== undefined ? SECONDARY_LOGIC_VALUES[logicNumber] : undefined,
          caseSensitive: ext.case_sensitive === true || e.case_sensitive === true,
          matchWholeWords: ext.match_whole_words === true,
          probability: ext.useProbability === true && typeof ext.probability === "number" ? ext.probability : undefined,
          scanDepth: typeof ext.scan_depth === "number" && ext.scan_depth >= 0 ? ext.scan_depth : undefined,
        });
      }
    }
  }

  return {
    attributes,
    alternateGreetings,
    worldbookEntries,
    worldbookName,
    compatReport: buildStCompatReport(jsonRaw),
  };
}
