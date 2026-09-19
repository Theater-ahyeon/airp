import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { streamSimple as streamOpenAI } from "@earendil-works/pi-ai/api/openai-completions";

const sockets = new Set();
const server = http.createServer(async (req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  await new Promise((r) => req.on("end", r));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta) => `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta }] })}\n\n`;
  for (let i = 0; i < 40; i++) {
    const ok = res.write(chunk({ content: `w${i}` }));
    console.log(`server wrote w${i} ok=${ok} destroyed=${res.destroyed} closed=${res.closed}`);
    await sleep(100);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});
server.on("connection", (s) => { sockets.add(s); s.on("close", () => { console.log("SOCKET CLOSED"); sockets.delete(s); }); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const model = { id: "m", name: "M", api: "openai-completions", provider: "mock", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 };
const ctrl = new AbortController();
for await (const ev of streamOpenAI(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, { apiKey: "k", signal: ctrl.signal })) {
  if (ev.type === "text_delta") { console.log("client: aborting now"); ctrl.abort(); }
  if (ev.type === "error") { console.log("client: error event, stopReason path hit"); break; }
}
await sleep(1500);
console.log("open sockets after 1.5s:", sockets.size, "getConnections:", await new Promise((r) => server.getConnections((e, n) => r(n))));
server.close();
process.exit(0);
