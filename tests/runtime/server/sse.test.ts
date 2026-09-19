// tests/runtime/server/sse.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../../../src/runtime/server/app.js";
import { FakeCardStore, FakeRunManager } from "./fakes.js";
import type { ServerConfig, RuntimeEvent } from "../../../src/runtime/contracts.js";
import type { Hono } from "hono";

describe("sse.ts SSE 视图与 reattach/退订", () => {
  const token = "valid-token-sse";
  const port = 8080;
  let fakeCardStore: FakeCardStore;
  let fakeRunManager: FakeRunManager;
  let config: ServerConfig;
  let app: Hono;

  beforeEach(() => {
    fakeCardStore = new FakeCardStore("/tmp/airp-test-home");
    fakeRunManager = new FakeRunManager();
    config = {
      token,
      port,
      host: "127.0.0.1",
      allowedOrigins: [`http://127.0.0.1:${port}`],
      airpHome: "/tmp/airp-test-home",
    };
    app = createApp(config, {
      cardStore: fakeCardStore,
      runManager: fakeRunManager,
    });
  });

  it("验收标准 6: SSE reattach - ?from=3 且仅接收 seq > 3 的事件，结束后收到 event: end", async () => {
    // 1. 启动一个 Run
    const run = await fakeRunManager.startRun({
      cardId: "card-1",
      sessionId: "sess-1",
      prompt: "Tell me a story",
    });

    // 2. 先写入 5 条历史事件 (seq 1..5)
    for (let i = 1; i <= 5; i++) {
      const ev: RuntimeEvent = {
        id: `ev_${i}`,
        seq: i,
        timestamp: Date.now() + i,
        type: "run_delta",
        payload: {
          runId: run.runId,
          text: ` chunk_${i}`,
        },
      };
      fakeRunManager.addEventForRun(run.runId, ev);
    }

    // 3. 将 run 标记为已结束
    fakeRunManager.finishRun(run.runId, { text: "chunk_1 chunk_2 chunk_3 chunk_4 chunk_5" });

    // 4. 客户端带 ?from=3 建立 SSE 连接
    const res = await app.request(`http://127.0.0.1:${port}/api/runs/${run.runId}/events?from=3`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        "X-AIRP-Token": token,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();

    // 必须只收到 seq > 3 的事件（即 seq 4 和 seq 5）
    expect(text).not.toContain("id: 1");
    expect(text).not.toContain("id: 2");
    expect(text).not.toContain("id: 3");
    expect(text).toContain("id: 4");
    expect(text).toContain("id: 5");

    // 验证标准帧格式: id: <seq>\nevent: <type>\ndata: <JSON>\n\n
    expect(text).toContain("event: run_delta");
    expect(text).toContain("chunk_4");
    expect(text).toContain("chunk_5");

    // 验证 Run 结束帧
    expect(text).toContain("event: end");
    expect(text).toContain(`"runId":"${run.runId}"`);
  });

  it("Last-Event-ID 请求头优先于 ?from 参数", async () => {
    const run = await fakeRunManager.startRun({
      cardId: "card-1",
      sessionId: "sess-1",
      prompt: "Test Last-Event-ID",
    });

    for (let i = 1; i <= 5; i++) {
      fakeRunManager.addEventForRun(run.runId, {
        id: `ev_${i}`,
        seq: i,
        timestamp: Date.now(),
        type: "run_delta",
        payload: { runId: run.runId, text: `part_${i}` },
      });
    }
    fakeRunManager.finishRun(run.runId);

    // Last-Event-ID 为 4，?from=1；应优先取 Last-Event-ID (4)，只收到 seq 5
    const res = await app.request(`http://127.0.0.1:${port}/api/runs/${run.runId}/events?from=1`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        "X-AIRP-Token": token,
        "Last-Event-ID": "4",
      },
    });

    const text = await res.text();
    expect(text).not.toContain("id: 1");
    expect(text).not.toContain("id: 2");
    expect(text).not.toContain("id: 3");
    expect(text).not.toContain("id: 4");
    expect(text).toContain("id: 5");
    expect(text).toContain("event: end");
  });

  it("验收标准 7: SSE 退订 - 客户端断开连接后 fake runManager 记录到退订被调用", async () => {
    const run = await fakeRunManager.startRun({
      cardId: "card-1",
      sessionId: "sess-1",
      prompt: "Long running streaming",
    });

    const abortController = new AbortController();
    const { promise: unsubPromise, resolve: onUnsubscribe } = Promise.withResolvers<void>();
    fakeRunManager.onUnsubscribeCallback = () => {
      onUnsubscribe();
    };

    const res = await app.request(`http://127.0.0.1:${port}/api/runs/${run.runId}/events`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        "X-AIRP-Token": token,
      },
      signal: abortController.signal,
    });

    expect(res.status).toBe(200);

    // 确认订阅已建立
    const subs = fakeRunManager.subscribers.get(run.runId);
    expect(subs?.size).toBe(1);

    // 客户端主动 abort 断开连接
    abortController.abort();

    // 等待退订回调完成，无需猜测 wall-clock timer
    await unsubPromise;

    // 验证退订被调用，无订阅泄漏
    expect(fakeRunManager.unsubscribeCalls).toBeGreaterThanOrEqual(1);
    expect(subs?.size).toBe(0);
  });
});
