// tests/runtime/server/fakes.ts
// 用于测试服务器骨架的内存门面 Fake 实现。
import type {
  CardStoreFacade,
  RunManagerFacade,
  CardSummary,
  CardMeta,
  ExportBundle,
  ReplayResult,
  StartRunInput,
  RunRecord,
  RunEventSink,
  RuntimeEvent,
  RuntimeEventDraft,
  FloorAppendedEvent,
  FloorSwipedEvent,
  FloorEditedEvent,
  RollbackEvent,
  UndoRollbackEvent,
  StateOpEvent,
} from "../../../src/runtime/contracts.js";
import type { CharacterAttributes } from "../../../src/core/types/character.js";
import type { Role } from "../../../src/core/types/floor-tree.js";
import type { StateOp } from "../../../src/core/types/state.js";
export class FakeCardStore implements CardStoreFacade {
  readonly home: string;
  private cards: Map<string, { meta: CardMeta; original: CharacterAttributes; workingCopy: CharacterAttributes }> = new Map();
  private sessions: Map<string, { cardId: string; events: RuntimeEvent[] }> = new Map();

  constructor(home: string) {
    this.home = home;
  }

  async listCards(): Promise<CardSummary[]> {
    return Array.from(this.cards.entries()).map(([cardId, item]) => ({
      cardId,
      name: item.original.name,
      description: item.original.description ?? "",
      tags: item.original.tags ?? [],
      sessionCount: Array.from(this.sessions.values()).filter((s) => s.cardId === cardId).length,
      createdAt: item.meta.createdAt,
      updatedAt: item.meta.updatedAt,
    }));
  }

  async createCard(input: { cardId?: string; attributes: CharacterAttributes }): Promise<{ cardId: string }> {
    const cardId = input.cardId ?? `card_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = Date.now();
    const meta: CardMeta = {
      cardId,
      schemaVersion: 1,
      createdAt: now,
      updatedAt: now,
      totalSessions: 0,
      activeSessionId: null,
    };
    this.cards.set(cardId, {
      meta,
      original: { ...input.attributes },
      workingCopy: { ...input.attributes },
    });
    return { cardId };
  }

  async readCard(cardId: string): Promise<{ meta: CardMeta; original: CharacterAttributes; workingCopy: CharacterAttributes }> {
    const item = this.cards.get(cardId);
    if (!item) {
      throw new Error(`Card not found: ${cardId}`);
    }
    return item;
  }

  async createSession(cardId: string, sessionId?: string): Promise<{ sessionId: string }> {
    if (!this.cards.has(cardId)) {
      throw new Error(`Card not found: ${cardId}`);
    }
    const sid = sessionId ?? `session_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this.sessions.set(sid, { cardId, events: [] });
    return { sessionId: sid };
  }

  async listSessions(cardId: string): Promise<string[]> {
    return Array.from(this.sessions.entries())
      .filter(([_, s]) => s.cardId === cardId)
      .map(([sid]) => sid);
  }

  async appendFloor(
    cardId: string,
    sessionId: string,
    input: { role: Role; content: string; parentId?: string | null }
  ): Promise<FloorAppendedEvent> {
    const ev: FloorAppendedEvent = {
      id: `ev_${Date.now()}`,
      seq: 1,
      timestamp: Date.now(),
      type: "floor_appended",
      payload: {
        floorId: `floor_${Date.now()}`,
        parentId: input.parentId ?? null,
        message: {
          role: input.role,
          content: input.content,
          timestamp: Date.now(),
        },
      },
    };
    const sess = this.sessions.get(sessionId);
    if (sess) sess.events.push(ev);
    return ev;
  }

  async swipeFloor(cardId: string, sessionId: string, input: { floorId: string; content: string }): Promise<FloorSwipedEvent> {
    const ev: FloorSwipedEvent = {
      id: `ev_${Date.now()}`,
      seq: 1,
      timestamp: Date.now(),
      type: "floor_swiped",
      payload: { floorId: input.floorId, variantIndex: 1, content: input.content },
    };
    return ev;
  }

  async editFloor(cardId: string, sessionId: string, input: { floorId: string; content: string }): Promise<FloorEditedEvent> {
    const ev: FloorEditedEvent = {
      id: `ev_${Date.now()}`,
      seq: 1,
      timestamp: Date.now(),
      type: "floor_edited",
      payload: { floorId: input.floorId, content: input.content },
    };
    return ev;
  }

  async rollback(cardId: string, sessionId: string, toFloorId: string): Promise<RollbackEvent> {
    const ev: RollbackEvent = {
      id: `ev_${Date.now()}`,
      seq: 1,
      timestamp: Date.now(),
      type: "rollback",
      payload: { toFloorId, previousHead: "floor_0" },
    };
    return ev;
  }

  async undoRollback(cardId: string, sessionId: string): Promise<UndoRollbackEvent> {
    const ev: UndoRollbackEvent = {
      id: `ev_${Date.now()}`,
      seq: 1,
      timestamp: Date.now(),
      type: "undo_rollback",
      payload: { restoredHead: "floor_1" },
    };
    return ev;
  }

  async applyStateOp(cardId: string, sessionId: string, op: Omit<StateOp, "id" | "timestamp">): Promise<StateOpEvent> {
    const ev: StateOpEvent = {
      id: `ev_${Date.now()}`,
      seq: 1,
      timestamp: Date.now(),
      type: "state_op",
      payload: {
        op: {
          ...op,
          id: `op_${Date.now()}`,
          timestamp: Date.now(),
        } as StateOp,
      },
    };
    return ev;
  }

  async appendEvent(cardId: string, sessionId: string, draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    const sess = this.sessions.get(sessionId);
    const seq = (sess?.events.length ?? 0) + 1;
    const ev: RuntimeEvent = {
      ...draft,
      id: `ev_${seq}`,
      seq,
    } as RuntimeEvent;
    sess?.events.push(ev);
    return ev;
  }

  async replay(cardId: string, sessionId: string): Promise<ReplayResult> {
    const sess = this.sessions.get(sessionId);
    if (!sess) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return {
      tree: {
        rootId: "root",
        currentId: "root",
        nodes: {},
      },
      state: {},
      lastSeq: sess.events.length,
      snapshotSeq: 0,
    };
  }

  async exportCard(cardId: string): Promise<ExportBundle> {
    const card = this.cards.get(cardId);
    if (!card) {
      throw new Error(`Card not found: ${cardId}`);
    }
    return {
      version: 1,
      exportedAt: Date.now(),
      meta: card.meta,
      original: card.original,
      workingCopy: card.workingCopy,
      sessions: Array.from(this.sessions.entries())
        .filter(([_, s]) => s.cardId === cardId)
        .map(([sid, s]) => ({ sessionId: sid, events: s.events })),
    };
  }

  async importCard(bundle: ExportBundle, opts?: { newCardId?: string }): Promise<{ cardId: string }> {
    const cardId = opts?.newCardId ?? bundle.meta.cardId;
    this.cards.set(cardId, {
      meta: { ...bundle.meta, cardId },
      original: bundle.original,
      workingCopy: bundle.workingCopy,
    });
    for (const s of bundle.sessions) {
      this.sessions.set(s.sessionId, { cardId, events: s.events });
    }
    return { cardId };
  }

  async migrate(cardId: string): Promise<{ from: number; to: number; backupPath: string | null }> {
    return { from: 1, to: 1, backupPath: null };
  }
}

export class FakeRunManager implements RunManagerFacade {
  private runs: Map<string, RunRecord> = new Map();
  private events: Map<string, RuntimeEvent[]> = new Map();
  public unsubscribeCalls = 0;
  public onUnsubscribeCallback?: () => void;
  public subscribers: Map<string, Set<RunEventSink>> = new Map();

  async startRun(input: StartRunInput): Promise<RunRecord> {
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const record: RunRecord = {
      runId,
      cardId: input.cardId,
      sessionId: input.sessionId,
      status: "running",
      model: input.model ?? "mock-model",
      prompt: input.prompt,
      createdAt: Date.now(),
      startedAt: Date.now(),
      endedAt: null,
      text: "",
      lastSeq: 0,
    };
    this.runs.set(runId, record);
    this.events.set(runId, []);
    return record;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async listRuns(cardId: string, sessionId: string): Promise<RunRecord[]> {
    return Array.from(this.runs.values()).filter(
      (r) => r.cardId === cardId && r.sessionId === sessionId
    );
  }

  async cancelRun(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
      return false;
    }
    run.status = "cancelled";
    run.endedAt = Date.now();
    run.cancelReason = "user_cancelled";
    return true;
  }

  addEventForRun(runId: string, event: RuntimeEvent) {
    const evs = this.events.get(runId) ?? [];
    evs.push(event);
    this.events.set(runId, evs);
    const run = this.runs.get(runId);
    if (run) {
      run.lastSeq = Math.max(run.lastSeq, event.seq);
    }
    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const sink of subs) {
        sink.onEvent(event);
      }
    }
  }

  finishRun(runId: string, finalRecord?: Partial<RunRecord>) {
    const run = this.runs.get(runId);
    if (!run) return;
    Object.assign(run, {
      status: "completed",
      endedAt: Date.now(),
      ...finalRecord,
    });
    const subs = this.subscribers.get(runId);
    if (subs) {
      for (const sink of subs) {
        sink.onEnd(run);
      }
    }
  }

  async subscribe(runId: string, fromSeq: number, sink: RunEventSink): Promise<() => void> {
    const run = this.runs.get(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    const pastEvents = (this.events.get(runId) ?? []).filter((e) => e.seq > fromSeq);
    for (const ev of pastEvents) {
      sink.onEvent(ev);
    }

    if (run.status === "completed" || run.status === "cancelled" || run.status === "failed") {
      sink.onEnd(run);
      return () => {
        this.unsubscribeCalls++;
      };
    }

    let subs = this.subscribers.get(runId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(runId, subs);
    }
    subs.add(sink);

    return () => {
      this.unsubscribeCalls++;
      subs?.delete(sink);
      this.onUnsubscribeCallback?.();
    };
  }

  async recoverOnBoot(): Promise<RunRecord[]> {
    return [];
  }
}
