// src/runtime/contracts.ts
// AIRP Runtime 层共享契约（架构层冻结文件）。
//
// 规则：
// - 实现方（store / session / server / credentials）只可 import 本文件的类型与常量。
// - 修改任何签名前必须先改本文件并由架构层批准，禁止在实现文件里私自定义同名类型。
// - 本文件不含实现、不做 IO、不引入 node:* 运行时模块，只依赖 src/core 的纯类型。

import type { FloorMessage, Role } from "../core/types/floor-tree.js";
import type { StateOp, StateSnapshot } from "../core/types/state.js";
import type { CharacterAttributes } from "../core/types/character.js";

/** 事件日志 schema 版本。破坏性变更必须递增，并在 migrations.ts 中提供迁移。 */
export const RUNTIME_SCHEMA_VERSION = 1;

/** 卡目录布局（相对 <AIRP_HOME>/cards/<cardId>/）。 */
export const CARD_LAYOUT = {
  card: "card.json",
  meta: "meta.json",
  sessions: "sessions",
  backups: "backups"
} as const;

/** 会话目录布局（相对 <AIRP_HOME>/cards/<cardId>/sessions/<sessionId>/）。 */
export const SESSION_LAYOUT = {
  events: "events.jsonl",
  snapshots: "snapshots",
  runs: "runs"
} as const;

/** 默认快照间隔（累计事件条数）。 */
export const DEFAULT_SNAPSHOT_INTERVAL = 50;

/** 导出包版本，与 RUNTIME_SCHEMA_VERSION 解耦。 */
export const EXPORT_BUNDLE_VERSION = 1;

/** 内存态楼层树的磁盘表示（Map -> Record，可 JSON 化）。 */
export interface SerializedFloorTree {
  id: string;
  rootFloorId: string | null;
  activeBranchId: string;
  floors: Record<string, FloorMessage>;
  undoCheckpointFloorId: string | null;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
}

// ---------------------------------------------------------------------------
// 事件模型：patch-first，append-only，重放 = 顺序 apply
// ---------------------------------------------------------------------------

export type RuntimeEventType =
  | "session_created"
  | "floor_appended"
  | "floor_swiped"
  | "floor_edited"
  | "branch_switched"
  | "rollback"
  | "undo_rollback"
  | "state_op"
  | "summary_updated"
  | "run_created"
  | "run_started"
  | "run_delta"
  | "run_completed"
  | "run_cancelled"
  | "run_failed"
  | "checkpoint"
  | "butler_extracted"
  | "butler_degraded";

export interface RuntimeEventBase {
  /** 会话内单调递增序号，由 EventLog 分配，从 1 开始，绝不重复。 */
  seq: number;
  id: string;
  cardId: string;
  sessionId: string;
  ts: number;
}

export interface SessionCreatedEvent extends RuntimeEventBase {
  type: "session_created";
  payload: { title?: string };
}

export interface FloorAppendedEvent extends RuntimeEventBase {
  type: "floor_appended";
  payload: {
    floorId: string;
    parentId: string | null;
    branchId: string;
    floorIndex: number;
    role: Role;
    content: string;
  };
}

export interface FloorSwipedEvent extends RuntimeEventBase {
  type: "floor_swiped";
  payload: { floorId: string; swipeIndex: number; content: string };
}

export interface FloorEditedEvent extends RuntimeEventBase {
  type: "floor_edited";
  payload: { floorId: string; content: string; previousContent: string };
}

export interface BranchSwitchedEvent extends RuntimeEventBase {
  type: "branch_switched";
  payload: { branchId: string };
}

export interface RollbackEvent extends RuntimeEventBase {
  type: "rollback";
  payload: { toFloorId: string; forgottenFloorIds: string[] };
}

export interface UndoRollbackEvent extends RuntimeEventBase {
  type: "undo_rollback";
  payload: {
    restoredFloorIds: string[];
    /**
     * 自包含恢复数据：本次被撤销回退的楼层完整快照（含 swipes 与 editHistory）。
     *
     * 硬约束：重放必须**只依赖本字段**恢复楼层，禁止依赖"重放过程中的内存楼层归档"。
     * 原因：快照 checkpoint 会截断被其吸收的历史事件，一旦回退发生在快照边界之前，
     * 内存归档在重放起点处为空，恢复必然失败（数据永久丢失）。
     *
     * 同时要求：只恢复**最近一次** rollback 遗忘的楼层；更早的 rollback 已被新的
     * 回退覆盖其恢复点，其遗忘必须是永久的。
     */
    restoredFloors: FloorMessage[];
  };
}

export interface StateOpEvent extends RuntimeEventBase {
  type: "state_op";
  payload: { op: StateOp };
}

export interface SummaryUpdatedEvent extends RuntimeEventBase {
  type: "summary_updated";
  payload: { branchId: string; summary: string; upToFloorId: string };
}

export interface RunCreatedEvent extends RuntimeEventBase {
  type: "run_created";
  payload: { runId: string; model: string };
}

export interface RunStartedEvent extends RuntimeEventBase {
  type: "run_started";
  payload: { runId: string };
}

/**
 * 增量文本事件。payload.text 只包含"自上一条 run_delta 以来的新增文本"。
 * 落盘节流由 session 层决定（默认 150ms 或 4KB 先到先触发），禁止逐字符落盘。
 */
export interface RunDeltaEvent extends RuntimeEventBase {
  type: "run_delta";
  payload: { runId: string; text: string };
}

export interface RunCompletedEvent extends RuntimeEventBase {
  type: "run_completed";
  payload: { runId: string; text: string; usage?: TokenUsage };
}

export interface RunCancelledEvent extends RuntimeEventBase {
  type: "run_cancelled";
  payload: { runId: string; reason?: string };
}

export interface RunFailedEvent extends RuntimeEventBase {
  type: "run_failed";
  payload: { runId: string; error: string };
}

export interface CheckpointEvent extends RuntimeEventBase {
  type: "checkpoint";
  payload: { snapshotSeq: number; snapshotPath: string };
}

export interface ButlerExtractedEvent extends RuntimeEventBase {
  type: "butler_extracted";
  payload: {
    floorId: string;
    stateOpsCount: number;
    summaryUpdated: boolean;
    tokensUsed?: { input: number; output: number };
  };
}

export interface ButlerDegradedEvent extends RuntimeEventBase {
  type: "butler_degraded";
  payload: {
    floorId: string;
    reason: string;
  };
}

export type RuntimeEvent =
  | SessionCreatedEvent
  | FloorAppendedEvent
  | FloorSwipedEvent
  | FloorEditedEvent
  | BranchSwitchedEvent
  | RollbackEvent
  | UndoRollbackEvent
  | StateOpEvent
  | SummaryUpdatedEvent
  | RunCreatedEvent
  | RunStartedEvent
  | RunDeltaEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent
  | CheckpointEvent
  | ButlerExtractedEvent
  | ButlerDegradedEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 写入侧事件：seq 与 id 由 EventLog 分配，调用方不得提供。 */
export type RuntimeEventDraft = DistributiveOmit<RuntimeEvent, "seq" | "id">;

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.seq === "number" &&
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.cardId === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.ts === "number" &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null
  );
}

// ---------------------------------------------------------------------------
// 重放结果与快照
// ---------------------------------------------------------------------------

export interface ReplayResult {
  tree: SerializedFloorTree;
  state: StateSnapshot;
  summary: string | null;
  lastSeq: number;
  /** 快照之后实际重放的事件（不含被快照吸收的历史）。 */
  replayedEvents: RuntimeEvent[];
  fromCheckpointSeq: number | null;
}

export interface SessionCheckpoint {
  schemaVersion: number;
  cardId: string;
  sessionId: string;
  /** 该快照已吸收的最大事件序号。 */
  seq: number;
  createdAt: number;
  tree: SerializedFloorTree;
  state: StateSnapshot;
  summary: string | null;
}

// ---------------------------------------------------------------------------
// 卡元数据与导出包
// ---------------------------------------------------------------------------

export interface CardMeta {
  schemaVersion: number;
  cardId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastMigratedAt?: number;
}

export interface CardSummary {
  cardId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  sessionCount: number;
  schemaVersion: number;
}

export interface ExportBundle {
  bundleVersion: number;
  exportedAt: number;
  schemaVersion: number;
  meta: CardMeta;
  character: {
    original: CharacterAttributes;
    workingCopy: CharacterAttributes;
  };
  sessions: Array<{
    sessionId: string;
    events: RuntimeEvent[];
  }>;
}

// ---------------------------------------------------------------------------
// 存储门面（实现：src/runtime/store/**）
// ---------------------------------------------------------------------------

export interface CardStoreFacade {
  /** <AIRP_HOME> 绝对路径，用于诊断与测试断言。 */
  readonly home: string;

  listCards(): Promise<CardSummary[]>;
  createCard(input: { cardId?: string; attributes: CharacterAttributes }): Promise<{ cardId: string }>;
  readCard(cardId: string): Promise<{
    meta: CardMeta;
    original: CharacterAttributes;
    workingCopy: CharacterAttributes;
  }>;

  createSession(cardId: string, sessionId?: string): Promise<{ sessionId: string }>;
  listSessions(cardId: string): Promise<string[]>;

  appendFloor(
    cardId: string,
    sessionId: string,
    input: { role: Role; content: string; parentId?: string | null }
  ): Promise<FloorAppendedEvent>;
  swipeFloor(
    cardId: string,
    sessionId: string,
    input: { floorId: string; content: string }
  ): Promise<FloorSwipedEvent>;
  editFloor(
    cardId: string,
    sessionId: string,
    input: { floorId: string; content: string }
  ): Promise<FloorEditedEvent>;
  rollback(cardId: string, sessionId: string, toFloorId: string): Promise<RollbackEvent>;
  undoRollback(cardId: string, sessionId: string): Promise<UndoRollbackEvent>;
  applyStateOp(
    cardId: string,
    sessionId: string,
    op: Omit<StateOp, "id" | "timestamp">
  ): Promise<StateOpEvent>;

  /** 通用写入逃生口：session 层写 run_* 事件、summary_updated 等使用。 */
  appendEvent(cardId: string, sessionId: string, draft: RuntimeEventDraft): Promise<RuntimeEvent>;

  /** 快照 + 重放，得到任意时刻的权威状态。 */
  replay(cardId: string, sessionId: string): Promise<ReplayResult>;
  readEvents(cardId: string, sessionId: string, fromSeq?: number): Promise<RuntimeEvent[]>;

  exportCard(cardId: string): Promise<ExportBundle>;
  importCard(bundle: ExportBundle, opts?: { newCardId?: string }): Promise<{ cardId: string }>;

  /** 版本化迁移，迁移前自动备份；无需迁移时 backupPath 为 null。 */
  migrate(cardId: string): Promise<{ from: number; to: number; backupPath: string | null }>;
}

// ---------------------------------------------------------------------------
// 模型端口（阶段 2 只用假模型；真实 pi-ai 适配在阶段 3+）
// ---------------------------------------------------------------------------

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type ModelStreamChunk =
  | { type: "start" }
  | { type: "text_delta"; text: string }
  | { type: "done"; usage?: TokenUsage }
  | { type: "error"; error: string };

export interface ModelStreamPort {
  stream(req: {
    model: string;
    messages: ModelMessage[];
    abortSignal: AbortSignal;
  }): AsyncGenerator<ModelStreamChunk, void, unknown>;
}

// ---------------------------------------------------------------------------
// Run 生命周期（实现：src/runtime/session/**）
// ---------------------------------------------------------------------------

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  /** 进程崩溃时处于 running/queued 的 Run，启动后被标记为 interrupted。 */
  | "interrupted";

export interface RunRecord {
  runId: string;
  cardId: string;
  sessionId: string;
  status: RunStatus;
  model: string;
  prompt: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** 累积的完整输出文本（增量事件重放的结果）。 */
  text: string;
  usage?: TokenUsage;
  error?: string;
  cancelReason?: string;
  /** 已落盘的最后一条事件序号，用于 reattach 续读。 */
  lastSeq: number;
}

export interface StartRunInput {
  cardId: string;
  sessionId: string;
  model?: string;
  prompt: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /**
   * 组装完成的完整消息序列（含 system 前缀与历史）。
   * 由 ChatEngine 通过 AssemblyPipeline 生成后传入；未提供时 RunManager
   * 退回裸 prompt 单消息（仅用于底层测试与探针直连）。
   */
  messages?: ModelMessage[];
}

/** 会话级对话回合引擎：组装 → 生成 → 楼层落地 → 管家提取。 */
export interface ChatEngineFacade {
  /**
   * 开始一个对话回合：追加用户楼层 → 组装上下文 → 启动 Run；
   * Run 完成后自动追加助手楼层并触发管家提取（异步，失败显式降级事件）。
   * 同一会话已有进行中的回合时抛出 TurnConflictError。
   */
  startTurn(input: StartRunInput): Promise<RunRecord>;
}

export interface RunEventSink {
  onEvent(event: RuntimeEvent): void;
  onEnd(record: RunRecord): void;
}

export interface RunManagerFacade {
  startRun(input: StartRunInput): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  listRuns(cardId: string, sessionId: string): Promise<RunRecord[]>;
  /** 取消进行中的 Run；对已结束的 Run 返回 false。 */
  cancelRun(runId: string): Promise<boolean>;
  /**
   * 订阅一个 Run：先按 fromSeq 重放已持久化事件，再续接实时事件。
   * 返回退订函数。Run 已结束时重放完毕即调用 onEnd。
   */
  subscribe(runId: string, fromSeq: number, sink: RunEventSink): Promise<() => void>;
  /** 启动时调用：把遗留的 queued/running Run 标记为 interrupted 并返回它们。 */
  recoverOnBoot(): Promise<RunRecord[]>;
}

// ---------------------------------------------------------------------------
// 服务器配置（实现：src/runtime/server/**、src/runtime/credentials/**）
export interface ServerDeps {
  cardStore: CardStoreFacade;
  runManager: RunManagerFacade;
  /** 对话回合引擎：POST /api/runs 的实际执行者。 */
  chatEngine: ChatEngineFacade;
}

export interface ServerConfig {
  /** 启动令牌：所有 /api/* 请求必须携带（X-AIRP-Token 头或 ?token=）。 */
  token: string;
  port: number;
  host: "127.0.0.1";
  allowedOrigins: string[];
  airpHome: string;
  /** 前端静态资源目录（dist-ui）。缺省时回退占位页。 */
  staticDir?: string;
}

export interface CredentialStore {
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<boolean>;
  /** 实际使用的后端，用于诊断输出。 */
  readonly backend: "os-keychain" | "encrypted-file";
}
