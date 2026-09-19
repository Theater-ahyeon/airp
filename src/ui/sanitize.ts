// src/ui/sanitize.ts
import DOMPurify from "dompurify";

interface SanitizeCallable {
  sanitize(source: string, options?: unknown): string;
}

function resolvePurifier(candidate: unknown): SanitizeCallable | null {
  // dompurify 的默认导出是可调用工厂（typeof === "function"，.sanitize 挂在实例上）。
  // 旧代码只接受 object 形态，导致 DOMPurify 分支在**所有**环境（含真实浏览器）
  // 都是死代码，永远走可绕过的正则 fallback——审查 M-7 升级缺陷，此处修复。
  // node 无 window 时 dompurify 工厂无 .sanitize，仍按预期退回 fallback。
  if (!candidate) return null;
  if (typeof candidate === "function" || typeof candidate === "object") {
    if ("sanitize" in candidate && typeof candidate.sanitize === "function") {
      return candidate as SanitizeCallable;
    }
  }
  if (candidate && typeof candidate === "object" && "default" in candidate) {
    const inner = (candidate as { default?: unknown }).default;
    if (inner && typeof inner === "object" && "sanitize" in inner && typeof inner.sanitize === "function") {
      return inner as SanitizeCallable;
    }
  }
  return null;
}

export function sanitizeHtml(dirty: string): string {
  if (!dirty) return "";
  const purifier = resolvePurifier(DOMPurify);
  if (purifier) {
    return purifier.sanitize(dirty, {
      ALLOWED_TAGS: [
        "b", "i", "em", "strong", "a", "p", "br", "code", "pre",
        "ul", "ol", "li", "span", "blockquote", "h1", "h2", "h3", "h4"
      ],
      ALLOWED_ATTR: ["href", "target", "class", "rel"],
    });
  }
  return dirty
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/javascript:/gi, "");
}
