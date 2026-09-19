import http from "node:http";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    console.log("REQ", req.method, req.url, "headers:", JSON.stringify(req.headers));
    console.log("BODY", body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: { role: "assistant", content: "你好" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "mock-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const model = { id: "mock-model", name: "Mock", api: "openai-completions", provider: "mock", baseUrl: `http://127.0.0.1:${port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };

const timeout = setTimeout(() => { console.log("TIMEOUT 8s — stream never terminated"); server.close(); process.exit(2); }, 8000);
const stream = streamOpenAI(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }, { apiKey: "mock-key" });
console.log("stream created");
for await (const ev of stream) {
  console.log("EVENT", ev.type, ev.type === "text_delta" ? ev.delta : ev.type === "error" ? String(ev.error?.message ?? ev.error) : "");
}
clearTimeout(timeout);
console.log("stream ended cleanly");
server.close();
process.exit(0);
