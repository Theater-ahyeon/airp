// tests/runtime/store/invariants.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CardStore } from "../../../src/runtime/card-store.js";
import type { CharacterAttributes } from "../../../src/core/types/character.js";
import type { RuntimeEventDraft } from "../../../src/runtime/contracts.js";

describe("快照与重放不变量测试 (验收标准 2)", () => {
  let tmpHome: string;

  const sampleAttr: CharacterAttributes = {
    name: "Alya",
    description: "Silver hair girl",
    personality: "Tsundere",
    scenario: "School",
    firstMessage: "Hello comrade",
    mesExamples: "<START>\nHello"
  };

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-invariants-"));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpHome, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  it("随机生成 ≥150 条混合事件，对比「全量重放」与「小间隔快照 + 增量重放」深度一致", async () => {
    // 创建一个快照间隔为 10 的 store，使得 160 条事件流频繁触发 checkpoint
    const snapInterval = 10;
    const storeWithSnap = new CardStore(tmpHome, snapInterval);

    const { cardId } = await storeWithSnap.createCard({ cardId: "inv_card", attributes: sampleAttr });
    const { sessionId } = await storeWithSnap.createSession(cardId, "inv_session");

    let floorCount = 0;
    const activeFloors: string[] = [];

    // 生成 ≥150 条操作（包含 append, swipe, edit, state_op, summary, rollback, undo_rollback）
    const totalOps = 160;
    for (let i = 0; i < totalOps; i++) {
      const rand = Math.random();

      if (activeFloors.length < 3 || rand < 0.35) {
        // 1. appendFloor
        floorCount++;
        const ev = await storeWithSnap.appendFloor(cardId, sessionId, {
          role: floorCount % 2 === 1 ? "user" : "assistant",
          content: `Floor message #${floorCount} (step ${i})`
        });
        activeFloors.push(ev.payload.floorId);
      } else if (rand < 0.5) {
        // 2. swipeFloor
        const targetFloorId = activeFloors[Math.floor(Math.random() * activeFloors.length)];
        await storeWithSnap.swipeFloor(cardId, sessionId, {
          floorId: targetFloorId,
          content: `Swipe for ${targetFloorId} at step ${i}`
        });
      } else if (rand < 0.65) {
        // 3. editFloor
        const targetFloorId = activeFloors[Math.floor(Math.random() * activeFloors.length)];
        await storeWithSnap.editFloor(cardId, sessionId, {
          floorId: targetFloorId,
          content: `Edited ${targetFloorId} at step ${i}`
        });
        // 4. applyStateOp
        await storeWithSnap.applyStateOp(cardId, sessionId, {
          type: "set",
          path: `metrics.step_${i}`,
          value: i * 42
        });
      } else if (rand < 0.9) {
        // 5. rollback (回退到某个之前的楼层，遗忘后续楼层)
        if (activeFloors.length > 2) {
          const cutIndex = Math.floor(Math.random() * (activeFloors.length - 1));
          const targetFloorId = activeFloors[cutIndex];
          await storeWithSnap.rollback(cardId, sessionId, targetFloorId);
          activeFloors.splice(cutIndex + 1);
        }
      } else {
        // 6. undoRollback（如果恢复点可用）
        try {
          await storeWithSnap.undoRollback(cardId, sessionId);
          // 如果 undo 成功，重新同步 activeFloors
          const currentRep = await storeWithSnap.replay(cardId, sessionId);
          activeFloors.length = 0;
          const sortedFloors = Object.values(currentRep.tree.floors).sort((a, b) => a.floorIndex - b.floorIndex);
          for (const f of sortedFloors) {
            activeFloors.push(f.id);
          }
        } catch {
          // 恢复点失效或不存在时允许抛错，继续测试
        }
      }
    }

    // 1. 使用当前 storeWithSnap（内部已存有多个快照）重放，执行「快照 + 增量重放」
    const replayFromSnapshot = await storeWithSnap.replay(cardId, sessionId);

    // 2. 在同一份事件日志上执行「全量重放（无快照）」
    const replayPure = await storeWithSnap.replay(cardId, sessionId, { ignoreSnapshot: true });

    // 验证核心不变量：
    // 「快照 + 增量重放」与「全量重放（无快照）」结果逐字段一致
    expect(replayFromSnapshot.lastSeq).toBe(replayPure.lastSeq);
    expect(replayFromSnapshot.tree).toEqual(replayPure.tree);
    expect(replayFromSnapshot.state).toEqual(replayPure.state);
    expect(replayFromSnapshot.summary).toEqual(replayPure.summary);

    // 额外断言：有快照的重放确实触发了快照加速，而无快照全量重放 fromCheckpointSeq 为 null
    expect(replayFromSnapshot.fromCheckpointSeq).not.toBeNull();
    expect(replayFromSnapshot.fromCheckpointSeq).toBeGreaterThan(0);
    expect(replayPure.fromCheckpointSeq).toBeNull();
    expect(replayPure.replayedEvents.length).toBeGreaterThan(replayFromSnapshot.replayedEvents.length);
  }, 30000);
});
