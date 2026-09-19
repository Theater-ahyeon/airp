// src/runtime/server/security.ts
// AIRP 本地安全边界实现：Host 校验、Origin 校验、Token 校验与定长时序安全比较。

import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { ServerConfig } from "../contracts.js";

/**
 * 定长时序安全字符串比较。
 * 为防止通过 timing 泄漏输入长度，采用定长填充路径：
 * 当长度不同时，依然对固定长度/对齐缓冲区执行 crypto.timingSafeEqual，最后返回 false。
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");

  const maxLength = Math.max(bufA.length, bufB.length, 1);
  const padA = Buffer.alloc(maxLength, 0);
  const padB = Buffer.alloc(maxLength, 0);

  bufA.copy(padA);
  bufB.copy(padB);

  // 无论长度是否一致，都做恒定长度 timingSafeEqual 计算，不提前 return
  const isEqual = crypto.timingSafeEqual(padA, padB);
  return isEqual && bufA.length === bufB.length;
}

/**
 * 提取请求中的 Token。
 * 优先级：
 * 1. X-AIRP-Token 请求头
 * 2. ?token= 查询参数（EventSource / SSE 不支持自定义头，必须支持 query）
 */
export function extractToken(req: Request | { header: (name: string) => string | undefined; url: string }): string | null {
  let headerVal: string | null = null;
  let urlStr = "";

  if ("header" in req && typeof req.header === "function") {
    headerVal = req.header("x-airp-token") ?? req.header("X-AIRP-Token") ?? null;
    urlStr = req.url;
  } else if ("headers" in req && req.headers && typeof req.headers.get === "function") {
    headerVal = req.headers.get("x-airp-token");
    urlStr = req.url;
  }

  if (headerVal && headerVal.trim().length > 0) {
    return headerVal.trim();
  }

  try {
    const url = new URL(urlStr, "http://127.0.0.1");
    const queryToken = url.searchParams.get("token");
    if (queryToken && queryToken.trim().length > 0) {
      return queryToken.trim();
    }
  } catch {
    // 忽略非法 URL 解析
  }

  return null;
}

/**
 * 校验请求的 Origin。
 * 契约规则：
 * - Origin 缺失（同源导航、curl、测试、非跨域普通请求）→ 允许
 * - Origin 存在时，必须严格属于白名单，否则拒绝
 */
export function isAllowedOrigin(origin: string | undefined | null, allowedOrigins: string[]): boolean {
  if (!origin || origin.trim().length === 0) {
    return true;
  }
  return allowedOrigins.includes(origin.trim());
}

/**
 * 校验 Host 头，防止 DNS rebinding 攻击。
 * 仅允许本机回环地址：
 * - 127.0.0.1:<port> 或 127.0.0.1
 * - localhost:<port> 或 localhost
 * - [::1]:<port> 或 [::1]
 */
export function isAllowedHost(hostHeader: string | undefined | null, port: number): boolean {
  if (typeof hostHeader !== "string" || hostHeader.trim().length === 0) {
    return false;
  }
  const host = hostHeader.trim().toLowerCase();
  const allowed: Record<string, true> = {
    [`127.0.0.1:${port}`]: true,
    "127.0.0.1": true,
    [`localhost:${port}`]: true,
    "localhost": true,
    [`[::1]:${port}`]: true,
    "[::1]": true,
  };

  return allowed[host] === true;
}

/**
 * 生成 32 字节高熵随机启动令牌。
 */
export function generateStartToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * 创建 Hono 安全边界中间件。
 * 执行顺序：Host 校验 → Origin 校验 → Token 校验。
 * 失败返回 403 { error: string }，严禁在响应中回显期望的 token。
 */
export function createSecurityMiddleware(
  config: Pick<ServerConfig, "token" | "port" | "allowedOrigins">
): MiddlewareHandler {
  return async (c: Context, next) => {
    // 1. Host 校验
    const host = c.req.header("host");
    if (!isAllowedHost(host, config.port)) {
      return c.json({ error: "Forbidden: invalid Host header" }, 403);
    }

    // 2. Origin 校验
    const origin = c.req.header("origin");
    if (!isAllowedOrigin(origin, config.allowedOrigins)) {
      return c.json({ error: "Forbidden: origin not allowed" }, 403);
    }

    // 3. Token 校验
    const token = extractToken(c.req);
    if (!token || !timingSafeEqualString(token, config.token)) {
      return c.json({ error: "Forbidden: invalid or missing start token" }, 403);
    }

    await next();
  };
}
