// tests/runtime/server/app.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createApp } from "../../../src/runtime/server/app.js";
import { FakeCardStore, FakeRunManager } from "./fakes.js";
import type { ServerConfig } from "../../../src/runtime/contracts.js";
import type { Hono } from "hono";
describe("app.ts 路由契约与端点测试", () => {
  const token = "valid-token-123456";
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

  const authedReq = (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set("Host", `127.0.0.1:${port}`);
    headers.set("X-AIRP-Token", token);
    return app.request(`http://127.0.0.1:${port}${path}`, {
      ...options,
      headers,
    });
  };

  it("GET / 返回占位 HTML（不含启动密钥）", async () => {
    const res = await app.request("http://127.0.0.1:8080/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("AIRP");
    expect(html).toContain("启动令牌");
    expect(html).not.toContain(token);
  });

  it("验收标准 1: GET /api/health 在携带正确 token 时返回 200", async () => {
    const res = await authedReq("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; schemaVersion: number; airpHome: string; startedAt: number; pid: number };
    expect(body.ok).toBe(true);
    expect(body.schemaVersion).toBe(1);
    expect(body.airpHome).toBe("/tmp/airp-test-home");
    expect(typeof body.startedAt).toBe("number");
    expect(typeof body.pid).toBe("number");
  });

  it("验收标准 5: 卡管理契约 /api/cards, /api/cards/:cardId, /api/cards/:cardId/export, /api/cards/import", async () => {
    // 1. POST /api/cards
    const createRes = await authedReq("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Character",
        description: "A test character description",
        personality: "Kind",
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { cardId: string };
    expect(created.cardId).toBeTruthy();
    const cardId = created.cardId;

    // 2. GET /api/cards
    const listRes = await authedReq("/api/cards");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { cards: Array<{ cardId: string; name: string }> };
    expect(listBody.cards).toHaveLength(1);
    expect(listBody.cards[0].cardId).toBe(cardId);
    expect(listBody.cards[0].name).toBe("Test Character");

    // 3. GET /api/cards/:cardId
    const getRes = await authedReq(`/api/cards/${cardId}`);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as { meta: { cardId: string }; original: { name: string }; workingCopy: { name: string } };
    expect(getBody.meta.cardId).toBe(cardId);
    expect(getBody.original.name).toBe("Test Character");
    expect(getBody.workingCopy.name).toBe("Test Character");

    // 4. GET /api/cards/:cardId/export
    const exportRes = await authedReq(`/api/cards/${cardId}/export`);
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toContain("application/json");
    const exportBody = await exportRes.json();
    expect(exportBody.version).toBe(1);
    expect(exportBody.meta.cardId).toBe(cardId);

    // 5. POST /api/cards/import
    const importRes = await authedReq("/api/cards/import?newCardId=imported-card-1", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exportBody),
    });
    expect(importRes.status).toBe(201);
    const importBody = (await importRes.json()) as { cardId: string };
    expect(importBody.cardId).toBe("imported-card-1");
  });

  it("会话管理契约 POST /api/sessions 与 GET /api/sessions/:sessionId/tree", async () => {
    // 先建卡
    const cardRes = await authedReq("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Session Target" }),
    });
    const { cardId } = (await cardRes.json()) as { cardId: string };

    // POST /api/sessions
    const sessionRes = await authedReq("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cardId }),
    });
    expect(sessionRes.status).toBe(201);
    const sessionBody = (await sessionRes.json()) as { sessionId: string };
    expect(sessionBody.sessionId).toBeTruthy();
    const sessionId = sessionBody.sessionId;

    // GET /api/sessions/:sessionId/tree
    const treeRes = await authedReq(`/api/sessions/${sessionId}/tree?cardId=${cardId}`);
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { tree: { rootId: string }; state: unknown };
    expect(treeBody.tree.rootId).toBe("root");

    // 缺少 cardId 参数时返回 400
    const treeMissingCardRes = await authedReq(`/api/sessions/${sessionId}/tree`);
    expect(treeMissingCardRes.status).toBe(400);
  });

  it("验收标准 5: Run 契约 POST /api/runs, GET /api/runs/:id, POST /api/runs/:id/cancel", async () => {
    // 1. POST /api/runs -> 202
    const runRes = await authedReq("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cardId: "test-card",
        sessionId: "test-session",
        prompt: "Hello assistant",
      }),
    });
    expect(runRes.status).toBe(202);
    const runBody = (await runRes.json()) as { run: { runId: string; status: string } };
    expect(runBody.run.runId).toBeTruthy();
    expect(runBody.run.status).toBe("running");
    const runId = runBody.run.runId;

    // 2. GET /api/runs/:runId -> 200
    const getRunRes = await authedReq(`/api/runs/${runId}`);
    expect(getRunRes.status).toBe(200);
    const getRunBody = (await getRunRes.json()) as { run: { runId: string; prompt: string } };
    expect(getRunBody.run.runId).toBe(runId);
    expect(getRunBody.run.prompt).toBe("Hello assistant");

    // 3. POST /api/runs/:runId/cancel -> 200 { cancelled: boolean }
    const cancelRes = await authedReq(`/api/runs/${runId}/cancel`, {
      method: "POST",
    });
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as { cancelled: boolean };
    expect(cancelBody.cancelled).toBe(true);

    // 重复取消已结束的 run 返回 false
    const cancelAgainRes = await authedReq(`/api/runs/${runId}/cancel`, {
      method: "POST",
    });
    expect(cancelAgainRes.status).toBe(200);
    expect(await cancelAgainRes.json()).toEqual({ cancelled: false });
  });

  it("404 与非法参数 400 校验", async () => {
    // 不存在的路由返回 404
    const notFoundRes = await authedReq("/api/unknown-endpoint");
    expect(notFoundRes.status).toBe(404);
    expect(await notFoundRes.json()).toEqual({ error: "Not Found" });

    // POST /api/runs 参数缺失返回 400
    const badRunRes = await authedReq("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(badRunRes.status).toBe(400);

    // POST /api/cards body 非 JSON 返回 400
    const badJsonRes = await authedReq("/api/cards", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json-content",
    });
    expect(badJsonRes.status).toBe(400);
  });
});
