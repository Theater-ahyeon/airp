// src/runtime/snapshot-store.ts
// 快照 checkpoint 存储与管理。

import fs from "node:fs/promises";
import path from "node:path";
import type { SessionCheckpoint } from "./contracts.js";
import { ensureDir, writeJsonAtomic, readJson } from "./fs-atomic.js";

export class SnapshotStore {
  constructor(private readonly dir: string) {}

  /**
   * 保存快照：写入 snapshots/<seq>.json（原子写）。
   */
  async save(checkpoint: SessionCheckpoint): Promise<string> {
    await ensureDir(this.dir);
    const targetFile = path.join(this.dir, `${checkpoint.seq}.json`);
    await writeJsonAtomic(targetFile, checkpoint);
    return targetFile;
  }

  /**
   * 列出所有已有快照的 seq（升序排列）。
   */
  async list(): Promise<number[]> {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      const seqs: number[] = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const base = entry.name.slice(0, -5);
          const seq = Number.parseInt(base, 10);
          if (Number.isInteger(seq) && seq >= 0 && String(seq) === base) {
            seqs.push(seq);
          }
        }
      }
      seqs.sort((a, b) => a - b);
      return seqs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * 获取最新且合法的快照；若无快照或所有快照均损坏，返回 null。
   * 若最新快照损坏，会按 seq 降序逐个回退到较早的合法快照。
   */
  async latest(): Promise<SessionCheckpoint | null> {
    const seqs = await this.list();
    if (seqs.length === 0) {
      return null;
    }

    // 从大到小尝试加载，跳过损坏快照
    for (let i = seqs.length - 1; i >= 0; i--) {
      const seq = seqs[i];
      const filePath = path.join(this.dir, `${seq}.json`);
      try {
        const cp = await readJson<SessionCheckpoint>(filePath);
        if (
          cp &&
          typeof cp === "object" &&
          typeof cp.seq === "number" &&
          cp.seq === seq &&
          cp.tree &&
          typeof cp.tree === "object" &&
          cp.state &&
          typeof cp.state === "object"
        ) {
          return cp;
        }
      } catch {
        // 快照损坏，跳过继续尝试更早的
      }
    }

    return null;
  }

  /**
   * 获取指定 seq 的快照文件路径（供诊断或测试使用）。
   */
  getFilePath(seq: number): string {
    return path.join(this.dir, `${seq}.json`);
  }
}
