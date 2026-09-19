// src/runtime/bootstrap.ts
// AIRP 运行时装配与启动引导入口。
// 接线 CardStore、RunManager、CredentialStore 与 HTTP 服务。

import net from "node:net";
import path from "node:path";
import type {
  ServerConfig,
  ServerDeps,
  ModelStreamPort,
  CredentialStore,
} from "./contracts.js";
import { CardStore } from "./card-store.js";
import { RunManager } from "./session/run-manager.js";
import { MockModelPort } from "./session/mock-port.js";
import { EncryptedFileCredentialStore, probeOsKeychain } from "./credentials/key-store.js";
import { generateStartToken } from "./server/security.js";
import { startServer } from "./server/launch.js";
import type { StartedServer } from "./server/launch.js";
import { resolveAirpHome } from "./paths.js";

export interface BootstrapOptions {
  home?: string; // 覆盖 AIRP_HOME
  port?: number; // 默认 0 或约定默认端口
  snapshotInterval?: number;
  modelPort?: ModelStreamPort; // 注入用；默认用 session 层的假模型端口
}

export interface BootstrapResult {
  config: ServerConfig;
  deps: ServerDeps;
  url: string; // 含 token 的完整访问 URL
  port: number; // 真实端口（端口回退后的）
  token: string;
  credentials: CredentialStore;
  close(): Promise<void>;
}

/**
 * 在 127.0.0.1 上探查一个可用的空闲端口。
 */
async function findAvailablePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = net.createServer();
  srv.unref();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    if (addr && typeof addr === "object") {
      const port = addr.port;
      srv.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve(port);
        }
      });
    } else {
      srv.close(() => reject(new Error("Failed to get ephemeral port address")));
    }
  });
  return promise;
}

/**
 * 装配并启动 AIRP 本地服务。
 */
export async function bootstrap(options?: BootstrapOptions): Promise<BootstrapResult> {
  const airpHome = options?.home ? path.resolve(options.home) : resolveAirpHome();
  const token = generateStartToken();

  // 1. 初始化凭据存储
  const keychainBackend = await probeOsKeychain();
  const credentials = new EncryptedFileCredentialStore(airpHome, keychainBackend);

  // 2. 初始化持久化存储与会话管理器（真实依赖，非 fake）
  const cardStore = new CardStore(airpHome, options?.snapshotInterval);
  const modelPort = options?.modelPort ?? new MockModelPort();
  const runManager = new RunManager(cardStore, modelPort);

  // 启动时恢复未完成的 Run
  await runManager.recoverOnBoot();

  const deps: ServerDeps = {
    cardStore,
    runManager,
  };

  // 3. 确定起始端口：如果 options?.port 未指定或为 0，先获取一个动态可用端口
  let initialPort = options?.port ?? 3000;
  if (initialPort === 0) {
    initialPort = await findAvailablePort();
  }

  // 4. 探查并启动服务器。
  // 注意接线陷阱：startServer 在端口冲突时会回退到 port + attempt。
  // 而 securityMiddleware 的 isAllowedOrigin 是在 createApp 时读取 config.allowedOrigins 固化的。
  // 若传入 startServer 的 config.allowedOrigins 端口与最终回退后的真实端口不一致，
  // 携带 Origin 的合法本地跨域/同源请求会被拦截 (403)。
  // 因此我们在启动前先探测首个可用端口，将 startServer 的 allowedOrigins 设为真实端口。
  let serverInstance: StartedServer | null = null;
  let boundPort = initialPort;

  // 循环最多重试 10 次，每次探测可用端口并用该端口构造 allowedOrigins
  const maxRetries = 10;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const candidatePort = initialPort + attempt;
    const allowedOrigins = [
      `http://127.0.0.1:${candidatePort}`,
      `http://localhost:${candidatePort}`,
    ];

    const config: ServerConfig = {
      token,
      port: candidatePort,
      host: "127.0.0.1",
      allowedOrigins,
      airpHome,
    };

    try {
      serverInstance = await startServer(config, deps);
      boundPort = serverInstance.port;

      // 如果 startServer 发生过额外端口回退且与 candidatePort 不一致，
      // 说明发生了二次占用并跳到了更大端口，此时必须关闭并用真实端口重建确保 allowedOrigins 匹配
      if (serverInstance.port !== candidatePort) {
        await serverInstance.close();
        // 用真实端口重新绑定
        const correctOrigins = [
          `http://127.0.0.1:${serverInstance.port}`,
          `http://localhost:${serverInstance.port}`,
        ];
        const correctConfig: ServerConfig = {
          ...config,
          port: serverInstance.port,
          allowedOrigins: correctOrigins,
        };
        serverInstance = await startServer(correctConfig, deps);
        boundPort = serverInstance.port;
      }

      break;
    } catch (err: unknown) {
      lastError = err;
      const code = (err as { code?: string })?.code;
      if (code === "EADDRINUSE" && attempt < maxRetries) {
        continue;
      }
      throw err;
    }
  }

  if (!serverInstance) {
    throw lastError ?? new Error(`Failed to bind server starting from port ${initialPort}`);
  }

  const finalConfig: ServerConfig = {
    token,
    port: boundPort,
    host: "127.0.0.1",
    allowedOrigins: [
      `http://127.0.0.1:${boundPort}`,
      `http://localhost:${boundPort}`,
    ],
    airpHome,
  };

  let closed = false;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = null;
    }
  };

  return {
    config: finalConfig,
    deps,
    url: serverInstance.url,
    port: boundPort,
    token,
    credentials,
    close,
  };
}
