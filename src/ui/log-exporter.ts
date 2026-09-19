// src/ui/log-exporter.ts
// Redacted debug log exporter to protect sensitive keys and local paths.

export interface DebugLogExportInput {
  cardId: string;
  sessionId: string;
  events: Array<Record<string, unknown>>;
  runtimeConfig: Record<string, unknown>;
}

export function exportSanitizedDebugLog(input: DebugLogExportInput): string {
  const sensitivePatterns = [
    /Bearer\s+[A-Za-z0-9_-]+/gi,
    /token=[A-Za-z0-9_-]+/gi,
    /sk-[A-Za-z0-9_-]+/gi,
    /[A-Z]:\\[^"'\n\r\t]+/gi,
    /\/home\/[^"'\n\r\t]+/gi,
    /\/Users\/[^"'\n\r\t]+/gi
  ];

  let raw = JSON.stringify(input, null, 2);

  for (const pat of sensitivePatterns) {
    raw = raw.replace(pat, "[REDACTED]");
  }

  return raw;
}
