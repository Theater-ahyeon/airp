// src/runtime/server/app.ts
// AIRP Hono Web 路由与控制层实现。

import { Hono } from "hono";
import { z } from "zod";
import path from "node:path";
import fs from "node:fs";
import { serveStatic as createNodeStatic } from "@hono/node-server/serve-static";
import {
  RUNTIME_SCHEMA_VERSION,
  type ServerConfig,
  type ServerDeps,
  type ExportBundle,
  type StartRunInput,
} from "../contracts.js";
import type { CharacterAttributes } from "../../core/types/character.js";
import { extractCharacterCardFromPng } from "../../core/importers/png-card-extractor.js";
import { createSecurityMiddleware } from "./security.js";
import { handleRunEventsSSE } from "./sse.js";

const CreateCardSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  personality: z.string().default(""),
  scenario: z.string().default(""),
  firstMessage: z.string().default(""),
  mesExamples: z.string().default(""),
  systemPrompt: z.string().optional(),
  postHistoryInstructions: z.string().optional(),
  tags: z.array(z.string()).optional(),
  creatorNotes: z.string().optional(),
});
const ImportCardQuerySchema = z.object({
  newCardId: z.string().optional(),
});

const CreateSessionSchema = z.object({
  cardId: z.string().min(1),
});

const StartRunSchema = z.object({
  cardId: z.string().min(1),
  sessionId: z.string().min(1),
  model: z.string().optional(),
  prompt: z.string().min(1),
  maxContextTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

const AppendFloorSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1),
  parentId: z.string().nullable().optional(),
});

const SwipeFloorSchema = z.object({
  content: z.string().min(1),
});

const EditFloorSchema = z.object({
  content: z.string().min(1),
});

const RollbackSchema = z.object({
  toFloorId: z.string().min(1),
});
/**
 * 构造 AIRP Hono 实例。
 */
export function createApp(config: ServerConfig, deps: ServerDeps): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  // 静态前端托管（H-9）：staticDir 存在时托管 dist-ui，SPA 路由回退 index.html。
  // 无 staticDir 时保留说明占位页。
  const staticDir = config.staticDir;
  if (staticDir) {
    const serveStatic = createNodeStatic({ root: staticDir });
    app.use("*", async (c, next) => {
      // 静态资源仅服务非 /api 路径；/api 交给后续路由
      if (c.req.path.startsWith("/api/")) {
        return next();
      }
      const res = await serveStatic(c, next);
      if (res) return res;
      // SPA 回退：未命中静态文件且非 /api → index.html
      const indexPath = path.join(staticDir, "index.html");
      try {
        const html = await fs.promises.readFile(indexPath, "utf-8");
        return c.html(html);
      } catch {
        return next();
      }
    });
  } else {
    app.get("/", (c) => {
      return c.html(
        `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>AIRP Memory Engine</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 4rem auto; padding: 0 1rem; line-height: 1.6; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>AIRP 引擎正在运行</h1>
  <p>服务已在本机回环地址启动。所有 <code>/api/*</code> 请求必须携带启动令牌。</p>
  <p>启动令牌可通过请求头 <code>X-AIRP-Token</code> 或查询参数 <code>?token=...</code> 传递。</p>
  <p><em>安全提示：启动令牌仅限本机进程使用，切勿泄露或分享给第三方。</em></p>
</body>
</html>`
      );
    });
  }

  // 全局 404 处理
  app.notFound((c) => {
    return c.json({ error: "Not Found" }, 404);
  });

  // 全局 500 异常处理：严禁向客户端泄露调用栈
  app.onError((err, c) => {
    console.error("Unhandled runtime error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  // 安全中间件挂载到所有 /api/* 路径
  const securityMiddleware = createSecurityMiddleware(config);
  app.use("/api/*", securityMiddleware);

  // ---------------------------------------------------------------------------
  // API 路由实现
  // ---------------------------------------------------------------------------

  // GET /api/health
  app.get("/api/health", (c) => {
    return c.json({
      ok: true,
      schemaVersion: RUNTIME_SCHEMA_VERSION,
      airpHome: config.airpHome,
      startedAt,
      pid: process.pid,
    }, 200);
  });

  // GET /api/cards
  app.get("/api/cards", async (c) => {
    try {
      const cards = await deps.cardStore.listCards();
      return c.json({ cards }, 200);
    } catch (err) {
      console.error("Failed to list cards:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/cards
  app.post("/api/cards", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateCardSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    try {
      const result = await deps.cardStore.createCard({
        attributes: parsed.data,
      });
      return c.json({ cardId: result.cardId }, 201);
    } catch (err) {
      console.error("Failed to create card:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/cards/:cardId
  app.get("/api/cards/:cardId", async (c) => {
    const cardId = c.req.param("cardId");
    try {
      const card = await deps.cardStore.readCard(cardId);
      return c.json({
        meta: card.meta,
        original: card.original,
        workingCopy: card.workingCopy,
      }, 200);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT" || (err instanceof Error && err.message.toLowerCase().includes("not found"))) {
        return c.json({ error: `Card not found: ${cardId}` }, 404);
      }
      console.error("Failed to read card:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/cards/:cardId/export
  app.get("/api/cards/:cardId/export", async (c) => {
    const cardId = c.req.param("cardId");
    try {
      const bundle = await deps.cardStore.exportCard(cardId);
      return c.json(bundle, 200, {
        "Content-Type": "application/json",
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT" || (err instanceof Error && err.message.toLowerCase().includes("not found"))) {
        return c.json({ error: `Card not found: ${cardId}` }, 404);
      }
      console.error("Failed to export card:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/cards/import
  app.post("/api/cards/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid bundle payload" }, 400);
    }

    const queryParsed = ImportCardQuerySchema.safeParse(c.req.query());
    const newCardId = queryParsed.success ? queryParsed.data.newCardId : undefined;

    try {
      const result = await deps.cardStore.importCard(body as ExportBundle, {
        newCardId,
      });
      return c.json({ cardId: result.cardId }, 201);
    } catch (err) {
      console.error("Failed to import card:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/cards/import-st —— SillyTavern 卡导入（P1 导入保全）
  // 两种载荷：JSON 卡 body 直接传；PNG 卡 multipart/form-data 的 file 字段（内嵌 chara/ccv3）。
  app.post("/api/cards/import-st", async (c) => {
    try {
      let jsonRaw: unknown;
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("multipart/form-data")) {
        const form = await c.req.parseBody();
        const file = form["file"];
        if (!(file instanceof File)) {
          return c.json({ error: "multipart body must contain a 'file' field" }, 400);
        }
        const pngBuffer = Buffer.from(await file.arrayBuffer());
        jsonRaw = extractCharacterCardFromPng(pngBuffer);
      } else {
        jsonRaw = await c.req.json();
      }

      const result = await deps.cardStore.importStCard(jsonRaw);
      return c.json(
        {
          cardId: result.cardId,
          worldbookEntries: result.worldbookEntries,
          compat: {
            spec: result.compatReport.spec,
            specVersion: result.compatReport.specVersion,
            stats: result.compatReport.stats
          }
        },
        201
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("PNG") || message.includes("chara")) {
        return c.json({ error: `Not a SillyTavern card: ${message}` }, 400);
      }
      if (message.includes("missing required 'name'")) {
        return c.json({ error: message }, 400);
      }
      console.error("Failed to import ST card:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/cards/:cardId/st/original —— 不可变原版 JSON
  app.get("/api/cards/:cardId/st/original", async (c) => {
    const cardId = c.req.param("cardId");
    try {
      const original = await deps.cardStore.readStOriginal(cardId);
      if (original === null) {
        return c.json({ error: `Card has no ST original: ${cardId}` }, 404);
      }
      return c.json(original, 200);
    } catch (err) {
      console.error("Failed to read ST original:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/cards/:cardId/st/compat —— 字段级兼容报告
  app.get("/api/cards/:cardId/st/compat", async (c) => {
    const cardId = c.req.param("cardId");
    try {
      const report = await deps.cardStore.readStCompatReport(cardId);
      if (report === null) {
        return c.json({ error: `Card has no compat report: ${cardId}` }, 404);
      }
      return c.json(report, 200);
    } catch (err) {
      console.error("Failed to read compat report:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/cards/:cardId/worldbook —— 世界书投影
  app.get("/api/cards/:cardId/worldbook", async (c) => {
    const cardId = c.req.param("cardId");
    try {
      const worldbook = await deps.cardStore.readWorldbook(cardId);
      if (worldbook === null) {
        return c.json({ entries: [] }, 200);
      }
      return c.json(worldbook, 200);
    } catch (err) {
      console.error("Failed to read worldbook:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/sessions
  app.post("/api/sessions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = CreateSessionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    try {
      const result = await deps.cardStore.createSession(parsed.data.cardId);
      return c.json({ sessionId: result.sessionId }, 201);
    } catch (err) {
      console.error("Failed to create session:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/sessions/:sessionId/tree
  app.get("/api/sessions/:sessionId/tree", async (c) => {
    const sessionId = c.req.param("sessionId");
    const cardId = c.req.query("cardId");
    if (!cardId || cardId.trim().length === 0) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }

    try {
      const tree = await deps.cardStore.replay(cardId, sessionId);
      return c.json(tree, 200);
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT" || (err instanceof Error && err.message.toLowerCase().includes("not found"))) {
        return c.json({ error: `Session tree not found: ${sessionId}` }, 404);
      }
      console.error("Failed to replay session tree:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/runs —— 走 ChatEngine 完整回合（组装→生成→落地→管家）
  app.post("/api/runs", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const parsed = StartRunSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    try {
      const runRecord = await deps.chatEngine.startTurn(parsed.data as StartRunInput);
      return c.json({ run: runRecord }, 202);
    } catch (err) {
      if (err instanceof Error && err.name === "TurnConflictError") {
        return c.json({ error: "A turn is already in progress for this session" }, 409);
      }
      console.error("Failed to start run:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/runs/:runId
  app.get("/api/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    try {
      const run = await deps.runManager.getRun(runId);
      if (!run) {
        return c.json({ error: `Run not found: ${runId}` }, 404);
      }
      return c.json({ run }, 200);
    } catch (err) {
      console.error("Failed to get run:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/runs/:runId/cancel
  app.post("/api/runs/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    try {
      const cancelled = await deps.runManager.cancelRun(runId);
      return c.json({ cancelled }, 200);
    } catch (err) {
      console.error("Failed to cancel run:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // GET /api/runs/:runId/events (SSE)
  app.get("/api/runs/:runId/events", handleRunEventsSSE(deps.runManager));

  // GET /api/sessions?cardId=... —— 列出卡片全部会话
  app.get("/api/sessions", async (c) => {
    const cardId = c.req.query("cardId");
    if (!cardId || cardId.trim().length === 0) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }
    try {
      const sessions = await deps.cardStore.listSessions(cardId);
      return c.json({ sessions }, 200);
    } catch (err) {
      console.error("Failed to list sessions:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/sessions/:sessionId/floors —— 追加楼层（用户手动编辑或外部注入）
  app.post("/api/sessions/:sessionId/floors", async (c) => {
    const sessionId = c.req.param("sessionId");
    const cardId = c.req.query("cardId");
    if (!cardId) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = AppendFloorSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      const ev = await deps.cardStore.appendFloor(cardId, sessionId, parsed.data);
      return c.json({ event: ev }, 201);
    } catch (err) {
      console.error("Failed to append floor:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/sessions/:sessionId/floors/:floorId/swipe —— 重掷该楼
  app.post("/api/sessions/:sessionId/floors/:floorId/swipe", async (c) => {
    const sessionId = c.req.param("sessionId");
    const floorId = c.req.param("floorId");
    const cardId = c.req.query("cardId");
    if (!cardId) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = SwipeFloorSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      const ev = await deps.cardStore.swipeFloor(cardId, sessionId, { floorId, content: parsed.data.content });
      return c.json({ event: ev }, 201);
    } catch (err) {
      console.error("Failed to swipe floor:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/sessions/:sessionId/floors/:floorId/edit —— 编辑楼内容
  app.post("/api/sessions/:sessionId/floors/:floorId/edit", async (c) => {
    const sessionId = c.req.param("sessionId");
    const floorId = c.req.param("floorId");
    const cardId = c.req.query("cardId");
    if (!cardId) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = EditFloorSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      const ev = await deps.cardStore.editFloor(cardId, sessionId, { floorId, content: parsed.data.content });
      return c.json({ event: ev }, 201);
    } catch (err) {
      console.error("Failed to edit floor:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/sessions/:sessionId/rollback —— 回退到指定楼
  app.post("/api/sessions/:sessionId/rollback", async (c) => {
    const sessionId = c.req.param("sessionId");
    const cardId = c.req.query("cardId");
    if (!cardId) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const parsed = RollbackSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    try {
      const ev = await deps.cardStore.rollback(cardId, sessionId, parsed.data.toFloorId);
      return c.json({ event: ev }, 201);
    } catch (err) {
      console.error("Failed to rollback:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  // POST /api/sessions/:sessionId/undo-rollback —— 撤销最近回退
  app.post("/api/sessions/:sessionId/undo-rollback", async (c) => {
    const sessionId = c.req.param("sessionId");
    const cardId = c.req.query("cardId");
    if (!cardId) {
      return c.json({ error: "Missing required query parameter: cardId" }, 400);
    }
    try {
      const ev = await deps.cardStore.undoRollback(cardId, sessionId);
      return c.json({ event: ev }, 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes("No rollback event found")) {
        return c.json({ error: "No rollback event found to undo" }, 409);
      }
      console.error("Failed to undo rollback:", err);
      return c.json({ error: "Internal Server Error" }, 500);
    }
  });

  return app;
}
