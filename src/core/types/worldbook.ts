// src/core/types/worldbook.ts
// Core domain model: Worldbook / Lorebook dual-mode semantics.
// 激活语义为 ST 原生确定性规则（clean-room：从自有卡库 15123 条真实条目字段普查推导）：
// 常驻（constant）无条件激活；关键词条目按主键命中 + 副键四种逻辑过滤。

export type WorldbookActivationMode = "keyword" | "tool_search" | "always";

/** 副关键词组合逻辑（ST world info 数值语义）。 */
export type SecondaryKeyLogic = "AND_ANY" | "NOT_ALL" | "NOT_ANY" | "AND_ALL";

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
  /** 副关键词组合逻辑，默认 AND_ANY。 */
  secondaryLogic?: SecondaryKeyLogic;
  /** 大小写敏感匹配（默认不敏感）。 */
  caseSensitive?: boolean;
  /** 整词匹配（仅对含 ASCII 字母数字的键生效；CJK 键退化为子串匹配）。 */
  matchWholeWords?: boolean;
  /** 激活概率 0-100；<100 时按确定性种子（上下文哈希）决定，默认 100。 */
  probability?: number;
  /** 扫描深度：参与关键词扫描的最近消息数（含当前输入）；缺省由调用方决定。 */
  scanDepth?: number;
  tokenBudget?: number;
}

export interface Worldbook {
  id: string;
  name: string;
  entries: WorldbookEntry[];
}

function normalizeKey(key: string, caseSensitive: boolean): string {
  const trimmed = key.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function buildContextVariants(contextText: string, caseSensitive: boolean): string[] {
  return caseSensitive ? [contextText] : [contextText, contextText.toLowerCase()];
}

/** 单键命中判定：整词（ASCII 键）或子串。 */
function keyMatches(contextVariants: string[], key: string, caseSensitive: boolean, wholeWords: boolean): boolean {
  const k = normalizeKey(key, caseSensitive);
  if (k.length === 0) return false;
  const asciiWord = /^[A-Za-z0-9][A-Za-z0-9'’\-_]*$/.test(k);
  if (wholeWords && asciiWord) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9'’\\-_])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9'’\\-_])`, caseSensitive ? "" : "i");
    return contextVariants[0].search(pattern) !== -1;
  }
  return contextVariants.some((ctx) => ctx.includes(k));
}

function anyKeyMatches(entry: WorldbookEntry, keys: string[], contextVariants: string[]): boolean {
  const caseSensitive = entry.caseSensitive === true;
  const wholeWords = entry.matchWholeWords === true;
  return keys.some((k) => keyMatches(contextVariants, k, caseSensitive, wholeWords));
}

/**
 * 副关键词逻辑判定（前提：主键已命中）。
 * AND_ANY：任一副键命中；AND_ALL：全部副键命中；NOT_ANY：无任何副键命中；NOT_ALL：非全部副键命中。
 * 无副键时：AND_ANY/AND_ALL 视为无附加约束（通过）；NOT_* 视为无排除对象（通过）。
 */
function secondaryGate(entry: WorldbookEntry, contextVariants: string[]): boolean {
  const secondary = entry.secondaryKeys ?? [];
  if (secondary.length === 0) return true;
  const hits = secondary.map((k) => anyKeyMatches(entry, [k], contextVariants));
  switch (entry.secondaryLogic ?? "AND_ANY") {
    case "AND_ANY":
      return hits.some(Boolean);
    case "AND_ALL":
      return hits.every(Boolean);
    case "NOT_ANY":
      return !hits.some(Boolean);
    case "NOT_ALL":
      return !hits.every(Boolean);
  }
}

/** 确定性概率：同轮同上下文同结果（用上下文指纹做种子，不引入运行时随机）。 */
function probabilityGate(entry: WorldbookEntry, contextText: string): boolean {
  const p = entry.probability;
  if (p === undefined || p >= 100) return true;
  if (p <= 0) return false;
  let h = 2166136261;
  const seed = `${entry.id}:${contextText.length}:${contextText.slice(0, 64)}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 100 < p;
}

/**
 * 确定性激活。
 * @param scanTexts 扫描文本序列，scanTexts[0] 为当前用户输入，其后依次为更早的楼层文本（全部拼接进扫描）。
 * @param defaultScanDepth 条目未声明 scanDepth 时的默认扫描深度（ST 语义：最近 N 条消息，含当前输入）。
 */
export function filterWorldbookEntries(
  worldbook: Worldbook,
  scanTexts: string[] | string,
  allowToolSearch: boolean,
  defaultScanDepth: number = 2
): { activeEntries: WorldbookEntry[]; searchableEntries: WorldbookEntry[] } {
  const activeEntries: WorldbookEntry[] = [];
  const searchableEntries: WorldbookEntry[] = [];

  const texts = typeof scanTexts === "string" ? [scanTexts] : scanTexts;

  for (const entry of worldbook.entries) {
    if (!entry.enabled) continue;

    // 常驻条目（ST constant / 蓝灯）：无条件进入稳定前缀
    if (entry.mode === "always") {
      activeEntries.push(entry);
      continue;
    }

    if (entry.mode === "tool_search" && allowToolSearch) {
      searchableEntries.push(entry);
      continue;
    }

    // 关键词条目：按条目扫描深度截取文本 → 主键命中 + 副键逻辑门 + 概率门（全部确定性）
    const depth = Math.max(1, Math.min(entry.scanDepth ?? defaultScanDepth, texts.length));
    const effectiveContext = texts.slice(0, depth).join("\n");
    const caseSensitive = entry.caseSensitive === true;
    const contextVariants = buildContextVariants(effectiveContext, caseSensitive);
    const primaryHit = anyKeyMatches(entry, entry.keys, contextVariants);
    if (primaryHit && secondaryGate(entry, contextVariants) && probabilityGate(entry, effectiveContext)) {
      activeEntries.push(entry);
    } else if (allowToolSearch) {
      searchableEntries.push(entry);
    }
  }

  // Sort active entries by priority descending
  activeEntries.sort((a, b) => b.priority - a.priority);

  return { activeEntries, searchableEntries };
}
