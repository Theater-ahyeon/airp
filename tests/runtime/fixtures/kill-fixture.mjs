// tests/runtime/fixtures/kill-fixture.mjs
// 跨进程强杀测试用的子进程 fixture。
// 启动一个 Run，在慢速流中持续写事件，并向父进程输出 READY 及 runId。

import { CardStore } from "../../../src/runtime/card-store.js";
import { RunManager } from "../../../src/runtime/session/run-manager.js";
import { MockModelPort } from "../../../src/runtime/session/mock-port.js";
import { MockModelAdapter } from "../../../src/core/adapters/mock-model.js";

const airpHome = process.env.AIRP_HOME;
if (!airpHome) {
  console.error("AIRP_HOME required");
  process.exit(1);
}

const cardId = "card_kill_target";
const sessionId = "sess_kill_target";

async function main() {
  const cardStore = new CardStore(airpHome);
  await cardStore.createCard({
    cardId,
    attributes: {
      name: "Kill Target Card",
      description: "desc",
      personality: "pers",
      scenario: "scen",
      mesExamples: "examples",
      systemPrompt: "system",
      firstMessage: "hello"
    }
  });
  // 构造一个会持续产生 200 个 delta、每个间隔 20ms 的慢速流
  const adapter = new MockModelAdapter();
  // 放入一段长文本（4 字符一组，共 200 片，总计 4 秒）
  const longText = "ABCD".repeat(200);
  adapter.enqueueResponse(longText);

  const modelPort = new MockModelPort({ adapter, deltaDelayMs: 20 });
  // 节流设为 100ms 或 50 字符
  const runManager = new RunManager(cardStore, modelPort, {
    intervalMs: 100,
    maxChunkSize: 50
  });

  const record = await runManager.startRun({
    cardId,
    sessionId,
    prompt: "Kill test prompt"
  });

  // 通知父进程 runId 与启动就绪
  console.log(`READY:${record.runId}`);

  // 保持进程运行，等待父进程强杀
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
