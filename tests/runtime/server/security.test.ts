// tests/runtime/server/security.test.ts
import { describe, it, expect } from "vitest";
import {
  timingSafeEqualString,
  isAllowedHost,
  isAllowedOrigin,
  extractToken,
  generateStartToken,
  createSecurityMiddleware,
} from "../../../src/runtime/server/security.js";
import { Hono } from "hono";

describe("security.ts 本地安全边界", () => {
  describe("验收标准 4: timingSafeEqualString", () => {
    it("相同字符串返回 true", () => {
      expect(timingSafeEqualString("secret-token-123456", "secret-token-123456")).toBe(true);
      expect(timingSafeEqualString("", "")).toBe(true);
    });

    it("不同长度输入返回 false 且不抛错（走定长填充路径）", () => {
      expect(timingSafeEqualString("short", "much-longer-string-with-different-length")).toBe(false);
      expect(timingSafeEqualString("much-longer-string-with-different-length", "short")).toBe(false);
      expect(timingSafeEqualString("", "not-empty")).toBe(false);
      expect(timingSafeEqualString("not-empty", "")).toBe(false);
    });

    it("相同长度不同内容输入返回 false 且不抛错", () => {
      expect(timingSafeEqualString("abcdef123456", "abcdef123457")).toBe(false);
      expect(timingSafeEqualString("111111", "222222")).toBe(false);
    });
  });

  describe("验收标准 3: isAllowedHost (防 DNS rebinding)", () => {
    const port = 8080;

    it("允许 127.0.0.1、localhost、[::1]（带端口或不带端口）", () => {
      expect(isAllowedHost(`127.0.0.1:${port}`, port)).toBe(true);
      expect(isAllowedHost("127.0.0.1", port)).toBe(true);
      expect(isAllowedHost(`localhost:${port}`, port)).toBe(true);
      expect(isAllowedHost("localhost", port)).toBe(true);
      expect(isAllowedHost(`[::1]:${port}`, port)).toBe(true);
      expect(isAllowedHost("[::1]", port)).toBe(true);
    });

    it("拒绝未知 Host（包含 evil.example、局域网 IP、错误端口等）", () => {
      expect(isAllowedHost("evil.example", port)).toBe(false);
      expect(isAllowedHost(`evil.example:${port}`, port)).toBe(false);
      expect(isAllowedHost("192.168.1.100:8080", port)).toBe(false);
      expect(isAllowedHost("127.0.0.1:9999", port)).toBe(false);
      expect(isAllowedHost(undefined, port)).toBe(false);
      expect(isAllowedHost("", port)).toBe(false);
    });
  });

  describe("验收标准 2: isAllowedOrigin", () => {
    const allowedOrigins = ["http://127.0.0.1:8080", "http://localhost:8080"];

    it("Origin 缺失时允许（同源导航、curl、测试等）", () => {
      expect(isAllowedOrigin(undefined, allowedOrigins)).toBe(true);
      expect(isAllowedOrigin(null, allowedOrigins)).toBe(true);
      expect(isAllowedOrigin("", allowedOrigins)).toBe(true);
    });

    it("白名单内 Origin 允许", () => {
      expect(isAllowedOrigin("http://127.0.0.1:8080", allowedOrigins)).toBe(true);
      expect(isAllowedOrigin("http://localhost:8080", allowedOrigins)).toBe(true);
    });

    it("恶意外域 Origin 拒绝", () => {
      expect(isAllowedOrigin("http://evil.example", allowedOrigins)).toBe(false);
      expect(isAllowedOrigin("https://attacker.com", allowedOrigins)).toBe(false);
      expect(isAllowedOrigin("http://127.0.0.1:9999", allowedOrigins)).toBe(false);
    });
  });

  describe("extractToken & generateStartToken", () => {
    it("generateStartToken 返回 32 字节 base64url 格式字符串", () => {
      const token1 = generateStartToken();
      const token2 = generateStartToken();
      expect(token1).toBeTruthy();
      expect(token2).toBeTruthy();
      expect(token1).not.toBe(token2);
      expect(Buffer.from(token1, "base64url").length).toBe(32);
    });

    it("优先从 X-AIRP-Token 提取 token，其次从 ?token= 提取", () => {
      const reqHeader = new Request("http://127.0.0.1:8080/api/test?token=from-query", {
        headers: { "x-airp-token": "from-header" },
      });
      expect(extractToken(reqHeader)).toBe("from-header");

      const reqQuery = new Request("http://127.0.0.1:8080/api/test?token=from-query");
      expect(extractToken(reqQuery)).toBe("from-query");

      const reqNone = new Request("http://127.0.0.1:8080/api/test");
      expect(extractToken(reqNone)).toBe(null);
    });
  });

  describe("验收标准 1, 2, 3: createSecurityMiddleware 集成校验", () => {
    const port = 3456;
    const token = "correct-test-token-xyz";
    const allowedOrigins = [`http://127.0.0.1:${port}`];

    const app = new Hono();
    app.use(
      "/api/*",
      createSecurityMiddleware({
        port,
        token,
        allowedOrigins,
      })
    );
    app.get("/api/test", (c) => c.json({ ok: true }));

    it("正常请求（正确 Host, 无 Origin, 正确 Token）返回 200", async () => {
      const res = await app.request("http://127.0.0.1:3456/api/test", {
        headers: {
          Host: `127.0.0.1:${port}`,
          "X-AIRP-Token": token,
        },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ ok: true });
    });

    it("Host 非法时返回 403（防 DNS rebinding）", async () => {
      const res = await app.request("http://127.0.0.1:3456/api/test", {
        headers: {
          Host: "evil.example",
          "X-AIRP-Token": token,
        },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("Host");
      expect(data.error).not.toContain(token);
    });

    it("Origin 为恶意外域时返回 403", async () => {
      const res = await app.request("http://127.0.0.1:3456/api/test", {
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: "http://evil.example",
          "X-AIRP-Token": token,
        },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("origin");
      expect(data.error).not.toContain(token);
    });

    it("Origin 为合法白名单且正确 token 时返回 200", async () => {
      const res = await app.request("http://127.0.0.1:3456/api/test", {
        headers: {
          Host: `127.0.0.1:${port}`,
          Origin: `http://127.0.0.1:${port}`,
          "X-AIRP-Token": token,
        },
      });
      expect(res.status).toBe(200);
    });

    it("Token 缺失时返回 403", async () => {
      const res = await app.request("http://127.0.0.1:3456/api/test", {
        headers: {
          Host: `127.0.0.1:${port}`,
        },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("token");
      expect(data.error).not.toContain(token);
    });

    it("Token 错误时返回 403", async () => {
      const res = await app.request("http://127.0.0.1:3456/api/test", {
        headers: {
          Host: `127.0.0.1:${port}`,
          "X-AIRP-Token": "wrong-token",
        },
      });
      expect(res.status).toBe(403);
      const data = (await res.json()) as { error: string };
      expect(data.error).toContain("token");
      expect(data.error).not.toContain(token);
    });

    it("通过 ?token= 查询参数也能通过 token 校验", async () => {
      const res = await app.request(`http://127.0.0.1:3456/api/test?token=${token}`, {
        headers: {
          Host: `127.0.0.1:${port}`,
        },
      });
      expect(res.status).toBe(200);
    });
  });
});
