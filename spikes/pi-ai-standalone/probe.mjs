// Spike 0.2 — endpoint capability probe (four-tier degradation ladder) against mock endpoints.
import http from "node:http";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${detail}`); };

const server = http.createServer(async (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  await new Promise((r) => req.on("end", r));
  const payload = JSON.parse(body);
  const m2 = req.url.match(/^\/v1\/(tools|json|text)\/chat\/completions/); const mode = m2 ? m2[1] : null; console.log("REQ", req.url, "tools=" + !!payload.tools, "rf=" + !!payload.response_format);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const one = (delta, extra = {}) => `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
  const done = `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`;
  if (payload.tools && mode === "tools") {
    res.write(one({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "record_state", arguments: '{"ok":true}' } }] }));
    res.write(one({}, { finish_reason: "tool_calls" }));
  } else if (payload.tools) {
    res.write(one({ role: "assistant", content: "我不太明白你的意思。" }));
    res.write(one({}, { finish_reason: "stop" }));
  } else if (payload.response_format?.type === "json_object" && mode !== "text") {
    res.write(one({ role: "assistant", content: '{"ok":true}' }));
    res.write(one({}, { finish_reason: "stop" }));
  } else {
    res.write(one({ role: "assistant", content: '好的：```json\n{"ok":true}\n```' }));
    res.write(one({}, { finish_reason: "stop" }));
  }
  res.write(done);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const mkModel = (mode) => ({ id: "m", name: "M", api: "openai-completions", provider: "mock", baseUrl: `http://127.0.0.1:${port}/v1/${mode}`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 });
const tools = [{ name: "record_state", description: "记录状态", parameters: { type: "object", properties: { ok: { type: "boolean" } } } }];

async function collect(model, ctx, options) {
  const out = { text: "", toolCalls: [], error: null };
  try {
    for await (const ev of streamOpenAI(model, ctx, options)) {
      if (ev.type === "text_delta") out.text += ev.delta;
      if (ev.type === "toolcall_end") out.toolCalls.push(ev.toolCall);
      if (ev.type === "error") out.error = String(ev.error?.message ?? ev.error);
    }
  } catch (e) { out.error = String(e?.message ?? e); }
  return out;
}

async function detectCapability(model) {
  // Tier 1: tool calling（pi-ai 的结构化输出主路径）
  const ctx1 = { messages: [{ role: "user", content: "记录状态", timestamp: 1 }], tools };
  const t1 = await collect(model, ctx1, { apiKey: "k", toolChoice: "required" });
  if (!t1.error && t1.toolCalls.length > 0) return { tier: 1, label: "tool-calling" };
  // Tier 2: json mode（经 onPayload 注入 response_format）
  const ctx2 = { messages: [{ role: "user", content: "输出JSON", timestamp: 1 }] };
  const t2 = await collect(model, ctx2, { apiKey: "k", onPayload: (p) => ({ ...p, response_format: { type: "json_object" } }) });
  if (!t2.error) { try { JSON.parse(t2.text); return { tier: 2, label: "json-mode" }; } catch { } }
  // Tier 3: prompt + 解析
  const t3 = await collect(model, ctx2, { apiKey: "k" });
  if (!t3.error) { const m = t3.text.match(/```json\s*([\s\S]*?)```/); if (m) { try { JSON.parse(m[1]); return { tier: 3, label: "prompt+parse" }; } catch { } } }
  return { tier: 4, label: "disabled" };
}

for (const [mode, expectTier] of [["tools", 1], ["json", 2], ["text", 3]]) {
  const r = await detectCapability(mkModel(mode));
  record(`探测定级 mode=${mode}`, r.tier === expectTier, `got tier=${r.tier} (${r.label}), expect=${expectTier}`);
}
server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n== 结论: ${failed.length === 0 ? "探测阶梯逻辑全部通过 (" + results.length + " 项)" : failed.length + " 项失败"} ==`);
if (failed.length > 0) process.exitCode = 1;

