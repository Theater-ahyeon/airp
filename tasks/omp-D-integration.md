# 任务书 D · AIRP 阶段 2「真实装配 + 端到端集成验收」

你是资深 Node/TypeScript 工程师。前三路工作（存储地基 `src/runtime/store` 系列、服务器骨架 `src/runtime/server/**`、生成生命周期 `src/runtime/session/**`）已分别交付并通过各自单测，但它们**从未被真实接线在一起**——目前服务器的路由测试用的是内存 fake。本任务把它们装配成可运行的本地服务器，并用**真实依赖**跑通端到端链路。

## 一、先读

1. `src/runtime/contracts.ts` —— 冻结契约（`ServerConfig`、`ServerDeps`、`CardStoreFacade`、`RunManagerFacade`、`CredentialStore`）。
2. `src/runtime/card-store.ts` —— `CardStore` 构造函数：`new CardStore(customHome?, snapshotInterval?)`。
3. `src/runtime/session/run-manager.ts`、`src/runtime/session/run-store.ts`、`src/runtime/session/mock-port.ts`、`src/runtime/session/index.ts` —— RunManager 的构造方式与导出。
4. `src/runtime/server/app.ts`、`launch.ts`、`security.ts`、`sse.ts` —— `createApp(config, deps)` 与 `startServer(config, deps)`。
5. `src/runtime/credentials/key-store.ts` —— 凭据存储后端。
6. `docs/runtime/阶段2-*.md` 三份交付文档。
7. `项目实现步骤蓝图.md` —— 阶段 2 的 4 条任务与 5 项退出条件。
8. `probes/stage2-probe.mjs` —— 架构层的对抗性探针（可参考其运行方式）。

## 二、文件边界

允许创建/修改：

- `src/runtime/bootstrap.ts`
- `bin/airp.mjs`
- `tests/runtime/integration/*.test.ts`
- `docs/runtime/阶段2-集成与端到端.md`

**严禁修改**：`src/runtime/contracts.ts`、`src/core/**`、`tests/core/**`、`scripts/**`、`tsconfig.json`、`vitest.config.ts`、`package.json`（bin 字段由架构层添加）、三份根文档、`probes/**`、`tasks/**`。

若接线过程中发现上游实现有**阻塞性缺陷**（例如某个门面方法行为与契约不符导致无法装配），允许做**最小修复**，但必须在交付文档中单列「上游缺陷修复」一节，写明文件、行号、缺陷、修复、影响面。**不允许顺手重构上游代码。**

注意：`src/runtime/card-store.ts` 与 `tests/runtime/store/**` 可能正被并行同事修复（撤销回退正确性），**不要修改它们**。

## 三、实现要求

### 1. `src/runtime/bootstrap.ts`

```ts
export interface BootstrapOptions {
  home?: string;          // 覆盖 AIRP_HOME
  port?: number;          // 默认 0 或约定默认端口
  snapshotInterval?: number;
  modelPort?: ModelStreamPort;  // 注入用；默认用 session 层的假模型端口
}

export interface BootstrapResult {
  config: ServerConfig;
  deps: ServerDeps;
  url: string;            // 含 token 的完整访问 URL
  port: number;           // 真实端口（端口回退后的）
  token: string;
  credentials: CredentialStore;
  close(): Promise<void>;
}

export async function bootstrap(options?: BootstrapOptions): Promise<BootstrapResult>;
```

硬要求：

- `allowedOrigins` 必须使用**真实端口**构造（`http://127.0.0.1:<真实端口>`、`http://localhost:<真实端口>`）。`startServer` 端口回退后端口会变，**必须在拿到真实端口后再计算 allowedOrigins**——这是已知的接线陷阱，写错会导致同源 POST 请求被自己的 Origin 校验拦掉。请为此写一条测试。
- `deps` 用真实的 `CardStore` 与 `RunManager`（不是 fake）。
- `close()` 必须关闭 HTTP 服务器并释放订阅/定时器，可重复调用不报错。
- 不自动打开浏览器、不调用任何外部命令。

### 2. `bin/airp.mjs`

- ESM 可执行入口，支持 `--port <n>`、`--home <path>`。
- 启动后打印 `AIRP listening on <url>`（url 含 token），并提示"令牌仅本机可用，不要分享"。
- `SIGINT` / `SIGTERM` 优雅关闭后退出，退出码 0。
- 用 `process.on("unhandledRejection")` 兜底打印错误并非零退出，不要静默吞错。
- 通过 `import("../dist/runtime/bootstrap.js")` 或 `../src/runtime/bootstrap.ts` 均可，但必须在你交付时**实际可运行**——请在文档里给出确切的运行命令与真实输出。

### 3. 端到端集成测试（`tests/runtime/integration/`）

用真实装配（`bootstrap()` + 真实 `fetch`），**不得使用 fake**，覆盖：

1. 健康检查：带正确 token → 200；无 token → 403；错误 token → 403。
2. 安全边界：`Origin: http://evil.example` → 403；`Host: evil.example` → 403。
3. 主链路：`POST /api/cards` → `POST /api/sessions` → `POST /api/runs` → `GET /api/runs/:runId/events` 收 SSE → 断言收到的 `run_delta` 拼接文本等于 `GET /api/runs/:runId` 返回的 `run.text`。
4. 断线 reattach：在流进行中断开 SSE 连接，稍后用 `?from=<已收到最大 seq>` 重连，断言能补齐剩余事件且**不重不漏**（seq 连续）。
5. 持久化往返：`GET /api/cards/:cardId/export` → `POST /api/cards/import?newCardId=xxx` → 对新卡 `GET /api/sessions/:sessionId/tree?cardId=xxx` → 断言楼层树与源卡一致。
6. 取消：`POST /api/runs` 后 `POST /api/runs/:runId/cancel` → 断言 `cancelled: true` 且 `run.text` 保留已生成部分（非空）。
7. `close()` 后端口释放（能再次 `bootstrap` 到同一端口）。

测试必须使用临时 `AIRP_HOME`（`fs.mkdtemp`）与临时端口，不得污染用户真实 `~/.airp`。

## 四、验收命令（仓库根目录）

```
pnpm build            # 零错误
pnpm test             # 全量全绿
pnpm check:isolation  # PASS
node probes/stage2-probe.mjs   # 5/5（若因并行修复尚未完成而为 3/5，如实注明，不要改探针）
```

## 五、交付物

1. `src/runtime/bootstrap.ts`、`bin/airp.mjs`、集成测试。
2. `docs/runtime/阶段2-集成与端到端.md`：
   - 装配图（bootstrap 如何把 store / session / server / credentials 串起来）
   - 真实端口 → allowedOrigins 的顺序说明
   - 端到端测试清单与运行证据（命令 + 关键输出摘录）
   - `bin/airp.mjs` 的真实运行输出（贴原始日志）
   - 上游缺陷修复清单（若有）
   - 已知限制与阶段 3 注意事项
3. 文档末尾「执行总结」小节：≤25 行中文总结（改动文件、命令实际结果、遗留问题）。

要求：所有断言必须有真实运行证据，禁止只写"应当通过"。若某项确实无法在当前阶段验证，明确写出原因与后续验证方案，不要伪装通过。
