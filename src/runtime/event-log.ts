// src/runtime/event-log.ts
// JSONL append-only 事件日志：单调递增 seq、原子 append + fsync、崩溃尾行容忍与截断修复。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { RuntimeEvent, RuntimeEventDraft } from "./contracts.js";
import { isRuntimeEvent, DEFAULT_SNAPSHOT_INTERVAL } from "./contracts.js";
import { ensureDir } from "./fs-atomic.js";

export interface EventLogOptions {
  cardId: string;
  sessionId: string;
  filePath: string;
  snapshotInterval?: number;
  onSnapshotThreshold?: (currentSeq: number) => Promise<void>;
}

export class EventLog {
  readonly cardId: string;
  readonly sessionId: string;
  readonly filePath: string;
  readonly snapshotInterval: number;
  private readonly onSnapshotThreshold?: (currentSeq: number) => Promise<void>;

  /** 互斥锁队列，保证多并发 append 严格串行执行并分配单调连续 seq */
  private mutexTail: Promise<void> = Promise.resolve();
  private cachedLastSeq: number | null = null;
  /** 记录从上一次触发快照至今累计写入的事件数 */
  private eventsSinceLastSnapshot = 0;

  constructor(options: EventLogOptions) {
    this.cardId = options.cardId;
    this.sessionId = options.sessionId;
    this.filePath = options.filePath;
    this.snapshotInterval = options.snapshotInterval ?? DEFAULT_SNAPSHOT_INTERVAL;
    this.onSnapshotThreshold = options.onSnapshotThreshold;
  }

  /**
   * 线程安全的串行任务执行器
   */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexTail.then(fn, fn);
    this.mutexTail = next.then(() => {}, () => {});
    return next;
  }

  /**
   * 追加一条事件：自动生成 seq、id、ts，写盘并 fsync。
   */
  async append(draft: RuntimeEventDraft): Promise<RuntimeEvent> {
    return this.runExclusive(async () => {
      if (this.cachedLastSeq === null) {
        this.cachedLastSeq = await this.readLastSeqFromFile();
      }

      const nextSeq = this.cachedLastSeq + 1;
      const id = crypto.randomUUID();
      const ts = Date.now();

      const event: RuntimeEvent = {
        ...(draft as unknown as Record<string, unknown>),
        seq: nextSeq,
        id,
        cardId: this.cardId,
        sessionId: this.sessionId,
        ts
      } as RuntimeEvent;

      if (!isRuntimeEvent(event)) {
        throw new Error(`Constructed invalid RuntimeEvent for seq ${nextSeq}`);
      }

      await ensureDir(path.dirname(this.filePath));

      const line = JSON.stringify(event) + "\n";
      const handle = await fs.open(this.filePath, "a");
      try {
        await handle.writeFile(line, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      this.cachedLastSeq = nextSeq;
      this.eventsSinceLastSnapshot++;

      const shouldSnapshot =
        this.snapshotInterval > 0 &&
        this.eventsSinceLastSnapshot >= this.snapshotInterval &&
        !!this.onSnapshotThreshold;

      if (shouldSnapshot) {
        this.eventsSinceLastSnapshot = 0;
      }

      return event;
    }).then(async (event) => {
      // 在释放 append 互斥锁之后异步触发快照写入，避免 replay 读取 event-log 时死锁
      if (
        this.snapshotInterval > 0 &&
        this.onSnapshotThreshold &&
        event.seq % this.snapshotInterval === 0
      ) {
        try {
          await this.onSnapshotThreshold(event.seq);
        } catch {
          // 快照失败不阻断事件日志追加
        }
      }
      return event;
    });
  }
  /**
   * 读取全部合法事件（自动忽略末尾损坏的残缺行）。
   */
  async readAll(): Promise<RuntimeEvent[]> {
    return this.readFrom(1);
  }

  /**
   * 从指定 seq 开始读取事件（包含 minSeq）。
   */
  async readFrom(minSeq: number): Promise<RuntimeEvent[]> {
    return this.runExclusive(async () => {
      let content = "";
      try {
        content = await fs.readFile(this.filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }

      if (!content) return [];

      const lines = content.split("\n");
      const events: RuntimeEvent[] = [];

      // 如果 minSeq > 1，跳过早于 minSeq 的事件。
      // 安全说明：必须 JSON.parse 后读取顶层 event.seq 判定，禁止行内正则预检——
      // payload 内嵌的 "seq": 键会先于顶层 seq 出现，导致事件被静默丢弃（审查 H-6）。
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        try {
          const parsed = JSON.parse(line);
          if (isRuntimeEvent(parsed)) {
            if (parsed.seq >= minSeq) {
              events.push(parsed);
            }
          }
        } catch {
          // 若为末尾行解析失败，属于崩溃尾行，容忍丢弃；中间行异常亦跳过保证健壮
        }
      }

      return events;
    });
  }

  /**
   * 获取当前最大的合法 seq
   */
  async lastSeq(): Promise<number> {
    return this.runExclusive(async () => {
      if (this.cachedLastSeq !== null) {
        return this.cachedLastSeq;
      }
      this.cachedLastSeq = await this.readLastSeqFromFile();
      return this.cachedLastSeq;
    });
  }

  /**
   * 修复尾部崩溃残缺行：将文件截断到最后一条完整且合法的 JSON 行末尾。
   * 返回被截断删除的残缺字节数。
   */
  async repairTail(): Promise<number> {
    return this.runExclusive(async () => {
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return 0;
        }
        throw error;
      }

      const totalBytes = buffer.length;
      if (totalBytes === 0) return 0;

      // 从后往前寻找有效边界
      let validOffset = 0;
      let offset = 0;
      let maxSeq = 0;

      while (offset < totalBytes) {
        let newlineIndex = buffer.indexOf(0x0a, offset);
        let lineEnd = newlineIndex !== -1 ? newlineIndex : totalBytes;
        const lineBuf = buffer.subarray(offset, lineEnd);
        const lineStr = lineBuf.toString("utf-8").trim();

        if (lineStr.length > 0) {
          try {
            const parsed = JSON.parse(lineStr);
            if (isRuntimeEvent(parsed)) {
              if (newlineIndex !== -1) {
                validOffset = newlineIndex + 1;
              } else {
                // 最后一行没有换行但格式合法，需要补齐换行后视作有效
                validOffset = totalBytes;
              }
              if (parsed.seq > maxSeq) {
                maxSeq = parsed.seq;
              }
            } else {
              // 无法构成合法事件
              break;
            }
          } catch {
            // 解析失败，说明从当前 offset 起是损坏的半截数据
            break;
          }
        } else if (newlineIndex !== -1) {
          validOffset = newlineIndex + 1;
        }

        if (newlineIndex === -1) break;
        offset = newlineIndex + 1;
      }

      const truncatedBytes = totalBytes - validOffset;
      if (truncatedBytes > 0) {
        const handle = await fs.open(this.filePath, "r+");
        try {
          await handle.truncate(validOffset);
          await handle.sync();
        } finally {
          await handle.close();
        }
      }

      this.cachedLastSeq = maxSeq;
      return truncatedBytes;
    });
  }

  /**
   * 直接从磁盘文件扫描获取最后一条合法 seq
   */
  private async readLastSeqFromFile(): Promise<number> {
    let content = "";
    try {
      content = await fs.readFile(this.filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }

    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (isRuntimeEvent(parsed)) {
          return parsed.seq;
        }
      } catch {
        // 忽略末尾残缺行，继续向前找上一行
      }
    }

    return 0;
  }
}
