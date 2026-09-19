// src/runtime/server/launch.ts
// AIRP HTTP 服务启动器实现。
// 支持 EADDRINUSE 自动端口回退（最多向后重试 10 次），返回监听端口与控制句柄。

import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import type { ServerConfig, ServerDeps } from "../contracts.js";
import { createApp } from "./app.js";

export interface StartedServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * 启动 AIRP 本地服务。
 * 遇到 EADDRINUSE 端口冲突时自动递增重试（最多 10 次）。
 */
export async function startServer(config: ServerConfig, deps: ServerDeps): Promise<StartedServer> {
  const maxRetries = 10;
  const initialPort = config.port;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const currentPort = initialPort + attempt;
    const currentConfig: ServerConfig = {
      ...config,
      port: currentPort,
    };

    const app = createApp(currentConfig, deps);

    try {
      const server = await new Promise<ServerType>((resolve, reject) => {
        let isResolved = false;
        let srv: ServerType | null = null;

        const errorHandler = (err: unknown) => {
          if (!isResolved) {
            isResolved = true;
            if (srv) {
              try {
                srv.close();
              } catch {
                // ignore
              }
            }
            reject(err);
          }
        };

        try {
          srv = serve(
            {
              fetch: app.fetch,
              hostname: "127.0.0.1",
              port: currentPort,
            },
            () => {
              if (!isResolved) {
                isResolved = true;
                if (srv) {
                  srv.removeListener("error", errorHandler);
                  resolve(srv);
                }
              }
            }
          );
          srv.once("error", errorHandler);
        } catch (err) {
          errorHandler(err);
        }
      });

      const url = `http://127.0.0.1:${currentPort}/?token=${currentConfig.token}`;
      console.log(`AIRP listening on ${url}`);
      console.log("提示：启动令牌仅本机可用，切勿分享给他人或泄露到公共网络。");

      return {
        port: currentPort,
        url,
        close: async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((err) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          });
        },
      };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "EADDRINUSE" && attempt < maxRetries) {
        // 端口被占用，尝试下一个端口
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to bind server after ${maxRetries} retries starting from port ${initialPort}`);
}
