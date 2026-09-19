// src/runtime/session/run-manager.ts
// Run 状态机、生成生命周期、增量节流、优雅取消、reattach 订阅与崩溃恢复实现。

import crypto from "node:crypto";
import type {
  CardStoreFacade,
  ModelStreamPort,
  RunManagerFacade,
  RunRecord,
  StartRunInput,
  RunEventSink,
  RuntimeEvent,
  TokenUsage
} from "../contracts.js";
import { RunStore } from "./run-store.js";
import { MockModelPort } from "./mock-port.js";
import { assertSafeId } from "../paths.js";

/** 增量节流策略参数 */
export interface ThrottleConfig {
  /** 最大等待毫秒数，默认 150ms */
  intervalMs?: number;
  /** 最大累积文本字节/字符数，默认 4KB (4096) */
  maxChunkSize?: number;
}

interface ActiveRunContext {
  record: RunRecord;
  abortController: AbortController;
  subscribers: Set<RunEventSink>;
  pendingBuffer: string;
  flushTimer: NodeJS.Timeout | null;
  /** 保证同一 Run 内部写事件严格串行，按序递增 lastSeq */
  writeQueue: Promise<void>;
  /** 生成完成或中止时的 Promise */
  completionPromise: Promise<RunRecord>;
}

export class RunManager implements RunManagerFacade {
  readonly cardStore: CardStoreFacade;
  readonly modelPort: ModelStreamPort;
  readonly runStore: RunStore;
  private readonly throttleIntervalMs: number;
  private readonly throttleMaxChunkSize: number;

  /** 内存活跃 Run 上下文映射 (runId -> ActiveRunContext) */
  private readonly activeRuns = new Map<string, ActiveRunContext>();
  /** 索引：runId -> { cardId, sessionId }，用于加快 getRun 查找未激活时的磁盘位置 */
  private readonly runLocations = new Map<string, { cardId: string; sessionId: string }>();

  constructor(
    cardStore: CardStoreFacade,
    modelPort?: ModelStreamPort,
    throttleConfig?: ThrottleConfig
  ) {
    this.cardStore = cardStore;
    this.modelPort = modelPort ?? new MockModelPort();
    this.runStore = new RunStore(cardStore.home);
    this.throttleIntervalMs = throttleConfig?.intervalMs ?? 150;
    this.throttleMaxChunkSize = throttleConfig?.maxChunkSize ?? 4096;
  }

  async startRun(input: StartRunInput): Promise<RunRecord> {
    assertSafeId(input.cardId, "cardId");
    assertSafeId(input.sessionId, "sessionId");

    const runId = crypto.randomUUID();
    const model = input.model ?? "mock-model";
    const now = Date.now();

    const record: RunRecord = {
      runId,
      cardId: input.cardId,
      sessionId: input.sessionId,
      status: "queued",
      model,
      prompt: input.prompt,
      createdAt: now,
      startedAt: null,
      endedAt: null,
      text: "",
      lastSeq: 0
    };

    this.runLocations.set(runId, { cardId: input.cardId, sessionId: input.sessionId });

    // 1. write-ahead: 先落盘 run_created 事件与 run.json
    const createdEvent = await this.cardStore.appendEvent(record.cardId, record.sessionId, {
      cardId: record.cardId,
      sessionId: record.sessionId,
      ts: now,
      type: "run_created",
      payload: { runId, model }
    });
    record.lastSeq = createdEvent.seq;
    await this.runStore.save(record);

    // 2. 状态迁为 running：先写 run_started 事件，再改内存与磁盘
    record.status = "running";
    record.startedAt = Date.now();
    const startedEvent = await this.cardStore.appendEvent(record.cardId, record.sessionId, {
      cardId: record.cardId,
      sessionId: record.sessionId,
      ts: record.startedAt,
      type: "run_started",
      payload: { runId }
    });
    record.lastSeq = startedEvent.seq;
    await this.runStore.save(record);

    const abortController = new AbortController();
    const subscribers = new Set<RunEventSink>();

    const context: ActiveRunContext = {
      record,
      abortController,
      subscribers,
      pendingBuffer: "",
      flushTimer: null,
      writeQueue: Promise.resolve(),
      // completionPromise 下方初始化
      completionPromise: Promise.resolve(record)
    };

    // 启动后台流式处理
    const completionPromise = this.executeStream(context, input);
    context.completionPromise = completionPromise;

    this.activeRuns.set(runId, context);

    // 广播初始事件（若已存在订阅者）
    this.broadcastEvent(context, createdEvent);
    this.broadcastEvent(context, startedEvent);

    return record;
  }

  private async executeStream(context: ActiveRunContext, input: StartRunInput): Promise<RunRecord> {
    const { record, abortController } = context;

    try {
      const stream = this.modelPort.stream({
        model: record.model,
        // ChatEngine 已完成组装：messages 是完整消息序列（system 前缀+历史+最新输入）。
        // 未提供时退回裸 prompt（仅底层测试/探针直连场景）。
        messages: input.messages ?? [{ role: "user", content: input.prompt }],
        abortSignal: abortController.signal
      });

      for await (const chunk of stream) {
        if (chunk.type === "start") {
          // start 信号已在 run_started 中表达
          continue;
        } else if (chunk.type === "text_delta") {
          context.pendingBuffer += chunk.text;
          record.text += chunk.text;

          // 节流判定：达到 4KB 则立即 flush
          if (context.pendingBuffer.length >= this.throttleMaxChunkSize) {
            this.clearFlushTimer(context);
            await this.flushPendingText(context);
          } else if (!context.flushTimer) {
            // 设置 150ms 定时器
            context.flushTimer = setTimeout(() => {
              context.flushTimer = null;
              void this.flushPendingText(context);
            }, this.throttleIntervalMs);
          }
        } else if (chunk.type === "done") {
          // 正常完成
          this.clearFlushTimer(context);
          await this.flushPendingText(context);
          await this.transitionTerminal(context, "completed", { usage: chunk.usage });
          return record;
        } else if (chunk.type === "error") {
          // 模型端抛出错误 chunk
          throw new Error(chunk.error);
        }
      }

      // 如果生成器无 done chunk 即耗尽，也视作完成并 flush
      this.clearFlushTimer(context);
      await this.flushPendingText(context);
      if (record.status === "running") {
        await this.transitionTerminal(context, "completed");
      }
    } catch (err: unknown) {
      this.clearFlushTimer(context);
      // 无论如何，在终态前 flush 未落盘的残余文本
      await this.flushPendingText(context);

      const isAborted =
        abortController.signal.aborted ||
        (err instanceof Error &&
          (err.name === "AbortError" ||
            err.message.includes("aborted") ||
            err.message.includes("Request aborted")));

      if (isAborted) {
        await this.transitionTerminal(context, "cancelled", {
          cancelReason: record.cancelReason ?? "User cancelled"
        });
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await this.transitionTerminal(context, "failed", { error: errorMsg });
      }
    } finally {
      this.activeRuns.delete(record.runId);
      // 触发所有订阅者的 onEnd 回调
      for (const sink of context.subscribers) {
        try {
          sink.onEnd(record);
        } catch {
          // 忽略下游 sink 异常
        }
      }
      context.subscribers.clear();
    }

    return record;
  }

  /**
   * 刷新累积未落盘的文本，生成 run_delta 事件并落盘
   */
  private flushPendingText(context: ActiveRunContext): Promise<void> {
    const textToFlush = context.pendingBuffer;
    if (textToFlush.length === 0) {
      return context.writeQueue;
    }
    context.pendingBuffer = "";

    const { record } = context;
    context.writeQueue = context.writeQueue.then(async () => {
      try {
        const deltaEvent = await this.cardStore.appendEvent(record.cardId, record.sessionId, {
          cardId: record.cardId,
          sessionId: record.sessionId,
          ts: Date.now(),
          type: "run_delta",
          payload: { runId: record.runId, text: textToFlush }
        });
        record.lastSeq = deltaEvent.seq;
        // 磁盘上 RunRecord.text 与事件日志严格同步
        const diskRecord = { ...record };
        // 从已落盘事件或维护已落盘文本
        await this.runStore.save(diskRecord);
        this.broadcastEvent(context, deltaEvent);
      } catch (err) {
        // 写入失败时，若尚未终态，可重新塞回 pendingBuffer 尝试
        context.pendingBuffer = textToFlush + context.pendingBuffer;
        throw err;
      }
    });

    return context.writeQueue;
  }

  private clearFlushTimer(context: ActiveRunContext): void {
    if (context.flushTimer) {
      clearTimeout(context.flushTimer);
      context.flushTimer = null;
    }
  }

  /**
   * 向终态迁移：先排入 writeQueue 写终态事件，再修改内存与持久化
   */
  private transitionTerminal(
    context: ActiveRunContext,
    status: "completed" | "cancelled" | "failed",
    extra?: { usage?: TokenUsage; cancelReason?: string; error?: string }
  ): Promise<void> {
    const { record } = context;
    context.writeQueue = context.writeQueue.then(async () => {
      if (record.status !== "running" && record.status !== "queued") {
        return;
      }

      record.status = status;
      record.endedAt = Date.now();
      if (extra?.usage) record.usage = extra.usage;
      if (extra?.cancelReason) record.cancelReason = extra.cancelReason;
      if (extra?.error) record.error = extra.error;

      let terminalEvent: RuntimeEvent;
      if (status === "completed") {
        terminalEvent = await this.cardStore.appendEvent(record.cardId, record.sessionId, {
          cardId: record.cardId,
          sessionId: record.sessionId,
          ts: record.endedAt ?? Date.now(),
          type: "run_completed",
          payload: { runId: record.runId, text: record.text, usage: record.usage }
        });
      } else if (status === "cancelled") {
        terminalEvent = await this.cardStore.appendEvent(record.cardId, record.sessionId, {
          cardId: record.cardId,
          sessionId: record.sessionId,
          ts: record.endedAt ?? Date.now(),
          type: "run_cancelled",
          payload: { runId: record.runId, reason: record.cancelReason }
        });
      } else {
        terminalEvent = await this.cardStore.appendEvent(record.cardId, record.sessionId, {
          cardId: record.cardId,
          sessionId: record.sessionId,
          ts: record.endedAt ?? Date.now(),
          type: "run_failed",
          payload: { runId: record.runId, error: record.error ?? "Unknown error" }
        });
      }
      record.lastSeq = terminalEvent.seq;
      await this.runStore.save(record);
      this.broadcastEvent(context, terminalEvent);
    });

    return context.writeQueue;
  }

  private broadcastEvent(context: ActiveRunContext, event: RuntimeEvent): void {
    for (const sink of context.subscribers) {
      try {
        sink.onEvent(event);
      } catch {
        // 隔离下游订阅者的回调错误
      }
    }
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const active = this.activeRuns.get(runId);
    if (active) {
      return { ...active.record };
    }
    let diskRecord: RunRecord | null = null;
    const loc = this.runLocations.get(runId);
    if (loc) {
      diskRecord = await this.runStore.load(loc.cardId, loc.sessionId, runId);
    }

    if (!diskRecord) {
      // 若无位置索引，全卡扫描加载并更新索引
      const all = await this.runStore.listAllRuns();
      for (const r of all) {
        this.runLocations.set(r.runId, { cardId: r.cardId, sessionId: r.sessionId });
        if (r.runId === runId) {
          diskRecord = r;
          break;
        }
      }
    }

    if (diskRecord) {
      // 从事件日志重放获取权威 text
      const events = await this.cardStore.readEvents(diskRecord.cardId, diskRecord.sessionId, 1);
      const deltas = events.filter((ev) => {
        if (ev.type === "run_delta" && "payload" in ev && ev.payload && typeof ev.payload === "object" && "runId" in ev.payload) {
          return ev.payload.runId === runId;
        }
        return false;
      });
      const replayedText = deltas.map((d) => (d as unknown as { payload: { text: string } }).payload.text).join("");
      if (replayedText.length > 0) {
        diskRecord.text = replayedText;
      }
      return diskRecord;
    }

    return null;
  }

  async listRuns(cardId: string, sessionId: string): Promise<RunRecord[]> {
    assertSafeId(cardId, "cardId");
    assertSafeId(sessionId, "sessionId");

    const diskRecords = await this.runStore.list(cardId, sessionId);
    return diskRecords.map((r) => {
      const active = this.activeRuns.get(r.runId);
      return active ? { ...active.record } : r;
    });
  }

  async cancelRun(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (!active) {
      // 若非活跃中（已在磁盘为终态），不可取消
      return false;
    }

    if (active.record.status !== "running" && active.record.status !== "queued") {
      return false;
    }

    active.record.cancelReason = active.record.cancelReason ?? "User cancelled";
    active.abortController.abort();
    try {
      await active.completionPromise;
    } catch {
      // 忽略中断传播
    }

    return true;
  }

  async subscribe(runId: string, fromSeq: number, sink: RunEventSink): Promise<() => void> {
    // 1. 获取 Run 基础元数据以确认 cardId 与 sessionId
    let record = await this.getRun(runId);
    if (!record) {
      throw new Error(`Run not found: ${runId}`);
    }

    // 2. 区分当前是否为内存活跃 Run
    const active = this.activeRuns.get(runId);

    // 3. 核心设计：重放事件日志中属于该 Run 的历史事件（seq > fromSeq）
    // 读取历史事件并按 seq 升序过滤出属于当前 runId 的事件
    const allEvents = await this.cardStore.readEvents(record.cardId, record.sessionId, fromSeq + 1);
    const runEvents = allEvents.filter((ev) => {
      if ("payload" in ev && ev.payload && typeof ev.payload === "object" && "runId" in ev.payload) {
        return ev.payload.runId === runId;
      }
      return false;
    });

    let lastDeliveredSeq = fromSeq;
    for (const ev of runEvents) {
      sink.onEvent(ev);
      lastDeliveredSeq = Math.max(lastDeliveredSeq, ev.seq);
    }

    // 4. 若 Run 已在终态，重放完成后立即触发 onEnd，返回 no-op
    if (!active || (active.record.status !== "running" && active.record.status !== "queued")) {
      // 重新读取一次最新 record（可能在重放期间终态已更新）
      const finalRecord = (await this.getRun(runId)) ?? record;
      sink.onEnd(finalRecord);
      return () => {};
    }

    // 5. 若 Run 仍活跃，挂入实时订阅表；为了防止重放与实时订阅之间的空洞或重复，封装过滤 wrapper
    let unsubscribed = false;
    const liveSink: RunEventSink = {
      onEvent: (ev: RuntimeEvent) => {
        if (unsubscribed) return;
        if (ev.seq > lastDeliveredSeq) {
          lastDeliveredSeq = ev.seq;
          sink.onEvent(ev);
        }
      },
      onEnd: (finalRecord: RunRecord) => {
        if (unsubscribed) return;
        sink.onEnd(finalRecord);
      }
    };

    active.subscribers.add(liveSink);

    // 检查挂上之前是否恰好 Run 结束
    if (active.record.status !== "running" && active.record.status !== "queued") {
      active.subscribers.delete(liveSink);
      if (!unsubscribed) {
        sink.onEnd(active.record);
      }
      return () => {};
    }

    return () => {
      unsubscribed = true;
      active.subscribers.delete(liveSink);
    };
  }

  async recoverOnBoot(): Promise<RunRecord[]> {
    const allRuns = await this.runStore.listAllRuns();
    const interruptedRuns: RunRecord[] = [];

    for (const run of allRuns) {
      this.runLocations.set(run.runId, { cardId: run.cardId, sessionId: run.sessionId });

      if (run.status === "queued" || run.status === "running") {
        run.status = "interrupted";
        run.endedAt = Date.now();
        run.error = run.error ?? "Process crashed or abruptly terminated";

        // 从事件日志中恢复已落盘的全部 run_delta 文本，保证 record.text 与重放严格一致
        const events = await this.cardStore.readEvents(run.cardId, run.sessionId, 1);
        const deltas = events.filter((ev) => {
          if (ev.type === "run_delta" && "payload" in ev && ev.payload && typeof ev.payload === "object" && "runId" in ev.payload) {
            return ev.payload.runId === run.runId;
          }
          return false;
        });
        run.text = deltas.map((d) => (d as unknown as { payload: { text: string } }).payload.text).join("");

        // 写 run_failed 事件作为权威记录
        const failEvent = await this.cardStore.appendEvent(run.cardId, run.sessionId, {
          cardId: run.cardId,
          sessionId: run.sessionId,
          ts: run.endedAt ?? Date.now(),
          type: "run_failed",
          payload: {
            runId: run.runId,
            error: run.error
          }
        });
        run.lastSeq = failEvent.seq;
        await this.runStore.save(run);
        interruptedRuns.push(run);
      }
    }

    return interruptedRuns;
  }
}
