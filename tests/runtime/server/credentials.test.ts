// tests/runtime/server/credentials.test.ts
// 验收标准 8: 凭据加密（明文不落盘 + 读回一致 + iv 每次不同）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EncryptedFileCredentialStore,
  createCredentialStore,
  probeOsKeychain,
} from "../../../src/runtime/credentials/key-store.js";
describe("key-store.ts 凭据存储与加密", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-cred-test-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("探测 OS keychain，Windows 环境返回 encrypted-file，绝不抛错", async () => {
    const backend = await probeOsKeychain();
    expect(["os-keychain", "encrypted-file"]).toContain(backend);
    if (process.platform === "win32") {
      expect(backend).toBe("encrypted-file");
    }
  });

  it("验收标准 8: 明文不落盘 + 读回一致 + IV 每次不同", async () => {
    const store = new EncryptedFileCredentialStore(tempHome);
    const secretName = "openai";
    const secretVal1 = "sk-test-secret-value-1234567890abcdef";

    // 1. 写入 secret
    await store.setSecret(secretName, secretVal1);

    // 2. 读回一致
    const readBack1 = await store.getSecret(secretName);
    expect(readBack1).toBe(secretVal1);

    // 3. 验收硬要求：credentials.enc 原始字节中不得出现明文
    const encFilePath = path.join(tempHome, "credentials.enc");
    const rawContent1 = await fs.readFile(encFilePath, "utf-8");
    expect(rawContent1).not.toContain(secretVal1);
    expect(rawContent1).not.toContain("openai"); // key 名称也在 JSON 密文内，不得明文泄漏

    const parsed1 = JSON.parse(rawContent1) as { v: number; iv: string; tag: string; data: string };
    expect(parsed1.v).toBe(1);
    expect(parsed1.iv).toBeTruthy();
    expect(parsed1.tag).toBeTruthy();
    expect(parsed1.data).toBeTruthy();

    // 4. 再次写入更新值，检查 IV 每次不同（绝不复用 IV）
    const secretVal2 = "sk-test-secret-value-second-version";
    await store.setSecret(secretName, secretVal2);

    const readBack2 = await store.getSecret(secretName);
    expect(readBack2).toBe(secretVal2);

    const rawContent2 = await fs.readFile(encFilePath, "utf-8");
    expect(rawContent2).not.toContain(secretVal2);
    const parsed2 = JSON.parse(rawContent2) as { v: number; iv: string; tag: string; data: string };

    expect(parsed2.iv).not.toBe(parsed1.iv); // IV 必须全新生成

    // 5. 删除 secret
    const deleted = await store.deleteSecret(secretName);
    expect(deleted).toBe(true);
    expect(await store.getSecret(secretName)).toBe(null);

    const deletedAgain = await store.deleteSecret(secretName);
    expect(deletedAgain).toBe(false);
  });

  it("工厂函数 createCredentialStore 能正确实例化", async () => {
    const store = await createCredentialStore(tempHome);
    expect(store.backend).toBeDefined();
    await store.setSecret("anthropic", "ant-key-999");
    expect(await store.getSecret("anthropic")).toBe("ant-key-999");
  });
});
