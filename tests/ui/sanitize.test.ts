// @vitest-environment jsdom
// tests/ui/sanitize.test.ts
//
// vitest.config.ts 默认 environment 为 "node"，本文件必须显式声明 jsdom：
// src/ui/sanitize.ts 在有 window/document 的环境走真 DOMPurify 路径
//（实际解析的 dompurify 版本为 3.4.15），仅在无 window 的纯 node 环境退化为
// 内置正则 fallback。该 fallback 只是降级手段，并非安全边界——node 环境实测其
// 原样放行 <svg onload=...> 与实体编码的 jav&#x09;ascript:、data:text/html 向量，
// 对 javascript: 也只做字面量删除（输出 href="alert(1)"）。
// 浏览器与 jsdom 环境一律走 DOMPurify，本文件全部断言针对这条真实路径。
// node 侧契约（实测确认，无需 mock）：dompurify 工厂在无 window 时不暴露
// .sanitize，resolvePurifier 返回 null，fallback 按预期生效。
import { describe, it, expect } from "vitest";
import DOMPurify from "dompurify";
import { sanitizeHtml } from "../../src/ui/sanitize.js";

describe("Frontend Security: DOMPurify Sanitize", () => {
  it("环境守卫：jsdom 下 DOMPurify 可用，测试走真实净化路径而非正则 fallback", () => {
    // 若本文件头部指令失效（如被删除或环境被改回 node），dompurify 在无 window
    // 环境不暴露 .sanitize，sanitizeHtml 会退化到可绕过的正则 fallback，
    // 下方全部 XSS 断言随之失真——此守卫让这种退化显式失败而非静默通过。
    expect(DOMPurify.isSupported).toBe(true);
    expect(typeof DOMPurify.sanitize).toBe("function");
  });

  it("XSS 防御：script / svg onload / iframe / img 全部剥离（含事件属性）", () => {
    // <script> 整体（含内容）剥离，其余结构保留（实测：DOMPurify 3.4.15 输出）
    expect(sanitizeHtml("<p>正常内容</p><script>alert('xss')</script>")).toBe("<p>正常内容</p>");
    // 大小写混合的 script 标签同样整体剥离（HTML 标签名大小写不敏感）
    expect(sanitizeHtml("<ScRipt>alert(1)</ScRipt>后文")).toBe("后文");

    // <svg onload=...>：svg 不在 ALLOWED_TAGS，整个子树被移除（实测输出 "后文"）。
    // 注意：该向量是旧正则 fallback 实测原样放行的向量——此断言成立本身
    // 即证明本文件运行在真 DOMPurify 路径上，而非可绕过的 fallback。
    const svgOut = sanitizeHtml('<svg onload="alert(1)"><circle r="1"/></svg>后文');
    expect(svgOut).toBe("后文");
    expect(svgOut).not.toContain("<svg");
    expect(svgOut).not.toContain("onload");

    // <iframe> 不在 ALLOWED_TAGS，整体剥离（实测输出 "正文"）
    const iframeOut = sanitizeHtml('<iframe src="https://evil.example"></iframe>正文');
    expect(iframeOut).toBe("正文");
    expect(iframeOut).not.toContain("<iframe");
    expect(iframeOut).not.toContain("src");

    // <img> 不在 ALLOWED_TAGS：标签剥离，前后文本保留；onerror 不得存活
    expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).toBe("");
    const imgOut = sanitizeHtml('<p>前<img src="x" onerror="alert(1)">后</p>');
    expect(imgOut).toBe("<p>前后</p>");
    expect(imgOut).not.toContain("<img");
    expect(imgOut).not.toContain("onerror");
  });

  it("XSS 防御：javascript: / 实体编码变体 / data: 伪协议不得存活", () => {
    // 直写 javascript: —— 实测：DOMPurify 移除危险 href 属性，保留 <a> 元素与文字。
    // （旧正则 fallback 对此向量只删 "javascript:" 字面量，实测输出 href="alert(1)"）
    const jsOut = sanitizeHtml('<a href="javascript:alert(1)">点击领取</a>');
    expect(jsOut).toBe("<a>点击领取</a>");
    expect(jsOut).not.toContain("javascript");
    expect(jsOut).not.toContain("alert(1)");

    // 实体编码变体：jav&#x09;ascript: 在 HTML 属性解码后为 "jav\tascript:"。
    // 旧正则 fallback 实测原样放行此向量（正则只匹配字面量 "javascript:"）；
    // DOMPurify 在解码后的属性值上校验协议，实测剥离整个 href。
    const entityOut = sanitizeHtml('<a href="jav&#x09;ascript:alert(1)">点击</a>');
    expect(entityOut).toBe("<a>点击</a>");
    expect(entityOut).not.toContain("ascript");
    expect(entityOut).not.toContain("alert(1)");

    // data:text/html 载荷 —— 旧 fallback 实测放行（href="data:text/html,..." 存活）；
    // DOMPurify 默认 URI 白名单不含 data:，实测剥离整个 href。
    const dataOut = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">点击</a>');
    expect(dataOut).toBe("<a>点击</a>");
    expect(dataOut).not.toContain("data:");
    expect(dataOut).not.toContain("<script");
  });

  it("XSS 防御：允许标签上的事件属性剥离，标签与内容保留", () => {
    // onload/onerror 不在 ALLOWED_ATTR（实测：属性移除，元素保留）
    expect(sanitizeHtml('<p onload="alert(1)">段落</p>')).toBe("<p>段落</p>");
    expect(sanitizeHtml('<p onerror="alert(1)">文本</p>')).toBe("<p>文本</p>");
  });

  it("合法 HTML 格式与排版标签保全", () => {
    const safeContent = "<h1>标题</h1><p>正文内容，<strong>加粗</strong> 与 <em>斜体</em></p>";
    expect(sanitizeHtml(safeContent)).toBe(safeContent);

    // 白名单标签（b/i/code/p...）结构原样保留；a 的安全 https href 保留
    //（实测输出与输入逐字一致）
    const mixed =
      '<p>段落 <b>加粗</b> <i>斜体</i> <code>code</code> <a href="https://example.com">链接</a></p>';
    const out = sanitizeHtml(mixed);
    expect(out).toBe(mixed);
    expect(out).toContain('<a href="https://example.com">链接</a>');
  });

  it("P2 扩展标签保全：允许 div、table、style 作用域用于状态栏与卡内组件展示", () => {
    const tableAndDiv = '<div class="status-panel"><table style="color: red;"><tbody><tr><td>HP</td><td>100</td></tr></tbody></table></div>';
    const out = sanitizeHtml(tableAndDiv);
    expect(out).toContain('<div class="status-panel">');
    expect(out).toContain('<table style="color: red;">');
    expect(out).toContain('<td>HP</td>');
    expect(out).toContain('<td>100</td>');
  });
});
