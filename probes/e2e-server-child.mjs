// probes/e2e-server-child.mjs
// 端到端强杀探针的服务器子进程：真实装配 CardStore + RunManager + Hono 服务。
// 用法：node probes/e2e-server-child.mjs <port> <home> <token>

import { CardStore } from "../dist/runtime/card-store.js";
import { RunManager, MockModelPort } from "../dist/runtime/session/index.js";
import { ChatEngine } from "../dist/runtime/session/chat-engine.js";
import { MockModelAdapter } from "../dist/core/adapters/mock-model.js";
import { createApp } from "../dist/runtime/server/app.js";
import { startServer } from "../dist/runtime/server/launch.js";
const port = Number(process.argv[2]);
const home = process.argv[3];
const token = process.argv[4];

if (!Number.isInteger(port) || !home || !token) {
  console.error("usage: node e2e-server-child.mjs <port> <home> <token>");
  process.exit(2);
}

// 足够长的合成回复：假模型按 4 字符切片，deltaDelayMs=40 → 约 10 秒的慢速流
const LONG_REPLY = Array.from({ length: 60 }, (_, i) => `第${i + 1}段落：艾莉丝翻开泛黄的手札，纸页间浮起细碎的光尘。`).join("");

const store = new CardStore(home);
const adapter = new MockModelAdapter();
adapter.enqueueResponse(LONG_REPLY);
adapter.enqueueResponse(LONG_REPLY);

const modelPort = new MockModelPort({ adapter, deltaDelayMs: 40 });
const runManager = new RunManager(store, modelPort, { intervalMs: 80 });
const chatEngine = new ChatEngine(store, runManager, modelPort, adapter);

// 启动恢复：把上次进程崩溃时遗留的 queued/running Run 标记为 interrupted
const recovered = await runManager.recoverOnBoot();

const config = {
  token,
  port,
  host: "127.0.0.1",
  allowedOrigins: [`http://127.0.0.1:${port}`, `http://localhost:${port}`],
  airpHome: home
};
const deps = { cardStore: store, runManager, chatEngine };

const app = createApp(config, deps);
void app;

const server = await startServer(config, deps);
console.log(`E2E_READY port=${server.port} recovered=${recovered.length}`);
