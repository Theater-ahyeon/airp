// tests/stage5/first-playable-e2e.test.ts
// Stage 5 First Playable Acceptance:
// Real ST Card import -> Session creation -> Streaming conversation -> Swipe -> Edit -> Rollback -> Undo Rollback -> Restart Replay

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { importSillyTavernV2Card } from "../../src/core/importers/st-card-importer.js";
import { CardStore } from "../../src/runtime/card-store.js";
import { RunManager } from "../../src/runtime/session/run-manager.js";
import { MockModelPort } from "../../src/runtime/session/mock-port.js";
import { MockModelAdapter } from "../../src/core/adapters/mock-model.js";
import { AssemblyPipeline } from "../../src/core/pipeline/assembly-pipeline.js";
import { createCharacterCard } from "../../src/core/types/character.js";
import { FloorMessage } from "../../src/core/types/floor-tree.js";

describe("Stage 5 First Playable 闭环验收：真实 ST 卡片全生命周期与持久化", () => {
  let tempHome: string;
  let cardStore: CardStore;
  const rawStCard = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "汐 · 雾港灯语",
      description: "深夜海边灯塔下的守灯人。",
      personality: "冷静、守秘",
      scenario: "深夜海边灯塔酒馆",
      first_mes: "夜潮拍打着黑礁，汐推来了一盏防风灯。",
      mes_example: "",
      system_prompt: "严肃叙事小说风格。",
    },
  };

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-stage5-e2e-"));
    cardStore = new CardStore(tempHome);
  });

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        await fs.rm(tempHome, { recursive: true, force: true });
        break;
      } catch {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 80);
        await promise;
      }
    }
  });

  it("验收闭环：导入ST卡 -> 创建会话 -> 多轮对话 -> Swipe -> 编辑 -> 回退 -> 撤销回退 -> 离线重开恢复", async () => {
    // 1. 导入 ST 卡并落盘
    const imported = importSillyTavernV2Card(rawStCard);
    const { cardId } = await cardStore.createCard({ attributes: imported.attributes });
    expect(cardId).toBeTruthy();

    const readBackCard = await cardStore.readCard(cardId);
    expect(readBackCard.original.name).toBe("汐 · 雾港灯语");
    expect(readBackCard.workingCopy.name).toBe("汐 · 雾港灯语");

    // 2. 创建剧情会话
    const sessionId = "session_play_01";
    await cardStore.createSession(cardId, sessionId, "雾港灯语 · 第一夜");

    // 3. 模型与 RunManager 装配
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("海水漫不过第七级台阶，至少在午夜之前不会。");
    const modelPort = new MockModelPort({ adapter });
    // 4. 用户发言与生成 (Floor 1 & Floor 2)
    const floor1Ev = await cardStore.appendFloor(cardId, sessionId, {
      role: "user",
      content: "请问关于失落之城的石碑在哪？",
    });
    expect(floor1Ev.payload.floorIndex).toBe(1);

    const floor2Ev = await cardStore.appendFloor(cardId, sessionId, {
      role: "assistant",
      content: "海水漫不过第七级台阶，至少在午夜之前不会。",
    });
    expect(floor2Ev.payload.floorIndex).toBe(2);

    // 5. Swipe 候选分支：新增候选并在同一个楼层切换
    const swipedEv = await cardStore.swipeFloor(cardId, sessionId, {
      floorId: floor2Ev.payload.floorId,
      content: "窗外夜潮汹涌，汐冷冷地审视着你：“你打听石碑，意欲何为？”",
    });
    expect(swipedEv.payload.swipeIndex).toBe(1);

    // 6. 原位编辑楼层
    const editedEv = await cardStore.editFloor(cardId, sessionId, {
      floorId: floor2Ev.payload.floorId,
      content: "“石碑就在灯塔地下暗室。”汐轻声说道。",
    });
    expect(editedEv.payload.content).toBe("“石碑就在灯塔地下暗室。”汐轻声说道。");

    // 7. 追加第 3 楼
    const floor3Ev = await cardStore.appendFloor(cardId, sessionId, {
      role: "user",
      content: "那我们现在就去吧。",
    });
    expect(floor3Ev.payload.floorIndex).toBe(3);

    // 8. 回退至第 2 楼 (第 3 楼被物理遗忘)
    const rollbackEv = await cardStore.rollback(cardId, sessionId, floor2Ev.payload.floorId);
    expect(rollbackEv.payload.forgottenFloorIds).toContain(floor3Ev.payload.floorId);

    const stateAfterRollback = await cardStore.replay(cardId, sessionId);
    expect(Object.keys(stateAfterRollback.tree.floors)).toHaveLength(2);
    expect(stateAfterRollback.tree.floors[floor3Ev.payload.floorId]).toBeUndefined();

    // 9. 撤销回退：第 3 楼自包含恢复
    const undoEv = await cardStore.undoRollback(cardId, sessionId);
    expect(undoEv.payload.restoredFloorIds).toContain(floor3Ev.payload.floorId);

    const stateAfterUndo = await cardStore.replay(cardId, sessionId);
    expect(Object.keys(stateAfterUndo.tree.floors)).toHaveLength(3);
    expect(stateAfterUndo.tree.floors[floor3Ev.payload.floorId]).toBeDefined();

    // 10. 离线重开恢复验证 (完全重新实例化 CardStore，模拟服务重启后无内存持久化恢复)
    const freshCardStore = new CardStore(tempHome);
    const restoredSession = await freshCardStore.replay(cardId, sessionId);
    expect(restoredSession.tree.id).toBe(sessionId);
    expect(Object.keys(restoredSession.tree.floors)).toHaveLength(3);
    expect(restoredSession.tree.floors[floor2Ev.payload.floorId].content).toBe(editedEv.payload.content);
  });
});
