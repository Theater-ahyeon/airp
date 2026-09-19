// src/runtime/migrations.ts
// 版本化迁移：支持备份与多阶段 schema 演进。

import fs from "node:fs/promises";
import path from "node:path";
import type { CardMeta } from "./contracts.js";
import { RUNTIME_SCHEMA_VERSION } from "./contracts.js";
import { cardDir, backupsDir, cardMetaPath } from "./paths.js";
import { ensureDir, copyDirectory, writeJsonAtomic, readJson } from "./fs-atomic.js";

export interface MigrationResult {
  from: number;
  to: number;
  backupPath: string | null;
}

/**
 * 执行卡目录版本迁移。
 * 如果当前 schemaVersion 与 RUNTIME_SCHEMA_VERSION 相同，直接返回（幂等，不产生备份）。
 * 如果不相同：
 * 1. 备份整个卡目录到 backups/<ISO时间戳>/
 * 2. 依次应用迁移函数直到升级至目标版本
 * 3. 更新 meta.json 中的 schemaVersion 与 lastMigratedAt
 * 4. 若过程报错，备份完整保留，原目录不产生破坏性半途状态
 */
export async function migrateCard(home: string, cardId: string): Promise<MigrationResult> {
  const targetCardDir = cardDir(home, cardId);
  const metaPath = cardMetaPath(home, cardId);

  let meta: Partial<CardMeta> = {};
  let currentVersion = 0;

  try {
    meta = await readJson<Partial<CardMeta>>(metaPath);
    if (typeof meta.schemaVersion === "number") {
      currentVersion = meta.schemaVersion;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // 无 meta.json 视作 v0
    currentVersion = 0;
  }

  if (currentVersion === RUNTIME_SCHEMA_VERSION) {
    return {
      from: currentVersion,
      to: RUNTIME_SCHEMA_VERSION,
      backupPath: null
    };
  }

  // 1. 创建备份
  const backupsRoot = backupsDir(home, cardId);
  await ensureDir(backupsRoot);
  // Windows 下冒号不被允许作为文件夹名，将 : 替换为 -
  const timestampSafe = new Date().toISOString().replace(/:/g, "-");
  const backupPath = path.join(backupsRoot, timestampSafe);
  await ensureDir(backupPath);

  // 复制当前卡目录到备份（排除 backups 自身以防无限递归）
  const entries = await fs.readdir(targetCardDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "backups") continue;
    const srcPath = path.join(targetCardDir, entry.name);
    const destPath = path.join(backupPath, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }

  // 2. 逐步迁移
  let v = currentVersion;
  try {
    if (v === 0) {
      // 迁移 0 -> 1：若缺失 meta.json 或缺少规范字段，进行补充补全
      const now = Date.now();
      const updatedMeta: CardMeta = {
        schemaVersion: 1,
        cardId,
        name: typeof meta.name === "string" && meta.name ? meta.name : cardId,
        createdAt: typeof meta.createdAt === "number" ? meta.createdAt : now,
        updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : now,
        lastMigratedAt: now
      };
      await writeJsonAtomic(metaPath, updatedMeta);
      v = 1;
    }

    if (v !== RUNTIME_SCHEMA_VERSION) {
      throw new Error(`No migration path from schemaVersion ${v} to ${RUNTIME_SCHEMA_VERSION}`);
    }

    return {
      from: currentVersion,
      to: RUNTIME_SCHEMA_VERSION,
      backupPath
    };
  } catch (error) {
    // 迁移失败，抛出错误前保留 backupPath
    throw new Error(
      `Migration failed from v${currentVersion} to v${RUNTIME_SCHEMA_VERSION}. Backup safely preserved at ${backupPath}. Reason: ${(error as Error).message}`
    );
  }
}
