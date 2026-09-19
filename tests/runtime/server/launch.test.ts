// tests/runtime/server/launch.test.ts
// 验收标准 9: 端口回退（占用某端口后 startServer 能成功落到 port + 1）。
import net from "node:net";
import { describe, it, expect } from "vitest";
import { startServer } from "../../../src/runtime/server/launch.js";
import { FakeCardStore, FakeRunManager } from "./fakes.js";
import type { ServerConfig } from "../../../src/runtime/contracts.js";

describe("launch.ts 服务启动与端口回退", () => {
  it("验收标准 9: 端口被占用时，自动回退到 port + 1 并成功启动", async () => {
    // 1. 创建一个原生 TCP 服务器占用一个随机可用端口
    const blockerServer = net.createServer();
    const { promise: listenPromise, resolve: onListening } = Promise.withResolvers<number>();

    blockerServer.listen(0, "127.0.0.1", () => {
      const addr = blockerServer.address();
      if (addr && typeof addr === "object") {
        onListening(addr.port);
      }
    });

    const occupiedPort = await listenPromise;
    expect(occupiedPort).toBeGreaterThan(0);

    const fakeCardStore = new FakeCardStore("/tmp/airp-launch-test");
    const fakeRunManager = new FakeRunManager();

    const config: ServerConfig = {
      token: "launch-test-token",
      port: occupiedPort, // 传入被占用的端口
      host: "127.0.0.1",
      allowedOrigins: [`http://127.0.0.1:${occupiedPort + 1}`],
      airpHome: "/tmp/airp-launch-test",
    };

    // 2. 调用 startServer，预期自动回退到 occupiedPort + 1
    const started = await startServer(config, {
      cardStore: fakeCardStore,
      runManager: fakeRunManager,
    });

    try {
      expect(started.port).toBeGreaterThanOrEqual(occupiedPort + 1);
      expect(started.url).toBe(`http://127.0.0.1:${started.port}/?token=launch-test-token`);
      // 3. 测试向回退后的服务端口发送请求
      const res = await fetch(`http://127.0.0.1:${started.port}/api/health`, {
        headers: {
          Host: `127.0.0.1:${started.port}`,
          "X-AIRP-Token": "launch-test-token",
        },
      });
      expect(res.status).toBe(200);
      const data = (await res.json()) as { ok: boolean };
      expect(data.ok).toBe(true);
    } finally {
      // 4. 清理两个服务
      await started.close();
      await new Promise<void>((resolve) => blockerServer.close(() => resolve()));
    }
  });
});
