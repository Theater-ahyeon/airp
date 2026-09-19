// tests/runtime/store/card-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CardStore } from "../../../src/runtime/card-store.js";
import type { CharacterAttributes } from "../../../src/core/types/character.js";
import type { RuntimeEvent, RuntimeEventDraft } from "../../../src/runtime/contracts.js";
import { applyStateOp } from "../../../src/core/types/state.js";

describe("CardStore Facade (验收点 1, 2, 5, 6, 8, 9)", () => {
  let tmpHome: string;
  let store: CardStore;

  const sampleAttr: CharacterAttributes = {
    name: "Alya",
    description: "Silver hair girl",
    personality: "Tsundere",
    scenario: "School",
    firstMessage: "Hello comrade",
    mesExamples: "<START>\nHello"
  };

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-store-facade-"));
    store = new CardStore(tmpHome, 20); // 快照阈值设为 20，方便测试触发快照
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  it("一卡一目录物理独立与复制发现（验收点 8）", async () => {
    const { cardId: cardA } = await store.createCard({ cardId: "card_A", attributes: sampleAttr });
    const { cardId: cardB } = await store.createCard({
      cardId: "card_B",
      attributes: { ...sampleAttr, name: "Yuki" }
    });

    const { sessionId: sA } = await store.createSession(cardA);
    const { sessionId: sB } = await store.createSession(cardB);

    await store.appendFloor(cardA, sA, { role: "user", content: "Card A exclusive" });
    await store.appendFloor(cardB, sB, { role: "user", content: "Card B exclusive" });

    // 验证事件互不可见
    const eventsA = await store.readEvents(cardA, sA);
    const eventsB = await store.readEvents(cardB, sB);
    expect(eventsA.some((e) => e.type === "floor_appended" && e.payload.content === "Card A exclusive")).toBe(true);
    expect(eventsA.some((e) => e.type === "floor_appended" && e.payload.content === "Card B exclusive")).toBe(false);
    expect(eventsB.some((e) => e.type === "floor_appended" && e.payload.content === "Card B exclusive")).toBe(true);

    // 复制 card_A 目录到 card_C，验证 listCards() 能直接发现它
    const dirA = path.join(tmpHome, "cards", cardA);
    const dirC = path.join(tmpHome, "cards", "card_C");
    await fs.cp(dirA, dirC, { recursive: true });

    const cards = await store.listCards();
    const cardIds = cards.map((c) => c.cardId);
    expect(cardIds).toContain("card_A");
    expect(cardIds).toContain("card_B");
    expect(cardIds).toContain("card_C");

    const cardC = await store.readCard("card_C");
    expect(cardC.original.name).toBe("Alya");
  });

  it("物理遗忘与撤销物理遗忘（验收点 9）", async () => {
    const { cardId } = await store.createCard({ attributes: sampleAttr });
    const { sessionId } = await store.createSession(cardId);

    const f1 = await store.appendFloor(cardId, sessionId, { role: "user", content: "Floor 1" });
    const f2 = await store.appendFloor(cardId, sessionId, { role: "assistant", content: "Floor 2" });
    const f3 = await store.appendFloor(cardId, sessionId, { role: "user", content: "Floor 3" });

    let replay1 = await store.replay(cardId, sessionId);
    expect(Object.keys(replay1.tree.floors)).toHaveLength(3);
    expect(replay1.tree.floors[f1.payload.floorId]).toBeDefined();
    expect(replay1.tree.floors[f2.payload.floorId]).toBeDefined();
    expect(replay1.tree.floors[f3.payload.floorId]).toBeDefined();

    // Rollback 回退到 Floor 1：Floor 2 和 Floor 3 必须物理遗忘
    await store.rollback(cardId, sessionId, f1.payload.floorId);

    let replayAfterRollback = await store.replay(cardId, sessionId);
    expect(Object.keys(replayAfterRollback.tree.floors)).toHaveLength(1);
    expect(replayAfterRollback.tree.floors[f1.payload.floorId]).toBeDefined();
    expect(replayAfterRollback.tree.floors[f2.payload.floorId]).toBeUndefined();
    expect(replayAfterRollback.tree.floors[f3.payload.floorId]).toBeUndefined();
    expect(replayAfterRollback.tree.undoCheckpointFloorId).toBe(f3.payload.floorId);

    // 执行 undoRollback：恢复被物理遗忘的楼层
    await store.undoRollback(cardId, sessionId);

    let replayAfterUndo = await store.replay(cardId, sessionId);
    expect(Object.keys(replayAfterUndo.tree.floors)).toHaveLength(3);
    expect(replayAfterUndo.tree.floors[f1.payload.floorId].content).toBe("Floor 1");
    expect(replayAfterUndo.tree.floors[f2.payload.floorId].content).toBe("Floor 2");
    expect(replayAfterUndo.tree.floors[f3.payload.floorId].content).toBe("Floor 3");
    expect(replayAfterUndo.tree.undoCheckpointFloorId).toBeNull();
  });

  it("快照触发与加速重放（验收点 2）", async () => {
    // 实例化 snapshotInterval = 10 的 store
    const fastStore = new CardStore(tmpHome, 10);
    const { cardId } = await fastStore.createCard({ attributes: sampleAttr });
    const { sessionId } = await fastStore.createSession(cardId);

    // 写入 25 条事件，预期在第 10、20 条事件时触发快照
    for (let i = 1; i <= 25; i++) {
      await fastStore.appendFloor(cardId, sessionId, {
        role: i % 2 === 1 ? "user" : "assistant",
        content: `Msg ${i}`
      });
    }

    const replayRes = await fastStore.replay(cardId, sessionId);
    // 必须使用了快照（fromCheckpointSeq 非空）
    expect(replayRes.fromCheckpointSeq).not.toBeNull();
    expect(replayRes.fromCheckpointSeq).toBeGreaterThanOrEqual(10);
    expect(replayRes.lastSeq).toBe(26); // 1 条 session_created + 25 条 floor_appended
    expect(Object.keys(replayRes.tree.floors)).toHaveLength(25);

    // 另外对比全量从头重放（使用全新无快照实例直接逐条重放）
    const allEvents = await fastStore.readEvents(cardId, sessionId);
    expect(allEvents.length).toBe(26);
  });

  it("版本化迁移 + 自动备份演练（验收点 5）", async () => {
    const { cardId } = await store.createCard({ cardId: "migrate_card", attributes: sampleAttr });

    const metaPath = path.join(tmpHome, "cards", cardId, "meta.json");
    const originalMeta = JSON.parse(await fs.readFile(metaPath, "utf-8"));

    // 人工将 schemaVersion 改为 0
    originalMeta.schemaVersion = 0;
    await fs.writeFile(metaPath, JSON.stringify(originalMeta, null, 2), "utf-8");

    // 第一次迁移：应生成备份，且迁移到目标版本 1
    const res1 = await store.migrate(cardId);
    expect(res1.from).toBe(0);
    expect(res1.to).toBe(1);
    expect(res1.backupPath).not.toBeNull();

    // 验证备份目录确实存在且内含原件
    const backupStat = await fs.stat(res1.backupPath!);
    expect(backupStat.isDirectory()).toBe(true);
    const backupMeta = JSON.parse(await fs.readFile(path.join(res1.backupPath!, "meta.json"), "utf-8"));
    expect(backupMeta.schemaVersion).toBe(0);

    // 验证当前 meta.json 已升级
    const currentMeta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    expect(currentMeta.schemaVersion).toBe(1);
    expect(currentMeta.lastMigratedAt).toBeDefined();

    // 第二次迁移：版本一致，幂等返回 backupPath: null
    const res2 = await store.migrate(cardId);
    expect(res2.from).toBe(1);
    expect(res2.to).toBe(1);
    expect(res2.backupPath).toBeNull();
  });

  it("导出与导入无损往返（验收点 6）", async () => {
    const { cardId } = await store.createCard({ attributes: sampleAttr });
    const { sessionId: s1 } = await store.createSession(cardId);

    const f1 = await store.appendFloor(cardId, s1, { role: "user", content: "Original msg 1" });
    await store.swipeFloor(cardId, s1, { floorId: f1.payload.floorId, content: "Swiped msg 1" });
    await store.editFloor(cardId, s1, { floorId: f1.payload.floorId, content: "Edited msg 1" });
    await store.applyStateOp(cardId, s1, {
      floorId: f1.payload.floorId,
      branchId: "main",
      type: "set",
      key: "favorability",
      value: 100
    });
    await store.appendEvent(cardId, s1, {
      type: "summary_updated",
      cardId,
      sessionId: s1,
      ts: Date.now(),
      payload: { branchId: "main", summary: "Summary text", upToFloorId: f1.payload.floorId }
    });

    const sourceReplay = await store.replay(cardId, s1);

    // 导出 Card
    const bundle = await store.exportCard(cardId);
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0].events.length).toBeGreaterThan(0);

    // 导入为新卡 new_card
    const { cardId: importedCardId } = await store.importCard(bundle, { newCardId: "new_card" });
    expect(importedCardId).toBe("new_card");

    const targetReplay = await store.replay(importedCardId, s1);

    // 逐字段全字段对比
    expect(targetReplay.lastSeq).toBe(sourceReplay.lastSeq);
    expect(targetReplay.summary).toBe(sourceReplay.summary);
    expect(targetReplay.state).toEqual(sourceReplay.state);
    expect(targetReplay.tree.rootFloorId).toBe(sourceReplay.tree.rootFloorId);
    expect(targetReplay.tree.activeBranchId).toBe(sourceReplay.tree.activeBranchId);
    expect(targetReplay.tree.floors).toEqual(sourceReplay.tree.floors);

    // 若未指定 newCardId 且原卡已存在，必须报错防止静默覆盖
    await expect(store.importCard(bundle)).rejects.toThrow(/already exists/);
  });

  it("随机生成 ≥200 条混合事件重放一致性（验收点 1）", async () => {
    // 设置 snapshotInterval 较大以验证完整重放算法与 reference runner
    const referenceStore = new CardStore(tmpHome, 500);
    const { cardId } = await referenceStore.createCard({ attributes: sampleAttr });
    const { sessionId } = await referenceStore.createSession(cardId);

    // 纯参考重放模型
    interface RefState {
      floors: Record<string, { content: string; floorIndex: number; swipes: string[] }>;
      state: Record<string, unknown>;
      summary: string | null;
      activeBranchId: string;
      undoCheckpointFloorId: string | null;
    }
    const ref: RefState = {
      floors: {},
      state: {},
      summary: null,
      activeBranchId: "main",
      undoCheckpointFloorId: null
    };
    const refFloorArchive: Record<string, { content: string; floorIndex: number; swipes: string[] }> = {};

    let floorIndexCounter = 0;
    const floorIds: string[] = [];

    // 生成 220 条事件
    for (let i = 0; i < 220; i++) {
      const opChoice = Math.random();

      if (opChoice < 0.45 || floorIds.length === 0) {
        // appendFloor
        floorIndexCounter++;
        const fId = `floor_rand_${i}`;
        const content = `Content ${i}`;
        floorIds.push(fId);

        ref.floors[fId] = {
          content,
          floorIndex: floorIndexCounter,
          swipes: [content]
        };
        refFloorArchive[fId] = JSON.parse(JSON.stringify(ref.floors[fId]));
        ref.undoCheckpointFloorId = null;

        await referenceStore.appendEvent(cardId, sessionId, {
          type: "floor_appended",
          cardId,
          sessionId,
          ts: 1000 + i,
          payload: {
            floorId: fId,
            parentId: floorIds.length > 1 ? floorIds[floorIds.length - 2] : null,
            branchId: "main",
            floorIndex: floorIndexCounter,
            role: "user",
            content
          }
        });
      } else if (opChoice < 0.65) {
        // state_op
        const key = `k_${i % 5}`;
        const val = i;
        ref.state = applyStateOp(ref.state, {
          id: `op_${i}`,
          floorId: floorIds[floorIds.length - 1],
          branchId: "main",
          type: "set",
          key,
          value: val,
          timestamp: 1000 + i
        });

        await referenceStore.appendEvent(cardId, sessionId, {
          type: "state_op",
          cardId,
          sessionId,
          ts: 1000 + i,
          payload: {
            op: {
              id: `op_${i}`,
              floorId: floorIds[floorIds.length - 1],
              branchId: "main",
              type: "set",
              key,
              value: val,
              timestamp: 1000 + i
            }
          }
        });
      } else if (opChoice < 0.8) {
        // floor_swiped
        const pickFloorId = floorIds[Math.floor(Math.random() * floorIds.length)];
        const newContent = `Swipe_${i}`;
        if (ref.floors[pickFloorId]) {
          ref.floors[pickFloorId].swipes.push(newContent);
          ref.floors[pickFloorId].content = newContent;
          refFloorArchive[pickFloorId] = JSON.parse(JSON.stringify(ref.floors[pickFloorId]));

          await referenceStore.appendEvent(cardId, sessionId, {
            type: "floor_swiped",
            cardId,
            sessionId,
            ts: 1000 + i,
            payload: {
              floorId: pickFloorId,
              swipeIndex: ref.floors[pickFloorId].swipes.length - 1,
              content: newContent
            }
          });
        }
      } else if (opChoice < 0.9) {
        // summary_updated
        const newSummary = `Summary at ${i}`;
        ref.summary = newSummary;

        await referenceStore.appendEvent(cardId, sessionId, {
          type: "summary_updated",
          cardId,
          sessionId,
          ts: 1000 + i,
          payload: {
            branchId: "main",
            summary: newSummary,
            upToFloorId: floorIds[floorIds.length - 1]
          }
        });
      } else {
        // floor_edited
        const pickFloorId = floorIds[Math.floor(Math.random() * floorIds.length)];
        const editContent = `Edited_${i}`;
        if (ref.floors[pickFloorId]) {
          const old = ref.floors[pickFloorId].content;
          ref.floors[pickFloorId].content = editContent;
          ref.floors[pickFloorId].swipes[ref.floors[pickFloorId].swipes.length - 1] = editContent;
          refFloorArchive[pickFloorId] = JSON.parse(JSON.stringify(ref.floors[pickFloorId]));
          await referenceStore.appendEvent(cardId, sessionId, {
            type: "floor_edited",
            cardId,
            sessionId,
            ts: 1000 + i,
            payload: {
              floorId: pickFloorId,
              content: editContent,
              previousContent: old
            }
          });
        }
      }
    }

    const replayRes = await referenceStore.replay(cardId, sessionId);

    // 验证事件条数至少为 221（1 session_created + 220 混合事件）
    expect(replayRes.lastSeq).toBeGreaterThanOrEqual(220);

    // 验证状态一致性
    expect(replayRes.summary).toBe(ref.summary);
    expect(replayRes.state).toEqual(ref.state);

    // 验证楼层内容与条数一致性
    for (const [fId, refFloor] of Object.entries(ref.floors)) {
      expect(replayRes.tree.floors[fId]).toBeDefined();
      expect(replayRes.tree.floors[fId].content).toBe(refFloor.content);
      expect(replayRes.tree.floors[fId].swipes).toEqual(refFloor.swipes);
    }
  });
  it("回归测试缺陷 A：快照边界后 undo_rollback 应恢复全部被遗忘楼层", async () => {
    // snapshotInterval=1，每次写入立即触发快照
    const smallSnapStore = new CardStore(tmpHome, 1);
    const { cardId } = await smallSnapStore.createCard({ attributes: sampleAttr });
    const { sessionId } = await smallSnapStore.createSession(cardId);

    const f1 = await smallSnapStore.appendFloor(cardId, sessionId, { role: "user", content: "一楼" });
    await smallSnapStore.appendFloor(cardId, sessionId, { role: "assistant", content: "二楼" });
    await smallSnapStore.appendFloor(cardId, sessionId, { role: "assistant", content: "三楼" });

    await smallSnapStore.rollback(cardId, sessionId, f1.payload.floorId);
    const afterRollback = await smallSnapStore.replay(cardId, sessionId);
    expect(Object.keys(afterRollback.tree.floors)).toHaveLength(1);

    // 执行撤销回退
    await smallSnapStore.undoRollback(cardId, sessionId);
    const afterUndo = await smallSnapStore.replay(cardId, sessionId);

    expect(Object.keys(afterUndo.tree.floors)).toHaveLength(3);
    expect(afterUndo.tree.undoCheckpointFloorId).toBeNull();
  });

  it("回归测试缺陷 B：连续两次 rollback 后 undo 只应恢复最近一次被遗忘的楼层", async () => {
    const { cardId } = await store.createCard({ attributes: sampleAttr });
    const { sessionId } = await store.createSession(cardId);

    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const ev = await store.appendFloor(cardId, sessionId, { role: "assistant", content: `第${i}楼` });
      ids.push(ev.payload.floorId);
    }

    // 第一次 rollback 到 3 楼（遗忘 4、5 楼）
    await store.rollback(cardId, sessionId, ids[2]);
    // 第二次 rollback 到 2 楼（遗忘 3 楼，恢复点应指向 3 楼）
    await store.rollback(cardId, sessionId, ids[1]);

    await store.undoRollback(cardId, sessionId);
    const afterUndo = await store.replay(cardId, sessionId);
    const visibleFloorIds = Object.keys(afterUndo.tree.floors).sort();

    // 预期可见 3 楼（1、2、3 楼），4、5 楼保持物理遗忘
    expect(visibleFloorIds).toHaveLength(3);
    expect(visibleFloorIds).toContain(ids[0]);
    expect(visibleFloorIds).toContain(ids[1]);
    expect(visibleFloorIds).toContain(ids[2]);
    expect(visibleFloorIds).not.toContain(ids[3]);
    expect(visibleFloorIds).not.toContain(ids[4]);
  });
});
