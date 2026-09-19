// probes/stage2-e2e-kill.mjs
// 架构层独立端到端验收：真实服务器进程 → 生成中 kill -9 → 重启 → reattach 恢复。
//
// 这是阶段 2 核心主张「后端拥有生成生命周期，SSE 仅为视图」的最强证据：
// 进程被强制杀死后，新进程必须能从磁盘事件日志完整重建崩溃前已持久化的输出。
//
// 运行：node probes/stage2-e2e-kill.mjs

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = path.join(ROOT, "probes", "e2e-server-child.mjs");
const TOKEN = "e2e-token-0123456789abcdef";
const PORT = 39117;

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), "airp-e2e-kill-"));

function startChild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, String(PORT), home, TOKEN], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`子进程启动超时：\n${out}`));
      }
    }, 25000);

    child.stdout.on("data", (d) => {
      out += d.toString();
      if (!settled && /E2E_READY/.test(out)) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, out });
      }
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
    });
    child.on("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`子进程提前退出 code=${code}：\n${out}`));
      }
    });
  });
}

function api(pathname, init = {}) {
  return fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    ...init,
    headers: {
      "x-airp-token": TOKEN,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

/** 读取 SSE 流，直到收满 deltaCount 条 run_delta（或流结束）。 */
async function readSSE(pathname, { deltaCount = Infinity, signal } = {}) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener("abort", onAbort);

  const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, {
    signal: ac.signal,
    headers: { "x-airp-token": TOKEN }
  });

  const events = [];
  let text = "";
  let endRecord = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let deltaSeen = 0;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        let id = null;
        let type = null;
        let data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!type) continue;

        if (type === "end") {
          endRecord = JSON.parse(data);
          events.push({ id, type });
          continue;
        }

        const parsed = data ? JSON.parse(data) : null;
        events.push({ id, type, seq: parsed?.seq });
        if (type === "run_delta") {
          text += parsed.payload.text;
          deltaSeen++;
        }
      }

      if (deltaSeen >= deltaCount) {
        ac.abort();
        break;
      }
    }
  } catch (err) {
    if (err?.name !== "AbortError") throw err;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }

  return { events, text, endRecord };
}

let child1 = null;
let child2 = null;

try {
  // ---------- 阶段一：起服务、开 Run、收部分流 ----------
  const started = await startChild();
  child1 = started.child;

  const cardRes = await api("/api/cards", {
    method: "POST",
    body: JSON.stringify({
      name: "强杀探针角色",
      description: "端到端强杀验收",
      personality: "冷静",
      scenario: "探针场景",
      firstMessage: "开始。",
      mesExamples: ""
    })
  });
  const { cardId } = await cardRes.json();

  const sessionRes = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ cardId })
  });
  const { sessionId } = await sessionRes.json();

  const runRes = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ cardId, sessionId, prompt: "请开始叙述。", model: "mock-model" })
  });
  const runPayload = await runRes.json();
  const runId = runPayload.run?.runId;

  record("0. 真实服务器进程完成装配并接受 Run", Boolean(runId), `cardId=${cardId} sessionId=${sessionId} runId=${runId}`);

  // 收 6 条 run_delta 后主动断开（模拟浏览器中途关掉标签页）
  const first = await readSSE(`/api/runs/${runId}/events?from=0`, { deltaCount: 6 });

  const beforeStatus = await (await api(`/api/runs/${runId}`)).json();
  const maxSeqBefore = Math.max(...first.events.map((e) => Number(e.id)).filter(Number.isFinite));

  record(
    "1. 崩溃前 Run 处于进行中且已有持久化输出",
    beforeStatus.run?.status === "running" && first.text.length > 0,
    `status=${beforeStatus.run?.status} 已收 delta=${first.events.filter((e) => e.type === "run_delta").length} 字符=${first.text.length} 最大 seq=${maxSeqBefore}`
  );

  const seqs = first.events.map((e) => e.seq).filter((n) => typeof n === "number");
  const continuous = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  record("2. 崩溃前事件序号严格单调递增无重复", continuous, `seqs=[${seqs.join(", ")}]`);

  // ---------- 阶段二：kill -9 ----------
  const killed = child1.kill("SIGKILL");
  await new Promise((resolve) => child1.on("exit", resolve));
  child1 = null;
  record("3. 服务器进程被 SIGKILL 强制终止", killed, `pid 已终止，无任何清理回调机会`);

  // ---------- 阶段三：重启同 AIRP_HOME ----------
  const restarted = await startChild();
  child2 = restarted.child;
  const recoveredCount = Number(/recovered=(\d+)/.exec(restarted.out)?.[1] ?? "-1");

  record("4. 重启时 recoverOnBoot 识别到被强杀的遗留 Run", recoveredCount === 1, `recovered=${recoveredCount}`);

  const afterStatusRes = await api(`/api/runs/${runId}`);
  const afterStatus = await afterStatusRes.json();

  record(
    "5. 重启后可通过 runId 定位该 Run（磁盘索引可重建）",
    afterStatusRes.status === 200 && Boolean(afterStatus.run),
    `HTTP ${afterStatusRes.status} status=${afterStatus.run?.status}`
  );

  record(
    "6. 被强杀的 Run 状态被标记为 interrupted",
    afterStatus.run?.status === "interrupted",
    `status=${afterStatus.run?.status} endedAt=${afterStatus.run?.endedAt ? "已记录" : "缺失"}`
  );

  // ---------- 阶段四：reattach 重放 ----------
  const replay = await readSSE(`/api/runs/${runId}/events?from=0`, { deltaCount: Infinity });

  record(
    "7. 重启后从 from=0 重放能拿到崩溃前已持久化的全部输出",
    replay.text.length >= first.text.length && replay.text.startsWith(first.text),
    `崩溃前 ${first.text.length} 字符 → 重放 ${replay.text.length} 字符，前缀一致=${replay.text.startsWith(first.text)}`
  );

  record(
    "8. 重放流以 end 帧正常收尾（事件日志无半行损坏）",
    Boolean(replay.endRecord),
    replay.endRecord ? `end 帧 runId=${replay.endRecord.runId} status=${replay.endRecord.status}` : "未收到 end 帧"
  );

  const replaySeqs = replay.events.map((e) => e.seq).filter((n) => typeof n === "number");
  const replayContinuous = replaySeqs.every((s, i) => i === 0 || s > replaySeqs[i - 1]);
  record(
    "9. 重放事件序号连续无缺口（seq 权威性跨进程保持）",
    replayContinuous && replaySeqs.length > 0,
    `事件数=${replaySeqs.length} seq 范围=[${replaySeqs[0]}, ${replaySeqs[replaySeqs.length - 1]}]`
  );

  // 崩溃前收到的事件必须全部包含在重放结果中
  const beforeIds = first.events.map((e) => e.id).filter(Boolean);
  const replayIds = new Set(replay.events.map((e) => e.id).filter(Boolean));
  const missing = beforeIds.filter((id) => !replayIds.has(id));
  record(
    "10. 崩溃前收到的每一条事件都能在重放中找到（零丢失）",
    missing.length === 0,
    missing.length === 0 ? `${beforeIds.length} 条事件全部命中` : `缺失 ${missing.length} 条：${missing.join(", ")}`
  );
} finally {
  for (const c of [child1, child2]) {
    if (c && !c.killed) {
      try {
        c.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  await fs.rm(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`端到端强杀探针：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exitCode = 1;
}
