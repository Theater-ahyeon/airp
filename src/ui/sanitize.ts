// src/ui/sanitize.ts
import DOMPurify from "dompurify";

interface SanitizeCallable {
  sanitize(source: string, options?: unknown): string;
}

function resolvePurifier(candidate: unknown): SanitizeCallable | null {
  if (!candidate || typeof candidate !== "object") return null;
  if ("sanitize" in candidate && typeof candidate.sanitize === "function") {
    return candidate as SanitizeCallable;
  }
  if ("default" in candidate && candidate.default && typeof candidate.default === "object") {
    const inner = candidate.default;
    if ("sanitize" in inner && typeof inner.sanitize === "function") {
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
