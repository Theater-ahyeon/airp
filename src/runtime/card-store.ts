// src/runtime/card-store.ts
// CardStoreFacade 完整实现：一卡一目录物理隔离、事件追加、快照机制与确定性重放。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  CardStoreFacade,
  CardSummary,
  CardMeta,
  ExportBundle,
  ReplayResult,
  SessionCheckpoint,
  SerializedFloorTree,
  RuntimeEvent,
  RuntimeEventDraft,
  FloorAppendedEvent,
  FloorSwipedEvent,
  FloorEditedEvent,
  RollbackEvent,
  UndoRollbackEvent,
  StateOpEvent,
  CheckpointEvent
} from "./contracts.js";
import {
  RUNTIME_SCHEMA_VERSION,
  EXPORT_BUNDLE_VERSION,
  DEFAULT_SNAPSHOT_INTERVAL
} from "./contracts.js";
import type { CharacterAttributes } from "../core/types/character.js";
import type { Role, FloorMessage } from "../core/types/floor-tree.js";
import type { StateOp, StateSnapshot } from "../core/types/state.js";
import { applyStateOp } from "../core/types/state.js";
import type { Worldbook, WorldbookEntry } from "../core/types/worldbook.js";
import { importSillyTavernV2Card } from "../core/importers/st-card-importer.js";
import type { StCompatReport } from "../core/importers/compat-report.js";
import {
  resolveAirpHome,
  cardDir,
  cardsBaseDir,
  cardMetaPath,
  cardPayloadPath,
  sessionsBaseDir,
  sessionDir,
  eventsPath,
  snapshotsDir,
  assertSafeId,
  cardOriginalPath,
  cardCompatPath,
  cardWorldbookPath
} from "./paths.js";
import { ensureDir, writeJsonAtomic, writeAtomic, readJson } from "./fs-atomic.js";
import { EventLog } from "./event-log.js";
import { SnapshotStore } from "./snapshot-store.js";
import { migrateCard } from "./migrations.js";

/** 卡片内部存储格式 */
interface CardJsonData {
  original: CharacterAttributes;
  workingCopy: CharacterAttributes;
}

export class CardStore implements CardStoreFacade {
  readonly home: string;
  private readonly snapshotInterval: number;
  /** 会话对应的 EventLog 缓存映射 */
  private readonly eventLogs = new Map<string, EventLog>();
  /**
   * 会话级互斥队列：读改写操作（append/swipe/edit/rollback/undo）必须整体串行，
   * 防止并发 replay+append 产生重复 floorIndex（审查 M-5）。
   * 注意：createCheckpointInternal 不得获取该锁——快照触发点位于 appendFloor
   * 持锁期间的 EventLog.append 回调链上，重入会死锁；其一致性由
   * checkpoint.seq=吸收边界语义保证（见 createCheckpointInternal）。
   */
  private readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(customHome?: string, snapshotInterval = DEFAULT_SNAPSHOT_INTERVAL) {
    this.home = customHome ? path.resolve(customHome) : resolveAirpHome();
    this.snapshotInterval = snapshotInterval;
  }

  /** 会话级串行任务执行器（与 EventLog 内部互斥独立，嵌套调用会死锁） */
  private runSessionExclusive<T>(cardId: string, sessionId: string, fn: () => Promise<T>): Promise<T> {
    const key = this.getSessionKey(cardId, sessionId);
    const next = (this.sessionLocks.get(key) ?? Promise.resolve()).then(fn, fn);
    this.sessionLocks.set(key, next.then(() => {}, () => {}));
    return next;
  }

  private getSessionKey(cardId: string, sessionId: string): string {
    return `${cardId}:${sessionId}`;
  }

  private getEventLog(cardId: string, sessionId: string): EventLog {
    assertSafeId(cardId, "cardId");
    assertSafeId(sessionId, "sessionId");
    const key = this.getSessionKey(cardId, sessionId);
    let log = this.eventLogs.get(key);
    if (!log) {
      const filePath = eventsPath(this.home, cardId, sessionId);
      log = new EventLog({
        cardId,
        sessionId,
        filePath,
        snapshotInterval: this.snapshotInterval,
        onSnapshotThreshold: async (_seq) => {
          await this.createCheckpointInternal(cardId, sessionId);
        }
      });
      this.eventLogs.set(key, log);
    }
    return log;
  }

  private getSnapshotStore(cardId: string, sessionId: string): SnapshotStore {
    assertSafeId(cardId, "cardId");
    assertSafeId(sessionId, "sessionId");
    const dir = snapshotsDir(this.home, cardId, sessionId);
    return new SnapshotStore(dir);
  }
  /**
   * 触发生成快照并持久化到 snapshot-store。
   *
   * C-1 修复：checkpoint.seq 必须等于重放树**实际吸收**的最大事件 seq
   * （replayedEvents 最后一条的 seq），而不是事件日志的最新 lastSeq。
   * 后者在"快照重放期间并发 append"窗口内会大于树吸收边界，导致下一轮
   * replay 从 seq+1 起读、跳过未吸收事件——永久静默丢失。
   * 取吸收边界后，任何交错下快照与日志一致；未被吸收的事件下一轮重读（幂等）。
   */
  private async createCheckpointInternal(cardId: string, sessionId: string): Promise<SessionCheckpoint> {
    const replayRes = await this.replay(cardId, sessionId);
    const absorbedSeq = replayRes.replayedEvents.length > 0
      ? replayRes.replayedEvents[replayRes.replayedEvents.length - 1].seq
      : replayRes.fromCheckpointSeq ?? 0;
    const snapStore = this.getSnapshotStore(cardId, sessionId);
    const checkpoint: SessionCheckpoint = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      cardId,
      sessionId,
      seq: absorbedSeq,
      createdAt: Date.now(),
      tree: replayRes.tree,
      state: replayRes.state,
      summary: replayRes.summary
    };
    await snapStore.save(checkpoint);
    return checkpoint;
  }

  // ---------------------------------------------------------------------------
  // 卡片管理
  // ---------------------------------------------------------------------------

  async listCards(): Promise<CardSummary[]> {
    const base = cardsBaseDir(this.home);
    const summaries: CardSummary[] = [];

    let entries: Array<{ name: string; isDirectory: () => boolean }> = [];
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const cId = entry.name;
      // 过滤非合法 ID 目录
      try {
        assertSafeId(cId, "cardId");
      } catch {
        continue;
      }

      const metaFile = cardMetaPath(this.home, cId);
      let meta: Partial<CardMeta> = {};
      try {
        meta = await readJson<Partial<CardMeta>>(metaFile);
      } catch {
        // 若没有 meta.json，视为 v0 未迁移卡片
      }

      let sessionCount = 0;
      const sessDir = sessionsBaseDir(this.home, cId);
      try {
        const sEntries = await fs.readdir(sessDir, { withFileTypes: true });
        sessionCount = sEntries.filter((s) => s.isDirectory()).length;
      } catch {
        sessionCount = 0;
      }

      summaries.push({
        cardId: cId,
        name: meta.name ?? cId,
        createdAt: meta.createdAt ?? 0,
        updatedAt: meta.updatedAt ?? 0,
        sessionCount,
        schemaVersion: meta.schemaVersion ?? 0
      });
    }

    // 按创建时间倒序排列
    summaries.sort((a, b) => b.createdAt - a.createdAt);
    return summaries;
  }

  async createCard(input: { cardId?: string; attributes: CharacterAttributes }): Promise<{ cardId: string }> {
    const cId = input.cardId ?? `card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    assertSafeId(cId, "cardId");

    const targetDir = cardDir(this.home, cId);
    try {
      await fs.access(targetDir);
      throw new Error(`Card directory already exists: ${cId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await ensureDir(targetDir);
    const now = Date.now();

    const meta: CardMeta = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      cardId: cId,
      name: input.attributes.name || cId,
      createdAt: now,
      updatedAt: now
    };

    const cardData: CardJsonData = {
      original: { ...input.attributes },
      workingCopy: { ...input.attributes }
    };

    await writeJsonAtomic(cardMetaPath(this.home, cId), meta);
    await writeJsonAtomic(cardPayloadPath(this.home, cId), cardData);
    await ensureDir(sessionsBaseDir(this.home, cId));

    return { cardId: cId };
  }

  async readCard(cardId: string): Promise<{
    meta: CardMeta;
    original: CharacterAttributes;
    workingCopy: CharacterAttributes;
  }> {
    assertSafeId(cardId, "cardId");
    const metaFile = cardMetaPath(this.home, cardId);
    const payloadFile = cardPayloadPath(this.home, cardId);

    const meta = await readJson<CardMeta>(metaFile);
    const payload = await readJson<CardJsonData>(payloadFile);

    return {
      meta,
      original: payload.original,
      workingCopy: payload.workingCopy
    };
  }

  // ---------------------------------------------------------------------------
  // 会话管理
  // ---------------------------------------------------------------------------

  async createSession(cardId: string, sessionId?: string): Promise<{ sessionId: string }> {
    assertSafeId(cardId, "cardId");
    const sId = sessionId ?? `sess_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    assertSafeId(sId, "sessionId");

    const sDir = sessionDir(this.home, cardId, sId);
    await ensureDir(sDir);
    await ensureDir(snapshotsDir(this.home, cardId, sId));

    // 追加初始 session_created 事件
    await this.appendEvent(cardId, sId, {
      type: "session_created",
      cardId,
      sessionId: sId,
      ts: Date.now(),
      payload: { title: sId }
    });

    return { sessionId: sId };
  }

  async listSessions(cardId: string): Promise<string[]> {
    assertSafeId(cardId, "cardId");
    const base = sessionsBaseDir(this.home, cardId);
    try {
      const entries = await fs.readdir(base, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 领域事件写入
  // ---------------------------------------------------------------------------

  async appendFloor(
    cardId: string,
    sessionId: string,
    input: { role: Role; content: string; parentId?: string | null }
  ): Promise<FloorAppendedEvent> {
    // M-5：replay→append 读改写必须整体持会话锁，否则并发追加产生重复 floorIndex
    return this.runSessionExclusive(cardId, sessionId, async () => {
      const replayState = await this.replay(cardId, sessionId);
      const tree = replayState.tree;

      // 当 parentId 为空或未传递时，挂载在当前活跃分支的末尾
      let resolvedParentId: string | null = null;
      if (input.parentId !== undefined) {
        resolvedParentId = input.parentId;
      } else {
        // 寻找当前活跃分支的最大 floorIndex 楼层
        let latestInBranch: FloorMessage | null = null;
        for (const floor of Object.values(tree.floors)) {
          if (floor.branchId === tree.activeBranchId) {
            if (!latestInBranch || floor.floorIndex > latestInBranch.floorIndex) {
              latestInBranch = floor;
            }
          }
        }
        resolvedParentId = latestInBranch ? latestInBranch.id : null;
      }

      const parentFloor = resolvedParentId ? tree.floors[resolvedParentId] : null;
      const floorIndex = parentFloor ? parentFloor.floorIndex + 1 : 1;
      const floorId = `floor_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

      const draft: RuntimeEventDraft = {
        type: "floor_appended",
        cardId,
        sessionId,
        ts: Date.now(),
        payload: {
          floorId,
          parentId: resolvedParentId,
          branchId: tree.activeBranchId || "main",
          floorIndex,
          role: input.role,
          content: input.content
        }
      };

      const event = await this.appendEvent(cardId, sessionId, draft);
      return event as FloorAppendedEvent;
    });
  }

  async swipeFloor(
    cardId: string,
    sessionId: string,
    input: { floorId: string; content: string }
  ): Promise<FloorSwipedEvent> {
    return this.runSessionExclusive(cardId, sessionId, async () => {
      const replayState = await this.replay(cardId, sessionId);
      const floor = replayState.tree.floors[input.floorId];
      if (!floor) {
        throw new Error(`Floor not found: ${input.floorId}`);
      }

      const nextSwipeIndex = floor.swipes.length;
      const draft: RuntimeEventDraft = {
        type: "floor_swiped",
        cardId,
        sessionId,
        ts: Date.now(),
        payload: {
          floorId: input.floorId,
          swipeIndex: nextSwipeIndex,
          content: input.content
        }
      };

      const event = await this.appendEvent(cardId, sessionId, draft);
      return event as FloorSwipedEvent;
    });
  }

  async editFloor(
    cardId: string,
    sessionId: string,
    input: { floorId: string; content: string }
  ): Promise<FloorEditedEvent> {
    return this.runSessionExclusive(cardId, sessionId, async () => {
      const replayState = await this.replay(cardId, sessionId);
      const floor = replayState.tree.floors[input.floorId];
      if (!floor) {
        throw new Error(`Floor not found: ${input.floorId}`);
      }

      const draft: RuntimeEventDraft = {
        type: "floor_edited",
        cardId,
        sessionId,
        ts: Date.now(),
        payload: {
          floorId: input.floorId,
          content: input.content,
          previousContent: floor.content
        }
      };

      const event = await this.appendEvent(cardId, sessionId, draft);
      return event as FloorEditedEvent;
    });
  }

  async rollback(cardId: string, sessionId: string, toFloorId: string): Promise<RollbackEvent> {
    return this.runSessionExclusive(cardId, sessionId, async () => {
      const replayState = await this.replay(cardId, sessionId);
      const targetFloor = replayState.tree.floors[toFloorId];
      if (!targetFloor) {
        throw new Error(`Floor not found for rollback: ${toFloorId}`);
      }

      // H-2 修复：只遗忘目标楼层在**同一分支**上的后代（沿 parentId 链向下收集）。
      // 旧实现按全局 floorIndex > target 收集，会把其它分支的楼层整链误删。
      // 其它分支（branchId 不同）不是本分支路径的后代，予以保留。
      const forgottenFloorIds: string[] = [];
      const queue: string[] = [toFloorId];
      while (queue.length > 0) {
        const currentId = queue.shift()!;
        for (const floor of Object.values(replayState.tree.floors)) {
          if (floor.parentId === currentId && floor.branchId === targetFloor.branchId) {
            forgottenFloorIds.push(floor.id);
            queue.push(floor.id);
          }
        }
      }

      const draft: RuntimeEventDraft = {
        type: "rollback",
        cardId,
        sessionId,
        ts: Date.now(),
        payload: {
          toFloorId,
          forgottenFloorIds
        }
      };

      const event = await this.appendEvent(cardId, sessionId, draft);
      return event as RollbackEvent;
    });
  }

  async undoRollback(cardId: string, sessionId: string): Promise<UndoRollbackEvent> {
    return this.runSessionExclusive(cardId, sessionId, async () => {
      const log = this.getEventLog(cardId, sessionId);
      const allEvents = await log.readAll();

    // 从头重放事件日志（不使用快照）建立参照状态，精确计算最后一次 rollback 遗忘的楼层
    const tempTree: SerializedFloorTree = {
      id: sessionId,
      rootFloorId: null,
      activeBranchId: "main",
      floors: {},
      undoCheckpointFloorId: null
    };
    const tempState: StateSnapshot = {};
    let lastRollbackForgottenFloors: FloorMessage[] | null = null;
    let rollbackSeen = false;

    for (const ev of allEvents) {
      if (ev.type === "rollback") {
        rollbackSeen = true;
        // 在应用该 rollback 之前，从当前 tempTree 中深拷贝被本次 rollback 遗忘的楼层
        const forgotten: FloorMessage[] = [];
        for (const fId of ev.payload.forgottenFloorIds) {
          const fl = tempTree.floors[fId];
          if (fl) {
            forgotten.push(JSON.parse(JSON.stringify(fl)));
          }
        }
        lastRollbackForgottenFloors = forgotten;
      }

      this.applyEventToMemory(tempTree, tempState, () => {}, ev);
    }

    if (!rollbackSeen || !lastRollbackForgottenFloors) {
      throw new Error("No rollback event found to undo");
    }

    if (!tempTree.undoCheckpointFloorId) {
      throw new Error("No undo checkpoint available to restore");
    }

    const restoredFloors = JSON.parse(JSON.stringify(lastRollbackForgottenFloors)) as FloorMessage[];
    const restoredFloorIds = restoredFloors.map((f) => f.id);

    const draft: RuntimeEventDraft = {
      type: "undo_rollback",
      cardId,
      sessionId,
      ts: Date.now(),
      payload: {
        restoredFloorIds,
        restoredFloors
      }
    };

      const event = await this.appendEvent(cardId, sessionId, draft);
      return event as UndoRollbackEvent;
    });
  }

  async applyStateOp(
    cardId: string,
    sessionId: string,
    opInput: Omit<StateOp, "id" | "timestamp">
  ): Promise<StateOpEvent> {
    const fullOp: StateOp = {
      ...opInput,
      id: `op_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      timestamp: Date.now()
    };

    const draft: RuntimeEventDraft = {
      type: "state_op",
      cardId,
      sessionId,
      ts: Date.now(),
      payload: { op: fullOp }
    };

    const event = await this.appendEvent(cardId, sessionId, draft);
    return event as StateOpEvent;
  }

  async appendEvent(cardId: string, sessionId: string, draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const log = this.getEventLog(cardId, sessionId);
    return log.append(draft);
  }

  async readEvents(cardId: string, sessionId: string, fromSeq?: number): Promise<RuntimeEvent[]> {
    const log = this.getEventLog(cardId, sessionId);
    if (fromSeq !== undefined && fromSeq > 1) {
      return log.readFrom(fromSeq);
    }
    return log.readAll();
  }

  // ---------------------------------------------------------------------------
  // 重放与快照计算
  // ---------------------------------------------------------------------------

  async replay(cardId: string, sessionId: string, options?: { ignoreSnapshot?: boolean }): Promise<ReplayResult> {
    const snapStore = this.getSnapshotStore(cardId, sessionId);
    const latestSnapshot = options?.ignoreSnapshot ? null : await snapStore.latest();

    let tree: SerializedFloorTree;
    let state: StateSnapshot;
    let summary: string | null = null;
    let fromSeq = 1;
    let fromCheckpointSeq: number | null = null;

    if (latestSnapshot) {
      // 深拷贝以防快照对象受污染
      tree = JSON.parse(JSON.stringify(latestSnapshot.tree)) as SerializedFloorTree;
      state = JSON.parse(JSON.stringify(latestSnapshot.state)) as StateSnapshot;
      summary = latestSnapshot.summary;
      fromSeq = latestSnapshot.seq + 1;
      fromCheckpointSeq = latestSnapshot.seq;
    } else {
      tree = {
        id: sessionId,
        rootFloorId: null,
        activeBranchId: "main",
        floors: {},
        undoCheckpointFloorId: null
      };
      state = {};
      summary = null;
    }

    // 如果没有快照，从头读；如果有快照，只读快照之后的事件
    // 注意：若快照之前的事件发生过 floor_appended 且被 rollback，undo_rollback 可能需要跨快照恢复，
    // 因此当发生 undo_rollback 时若 archive 中缺失，会按需补充
    const log = this.getEventLog(cardId, sessionId);
    const events = await log.readFrom(fromSeq);

    // 顺序 apply 事件
    for (const ev of events) {
      this.applyEventToMemory(tree, state, (newSummary) => {
        summary = newSummary;
      }, ev);
    }

    const lastSeq = await log.lastSeq();

    return {
      tree,
      state,
      summary,
      lastSeq,
      replayedEvents: events,
      fromCheckpointSeq
    };
  }

  /**
   * 将单条事件应用至内存态（重放核心函数）
   */
  private applyEventToMemory(
    tree: SerializedFloorTree,
    state: StateSnapshot,
    setSummary: (s: string | null) => void,
    ev: RuntimeEvent
  ): void {
    switch (ev.type) {
      case "session_created": {
        // 重置/初始化
        if (!tree.rootFloorId && Object.keys(tree.floors).length === 0) {
          tree.activeBranchId = "main";
          tree.undoCheckpointFloorId = null;
        }
        break;
      }
      case "floor_appended": {
        const p = ev.payload;
        const newFloor: FloorMessage = {
          id: p.floorId,
          parentId: p.parentId,
          branchId: p.branchId,
          floorIndex: p.floorIndex,
          role: p.role,
          content: p.content,
          createdAt: ev.ts,
          updatedAt: ev.ts,
          swipes: [p.content],
          currentSwipeIndex: 0,
          editHistory: []
        };
        tree.floors[p.floorId] = newFloor;
        if (!tree.rootFloorId) {
          tree.rootFloorId = p.floorId;
        }
        tree.undoCheckpointFloorId = null;
        break;
      }
      case "floor_swiped": {
        const p = ev.payload;
        const target = tree.floors[p.floorId];
        if (target) {
          target.swipes.push(p.content);
          target.currentSwipeIndex = target.swipes.length - 1;
          target.content = p.content;
          target.updatedAt = ev.ts;
        }
        break;
      }
      case "floor_edited": {
        const p = ev.payload;
        const target = tree.floors[p.floorId];
        if (target) {
          target.editHistory = target.editHistory ?? [];
          target.editHistory.push({
            content: target.content,
            editedAt: ev.ts
          });
          target.content = p.content;
          if (target.swipes[target.currentSwipeIndex] !== undefined) {
            target.swipes[target.currentSwipeIndex] = p.content;
          }
          target.updatedAt = ev.ts;
        }
        break;
      }
      case "branch_switched": {
        tree.activeBranchId = ev.payload.branchId;
        break;
      }
      case "rollback": {
        const p = ev.payload;
        // 记录被遗忘楼层中 floorIndex 最深者作为 undoCheckpointFloorId
        // （旧实现取全局最大 floorIndex，可能指向其它分支的楼层——H-2 关联修正）
        let maxIndex = -1;
        let deepestId: string | null = null;
        for (const fId of p.forgottenFloorIds) {
          const f = tree.floors[fId];
          if (f && f.floorIndex > maxIndex) {
            maxIndex = f.floorIndex;
            deepestId = f.id;
          }
        }
        tree.undoCheckpointFloorId = deepestId;

        // 物理遗忘对应楼层
        for (const fId of p.forgottenFloorIds) {
          delete tree.floors[fId];
        }
        break;
      }
      case "undo_rollback": {
        const p = ev.payload;
        if (!p.restoredFloors || !Array.isArray(p.restoredFloors)) {
          throw new Error("undo_rollback event missing required payload.restoredFloors");
        }
        const floorIdSet = new Set(p.restoredFloors.map((f) => f.id));
        const declaredIdSet = new Set(p.restoredFloorIds ?? []);
        if (
          floorIdSet.size !== declaredIdSet.size ||
          ![...floorIdSet].every((id) => declaredIdSet.has(id))
        ) {
          throw new Error(
            `undo_rollback payload mismatch between restoredFloors and restoredFloorIds: [${[...floorIdSet].join(", ")}] vs [${[...declaredIdSet].join(", ")}]`
          );
        }

        // 只依赖 restoredFloors 恢复楼层
        for (const fl of p.restoredFloors) {
          tree.floors[fl.id] = JSON.parse(JSON.stringify(fl));
        }
        tree.undoCheckpointFloorId = null;
        break;
      }
      case "state_op": {
        // H-1 修复：物理遗忘——op 所属楼层已被 rollback 删除时，其状态变更不得存活。
        // （旧实现无条件 apply，回退后被遗忘楼层的状态仍进入投影与组装。）
        if (ev.payload.op.floorId && !tree.floors[ev.payload.op.floorId]) {
          break;
        }
        const nextState = applyStateOp(state, ev.payload.op);
        // 清空原对象并复制新键值
        for (const k of Object.keys(state)) {
          delete state[k];
        }
        Object.assign(state, nextState);
        break;
      }
      case "summary_updated": {
        // H-3 修复：摘要锚定楼（upToFloorId）已被遗忘时，摘要随之失效置空，
        // 防止被回退掉的"未来剧情"经摘要重新进入组装。
        if (ev.payload.upToFloorId && !tree.floors[ev.payload.upToFloorId]) {
          setSummary(null);
          break;
        }
        setSummary(ev.payload.summary);
        break;
      }
      // 管家事件与 run_* 事件只记录过程，重放时不改变投影
      case "butler_extracted":
      case "butler_degraded":
      case "run_created":
      case "run_started":
      case "run_delta":
      case "run_completed":
      case "run_cancelled":
      case "run_failed":
      case "checkpoint": {
        // 重放时忽略，不抛错
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 导入与导出
  // ---------------------------------------------------------------------------

  async exportCard(cardId: string): Promise<ExportBundle> {
    assertSafeId(cardId, "cardId");
    const { meta, original, workingCopy } = await this.readCard(cardId);
    const sessionIds = await this.listSessions(cardId);

    const sessions: Array<{ sessionId: string; events: RuntimeEvent[] }> = [];
    for (const sId of sessionIds) {
      const events = await this.readEvents(cardId, sId);
      sessions.push({
        sessionId: sId,
        events
      });
    }

    // P1 导入保全：ST 资产随包往返（original/compat/worldbook 任一存在即携带 st 段）
    const [stOriginal, stCompat, stWorldbook] = await Promise.all([
      this.readStOriginal(cardId),
      this.readStCompatReport(cardId),
      this.readWorldbook(cardId)
    ]);
    const st =
      stOriginal !== null || stCompat !== null || stWorldbook !== null
        ? {
            original: stOriginal ?? undefined,
            compatReport: stCompat ?? undefined,
            worldbook: stWorldbook ?? undefined
          }
        : undefined;

    return {
      bundleVersion: EXPORT_BUNDLE_VERSION,
      exportedAt: Date.now(),
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      meta,
      character: {
        original,
        workingCopy
      },
      sessions,
      st
    };
  }

  async importCard(bundle: ExportBundle, opts?: { newCardId?: string }): Promise<{ cardId: string }> {
    const targetCardId = opts?.newCardId ?? bundle.meta.cardId;
    assertSafeId(targetCardId, "cardId");

    const targetDir = cardDir(this.home, targetCardId);
    try {
      await fs.access(targetDir);
      throw new Error(`Target card directory already exists: ${targetCardId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    await ensureDir(targetDir);
    const now = Date.now();

    const newMeta: CardMeta = {
      ...bundle.meta,
      cardId: targetCardId,
      updatedAt: now
    };

    const cardPayload: CardJsonData = {
      original: bundle.character.original,
      workingCopy: bundle.character.workingCopy
    };

    await writeJsonAtomic(cardMetaPath(this.home, targetCardId), newMeta);
    await writeJsonAtomic(cardPayloadPath(this.home, targetCardId), cardPayload);
    await ensureDir(sessionsBaseDir(this.home, targetCardId));

    // P1 导入保全：ST 资产恢复（原版/兼容报告/世界书 verbatim 往返）
    if (bundle.st) {
      if (bundle.st.original !== undefined) {
        await writeJsonAtomic(cardOriginalPath(this.home, targetCardId), bundle.st.original);
      }
      if (bundle.st.compatReport !== undefined) {
        await writeJsonAtomic(cardCompatPath(this.home, targetCardId), bundle.st.compatReport);
      }
      if (bundle.st.worldbook !== undefined) {
        await writeJsonAtomic(cardWorldbookPath(this.home, targetCardId), bundle.st.worldbook);
      }
    }

    // 导入会话与事件
    for (const sess of bundle.sessions) {
      const sId = sess.sessionId;
      assertSafeId(sId, "sessionId");
      const sDir = sessionDir(this.home, targetCardId, sId);
      await ensureDir(sDir);
      await ensureDir(snapshotsDir(this.home, targetCardId, sId));

      const evPath = eventsPath(this.home, targetCardId, sId);
      let content = "";
      for (const ev of sess.events) {
        // 重写 cardId 为导入目标卡 ID
        const normalized: RuntimeEvent = {
          ...ev,
          cardId: targetCardId
        };
        content += JSON.stringify(normalized) + "\n";
      }

      if (content.length > 0) {
        // M-4：事件日志写入必须原子化——fs.writeFile 中途崩溃会留下半行 JSONL，
        // 重放时整文件损坏。writeAtomic 走 temp+rename，读者永远看到完整文件。
        await writeAtomic(evPath, content);
      }
    }

    return { cardId: targetCardId };
  }

  // ---------------------------------------------------------------------------
  // ST 卡导入（P1 导入保全：原版 verbatim + 世界书 + 兼容报告 + 工作副本）
  // ---------------------------------------------------------------------------

  /**
   * 导入 SillyTavern v1/v2/v3 卡。
   * 落盘五件套：card.json（工作副本）/ original.json（不可变原版 verbatim）/
   * worldbook.json（character_book 投影）/ compat.json（字段级兼容报告）/ meta.json。
   * 原版 JSON 原样字节保全（JSON.stringify 宽松往返：对象键序保留，仅空白差异），
   * 重导出时对 original.json 与导入源做结构恒等（deep-equal）验证——零字段丢失红线的实现。
   */
  async importStCard(
    jsonRaw: unknown,
    opts?: { cardId?: string }
  ): Promise<{ cardId: string; compatReport: StCompatReport; worldbookEntries: number }> {
    const imported = importSillyTavernV2Card(jsonRaw);

    const cId = opts?.cardId ?? `card_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    assertSafeId(cId, "cardId");
    const targetDir = cardDir(this.home, cId);
    try {
      await fs.access(targetDir);
      throw new Error(`Target card directory already exists: ${cId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const now = Date.now();
    const meta: CardMeta = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      cardId: cId,
      name: imported.attributes.name || cId,
      createdAt: now,
      updatedAt: now
    };
    const cardData: CardJsonData = {
      original: imported.attributes,
      workingCopy: imported.attributes
    };
    const worldbook: Worldbook | null = imported.worldbookEntries.length > 0
      ? {
          id: cId,
          name: imported.worldbookName ?? imported.attributes.name,
          entries: imported.worldbookEntries
        }
      : null;

    await ensureDir(targetDir);
    await ensureDir(sessionsBaseDir(this.home, cId));
    await writeJsonAtomic(cardMetaPath(this.home, cId), meta);
    await writeJsonAtomic(cardPayloadPath(this.home, cId), cardData);
    await writeJsonAtomic(cardOriginalPath(this.home, cId), jsonRaw);
    await writeJsonAtomic(cardCompatPath(this.home, cId), imported.compatReport);
    if (worldbook) {
      await writeJsonAtomic(cardWorldbookPath(this.home, cId), worldbook);
    }

    return { cardId: cId, compatReport: imported.compatReport, worldbookEntries: imported.worldbookEntries.length };
  }

  /** 读取不可变原版 JSON（无原版的 AIRP 原生卡返回 null）。 */
  async readStOriginal(cardId: string): Promise<unknown | null> {
    assertSafeId(cardId, "cardId");
    try {
      return await readJson<unknown>(cardOriginalPath(this.home, cardId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 读取兼容报告（非 ST 导入卡返回 null）。 */
  async readStCompatReport(cardId: string): Promise<StCompatReport | null> {
    assertSafeId(cardId, "cardId");
    try {
      return await readJson<StCompatReport>(cardCompatPath(this.home, cardId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** 读取世界书（无世界书卡返回 null）。 */
  async readWorldbook(cardId: string): Promise<Worldbook | null> {
    assertSafeId(cardId, "cardId");
    try {
      return await readJson<Worldbook>(cardWorldbookPath(this.home, cardId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // 版本迁移
  // ---------------------------------------------------------------------------

  async migrate(cardId: string): Promise<{ from: number; to: number; backupPath: string | null }> {
    return migrateCard(this.home, cardId);
  }
}
