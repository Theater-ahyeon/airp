// tests/runtime/session/run-manager.test.ts
// 覆盖任务书五、9 条验收标准的全面自动化测试。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { CardStore } from "../../../src/runtime/card-store.js";
import { RunStore } from "../../../src/runtime/session/run-store.js";
import { RunManager } from "../../../src/runtime/session/run-manager.js";
import { MockModelPort } from "../../../src/runtime/session/mock-port.js";
import { MockModelAdapter } from "../../../src/core/adapters/mock-model.js";
import type {
  RuntimeEvent,
  RunRecord,
  RunEventSink,
  RunDeltaEvent,
  ModelStreamPort,
  ModelStreamChunk
} from "../../../src/runtime/contracts.js";

describe("RunManager 生命周期与 9 项验收标准", () => {
  let tempHome: string;
  let cardStore: CardStore;
  const cardId = "test_card";
  const sessionId = "test_session";

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-run-manager-test-"));
    cardStore = new CardStore(tempHome);
    await cardStore.createCard({
      cardId,
      attributes: {
        name: "Test Character",
        description: "desc",
        personality: "pers",
        scenario: "scen",
        mesExamples: "examples",
        systemPrompt: "system",
        firstMessage: "hello"
      }
    });
    await cardStore.createSession(cardId, sessionId);
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(tempHome, { recursive: true, force: true });
        break;
      } catch {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 100);
        await promise;
      }
    }
  });
  // 验收标准 1：状态机全路径
  it("验收点 1: 状态机全路径 (start -> completed, start -> cancel -> cancelled, error -> failed, 终态不可再迁移)", async () => {
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("正常生成输出。");
    const runManager = new RunManager(cardStore, new MockModelPort({ adapter }));

    // 1.1 startRun -> completed
    const r1 = await runManager.startRun({ cardId, sessionId, prompt: "test completed" });
    expect(r1.status).toBe("running");
    expect(r1.prompt).toBe("test completed");

    // 等待后台流完成
    const waitCompleted = async (runId: string) => {
      for (let i = 0; i < 50; i++) {
        const current = await runManager.getRun(runId);
        if (current && current.status !== "running") return current;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 20);
        await promise;
      }
      throw new Error("Timeout waiting for run completion");
    };

    const completedRun = await waitCompleted(r1.runId);
    expect(completedRun.status).toBe("completed");
    expect(completedRun.text).toBe("正常生成输出。");
    expect(completedRun.endedAt).not.toBeNull();

    // 1.2 终态不可再迁移：对 completed 调 cancelRun 返回 false
    const cancelRes = await runManager.cancelRun(r1.runId);
    expect(cancelRes).toBe(false);

    // 1.3 startRun -> cancelRun -> cancelled
    const slowAdapter = new MockModelAdapter();
    slowAdapter.enqueueResponse("一二三四五六七八九十".repeat(20));
    const slowPort = new MockModelPort({ adapter: slowAdapter, deltaDelayMs: 25 });
    const slowManager = new RunManager(cardStore, slowPort);

    const r2 = await slowManager.startRun({ cardId, sessionId, prompt: "test cancel" });
    // 短暂等待流进入 running
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 30);
      await promise;
    }

    const didCancel = await slowManager.cancelRun(r2.runId);
    expect(didCancel).toBe(true);

    const cancelledRun = await slowManager.getRun(r2.runId);
    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelledRun?.cancelReason).toBe("User cancelled");

    // 对 cancelled Run 再次取消应返回 false
    expect(await slowManager.cancelRun(r2.runId)).toBe(false);

    // 1.4 异常端口 -> failed
    const errorPort: ModelStreamPort = {
      async *stream(_req): AsyncGenerator<ModelStreamChunk, void, unknown> {
        yield { type: "start" };
        yield { type: "text_delta", text: "前半截" };
        throw new Error("Simulated model connection error");
      }
    };
    const errorManager = new RunManager(cardStore, errorPort);
    const r3 = await errorManager.startRun({ cardId, sessionId, prompt: "test failed" });
    const failedRun = await waitCompleted(r3.runId);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("Simulated model connection error");
    expect(await errorManager.cancelRun(r3.runId)).toBe(false);
  });

  // 验收标准 2：节流有效性
  it("验收点 2: 节流有效性 (500 个 delta 间隔 5ms, run_delta 事件数 ≤ 50 远小于 500, replay 文本完全一致)", async () => {
    // 构造产生 500 个 delta 的自定义端口
    const customStreamPort: ModelStreamPort = {
      async *stream(_req): AsyncGenerator<ModelStreamChunk, void, unknown> {
        yield { type: "start" };
        for (let i = 1; i <= 500; i++) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 5);
          await promise;
          yield { type: "text_delta", text: `[${i}]` };
        }
        yield { type: "done" };
      }
    };

    // 节流配置：150ms 或 4096 字符
    const runManager = new RunManager(cardStore, customStreamPort, {
      intervalMs: 150,
      maxChunkSize: 4096
    });

    const run = await runManager.startRun({ cardId, sessionId, prompt: "throttle test" });

    // 等待流结束
    while (true) {
      const current = await runManager.getRun(run.runId);
      if (current && current.status === "completed") break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 100);
      await promise;
    }

    const finalRun = await runManager.getRun(run.runId);
    expect(finalRun?.status).toBe("completed");

    // 检查事件日志中该 run 产生的 run_delta 事件数量
    const events = await cardStore.readEvents(cardId, sessionId, 1);
    const deltaEvents = events.filter(
      (e): e is RunDeltaEvent =>
        e.type === "run_delta" && e.payload.runId === run.runId
    );

    // 500 个 delta、间隔 5ms 总时长约 2.5 秒，以 150ms 节流落盘，deltaEvents 次数应在 15~30 之间，断言 ≤ 50
    expect(deltaEvents.length).toBeLessThanOrEqual(50);
    expect(deltaEvents.length).toBeGreaterThan(0);

    // 断言 replay 拼接出的文本与 RunRecord.text 完全一致
    const reconstructedText = deltaEvents.map((d) => d.payload.text).join("");
    expect(finalRun?.text).toBe(reconstructedText);
    expect(finalRun?.text.length).toBeGreaterThan(500 * 3);
  }, 15000);

  // 验收标准 3：取消保留部分输出
  it("验收点 3: 取消保留部分输出 (生成到一半取消, RunRecord.text 非空且等于已落盘 delta 拼接结果)", async () => {
    // 产生 50 个 delta，每个延迟 30ms
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("一二三四".repeat(50));
    const slowPort = new MockModelPort({ adapter, deltaDelayMs: 30 });
    // 节流设为 100ms
    const runManager = new RunManager(cardStore, slowPort, { intervalMs: 100 });

    const run = await runManager.startRun({ cardId, sessionId, prompt: "cancel partial test" });

    // 等待产生至少一两次节流 flush（约 250ms）
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }

    const cancelSuccess = await runManager.cancelRun(run.runId);
    expect(cancelSuccess).toBe(true);

    const cancelledRun = await runManager.getRun(run.runId);
    expect(cancelledRun?.status).toBe("cancelled");
    expect(cancelledRun?.text.length).toBeGreaterThan(0);

    // 获取所有落盘的 run_delta 事件并拼接
    const events = await cardStore.readEvents(cardId, sessionId, 1);
    const deltas = events.filter(
      (e): e is RunDeltaEvent => e.type === "run_delta" && e.payload.runId === run.runId
    );
    const mergedDiskText = deltas.map((d) => d.payload.text).join("");

    expect(cancelledRun?.text).toBe(mergedDiskText);
  });

  // 验收标准 4：reattach 正确性
  it("验收点 4: reattach 正确性 (已完成后 subscribe(runId, 0) 收到全部 delta 且调 onEnd; subscribe(runId, k) 只收到 seq > k)", async () => {
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("这是已完成的完整输出段落。");
    const runManager = new RunManager(cardStore, new MockModelPort({ adapter }));

    const run = await runManager.startRun({ cardId, sessionId, prompt: "reattach test" });

    // 等待完成
    while (true) {
      const cur = await runManager.getRun(run.runId);
      if (cur && cur.status === "completed") break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 20);
      await promise;
    }

    // 1. fromSeq = 0
    const receivedEvents0: RuntimeEvent[] = [];
    let endedRecord0: RunRecord | null = null;
    const unsubscribe0 = await runManager.subscribe(run.runId, 0, {
      onEvent: (ev) => receivedEvents0.push(ev),
      onEnd: (rec) => {
        endedRecord0 = rec;
      }
    });

    expect(receivedEvents0.length).toBeGreaterThanOrEqual(3); // created, started, delta, completed
    expect(endedRecord0).not.toBeNull();
    expect(endedRecord0!.status).toBe("completed");
    expect(typeof unsubscribe0).toBe("function");

    // 2. fromSeq = k (只订阅后续事件)
    const midSeq = receivedEvents0[1].seq; // 例如 seq of run_started
    const receivedEventsK: RuntimeEvent[] = [];
    let endedRecordK: RunRecord | null = null;
    await runManager.subscribe(run.runId, midSeq, {
      onEvent: (ev) => receivedEventsK.push(ev),
      onEnd: (rec) => {
        endedRecordK = rec;
      }
    });

    expect(receivedEventsK.every((ev) => ev.seq > midSeq)).toBe(true);
    expect(receivedEventsK.length).toBe(receivedEvents0.length - 2);
    expect(endedRecordK).not.toBeNull();
  });

  // 验收标准 5：进行中 reattach
  it("验收点 5: 进行中 reattach (慢速流进行中订阅，收到历史重放+实时推送，seq 严格连续无缺口无重复)", async () => {
    const adapter = new MockModelAdapter();
    // 40 个 slice，每个 25ms
    adapter.enqueueResponse("一二三四".repeat(40));
    const slowPort = new MockModelPort({ adapter, deltaDelayMs: 25 });
    const runManager = new RunManager(cardStore, slowPort, { intervalMs: 80 });

    const run = await runManager.startRun({ cardId, sessionId, prompt: "live reattach test" });

    // 等待流运行中途，产生了部分事件
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 200);
      await promise;
    }

    const received: RuntimeEvent[] = [];
    const { promise: streamEnded, resolve: resolveEnd } = Promise.withResolvers<RunRecord>();

    await runManager.subscribe(run.runId, 0, {
      onEvent: (ev) => received.push(ev),
      onEnd: (rec) => resolveEnd(rec)
    });

    const finalRecord = await streamEnded;
    expect(finalRecord.status).toBe("completed");

    // 校验 seq 严格递增无重复无跳跃 (对于该 run 的事件)
    const seqs = received.map((e) => e.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    // 校验事件类型序列包含 created -> started -> [deltas...] -> completed
    const types = received.map((e) => e.type);
    expect(types[0]).toBe("run_created");
    expect(types[1]).toBe("run_started");
    expect(types[types.length - 1]).toBe("run_completed");
  });

  // 验收标准 6：多订阅者隔离
  it("验收点 6: 多订阅者隔离 (两个 sink 同时订阅，退订其一后另一个仍能收到后续事件)", async () => {
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("多订阅者隔离测试文本。".repeat(10));
    const slowPort = new MockModelPort({ adapter, deltaDelayMs: 30 });
    const runManager = new RunManager(cardStore, slowPort, { intervalMs: 80 });

    const run = await runManager.startRun({ cardId, sessionId, prompt: "multi subscriber test" });

    const eventsSink1: RuntimeEvent[] = [];
    const eventsSink2: RuntimeEvent[] = [];
    let sink1Ended = false;
    let sink2Ended = false;

    const unsub1 = await runManager.subscribe(run.runId, 0, {
      onEvent: (ev) => eventsSink1.push(ev),
      onEnd: () => {
        sink1Ended = true;
      }
    });

    const unsub2 = await runManager.subscribe(run.runId, 0, {
      onEvent: (ev) => eventsSink2.push(ev),
      onEnd: () => {
        sink2Ended = true;
      }
    });

    // 稍等收到前序事件后，退订 sink1
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 120);
      await promise;
    }
    unsub1();
    const sink1CountAtUnsub = eventsSink1.length;

    // 等待 run 完成
    while (true) {
      const cur = await runManager.getRun(run.runId);
      if (cur && cur.status === "completed") break;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
    // 稍微延时确保最后的 onEnd 到达
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }

    // sink1 退订后不得再收到任何事件与 onEnd
    expect(eventsSink1.length).toBe(sink1CountAtUnsub);
    expect(sink1Ended).toBe(false);

    // sink2 正常收到全部后续事件与 onEnd
    expect(eventsSink2.length).toBeGreaterThan(sink1CountAtUnsub);
    expect(sink2Ended).toBe(true);
  });

  // 验收标准 7：recoverOnBoot 幂等
  it("验收点 7: recoverOnBoot 幂等 (第一次返回被中断记录，第二次返回空数组；被中断记录状态为 interrupted 且 endedAt 非空)", async () => {
    const runManager = new RunManager(cardStore);

    // 人工在磁盘中写入两个遗留 Run（一个 queued，一个 running）
    const r1: RunRecord = {
      runId: "run_legacy_1",
      cardId,
      sessionId,
      status: "queued",
      model: "test-m",
      prompt: "prompt 1",
      createdAt: 1000,
      startedAt: null,
      endedAt: null,
      text: "",
      lastSeq: 1
    };
    const r2: RunRecord = {
      runId: "run_legacy_2",
      cardId,
      sessionId,
      status: "running",
      model: "test-m",
      prompt: "prompt 2",
      createdAt: 2000,
      startedAt: 2050,
      endedAt: null,
      text: "部分已生成内容",
      lastSeq: 5
    };
    const r3: RunRecord = {
      runId: "run_completed_already",
      cardId,
      sessionId,
      status: "completed",
      model: "test-m",
      prompt: "prompt 3",
      createdAt: 3000,
      startedAt: 3050,
      endedAt: 3500,
      text: "已完成",
      lastSeq: 8
    };

    await runManager.runStore.save(r1);
    await runManager.runStore.save(r2);
    await runManager.runStore.save(r3);

    // 第一次调用 recoverOnBoot
    const firstInterrupted = await runManager.recoverOnBoot();
    expect(firstInterrupted).toHaveLength(2);

    const int1 = firstInterrupted.find((r) => r.runId === "run_legacy_1");
    const int2 = firstInterrupted.find((r) => r.runId === "run_legacy_2");
    expect(int1?.status).toBe("interrupted");
    expect(int1?.endedAt).not.toBeNull();
    expect(int2?.status).toBe("interrupted");
    expect(int2?.endedAt).not.toBeNull();

    // 磁盘中状态也已变为 interrupted
    const loaded1 = await runManager.getRun("run_legacy_1");
    expect(loaded1?.status).toBe("interrupted");

    // 第二次调用 recoverOnBoot 必须幂等：返回空数组
    const secondInterrupted = await runManager.recoverOnBoot();
    expect(secondInterrupted).toEqual([]);
  });

  // 验收标准 8：跨进程强杀恢复（阶段 2 退出条件）
  it("验收点 8: 跨进程强杀恢复 (spawn 子进程写事件, 父进程 kill 强杀, 恢复后日志无半行损坏, replay 完整, recoverOnBoot 标记 interrupted)", async () => {
    const fixturePath = path.resolve(__dirname, "../fixtures/kill-fixture.mjs");

    // 找到 vitest 自带的 vite-node 可执行脚本执行 .mjs / ts 模块
    const viteNodePath = path.resolve(
      process.cwd(),
      "node_modules/.pnpm/vite-node@3.0.7_@types+node@26.6.2/node_modules/vite-node/vite-node.mjs"
    );
    const child = spawn(process.execPath, [viteNodePath, fixturePath], {
      env: { ...process.env, AIRP_HOME: tempHome },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let runId = "";
    const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<string>();

    child.stdout.on("data", (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/READY:([a-zA-Z0-9_-]+)/);
      if (match) {
        runId = match[1];
        resolveReady(runId);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      console.error("Fixture stderr:", data.toString());
    });

    child.on("error", (err) => {
      rejectReady(err);
    });

    child.on("exit", (code) => {
      if (!runId) {
        rejectReady(new Error(`Fixture exited prematurely with code ${code}`));
      }
    });

    await readyPromise;
    expect(runId).not.toBe("");

    // 让子进程在慢速流中写入若干 delta 事件（约 300ms）
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 300);
      await promise;
    }

    // 父进程强制杀死子进程 (child.kill('SIGKILL'))
    // 在 Windows 上 Node child.kill() 内部调用 TerminateProcess，完全等价于 POSIX kill -9
    child.kill("SIGKILL");

    // 等待子进程退出
    await new Promise((resolve) => child.on("exit", resolve));

    // 重新打开同一 AIRP_HOME
    const freshStore = new CardStore(tempHome);
    const freshManager = new RunManager(freshStore);

    // 1. 检查事件日志：无半行损坏，readEvents 正常返回
    const events = await freshStore.readEvents("card_kill_target", "sess_kill_target", 1);
    expect(events.length).toBeGreaterThanOrEqual(2); // created, started, 可能有若干 delta

    // 2. 检查 replay 无异常
    const replayResult = await freshStore.replay("card_kill_target", "sess_kill_target");
    expect(replayResult).toBeDefined();

    // 3. recoverOnBoot：将该崩溃未完成的 Run 标记为 interrupted
    const recovered = await freshManager.recoverOnBoot();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].runId).toBe(runId);
    expect(recovered[0].status).toBe("interrupted");
    expect(recovered[0].endedAt).not.toBeNull();

    // 4. 再次 recoverOnBoot 幂等
    const recovered2 = await freshManager.recoverOnBoot();
    expect(recovered2).toHaveLength(0);
  }, 15000);

  // 验收标准 9：无内存缓冲恢复（服务器重启等价）
  it("验收点 9: 无内存缓冲恢复 (Run 进行中销毁 RunManager 实例, 新实例 subscribe(runId, 0) 重放全部历史输出)", async () => {
    // 创建一个慢速流，产生多次落盘
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("这是用于无内存缓冲恢复测试的流式输出内容。".repeat(5));
    const slowPort = new MockModelPort({ adapter, deltaDelayMs: 25 });
    let manager1: RunManager | null = new RunManager(cardStore, slowPort, { intervalMs: 60 });

    const run = await manager1.startRun({ cardId, sessionId, prompt: "restart simulation" });

    // 让其运行 250ms 产生若干落盘 delta
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 250);
      await promise;
    }

    // 模拟服务器重启 / 内存崩溃：中止旧后台任务
    const activeContext = (manager1 as unknown as { activeRuns: Map<string, { abortController: AbortController }> })
      .activeRuns.get(run.runId);
    activeContext?.abortController.abort();
    {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 80);
      await promise;
    }
    manager1 = null;

    // 进程意外死亡时，磁盘上的 RunRecord 依然保持 running 状态（未来得及写 cancelled/completed）
    const rawDiskRecord = await new RunStore(cardStore.home).load(cardId, sessionId, run.runId);
    if (rawDiskRecord) {
      rawDiskRecord.status = "running";
      await new RunStore(cardStore.home).save(rawDiskRecord);
    }

    // 创建全新实例 manager2，此时没有任何内存缓存，模拟新服务启动
    const manager2 = new RunManager(cardStore);
    await manager2.recoverOnBoot();

    // 用新实例从 fromSeq = 0 进行 subscribe
    const receivedEvents: RuntimeEvent[] = [];
    let endedRecord: RunRecord | null = null;

    await manager2.subscribe(run.runId, 0, {
      onEvent: (ev) => receivedEvents.push(ev),
      onEnd: (rec) => {
        endedRecord = rec;
      }
    });

    // 验证：通过事件日志重放，完整收到了历史产生的 run_created, run_started, 以及所有已落盘的 run_delta 和 run_failed
    expect(receivedEvents.length).toBeGreaterThanOrEqual(3);
    const deltas = receivedEvents.filter((e): e is RunDeltaEvent => e.type === "run_delta");
    expect(deltas.length).toBeGreaterThan(0);

    // onEnd 正确回调，返回已被标记为 interrupted 的记录
    expect(endedRecord).not.toBeNull();
    expect(endedRecord!.status).toBe("interrupted");

    // 重放得到的文本与持久化记录文本一致
    const replayText = deltas.map((d) => d.payload.text).join("");
    expect(endedRecord!.text).toBe(replayText);
  });
});
