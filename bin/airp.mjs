#!/usr/bin/env node
// bin/airp.mjs
// AIRP 命令行可执行入口（纯 JavaScript ESM）。

import process from "node:process";
import { parseArgs } from "node:util";

process.on("unhandledRejection", (reason) => {
  console.error("AIRP 发生未捕获异常:", reason);
  process.exit(1);
});

async function main() {
  const { values } = parseArgs({
    options: {
      port: {
        type: "string",
        short: "p",
      },
      home: {
        type: "string",
      },
      help: {
        type: "boolean",
        short: "h",
      },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`用法: airp [options]

选项:
  -p, --port <n>    指定监听端口 (默认 3000，冲突自动顺延)
      --home <path> 指定 AIRP_HOME 目录 (默认 ~/.airp)
  -h, --help        显示帮助信息
`);
    process.exit(0);
  }

  let port;
  if (values.port) {
    const parsed = Number.parseInt(values.port, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
      console.error(`错误: 非法端口号 "${values.port}"`);
      process.exit(1);
    }
    port = parsed;
  }

  const home = values.home;

  // 动态引入编译产物或源码
  let bootstrap;
  try {
    const mod = await import("../dist/runtime/bootstrap.js");
    bootstrap = mod.bootstrap;
  } catch {
    const mod = await import("../src/runtime/bootstrap.js");
    bootstrap = mod.bootstrap;
  }

  const server = await bootstrap({
    port,
    home,
  });

  let shuttingDown = false;
  const gracefulShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在优雅关闭 AIRP 服务...`);
    try {
      await server.close();
      console.log("AIRP 服务已关闭。");
      process.exit(0);
    } catch (err) {
      console.error("关闭服务时出错:", err);
      process.exit(1);
    }
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
