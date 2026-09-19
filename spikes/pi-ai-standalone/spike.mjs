// Spike 0.1 — verify @earendil-works/pi-ai standalone as AIRP ModelPort.
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`); };

let abortSeenByServer = false;
const server = http.createServer(async (req, res) => {
  if (!(req.method === "POST" && req.url === "/v1/chat/completions")) { res.writeHead(404); res.end(); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  await new Promise((r) => req.on("end", r));
  const payload = JSON.parse(body);
  if (!abortSeenByServer) record("mock收到stream请求", payload.stream === true, `model=${payload.model} messages=${payload.messages.length}`);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, extra = {}) => `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
  let closed = false;
  req.on("close", () => { closed = true; abortSeenByServer = true; });
  const parts = ["你好", "，这是", "流式回复。"];
  for (let i = 0; i < parts.length; i++) {
    res.write(chunk({ role: i === 0 ? "assistant" : undefined, content: parts[i] }));
    await sleep(80);
    if (closed) return; // client aborted mid-stream
  }
  res.write(chunk({}, { finish_reason: "stop" }));
  res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290, prompt_tokens_details: { cached_tokens: 1024 } } })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});
server.on("connection", (s) => s.on("close", () => { abortSeenByServer = true; }));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const model = { id: "mock-model", name: "Mock", api: "openai-completions", provider: "mock", baseUrl, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

// Test 1: streaming + usage
{
  const events = []; let text = ""; let doneMsg = null;
  for await (const ev of streamOpenAI(model, context, { apiKey: "mock-key" })) {
    events.push(ev.type);
    if (ev.type === "text_delta") text += ev.delta;
    if (ev.type === "done") doneMsg = ev.message ?? null;
  }
  record("流式事件序列", events[0] === "start" && events.includes("done"), events.join(","));
  record("流式内容完整", text === "你好，这是流式回复。", JSON.stringify(text));
  const u = doneMsg?.usage;
  record("usage元数据(input含缓存拆分)", !!u && (u.input + u.cacheRead) === 1234 && u.output === 56, JSON.stringify(u));
  record("缓存token可见", !!u && u.cacheRead === 1024, `cacheRead=${u?.cacheRead}`);
}

// Test 2: AbortSignal mid-stream
{
  abortSeenByServer = false;
  const ctrl = new AbortController();
  const events = []; let terminated = false;
  try {
    for await (const ev of streamOpenAI(model, context, { apiKey: "mock-key", signal: ctrl.signal })) {
      events.push(ev.type);
      if (ev.type === "text_delta" && !ctrl.signal.aborted) ctrl.abort();
      if (ev.type === "error") terminated = true;
    }
  } catch { terminated = true; }
  let waited = 0; while (!abortSeenByServer && waited < 2500) { await sleep(100); waited += 100; }
  const noDone = !events.includes("done");
  record("取消终止流(无done)", terminated || noDone, `events=${events.join(",")}`);
  record("取消传导到HTTP连接", abortSeenByServer, `server saw close=${abortSeenByServer}`);
}

// Test 3: other adapters (structural)
record("anthropic适配器存在", typeof streamAnthropic === "function", "api/anthropic-messages#streamSimple");
record("google适配器存在", typeof streamGoogle === "function", "api/google-generative-ai#streamSimple");

// Test 4: standalone (no pi-coding-agent)
let hasDep = false;
try { await import("@earendil-works/pi-coding-agent"); hasDep = true; } catch { }
record("无pi-coding-agent依赖", !hasDep, "standalone OK");

server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n== 结论: ${failed.length === 0 ? "全部通过 (" + results.length + " 项)" : failed.length + " 项失败"} ==`);
process.exit(failed.length === 0 ? 0 : 1);



