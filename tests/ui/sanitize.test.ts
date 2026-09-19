// tests/ui/sanitize.test.ts
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/ui/sanitize.js";

describe("Frontend Security: DOMPurify Sanitize", () => {
  it("XSS 用例防御：过滤有害 script、onerror、javascript: 伪协议", () => {
    const maliciousScript = "<p>正常内容</p><script>alert('xss')</script>";
    expect(sanitizeHtml(maliciousScript)).toBe("<p>正常内容</p>");

    const maliciousImg = '<img src="x" onerror="alert(1)">';
    expect(sanitizeHtml(maliciousImg)).toBe("");

    const maliciousLink = '<a href="javascript:alert(1)">点击领取</a>';
    const cleanLink = sanitizeHtml(maliciousLink);
    expect(cleanLink).not.toContain("javascript:");
  });

  it("合法 HTML 格式与排版标签保全", () => {
    const safeContent = "<h1>标题</h1><p>正文内容，<strong>加粗</strong> 与 <em>斜体</em></p>";
    expect(sanitizeHtml(safeContent)).toBe(safeContent);
  });
});
