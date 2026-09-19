// tests/stage5/memory-recall-eval.test.ts
// Stage 5 Long-term Memory Recall Evaluation Suite:
// Buries facts at floor k, moves 50 floors forward, and asserts Butler extraction,
// versioned summary derivation, and exact prompt assembly recall.

import { describe, it, expect } from "vitest";
import { ButlerService, ButlerModelRunner } from "../../src/core/butler/butler.js";
import { ButlerHostABI } from "../../src/core/butler/contracts.js";
import { SummaryManager } from "../../src/core/memory/summary-manager.js";
import { AssemblyPipeline } from "../../src/core/pipeline/assembly-pipeline.js";
import { createCharacterCard } from "../../src/core/types/character.js";
import { FloorMessage } from "../../src/core/types/floor-tree.js";

describe("Stage 5 Long-term Memory Recall Evaluation Suite (k -> k+50 楼跨度验证)", () => {
  it("记忆锚定与召回闭环：k 楼埋入结构化事实与背景，跨越 50 楼后在组装与状态中精准召回", async () => {
    const memoryStateStore: Record<string, unknown> = {};
    let currentSummary: string = "";

    const hostAbi: ButlerHostABI = {
      getLatestFloorState: async () => ({ ...memoryStateStore }),
      appendStateOps: async (_c, _s, _f, _b, ops) => {
        for (const op of ops) {
          if (op.type === "set") memoryStateStore[op.key] = op.value;
          if (op.type === "inc") memoryStateStore[op.key] = ((memoryStateStore[op.key] as number) ?? 0) + (op.value as number);
        }
      },
      updateSummary: async (_c, _s, _b, _u, s) => {
        currentSummary = s;
      },
    };

    // 1. 在第 10 楼（k 楼）埋入关键事实：持有秘密钥匙、汐好感提升、解锁灯塔暗室线索
    const runner: ButlerModelRunner = {
      run: async (tier, prompt) => {
        if (prompt.includes("Floor: floor_10")) {
          return {
            rawText: "",
            toolCallArgs: {
              stateOps: [
                { type: "set", key: "secretKey", value: "rusted_copper_key" },
                { type: "set", key: "unlockedChamber", value: "lighthouse_b2" },
                { type: "inc", key: "affection", value: 15 },
              ],
              suggestedSummary: "旅行者获得了生锈的铜钥匙，得知可前往灯塔地下二层。",
            },
            tokensUsed: { input: 120, output: 30 },
          };
        }
        return {
          rawText: "{}",
          toolCallArgs: { stateOps: [] },
          tokensUsed: { input: 20, output: 5 },
        };
      },
    };

    const butler = new ButlerService(hostAbi, runner);
    await butler.scheduleFloorAnalysis("card_xi", "session_01", "main", {
      floorId: "floor_10",
      userMessage: "我愿意帮你守住灯塔，请把钥匙交给我吧。",
      assistantMessage: "汐将生锈的铜钥匙交给了你，并嘱咐你前往地下二层。",
      currentState: memoryStateStore,
    });

    // 验证 k 楼管家已准确写入事实
    expect(memoryStateStore.secretKey).toBe("rusted_copper_key");
    expect(memoryStateStore.unlockedChamber).toBe("lighthouse_b2");
    expect(memoryStateStore.affection).toBe(15);
    expect(currentSummary).toContain("生锈的铜钥匙");

    // 2. 跨越 50 楼（推进至第 60 楼，k+50）
    const summaryManager = new SummaryManager();
    summaryManager.setSummary("main", "floor_10", 10, currentSummary);

    const floors: FloorMessage[] = [];
    for (let i = 1; i <= 60; i++) {
      floors.push({
        id: `floor_${i}`,
        parentId: i > 1 ? `floor_${i - 1}` : null,
        branchId: "main",
        floorIndex: i,
        role: i % 2 === 0 ? "assistant" : "user",
        content: `这是第 ${i} 楼的对话内容，关于海风与灯塔的日常交谈。`,
        createdAt: 1700000000000 + i * 1000,
        updatedAt: 1700000000000 + i * 1000,
        swipes: [`这是第 ${i} 楼的对话内容。`],
        currentSwipeIndex: 0,
      });
    }

    // 3. 在第 60 楼发起 Prompt 组装，测试第 10 楼埋入的记忆召回情况
    const card = createCharacterCard("card_xi", {
      name: "汐",
      description: "灯塔守灯人",
      personality: "冷静",
      scenario: "雾港灯塔",
      firstMessage: "夜潮初起。",
      mesExamples: "",
      systemPrompt: "角色扮演模式。",
    });

    const pipeline = new AssemblyPipeline();
    const assembled = pipeline.assemble({
      character: card,
      floorHistory: floors,
      latestUserInput: "汐，你还记得我们在第十夜拿到的那把钥匙吗？",
      state: memoryStateStore,
      rollingSummary: summaryManager.getSummary("main"),
      pinnedStateKeys: ["secretKey", "unlockedChamber"],
      maxContextTokens: 1500,
      maxOutputTokens: 200,
      provider: "openai",
    });
    // 4. 断言记忆召回完整性
    // 系统提示词中必须精准召回 50 楼前埋入的结构化事实
    expect(assembled.systemPrompt).toContain("- secretKey: rusted_copper_key");
    expect(assembled.systemPrompt).toContain("- unlockedChamber: lighthouse_b2");
    expect(assembled.systemPrompt).toContain("- affection: 15");

    // 滚动摘要中必须包含长程记忆事件
    expect(assembled.systemPrompt).toContain("生锈的铜钥匙");

    // 历史楼层滑动窗口已被安全截断，但关键事实零丢失
    expect(assembled.truncatedBlocks.length).toBeGreaterThan(0);
    expect(assembled.prefixHash).toBeTruthy();
  });
});
