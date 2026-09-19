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
  assertSafeId
} from "./paths.js";
import { ensureDir, writeJsonAtomic, readJson } from "./fs-atomic.js";
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

  constructor(customHome?: string, snapshotInterval = DEFAULT_SNAPSHOT_INTERVAL) {
    this.home = customHome ? path.resolve(customHome) : resolveAirpHome();
    this.snapshotInterval = snapshotInterval;
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
   * 触发生成快照并持久化到 snapshot-store
   */
  private async createCheckpointInternal(cardId: string, sessionId: string): Promise<SessionCheckpoint> {
    const replayRes = await this.replay(cardId, sessionId);
    const snapStore = this.getSnapshotStore(cardId, sessionId);
    const checkpoint: SessionCheckpoint = {
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      cardId,
      sessionId,
      seq: replayRes.lastSeq,
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
  }

  async swipeFloor(
    cardId: string,
    sessionId: string,
    input: { floorId: string; content: string }
  ): Promise<FloorSwipedEvent> {
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
  }

  async editFloor(
    cardId: string,
    sessionId: string,
    input: { floorId: string; content: string }
  ): Promise<FloorEditedEvent> {
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
  }

  async rollback(cardId: string, sessionId: string, toFloorId: string): Promise<RollbackEvent> {
    const replayState = await this.replay(cardId, sessionId);
    const targetFloor = replayState.tree.floors[toFloorId];
    if (!targetFloor) {
      throw new Error(`Floor not found for rollback: ${toFloorId}`);
    }

    // 收集所有被遗忘的楼层 ID（比目标楼层 floorIndex 更大的所有楼层）
    const forgottenFloorIds: string[] = [];
    for (const floor of Object.values(replayState.tree.floors)) {
      if (floor.floorIndex > targetFloor.floorIndex) {
        forgottenFloorIds.push(floor.id);
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
  }

  async undoRollback(cardId: string, sessionId: string): Promise<UndoRollbackEvent> {
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
    setSummary: (s: string) => void,
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
        // 记录最新楼层作为 undoCheckpointFloorId
        let maxIndex = -1;
        let latestId: string | null = null;
        for (const f of Object.values(tree.floors)) {
          if (f.floorIndex > maxIndex) {
            maxIndex = f.floorIndex;
            latestId = f.id;
          }
        }
        tree.undoCheckpointFloorId = latestId;

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
        const nextState = applyStateOp(state, ev.payload.op);
        // 清空原对象并复制新键值
        for (const k of Object.keys(state)) {
          delete state[k];
        }
        Object.assign(state, nextState);
        break;
      }
      case "summary_updated": {
        setSummary(ev.payload.summary);
        break;
      }
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

    return {
      bundleVersion: EXPORT_BUNDLE_VERSION,
      exportedAt: Date.now(),
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      meta,
      character: {
        original,
        workingCopy
      },
      sessions
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
        await fs.writeFile(evPath, content, "utf-8");
      }
    }

    return { cardId: targetCardId };
  }

  // ---------------------------------------------------------------------------
  // 版本迁移
  // ---------------------------------------------------------------------------

  async migrate(cardId: string): Promise<{ from: number; to: number; backupPath: string | null }> {
    return migrateCard(this.home, cardId);
  }
}
