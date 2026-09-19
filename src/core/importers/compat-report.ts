// src/core/importers/compat-report.ts
// ST 卡兼容报告：导入时逐字段标注保全状态（supported / preserved），
// 是 P1"导入保全"验收（重导往返零字段丢失）的可解释性配套。
// 纯函数、零环境依赖（Core 隔离红线）。
// clean-room：字段清单从 SillyTavern V2 公开 spec 结构与自有卡 fixture 推导，未读 ST/TH 源码。

export type StFieldStatusKind = "supported" | "preserved";

export interface StFieldStatus {
  /** 字段路径，如 "data.extensions.regex_scripts"。 */
  path: string;
  /** supported = 进工作副本/世界书并参与行为；preserved = 仅原版保全，行为后续阶段接入。 */
  status: StFieldStatusKind;
  note?: string;
}

export interface StCompatReport {
  /** 识别出的卡片规范：chara_card_v2 / chara_card_v3 / legacy_v1。 */
  spec: string;
  specVersion?: string;
  fieldCount: number;
  fields: StFieldStatus[];
  stats: { supported: number; preserved: number };
}

/**
 * V2 spec data 层中 AIRP 已消费（进工作副本或世界书存储并参与行为）的字段。
 * character_book.entries 的子字段单独枚举。
 */
const SUPPORTED_DATA_FIELDS = new Set([
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "system_prompt",
  "post_history_instructions",
  "tags",
  "creator_notes",
  "alternate_greetings",
  "character_book",
]);

const SUPPORTED_BOOK_FIELDS = new Set(["name", "description", "entries"]);

const SUPPORTED_ENTRY_FIELDS = new Set([
  "keys",
  "secondary_keys",
  "content",
  "enabled",
  "insertion_order",
  "case_sensitive",
  "comment",
  "constant",
  "selective",
  "position",
  "use_regex",
]);

/** 条目 extensions.* 中已参与确定性激活语义的字段（自卡库普查确证）。 */
const SUPPORTED_ENTRY_EXT_FIELDS = new Set([
  "selectiveLogic",
  "scan_depth",
  "match_whole_words",
  "case_sensitive",
  "probability",
  "useProbability",
]);

/** ST v3 / 社区常见 data 层字段的中文备注（未知字段自动标 preserved 不需要备注）。 */
const KNOWN_PRESERVED_NOTES: Record<string, string> = {
  "data.extensions": "社区扩展载荷（正则脚本/深度提示/变量系统等）——原版完整保全，P2/P3 分阶段接入",
  "data.avatar": "ST 站内头像引用，AIRP 卡面由卡目录自管——仅原版保全",
  "data.creator": "作者署名——仅原版保全",
  "data.character_version": "角色版本号——仅原版保全",
  "data.nickname": "昵称（v3）——仅原版保全",
  "data.creator_notes_multilingual": "多语言作者注记（v3）——仅原版保全",
  "data.description_multilingual": "多语言人设（v3）——仅原版保全",
  "data.personality_multilingual": "多语言性格（v3）——仅原版保全",
  "data.scenario_multilingual": "多语言场景（v3）——仅原版保全",
  "data.first_mes_multilingual": "多语言开场白（v3）——仅原版保全",
  "data.mes_example_multilingual": "多语言对话示例（v3）——仅原版保全",
  "data.assets": "资产清单（v3）——仅原版保全",
  "data.group_only_greetings": "群聊专用问候（v3）——仅原版保全",
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 生成 ST 卡兼容报告。
 * 规则：
 * - 已知且已消费的字段 → supported；
 * - 其余一切字段（已知未消费 / 完全未知 / extensions 全体）→ preserved（零丢失红线的体现：没有 ignored）。
 */
export function buildStCompatReport(jsonRaw: unknown): StCompatReport {
  if (!isPlainObject(jsonRaw)) {
    throw new Error("Invalid character card JSON: root must be an object");
  }

  const root = jsonRaw;
  const hasData = isPlainObject(root.data);
  const data = hasData ? (root.data as Record<string, unknown>) : root;
  const dataPrefix = hasData ? "data." : "";

  const spec = typeof root.spec === "string" ? root.spec : hasData ? "chara_card_v2" : "legacy_v1";
  const specVersion = typeof root.spec_version === "string" ? root.spec_version : undefined;

  const fields: StFieldStatus[] = [];

  // 根级字段（v2 卡：spec / spec_version 之外的一切未知根字段；v1 卡：顶层即 data）
  for (const key of Object.keys(root)) {
    if (hasData && key === "data") continue;
    if (hasData && (key === "spec" || key === "spec_version")) continue;
    if (!hasData && SUPPORTED_DATA_FIELDS.has(key)) continue;
    fields.push({
      path: hasData ? key : `${key}`,
      status: "preserved",
      note: hasData ? "根级未知字段——仅原版保全" : undefined,
    });
  }

  // data 层字段
  for (const key of Object.keys(data)) {
    if (SUPPORTED_DATA_FIELDS.has(key)) {
      fields.push({ path: `${dataPrefix}${key}`, status: "supported" });
    } else {
      fields.push({
        path: `${dataPrefix}${key}`,
        status: "preserved",
        note: KNOWN_PRESERVED_NOTES[`${dataPrefix}${key}`],
      });
    }
  }

  // character_book 子结构
  const book = data.character_book;
  if (isPlainObject(book)) {
    for (const key of Object.keys(book)) {
      if (key === "entries") {
        fields.push({ path: `${dataPrefix}character_book.entries`, status: "supported" });
        // 条目级子字段：扫描第一条的键集合（ST 各条目字段一致；未知子字段按 preserved 汇总）
        const entries = Array.isArray(book.entries) ? book.entries : [];
        const entryKeySet = new Set<string>();
        for (const e of entries) {
          if (isPlainObject(e)) {
            for (const k of Object.keys(e)) entryKeySet.add(k);
          }
        }
        for (const k of entryKeySet) {
          fields.push({
            path: `${dataPrefix}character_book.entries[].${k}`,
            status: SUPPORTED_ENTRY_FIELDS.has(k) ? "supported" : "preserved",
          });
        }
        // 条目 extensions.* 激活细目（普查：selectiveLogic/scan_depth 等字段覆盖率 99.9%）
        const entryExtKeySet = new Set<string>();
        for (const e of entries) {
          const ee = isPlainObject(e) ? e.extensions : undefined;
          if (isPlainObject(ee)) {
            for (const k of Object.keys(ee)) entryExtKeySet.add(k);
          }
        }
        for (const k of entryExtKeySet) {
          fields.push({
            path: `${dataPrefix}character_book.entries[].extensions.${k}`,
            status: SUPPORTED_ENTRY_EXT_FIELDS.has(k) ? "supported" : "preserved",
            note: SUPPORTED_ENTRY_EXT_FIELDS.has(k) ? undefined : "世界书高级激活语义——原版保全，后续阶段接入",
          });
        }
      } else if (SUPPORTED_BOOK_FIELDS.has(key)) {
        fields.push({ path: `${dataPrefix}character_book.${key}`, status: "supported" });
      } else {
        fields.push({
          path: `${dataPrefix}character_book.${key}`,
          status: "preserved",
          note: "世界书元信息——仅原版保全",
        });
      }
    }
  }

  // extensions 子键明细（社区生态的核心载荷，逐键列出便于兼容性查看）
  const ext = data.extensions;
  if (isPlainObject(ext)) {
    for (const key of Object.keys(ext)) {
      fields.push({
        path: `${dataPrefix}extensions.${key}`,
        status: "preserved",
        note: "社区扩展——原版完整保全，行为接入见路线图 P2/P3/P5",
      });
    }
  } else if (ext !== undefined) {
    fields.push({ path: `${dataPrefix}extensions`, status: "preserved" });
  }

  const supported = fields.filter((f) => f.status === "supported").length;
  return {
    spec,
    specVersion,
    fieldCount: fields.length,
    fields,
    stats: { supported, preserved: fields.length - supported },
  };
}
