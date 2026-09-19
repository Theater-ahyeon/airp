// tests/runtime/store/snapshot-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SnapshotStore } from "../../../src/runtime/snapshot-store.js";
import type { SessionCheckpoint } from "../../../src/runtime/contracts.js";

describe("SnapshotStore (快照存储与容错)", () => {
  let tmpDir: string;
  let snapStore: SnapshotStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "airp-snapshot-"));
    snapStore = new SnapshotStore(tmpDir);
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  function makeCheckpoint(seq: number): SessionCheckpoint {
    return {
      schemaVersion: 1,
      cardId: "c1",
      sessionId: "s1",
      seq,
      createdAt: Date.now(),
      tree: {
        id: "s1",
        rootFloorId: "f1",
        activeBranchId: "main",
        floors: {
          f1: {
            id: "f1",
            parentId: null,
            branchId: "main",
            floorIndex: 1,
            role: "user",
            content: `Message ${seq}`,
            createdAt: 1000,
            updatedAt: 1000,
            swipes: [`Message ${seq}`],
            currentSwipeIndex: 0
          }
        },
        undoCheckpointFloorId: null
      },
      state: { count: seq },
      summary: `Summary at ${seq}`
    };
  }

  it("保存与列表检索", async () => {
    expect(await snapStore.list()).toEqual([]);
    expect(await snapStore.latest()).toBeNull();

    await snapStore.save(makeCheckpoint(10));
    await snapStore.save(makeCheckpoint(50));
    await snapStore.save(makeCheckpoint(30));

    expect(await snapStore.list()).toEqual([10, 30, 50]);

    const latest = await snapStore.latest();
    expect(latest?.seq).toBe(50);
    expect(latest?.state.count).toBe(50);
  });

  it("损坏快照自动容错回退", async () => {
    await snapStore.save(makeCheckpoint(10));
    await snapStore.save(makeCheckpoint(20));

    // 人工破坏快照 20.json
    const corruptFile = snapStore.getFilePath(20);
    await fs.writeFile(corruptFile, "{ invalid json content ...", "utf-8");

    // 应自动跳过损坏的 20.json，回退返回 10.json
    const fallback = await snapStore.latest();
    expect(fallback).not.toBeNull();
    expect(fallback?.seq).toBe(10);
  });
});
