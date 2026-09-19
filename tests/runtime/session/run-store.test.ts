// tests/runtime/session/run-store.test.ts
// 测试 RunStore 的原子写、读取、列出会话 runs 及跨会话/跨卡扫描。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { RunStore } from "../../../src/runtime/session/run-store.js";
import type { RunRecord } from "../../../src/runtime/contracts.js";

describe("RunStore 元数据持久化", () => {
  let tempHome: string;
  let runStore: RunStore;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-run-store-test-"));
    runStore = new RunStore(tempHome);
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("支持 save、load 和 list", async () => {
    const record: RunRecord = {
      runId: "run-001",
      cardId: "card_a",
      sessionId: "sess_a",
      status: "queued",
      model: "test-model",
      prompt: "hello test",
      createdAt: 1000,
      startedAt: null,
      endedAt: null,
      text: "",
      lastSeq: 1
    };

    await runStore.save(record);

    const loaded = await runStore.load("card_a", "sess_a", "run-001");
    expect(loaded).toEqual(record);

    const record2: RunRecord = {
      ...record,
      runId: "run-002",
      createdAt: 2000
    };
    await runStore.save(record2);

    const list = await runStore.list("card_a", "sess_a");
    expect(list).toHaveLength(2);
    expect(list[0].runId).toBe("run-001");
    expect(list[1].runId).toBe("run-002");
  });

  it("支持 listAllCardRuns 与 listAllRuns 跨会话跨卡扫描", async () => {
    const r1: RunRecord = {
      runId: "r1",
      cardId: "card_1",
      sessionId: "sess_1",
      status: "running",
      model: "m",
      prompt: "p",
      createdAt: 10,
      startedAt: 12,
      endedAt: null,
      text: "hello",
      lastSeq: 3
    };
    const r2: RunRecord = {
      ...r1,
      runId: "r2",
      sessionId: "sess_2",
      createdAt: 20
    };
    const r3: RunRecord = {
      ...r1,
      runId: "r3",
      cardId: "card_2",
      sessionId: "sess_x",
      createdAt: 30
    };

    await runStore.save(r1);
    await runStore.save(r2);
    await runStore.save(r3);

    const card1Runs = await runStore.listAllCardRuns("card_1");
    expect(card1Runs).toHaveLength(2);

    const allRuns = await runStore.listAllRuns();
    expect(allRuns).toHaveLength(3);
    const runIds = allRuns.map((r) => r.runId);
    expect(runIds).toContain("r1");
    expect(runIds).toContain("r2");
    expect(runIds).toContain("r3");
  });
});
