# 任务书 C · AIRP 阶段 2「本地服务器骨架 + 本地安全 + 凭据存储」

你是一名资深 Node/TypeScript 工程师，负责实现 AIRP 项目的本地 HTTP 服务器骨架、本地安全边界与 API key 凭据存储。这是一次**真实交付**：所有安全断言必须有自动化测试证明。

## 一、先读这些文件（权威输入）

1. `总设计案.md` —— 重点：Core Spine 第 6 条、**安全红线**（API key 加密存储、localhost 来源校验/启动令牌、模型输出渲染前消毒）。
2. `项目实现步骤蓝图.md` —— 重点：**阶段 2** 第 4 条任务与退出条件。
3. `NEXT.md` —— 当前进度。
4. `src/runtime/contracts.ts` —— **架构层冻结契约**。`ServerConfig`、`ServerDeps`、`CardStoreFacade`、`RunManagerFacade`、`CredentialStore`、`RunEventSink` 全部按此文件使用。
5. `src/core/types/*.ts` —— 阶段 1 纯领域层，可 import，**禁止修改**。

## 二、你的文件边界（只准动这些）

允许创建/修改：

- `src/runtime/server/app.ts`
- `src/runtime/server/security.ts`
- `src/runtime/server/sse.ts`
- `src/runtime/server/launch.ts`
- `src/runtime/credentials/key-store.ts`
- `tests/runtime/server/*.test.ts`
- `docs/runtime/阶段2-服务器骨架.md`

**严禁修改**：`package.json`、`tsconfig.json`、`vitest.config.ts`、`src/runtime/contracts.ts`、`src/core/**`、`tests/core/**`、`scripts/**`、`总设计案.md`、`项目实现步骤蓝图.md`、`NEXT.md`，以及 `src/runtime/store/**`、`src/runtime/paths.ts`、`src/runtime/event-log.ts`、`src/runtime/snapshot-store.ts`、`src/runtime/migrations.ts`、`src/runtime/card-store.ts`、`src/runtime/session/**`（并行同事的地盘）。

**可用依赖**：`hono@4.13.8`、`@hono/node-server@2.1.1`（已安装）、`node:*`、`zod`。**禁止新增依赖**；确需新依赖写进报告，不要自己装。

**禁止 git 操作**。

## 三、必须实现的内容

### 1. `security.ts` —— 本地安全边界

- `timingSafeEqualString(a, b): boolean`：用 `node:crypto` 的 `timingSafeEqual` 做**定长时序安全比较**（长度不同也走等长填充路径，不要提前 return 泄露长度）。
- `extractToken(req): string | null`：优先 `X-AIRP-Token` 请求头，其次 `?token=` 查询参数（SSE 场景浏览器 `EventSource` 无法自定义头，必须支持查询参数）。
- `isAllowedOrigin(origin, allowedOrigins): boolean`：`Origin` 缺失（同源导航、curl、测试）→ 允许；存在时必须在白名单内，否则拒绝。
- `isAllowedHost(hostHeader, port): boolean`：只允许 `127.0.0.1:<port>`、`localhost:<port>`、`[::1]:<port>`；其他一律拒绝（防 DNS rebinding）。
- `createSecurityMiddleware(config)`：Hono 中间件，按顺序执行 Host 校验 → Origin 校验 → Token 校验；失败返回 403，body 为 `{ error: string }`，**不得**在错误信息中回显期望的 token。
- `generateStartToken(): string`：`crypto.randomBytes(32).toString("base64url")`。

### 2. `app.ts` —— Hono 应用（路由表钉死，不得改名）

```
GET  /api/health                     → 200 { ok: true, schemaVersion, airpHome, startedAt, pid }
GET  /api/cards                      → 200 { cards: CardSummary[] }
POST /api/cards                      → 201 { cardId }         body: CharacterAttributes 对象
GET  /api/cards/:cardId              → 200 { meta, original, workingCopy }
GET  /api/cards/:cardId/export       → 200 ExportBundle（Content-Type: application/json）
POST /api/cards/import               → 201 { cardId }         body: ExportBundle，可选 ?newCardId=
POST /api/sessions                   → 201 { sessionId }      body: { cardId }
GET  /api/sessions/:sessionId/tree   → 200 ReplayResult       query: cardId 必填
POST /api/runs                       → 202 { run: RunRecord } body: StartRunInput
GET  /api/runs/:runId                → 200 { run: RunRecord }
POST /api/runs/:runId/cancel         → 200 { cancelled: boolean }
GET  /api/runs/:runId/events         → 200 text/event-stream（SSE，见下）
```

- `createApp(config: ServerConfig, deps: ServerDeps)`：返回 Hono 实例。所有 `/api/*` 走安全中间件。
- 入参用 zod 校验，非法入参返回 400 `{ error }`；未捕获异常返回 500 `{ error }` 且**不泄露堆栈到响应体**（写 `console.error` 即可）。
- 不存在的路由返回 404 JSON。
- 额外挂一个 `GET /` 返回极简占位 HTML（阶段 4 前的前端占位），内容里带上启动令牌的说明，不得内联真实密钥。

### 3. `sse.ts` —— SSE 视图（不是权威状态）

- 端点：`GET /api/runs/:runId/events`
- 客户端可带 `?from=<seq>` 或 `Last-Event-ID` 头（后者优先），表示"我已经收到 seq 之前的事件，请从 seq+1 开始补"。
- 服务端调用 `runManager.subscribe(runId, fromSeq, sink)`：
  - `sink.onEvent(ev)` → 写帧：`id: <seq>\n` + `event: <type>\n` + `data: <JSON>\n\n`。
  - `sink.onEnd(record)` → 写一帧 `event: end` + `data: <RunRecord JSON>`，然后结束流。
- 每 15 秒发一次 `: keepalive\n\n` 注释帧防代理超时。
- 客户端断开（`req.raw.signal` abort）时必须调用退订函数，**不得泄漏订阅**（有测试断言退订被调用）。
- 关键语义：**SSE 只是视图**。断线重连后靠 `from` 重放已持久化事件即可恢复完整输出，服务器不需要保留内存缓冲才能正确服务。这一点要在报告里写明设计理由。

### 4. `launch.ts` —— 启动器

- `startServer(config: ServerConfig, deps: ServerDeps)`：用 `@hono/node-server` 的 `serve()`，`hostname: "127.0.0.1"`，返回 `{ port, url, close(): Promise<void> }`。
- 端口占用时（`EADDRINUSE`）自动向 `port + 1` 重试，最多 10 次，并在返回的 `url` 中体现真实端口。
- 启动日志打印：`AIRP listening on http://127.0.0.1:<port>/?token=<token>`，以及"令牌仅本机可用、不要分享"的提示。
- **不自动打开浏览器**（阶段 4 才做），不要调用任何外部命令。

### 5. `key-store.ts` —— API key 凭据存储（`CredentialStore` 实现）

- 优先尝试 OS keychain：在 macOS 探测 `security` 命令、Linux 探测 `secret-tool` 是否可用（用 `node:child_process` 的 `execFile` 探测，**探测失败或不存在时静默回退**，不要抛错、不要安装任何东西）。探测结果决定 `backend` 取值。
- Windows（`process.platform === "win32"`）当前环境不接 keychain，`backend` 如实报告 `"encrypted-file"`。
- 加密文件回退：`<AIRP_HOME>/credentials.enc`，AES-256-GCM：
  - 密钥文件 `<AIRP_HOME>/.airp-key`（首次生成 32 字节随机，`mode: 0o600`），不存在则创建。
  - 文件格式：`{ "v": 1, "iv": "<base64>", "tag": "<base64>", "data": "<base64>" }`，`data` 是 `{ [name]: value }` 的密文。
  - 每次 `setSecret` 重新生成 iv（绝不复用）。
- 接口：`getSecret(name)`、`setSecret(name, value)`、`deleteSecret(name)`、`readonly backend`。
- **验收硬要求**：`setSecret("openai", "sk-test-xxx")` 之后，`credentials.enc` 的**原始字节中不得出现明文**（测试用 `fs.readFile` 后 `toString()` 断言 `not.toContain("sk-test-xxx")`），且 `getSecret` 能读回一致值。

## 四、工程约束

- ESM + `"module": "NodeNext"`：**所有相对 import 必须带 `.js` 后缀**。
- TypeScript strict 零错误；不用 `any` 兜底，不用 `@ts-ignore`。
- 注释用中文，简洁。
- 测试用 vitest；每个测试用 `fs.mkdtemp` 建独立临时 `AIRP_HOME`，用 `os.tmpdir()` 下的临时端口（先监听 0 端口拿端口号，或直接对 `app.request()` 发请求）。
- `CardStoreFacade` 与 `RunManagerFacade` 的**测试替身写在你自己的测试文件里**（内存 fake），不要引入 store/session 层的实现（那是并行同事未完成的文件）。生产接线由架构层在集成阶段完成。

## 五、验收标准（缺一不可，且必须留下证据）

1. **Token 缺失/错误 → 403**，`/api/health` 在带正确 token 时 200。
2. **Origin 校验**：`Origin: http://evil.example` → 403；`Origin: http://127.0.0.1:<port>` → 200；无 Origin → 200。
3. **Host 校验**：`Host: evil.example` → 403（防 DNS rebinding）。
4. **时序安全比较**：长度不同、内容不同的输入都返回 `false` 且不抛错。
5. **路由契约**：用内存 fake 跑通 `/api/cards`、`/api/cards/:id/export`、`/api/runs`、`/api/runs/:id`、`/api/runs/:id/cancel`，状态码与 body 形状符合上文表格。
6. **SSE reattach**：先写入 N 条 run 事件，再带 `?from=3` 连接，必须**只**收到 seq > 3 的事件帧，帧格式含 `id:`/`event:`/`data:`；Run 结束后收到 `event: end`。
7. **SSE 退订**：客户端断开后，fake `runManager` 记录到退订被调用（用 `AbortController` 主动 abort 触发）。
8. **凭据加密**：明文不落盘 + 读回一致 + iv 每次不同。
9. **端口回退**：占用某端口后 `startServer` 能成功落到 `port+1`。

命令（仓库根目录 `E:\agentcoding\airpbuild`）：

```
pnpm build            # tsc -b，必须零错误
pnpm test             # 全量测试必须全绿
pnpm check:isolation  # 必须 PASS
```

如果 `pnpm build` 因**并行同事尚未完成的文件**（`src/runtime/store/**`、`src/runtime/session/**`）而失败，不要修改那些文件，在报告里注明；你自己的文件必须零错误。

## 六、交付物

1. 上述实现文件与测试文件。
2. `docs/runtime/阶段2-服务器骨架.md`：文件清单与职责、路由表、安全模型说明（三条防线各自的攻击面与对策）、SSE reattach 时序说明、凭据加密格式说明、测试用例清单与结果、验收点 1-9 的逐条证据（命令 + 关键输出摘录）、契约缺口（若有）、已知限制。
3. 在文档末尾「执行总结」小节追加 ≤30 行中文总结：改动文件、`pnpm build`/`pnpm test` 实际结果、遗留问题。

开始前先读契约文件；实现中若发现契约与需求冲突，以「不修改 contracts.ts、在报告中记录缺口」为准则。
