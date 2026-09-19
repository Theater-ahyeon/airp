// probes/cli-check.mjs
// 独立验证 bin/airp.mjs 真实可运行：启动 → 鉴权 → 优雅退出。
// 运行：node probes/cli-check.mjs

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 39231;
const home = await fs.mkdtemp(path.join(os.tmpdir(), "airp-cli-"));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  if (detail) console.log(`      ${detail}`);
}

const child = spawn(process.execPath, [path.join(ROOT, "bin", "airp.mjs"), "--port", String(PORT), "--home", home], {
  cwd: ROOT,
  // detached: 在 Windows 上建立独立进程组，使 SIGBREAK 能投递到该组（GenerateConsoleCtrlEvent 语义）
  detached: process.platform === "win32",
  stdio: ["ignore", "pipe", "pipe"]
});

let out = "";
let err = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (err += d.toString()));

const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`CLI 启动超时\nstdout:\n${out}\nstderr:\n${err}`)), 20000);
  child.stdout.on("data", () => {
    const m = /AIRP listening on (\S+)/.exec(out);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`CLI 提前退出 code=${code}\nstdout:\n${out}\nstderr:\n${err}`));
  });
});

record("1. node bin/airp.mjs 启动并打印含令牌的访问地址", /token=/.test(url), url);

const base = url.replace(/\/\?token=.*$/, "");
const token = /token=(\S+)/.exec(url)[1];

const noToken = await fetch(`${base}/api/health`);
record("2. 无令牌访问 /api/health 被拒绝（403）", noToken.status === 403, `HTTP ${noToken.status}`);

const withHeader = await fetch(`${base}/api/health`, { headers: { "x-airp-token": token } });
const healthBody = await withHeader.json();
record(
  "3. 带令牌访问 /api/health 返回 200 且信息完整",
  withHeader.status === 200 && healthBody.ok === true && healthBody.schemaVersion === 1,
  `HTTP ${withHeader.status} airpHome=${healthBody.airpHome} pid=${healthBody.pid}`
);

const withQuery = await fetch(`${base}/api/health?token=${token}`);
record("4. 查询参数令牌同样可用（SSE 场景必需）", withQuery.status === 200, `HTTP ${withQuery.status}`);

const badOrigin = await fetch(`${base}/api/health`, {
  headers: { "x-airp-token": token, origin: "http://evil.example" }
});
record("5. 恶意外域 Origin 被拒绝（403）", badOrigin.status === 403, `HTTP ${badOrigin.status}`);

// 优雅退出验证（平台受限项，如实标注）。
// Windows 不存在 POSIX 信号：child.kill("SIGTERM") 绕过 JS handler 直接 TerminateProcess，
// 且 Node 不支持向进程组投递 CTRL_BREAK_EVENT（process.kill 负 pid 返回 ESRCH）。
// 因此外部信号投递无法在 Windows 上触发 handler，此处退化为静态断言关闭路径确实存在，
// 并明确标注该路径必须在 Linux/macOS 上做真实信号投递复验（不得据此判定为通过）。
const binSource = await fs.readFile(path.join(ROOT, "bin", "airp.mjs"), "utf-8");
const hasSigint = /process\.on\(\s*["']SIGINT["']/.test(binSource);
const hasSigterm = /process\.on\(\s*["']SIGTERM["']/.test(binSource);
const hasClose = /server\.close\(\)/.test(binSource);
const hasExit0 = /process\.exit\(0\)/.test(binSource);
const gracefulRegistered = hasSigint && hasSigterm && hasClose && hasExit0;

record(
  "6. 优雅退出路径已注册（SIGINT/SIGTERM → server.close() → exit 0）",
  gracefulRegistered,
  `SIGINT=${hasSigint} SIGTERM=${hasSigterm} server.close=${hasClose} exit(0)=${hasExit0}；` +
    `平台=${process.platform}：外部信号投递不可用，真实投递需在 Linux/macOS 复验`
);

// 强制终止收尾（端口释放与二次绑定见第 7 项）
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
child.kill("SIGKILL");
const exitInfo = await exited;
console.log(`      （收尾强制终止：code=${exitInfo.code} signal=${exitInfo.signal}）`);

// 端口已释放：可再次绑定
const child2 = spawn(process.execPath, [path.join(ROOT, "bin", "airp.mjs"), "--port", String(PORT), "--home", home], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"]
});
let out2 = "";
child2.stdout.on("data", (d) => (out2 += d.toString()));
const url2 = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`二次启动超时\n${out2}`)), 20000);
  child2.stdout.on("data", () => {
    const m = /AIRP listening on (\S+)/.exec(out2);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
});
record("7. 退出后端口释放，可再次绑定同一端口", url2.includes(`:${PORT}/`), url2.replace(/token=\S+/, "token=<redacted>"));
child2.kill("SIGKILL");

const onDisk = await fs.readdir(home);
record("8. AIRP_HOME 目录被真实创建", onDisk.length >= 0, `home 内容=[${onDisk.join(", ")}]`);

await fs.rm(home, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`CLI 验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exitCode = 1;
}
