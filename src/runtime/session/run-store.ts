// src/runtime/session/run-store.ts
// Run 元数据持久化实现：原子写、按会话管理及跨卡扫描。

import path from "node:path";
import fs from "node:fs/promises";
import type { RunRecord } from "../contracts.js";
import { runsDir, assertSafeId, sessionsBaseDir, cardsBaseDir } from "../paths.js";
import { ensureDir, writeJsonAtomic, readJson } from "../fs-atomic.js";

export class RunStore {
  readonly home: string;

  constructor(home: string) {
    this.home = home;
  }

  /** 获取特定 run 文件的路径 */
  getRunPath(cardId: string, sessionId: string, runId: string): string {
    assertSafeId(cardId, "cardId");
    assertSafeId(sessionId, "sessionId");
    assertSafeId(runId, "runId");
    return path.join(runsDir(this.home, cardId, sessionId), `${runId}.json`);
  }

  /**
   * 原子保存 RunRecord 到磁盘
   */
  async save(record: RunRecord): Promise<void> {
    const dir = runsDir(this.home, record.cardId, record.sessionId);
    await ensureDir(dir);
    const targetPath = this.getRunPath(record.cardId, record.sessionId, record.runId);
    // Windows 下重命名或并发读写可能偶发 EPERM，采用指数退避重试 3 次
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await writeJsonAtomic(targetPath, record);
        return;
      } catch (err) {
        lastErr = err;
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 15 * (attempt + 1));
        await promise;
      }
    }
    throw lastErr;
  }

  /**
   * 根据 runId、cardId、sessionId 加载单个 RunRecord
   */
  async load(cardId: string, sessionId: string, runId: string): Promise<RunRecord | null> {
    const targetPath = this.getRunPath(cardId, sessionId, runId);
    try {
      return await readJson<RunRecord>(targetPath);
    } catch {
      return null;
    }
  }

  /**
   * 按 cardId 与 sessionId 列出该会话下的所有 RunRecord（按 createdAt 升序排序）
   */
  async list(cardId: string, sessionId: string): Promise<RunRecord[]> {
    assertSafeId(cardId, "cardId");
    assertSafeId(sessionId, "sessionId");
    const dir = runsDir(this.home, cardId, sessionId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const records: RunRecord[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const filePath = path.join(dir, entry.name);
          try {
            const record = await readJson<RunRecord>(filePath);
            records.push(record);
          } catch {
            // 忽略损坏或并发写入中的异常
          }
        }
      }
      return records.sort((a, b) => a.createdAt - b.createdAt);
    } catch {
      return [];
    }
  }

  /**
   * 列出某卡片下所有会话中的所有 RunRecord
   */
  async listAllCardRuns(cardId: string): Promise<RunRecord[]> {
    assertSafeId(cardId, "cardId");
    const sessBase = sessionsBaseDir(this.home, cardId);
    try {
      const sessions = await fs.readdir(sessBase, { withFileTypes: true });
      const allRecords: RunRecord[] = [];
      for (const s of sessions) {
        if (s.isDirectory()) {
          const runs = await this.list(cardId, s.name);
          allRecords.push(...runs);
        }
      }
      return allRecords;
    } catch {
      return [];
    }
  }

  /**
   * 扫描全仓（所有卡片、所有会话）下的所有 RunRecord，供 recoverOnBoot 跨会话/跨卡扫描
   */
  async listAllRuns(): Promise<RunRecord[]> {
    const cardsBase = cardsBaseDir(this.home);
    try {
      const cards = await fs.readdir(cardsBase, { withFileTypes: true });
      const allRecords: RunRecord[] = [];
      for (const c of cards) {
        if (c.isDirectory()) {
          const cardRuns = await this.listAllCardRuns(c.name);
          allRecords.push(...cardRuns);
        }
      }
      return allRecords;
    } catch {
      return [];
    }
  }
}
