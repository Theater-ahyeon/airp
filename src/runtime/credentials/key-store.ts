// src/runtime/credentials/key-store.ts
// AIRP API key 凭据存储实现。
// 优先探测并使用 OS keychain，回退到基于 AES-256-GCM 的本地加密文件。

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CredentialStore } from "../contracts.js";

const pExecFile = promisify(execFile);

interface EncryptedPayload {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}
export async function probeOsKeychain(): Promise<"os-keychain" | "encrypted-file"> {
  if (process.platform === "win32") {
    return "encrypted-file";
  }

  if (process.platform === "darwin") {
    try {
      await pExecFile("security", ["help"]);
      return "os-keychain";
    } catch {
      return "encrypted-file";
    }
  }

  if (process.platform === "linux") {
    try {
      await pExecFile("secret-tool", ["--help"]);
      return "os-keychain";
    } catch {
      return "encrypted-file";
    }
  }

  return "encrypted-file";
}

/**
 * 基于 AES-256-GCM 加密文件的凭据存储实现。
 */
export class EncryptedFileCredentialStore implements CredentialStore {
  readonly backend: "os-keychain" | "encrypted-file";
  private readonly keyFilePath: string;
  private readonly encFilePath: string;
  private masterKey: Buffer | null = null;

  constructor(private readonly airpHome: string, backend: "os-keychain" | "encrypted-file" = "encrypted-file") {
    this.backend = backend;
    this.keyFilePath = path.join(this.airpHome, ".airp-key");
    this.encFilePath = path.join(this.airpHome, "credentials.enc");
  }

  /**
   * 获取或初始化 32 字节 master key。
   * 若不存在则生成随机密钥，文件模式 0o600。
   */
  private async getOrCreateMasterKey(): Promise<Buffer> {
    if (this.masterKey) {
      return this.masterKey;
    }

    try {
      const existing = await fs.readFile(this.keyFilePath);
      if (existing.length === 32) {
        this.masterKey = existing;
        return existing;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "ENOENT") {
        throw err;
      }
    }

    const newKey = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(this.keyFilePath), { recursive: true });
    await fs.writeFile(this.keyFilePath, newKey, { mode: 0o600 });
    this.masterKey = newKey;
    return newKey;
  }

  /**
   * 读取并解密整个凭据字典。
   */
  private async loadSecrets(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.encFilePath, "utf-8");
      const payload = JSON.parse(raw) as EncryptedPayload;
      if (payload.v !== 1 || !payload.iv || !payload.tag || !payload.data) {
        return {};
      }

      const key = await this.getOrCreateMasterKey();
      const iv = Buffer.from(payload.iv, "base64");
      const tag = Buffer.from(payload.tag, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload.data, "base64")),
        decipher.final(),
      ]);

      return JSON.parse(decrypted.toString("utf-8")) as Record<string, string>;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === "ENOENT") {
        return {};
      }
      throw err;
    }
  }

  /**
   * 加密并保存凭据字典。每次写入必须生成全新 IV。
   */
  private async saveSecrets(secrets: Record<string, string>): Promise<void> {
    const key = await this.getOrCreateMasterKey();
    const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const plaintext = Buffer.from(JSON.stringify(secrets), "utf-8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload: EncryptedPayload = {
      v: 1,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: encrypted.toString("base64"),
    };

    await fs.mkdir(path.dirname(this.encFilePath), { recursive: true });
    await fs.writeFile(this.encFilePath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  async getSecret(name: string): Promise<string | null> {
    const secrets = await this.loadSecrets();
    return secrets[name] ?? null;
  }

  async setSecret(name: string, value: string): Promise<void> {
    const secrets = await this.loadSecrets();
    secrets[name] = value;
    await this.saveSecrets(secrets);
  }

  async deleteSecret(name: string): Promise<boolean> {
    const secrets = await this.loadSecrets();
    if (!Object.prototype.hasOwnProperty.call(secrets, name)) {
      return false;
    }
    delete secrets[name];
    await this.saveSecrets(secrets);
    return true;
  }
}

/**
 * 创建凭据存储实例。
 * 先探测 keychain 支持情况，并在可能时委派或回退到 EncryptedFileCredentialStore。
 */
export async function createCredentialStore(airpHome: string): Promise<CredentialStore> {
  const backend = await probeOsKeychain();
  return new EncryptedFileCredentialStore(airpHome, backend);
}
