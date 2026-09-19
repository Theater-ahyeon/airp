// src/runtime/fs-atomic.ts
// 原子写与基础文件系统工具。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 确保目录存在，不存在则递归创建。
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * 原子写文件：写入同目录临时文件并 fsync，随后原子重命名覆盖目标文件。
 */
export async function writeAtomic(filePath: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const randomSuffix = crypto.randomBytes(6).toString("hex");
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomSuffix}.tmp`);

  const fileHandle = await fs.open(tempPath, "w");
  try {
    await fileHandle.writeFile(content);
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }

  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    // Windows 下目标文件若被占用或其他异常，尝试清理临时文件
    try {
      await fs.unlink(tempPath);
    } catch {
      // 忽略清理失败
    }
    throw error;
  }
}

/**
 * 原子写 JSON 文件（格式化缩进 2 格）。
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const serialized = JSON.stringify(data, null, 2);
  await writeAtomic(filePath, serialized);
}

/**
 * 安全读取 JSON 文件。若文件不存在且指定了 fallback，则返回 fallback；否则抛出异常。
 */
export async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * 递归复制目录（用于迁移前备份等）。
 */
export async function copyDirectory(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}
