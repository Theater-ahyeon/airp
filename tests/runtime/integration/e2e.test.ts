// tests/runtime/integration/e2e.test.ts
// 端到端集成测试：使用真实 bootstrap() + 真实 fetch，不得使用 fake。

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bootstrap } from "../../../src/runtime/bootstrap.js";
import type { BootstrapResult } from "../../../src/runtime/bootstrap.js";
import { MockModelPort } from "../../../src/runtime/session/mock-port.js";
import { MockModelAdapter } from "../../../src/core/adapters/mock-model.js";
import type {
  ExportBundle,
  ReplayResult,
  RunRecord,
} from "../../../src/runtime/contracts.js";
import type { CharacterAttributes } from "../../../src/core/types/character.js";

const TEST_CARD_ATTRS: CharacterAttributes = {
  name: "集成测试角色",
  description: "端到端测试角色",
  personality: "活泼热情",
  scenario: "酒馆柜台前",
  firstMessage: "你好呀！我是酒馆服务员。",
  mesExamples: "<START>\n{{user}}: 来杯麦酒\n{{char}}: 马上就来！",
};

describe("端到端集成测试（真实装配）", () => {
  let tmpHome: string;
  let server: BootstrapResult;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-e2e-"));
    // 采用随机端口 0 避免端口冲突
    // 使用可控慢速流模型，确保能够稳定测试取消分支
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("一二三四五六七八九十".repeat(20));
    const slowPort = new MockModelPort({ adapter, deltaDelayMs: 40 });

    // 采用随机端口 0 避免端口冲突
    server = await bootstrap({
      home: tmpHome,
      port: 0,
      modelPort: slowPort,
    });
  });
  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (tmpHome) {
      // Windows 上后台回合收尾（butler 事件写入）与 rm 存在竞态，重试以消除 flake
      for (let i = 0; i < 5; i++) {
        try {
          await fs.rm(tmpHome, { recursive: true, force: true });
          break;
        } catch {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 80);
          await promise;
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // 1. 健康检查：带正确 token -> 200；无 token -> 403；错误 token -> 403
  // ---------------------------------------------------------------------------
  it("1. 健康检查与 Token 鉴权边界", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // A. 正确 token (Header) -> 200
    const resOk = await fetch(`${baseUrl}/api/health`, {
      headers: {
        "X-AIRP-Token": server.token,
      },
    });
    expect(resOk.status).toBe(200);
    const dataOk = (await resOk.json()) as { ok: boolean; airpHome: string };
    expect(dataOk.ok).toBe(true);
    expect(dataOk.airpHome).toBe(tmpHome);

    // B. 正确 token (Query) -> 200
    const resOkQuery = await fetch(`${baseUrl}/api/health?token=${server.token}`);
    expect(resOkQuery.status).toBe(200);

    // C. 无 token -> 403
    const resNoToken = await fetch(`${baseUrl}/api/health`);
    expect(resNoToken.status).toBe(403);
    const dataNoToken = (await resNoToken.json()) as { error: string };
    expect(dataNoToken.error).toContain("Forbidden");

    // D. 错误 token -> 403
    const resBadToken = await fetch(`${baseUrl}/api/health`, {
      headers: {
        "X-AIRP-Token": "completely-invalid-token",
      },
    });
    expect(resBadToken.status).toBe(403);
  });

  // ---------------------------------------------------------------------------
  // 2. 安全边界：Origin 校验与 Host 校验
  // ---------------------------------------------------------------------------
  it("2. 安全边界拦截：非法 Origin 与非法 Host 均返回 403", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // A. 恶意 Origin: http://evil.example -> 403
    const resEvilOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: {
        "X-AIRP-Token": server.token,
        Origin: "http://evil.example",
      },
    });
    expect(resEvilOrigin.status).toBe(403);
    const evilOriginJson = (await resEvilOrigin.json()) as { error: string };
    expect(evilOriginJson.error).toContain("origin not allowed");

    // B. 恶意 Host: evil.example -> 403 (使用 http.request 避免 fetch 重写 Host 头)
    const http = await import("node:http");
    const { promise: hostPromise, resolve: resolveHost } = Promise.withResolvers<{
      status: number;
      body: string;
    }>();
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        path: "/api/health",
        method: "GET",
        headers: {
          Host: "evil.example",
          "X-AIRP-Token": server.token,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString()));
        res.on("end", () => resolveHost({ status: res.statusCode ?? 0, body }));
      }
    );
    req.end();
    const hostRes = await hostPromise;
    expect(hostRes.status).toBe(403);
    expect(hostRes.body).toContain("invalid Host header");

    // C. 合法 Origin -> 200 (白名单包含真实端口)
    const resGoodOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: {
        "X-AIRP-Token": server.token,
        Origin: `http://127.0.0.1:${server.port}`,
      },
    });
    expect(resGoodOrigin.status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 接线陷阱验证测试：端口回退后 allowedOrigins 必须使用真实端口
  // ---------------------------------------------------------------------------
  it("2-b. 端口回退后 allowedOrigins 仍精确匹配真实端口，合法同源跨域不被误杀", async () => {
    // 创建一个占用 TCP 端口的占位服务
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const blockerPort = (blocker.address() as net.AddressInfo).port;

    // 请求在该端口启动 bootstrap，触发回退
    const fallbackServer = await bootstrap({
      home: tmpHome,
      port: blockerPort,
    });

    try {
      expect(fallbackServer.port).toBeGreaterThan(blockerPort);
      // 发起带当前真实端口 Origin 的 POST 请求
      const postRes = await fetch(`http://127.0.0.1:${fallbackServer.port}/api/cards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AIRP-Token": fallbackServer.token,
          Origin: `http://127.0.0.1:${fallbackServer.port}`,
        },
        body: JSON.stringify(TEST_CARD_ATTRS),
      });
      expect(postRes.status).toBe(201);
    } finally {
      await fallbackServer.close();
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  // ---------------------------------------------------------------------------
  // 3. 主链路：创建卡片 -> 创建会话 -> 启动 Run -> 接收 SSE -> 断言完整文本
  // ---------------------------------------------------------------------------
  it("3. 主链路端到端：创建卡片/会话/Run，流式收 SSE 组装文本并与 RunRecord 一致", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-AIRP-Token": server.token,
    };

    // A. POST /api/cards
    const cardRes = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify(TEST_CARD_ATTRS),
    });
    expect(cardRes.status).toBe(201);
    const { cardId } = (await cardRes.json()) as { cardId: string };
    expect(cardId).toBeTruthy();

    // B. POST /api/sessions
    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cardId }),
    });
    expect(sessionRes.status).toBe(201);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };
    expect(sessionId).toBeTruthy();

    // C. POST /api/runs
    const runRes = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cardId,
        sessionId,
        prompt: "你好，请自我介绍一下",
      }),
    });
    expect(runRes.status).toBe(202);
    const { run } = (await runRes.json()) as { run: RunRecord };
    expect(run.runId).toBeTruthy();
    const runId = run.runId;

    // D. GET /api/runs/:runId/events 接收 SSE 事件流
    const sseRes = await fetch(`${baseUrl}/api/runs/${runId}/events?token=${server.token}`);
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let accumulatedDeltaText = "";
    let endEventReceived = false;
    let sseBuffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });

      // 按 SSE 帧分割双换行
      const blocks = sseBuffer.split("\n\n");
      sseBuffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim()) continue;
        const lines = block.split("\n");
        let eventType = "message";
        let dataStr = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.replace(/^event:\s*/, "").trim();
          } else if (line.startsWith("data:")) {
            dataStr = line.replace(/^data:\s*/, "");
          }
        }

        if (eventType === "run_delta") {
          const parsed = JSON.parse(dataStr);
          accumulatedDeltaText += parsed.payload.text;
        } else if (eventType === "end") {
          endEventReceived = true;
        }
      }

      if (endEventReceived) {
        break;
      }
    }

    expect(endEventReceived).toBe(true);
    expect(accumulatedDeltaText.length).toBeGreaterThan(0);

    // E. 查询 GET /api/runs/:runId
    const finalRunRes = await fetch(`${baseUrl}/api/runs/${runId}`, {
      headers,
    });
    expect(finalRunRes.status).toBe(200);
    const finalRunJson = (await finalRunRes.json()) as { run: RunRecord };
    expect(finalRunJson.run.status).toBe("completed");
    expect(accumulatedDeltaText).toBe(finalRunJson.run.text);
  });

  // ---------------------------------------------------------------------------
  // 4. 断线 reattach：断开 SSE，用 ?from=seq 续传，断言补齐事件且 seq 连续不重不漏
  // ---------------------------------------------------------------------------
  it("4. 断线 reattach：断流后使用 ?from=<seq> 续传，补齐后续事件且 seq 严格单调递增连续", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-AIRP-Token": server.token,
    };

    const cardRes = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify(TEST_CARD_ATTRS),
    });
    const { cardId } = (await cardRes.json()) as { cardId: string };

    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cardId }),
    });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // 启动 Run
    const runRes = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cardId,
        sessionId,
        prompt: "请讲一个关于星际旅行的故事",
      }),
    });
    const { run } = (await runRes.json()) as { run: RunRecord };
    const runId = run.runId;

    // 建立第一次 SSE 连接，接收几个事件后主动 abort
    const abortCtrl = new AbortController();
    const firstSseRes = await fetch(
      `${baseUrl}/api/runs/${runId}/events?token=${server.token}`,
      { signal: abortCtrl.signal }
    );
    expect(firstSseRes.status).toBe(200);

    const firstReader = firstSseRes.body!.getReader();
    const decoder = new TextDecoder();
    const firstBatchEvents: Array<{ seq: number; type: string; data: unknown }> = [];
    let firstBuffer = "";

    try {
      while (true) {
        const { done, value } = await firstReader.read();
        if (done) break;
        firstBuffer += decoder.decode(value, { stream: true });
        const blocks = firstBuffer.split("\n\n");
        firstBuffer = blocks.pop() ?? "";

        for (const block of blocks) {
          if (!block.trim() || block.startsWith(":")) continue;
          let seq = 0;
          let type = "message";
          let dataStr = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("id:")) seq = Number.parseInt(line.replace(/^id:\s*/, ""), 10);
            if (line.startsWith("event:")) type = line.replace(/^event:\s*/, "").trim();
            if (line.startsWith("data:")) dataStr = line.replace(/^data:\s*/, "");
          }
          if (type !== "end" && seq > 0) {
            firstBatchEvents.push({ seq, type, data: JSON.parse(dataStr) });
          }
        }

        // 收到至少 2 个事件时断开
        if (firstBatchEvents.length >= 2) {
          abortCtrl.abort();
          break;
        }
      }
    } catch {
      // 捕获预期中的 AbortError
    }

    expect(firstBatchEvents.length).toBeGreaterThanOrEqual(2);
    const maxFirstSeq = Math.max(...firstBatchEvents.map((e) => e.seq));

    // 使用 ?from=<maxFirstSeq> 建立第二次重连
    const secondSseRes = await fetch(
      `${baseUrl}/api/runs/${runId}/events?token=${server.token}&from=${maxFirstSeq}`
    );
    expect(secondSseRes.status).toBe(200);

    const secondReader = secondSseRes.body!.getReader();
    const secondBatchEvents: Array<{ seq: number; type: string; data: unknown }> = [];
    let secondBuffer = "";
    let gotEnd = false;

    while (true) {
      const { done, value } = await secondReader.read();
      if (done) break;
      secondBuffer += decoder.decode(value, { stream: true });
      const blocks = secondBuffer.split("\n\n");
      secondBuffer = blocks.pop() ?? "";

      for (const block of blocks) {
        if (!block.trim() || block.startsWith(":")) continue;
        let seq = 0;
        let type = "message";
        let dataStr = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) seq = Number.parseInt(line.replace(/^id:\s*/, ""), 10);
          if (line.startsWith("event:")) type = line.replace(/^event:\s*/, "").trim();
          if (line.startsWith("data:")) dataStr = line.replace(/^data:\s*/, "");
        }
        if (type === "end") {
          gotEnd = true;
        } else if (seq > 0) {
          secondBatchEvents.push({ seq, type, data: JSON.parse(dataStr) });
        }
      }

      if (gotEnd) break;
    }

    expect(gotEnd).toBe(true);

    // 断言 reattach 后收到的所有事件 seq 必须严格大于 maxFirstSeq
    for (const ev of secondBatchEvents) {
      expect(ev.seq).toBeGreaterThan(maxFirstSeq);
    }

    // 合并两批事件，断言不重不漏、seq 单调连续递增
    const allEvents = [...firstBatchEvents, ...secondBatchEvents];
    const allSeqs = allEvents.map((e) => e.seq);
    for (let i = 0; i < allSeqs.length - 1; i++) {
      expect(allSeqs[i + 1]).toBe(allSeqs[i] + 1);
    }
  });

  // ---------------------------------------------------------------------------
  // 5. 持久化往返：export -> import -> 检查楼层树一致
  // ---------------------------------------------------------------------------
  it("5. 数据无损导出与导入往返验证", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-AIRP-Token": server.token,
    };

    // A. 创建卡与会话并追加楼层
    const cardRes = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify(TEST_CARD_ATTRS),
    });
    const { cardId } = (await cardRes.json()) as { cardId: string };

    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cardId }),
    });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // 直接通过 cardStore 写入两条楼层以生成真实的楼层树
    await server.deps.cardStore.appendFloor(cardId, sessionId, {
      role: "user",
      content: "测试用户提问",
    });
    await server.deps.cardStore.appendFloor(cardId, sessionId, {
      role: "assistant",
      content: "测试助手回复内容",
    });

    // 获取源卡的楼层树
    const srcTreeRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/tree?cardId=${cardId}`,
      { headers }
    );
    expect(srcTreeRes.status).toBe(200);
    const srcTree = (await srcTreeRes.json()) as ReplayResult;
    expect(Object.keys(srcTree.tree.floors).length).toBe(2);

    // B. GET /api/cards/:cardId/export 导出卡片
    const exportRes = await fetch(`${baseUrl}/api/cards/${cardId}/export`, {
      headers,
    });
    expect(exportRes.status).toBe(200);
    const bundle = (await exportRes.json()) as ExportBundle;
    expect(bundle.bundleVersion).toBe(1);

    // C. POST /api/cards/import?newCardId=imported-card-test 导入卡片
    const importRes = await fetch(
      `${baseUrl}/api/cards/import?newCardId=imported-card-test`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(bundle),
      }
    );
    expect(importRes.status).toBe(201);
    const importResult = (await importRes.json()) as { cardId: string };
    expect(importResult.cardId).toBe("imported-card-test");

    // D. 对新卡查询楼层树，断言与原卡完全一致
    const importedTreeRes = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/tree?cardId=imported-card-test`,
      { headers }
    );
    expect(importedTreeRes.status).toBe(200);
    const importedTree = (await importedTreeRes.json()) as ReplayResult;
    expect(importedTree.tree).toEqual(srcTree.tree);
    expect(importedTree.lastSeq).toBe(srcTree.lastSeq);
  });

  // ---------------------------------------------------------------------------
  // 6. 取消：POST /api/runs 后 POST /api/runs/:runId/cancel
  // ---------------------------------------------------------------------------
  it("6. Run 取消语义：cancel 成功，cancelled 标志为 true 且保留部分已生成文本", async () => {
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const headers = {
      "Content-Type": "application/json",
      "X-AIRP-Token": server.token,
    };

    const cardRes = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers,
      body: JSON.stringify(TEST_CARD_ATTRS),
    });
    const { cardId } = (await cardRes.json()) as { cardId: string };

    const sessionRes = await fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cardId }),
    });
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    // 启动一个长生成 Run
    const runRes = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        cardId,
        sessionId,
        prompt: "请写一本长篇科幻小说，要求字数尽量多",
      }),
    });
    const { run } = (await runRes.json()) as { run: RunRecord };
    const runId = run.runId;

    // 等待首个 run_delta 事件到达，确保模型已产生部分输出
    const sseRes = await fetch(`${baseUrl}/api/runs/${runId}/events?token=${server.token}`);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuf = "";
    let receivedDelta = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
      if (sseBuf.includes("event: run_delta")) {
        receivedDelta = true;
        break;
      }
    }
    await reader.cancel();
    expect(receivedDelta).toBe(true);
    const cancelRes = await fetch(`${baseUrl}/api/runs/${runId}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelRes.status).toBe(200);
    const cancelData = (await cancelRes.json()) as { cancelled: boolean };
    expect(cancelData.cancelled).toBe(true);

    // 查询该 Run 的最终记录
    const finalRes = await fetch(`${baseUrl}/api/runs/${runId}`, { headers });
    expect(finalRes.status).toBe(200);
    const finalData = (await finalRes.json()) as { run: RunRecord };
    expect(finalData.run.status).toBe("cancelled");
    expect(finalData.run.endedAt).toBeTypeOf("number");
    expect(finalData.run.text.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 7. close() 后端口释放，能再次 bootstrap 到同一端口
  // ---------------------------------------------------------------------------
  it("7. 资源释放：close() 后端口完全释放，可重新在该端口启动", async () => {
    const fixedPort = server.port;

    // 关闭现有服务
    await server.close();

    // 验证服务确实已关闭：向旧端口发请求应连接拒绝 (fetch 会失败)
    let fetchFailed = false;
    try {
      await fetch(`http://127.0.0.1:${fixedPort}/api/health`);
    } catch {
      fetchFailed = true;
    }
    expect(fetchFailed).toBe(true);

    // 在同一端口上再次 bootstrap
    const newServer = await bootstrap({
      home: tmpHome,
      port: fixedPort,
    });

    try {
      expect(newServer.port).toBe(fixedPort);
      const res = await fetch(`http://127.0.0.1:${fixedPort}/api/health`, {
        headers: { "X-AIRP-Token": newServer.token },
      });
      expect(res.status).toBe(200);
    } finally {
      await newServer.close();
    }
  });
});
