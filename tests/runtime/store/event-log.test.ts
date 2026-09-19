// tests/runtime/store/event-log.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventLog } from "../../../src/runtime/event-log.js";
import type { RuntimeEventDraft } from "../../../src/runtime/contracts.js";

describe("EventLog (验收点 3 & 4)", () => {
  let tmpDir: string;
  let eventLogPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "airp-eventlog-"));
    eventLogPath = path.join(tmpDir, "events.jsonl");
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  it("基本追加与单调递增 seq 分配", async () => {
    const log = new EventLog({
      cardId: "card1",
      sessionId: "sess1",
      filePath: eventLogPath
    });

    const draft1: RuntimeEventDraft = {
      type: "session_created",
      cardId: "card1",
      sessionId: "sess1",
      ts: Date.now(),
      payload: { title: "Test" }
    };
    const ev1 = await log.append(draft1);
    expect(ev1.seq).toBe(1);
    expect(ev1.id).toBeDefined();

    const draft2: RuntimeEventDraft = {
      type: "floor_appended",
      cardId: "card1",
      sessionId: "sess1",
      ts: Date.now(),
      payload: {
        floorId: "f1",
        parentId: null,
        branchId: "main",
        floorIndex: 1,
        role: "user",
        content: "hello"
      }
    };
    const ev2 = await log.append(draft2);
    expect(ev2.seq).toBe(2);

    const all = await log.readAll();
    expect(all).toHaveLength(2);
    expect(all[0].seq).toBe(1);
    expect(all[1].seq).toBe(2);
    expect(await log.lastSeq()).toBe(2);
  });

  it("并发 append 安全（验收点 4: ≥50 次并发无重复无缺口）", async () => {
    const log = new EventLog({
      cardId: "c_concurrent",
      sessionId: "s_concurrent",
      filePath: eventLogPath
    });

    const totalCount = 60;
    const promises: Promise<unknown>[] = [];

    for (let i = 0; i < totalCount; i++) {
      const draft: RuntimeEventDraft = {
        type: "floor_appended",
        cardId: "c_concurrent",
        sessionId: "s_concurrent",
        ts: Date.now(),
        payload: {
          floorId: `f_${i}`,
          parentId: null,
          branchId: "main",
          floorIndex: i + 1,
          role: "user",
          content: `msg ${i}`
        }
      };
      promises.push(log.append(draft));
    }

    const results = (await Promise.all(promises)) as Array<{ seq: number }>;
    expect(results).toHaveLength(totalCount);

    // 检查返回结果的 seq 是否覆盖 1..60
    const returnedSeqs = results.map((r) => r.seq).sort((a, b) => a - b);
    for (let i = 0; i < totalCount; i++) {
      expect(returnedSeqs[i]).toBe(i + 1);
    }

    // 从磁盘重新读出，验证持久化文件行数及单调递增性
    const diskEvents = await log.readAll();
    expect(diskEvents).toHaveLength(totalCount);
    for (let i = 0; i < totalCount; i++) {
      expect(diskEvents[i].seq).toBe(i + 1);
    }
    expect(await log.lastSeq()).toBe(totalCount);
  });

  it("崩溃尾行恢复（验收点 3: 半行损坏忽略、lastSeq 正确、repairTail 截断修复）", async () => {
    const log = new EventLog({
      cardId: "c_crash",
      sessionId: "s_crash",
      filePath: eventLogPath
    });

    // 写入两条正常事件
    await log.append({
      type: "session_created",
      cardId: "c_crash",
      sessionId: "s_crash",
      ts: 1000,
      payload: { title: "Crash Test" }
    });
    await log.append({
      type: "floor_appended",
      cardId: "c_crash",
      sessionId: "s_crash",
      ts: 1001,
      payload: {
        floorId: "f1",
        parentId: null,
        branchId: "main",
        floorIndex: 1,
        role: "user",
        content: "First message"
      }
    });

    expect(await log.lastSeq()).toBe(2);

    // 手工在末尾追加半截损坏 JSON 字符串（模拟进程被 SIGKILL / 电源断电）
    const corruptedTail = '{"seq":3,"id":"corrupt-uuid","type":"floor_app';
    await fs.appendFile(eventLogPath, corruptedTail, "utf-8");

    // 模拟重新启动：创建新的 EventLog 实例读取
    const freshLog = new EventLog({
      cardId: "c_crash",
      sessionId: "s_crash",
      filePath: eventLogPath
    });

    // 1. readAll 应容忍尾部损坏行，返回前面的 2 条完整事件
    const events = await freshLog.readAll();
    expect(events).toHaveLength(2);
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);

    // 2. lastSeq 应正确返回 2
    const currentLastSeq = await freshLog.lastSeq();
    expect(currentLastSeq).toBe(2);

    // 3. repairTail 修复文件并返回截断字节数 > 0
    const truncatedBytes = await freshLog.repairTail();
    expect(truncatedBytes).toBe(Buffer.byteLength(corruptedTail, "utf-8"));

    // 4. 修复后文件应可继续正常 append，新 seq 为 3
    const ev3 = await freshLog.append({
      type: "floor_appended",
      cardId: "c_crash",
      sessionId: "s_crash",
      ts: 1002,
      payload: {
        floorId: "f2",
        parentId: "f1",
        branchId: "main",
        floorIndex: 2,
        role: "assistant",
        content: "Second message after recovery"
      }
    });
    expect(ev3.seq).toBe(3);

    const afterRepairEvents = await freshLog.readAll();
    expect(afterRepairEvents).toHaveLength(3);
    expect(afterRepairEvents[2].seq).toBe(3);
  });
});
