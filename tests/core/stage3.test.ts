// tests/core/stage3.test.ts
// Stage 3 exit criteria validation:
// 1. Degradation four tiers fixture test
// 2. Summary invalidation & lazy recalculation fixture
// 3. Memory recall evaluation suite (with mock adapter)
// 4. Physical forgetting semantics test (pruned branch state invisible)
// 5. Card-level memory session review consolidation

import { describe, it, expect } from "vitest";
import { ButlerService, ButlerModelRunner } from "../../src/core/butler/butler.js";
import { ButlerHostABI, DegradationTier } from "../../src/core/butler/contracts.js";
import { SummaryManager } from "../../src/core/memory/summary-manager.js";
import { SessionReviewConsolidator } from "../../src/core/memory/session-review.js";
import { StateManager } from "../../src/core/state/state-manager.js";
import { StateOp } from "../../src/core/types/state.js";
import { DualModeWorldbookRetriever } from "../../src/core/worldbook/dual-mode-retriever.js";
import { Worldbook } from "../../src/core/types/worldbook.js";

describe("Stage 3 · 状态系统与后台管家", () => {
  it("1. 管家四级降级阶梯探测与执行测试 (Tool -> JSON -> Parse -> Disabled)", async () => {
    let recordedOps: Array<{ key: string; value?: unknown }> = [];
    let recordedSummary: string | null = null;

    const fakeHostAbi: ButlerHostABI = {
      getLatestFloorState: async () => ({ affection: 50 }),
      appendStateOps: async (_c, _s, _f, _b, ops) => {
        recordedOps.push(...ops);
      },
      updateSummary: async (_c, _s, _b, _u, s) => {
        recordedSummary = s;
      }
    };

    // Tier 1: Tool Calling
    const runnerT1: ButlerModelRunner = {
      run: async () => ({
        rawText: "",
        toolCallArgs: {
          stateOps: [{ type: "inc", key: "affection", value: 5 }],
          suggestedSummary: "好感度上升"
        },
        tokensUsed: { input: 120, output: 25 }
      })
    };

    const butlerT1 = new ButlerService(fakeHostAbi, runnerT1);
    butlerT1.setCapability({ tier: 1, label: "tool-calling", detectedAt: Date.now() });
    await butlerT1.scheduleFloorAnalysis("c1", "s1", "main", {
      floorId: "f1",
      userMessage: "送你一朵花",
      assistantMessage: "谢谢你，我很开心。",
      currentState: { affection: 50 }
    });

    expect(recordedOps.length).toBe(1);
    expect(recordedOps[0].key).toBe("affection");
    expect(recordedSummary).toBe("好感度上升");

    // Tier 2: JSON Mode
    recordedOps = [];
    const runnerT2: ButlerModelRunner = {
      run: async () => ({
        rawText: JSON.stringify({
          stateOps: [{ type: "set", key: "giftReceived", value: true }]
        }),
        tokensUsed: { input: 100, output: 20 }
      })
    };

    const butlerT2 = new ButlerService(fakeHostAbi, runnerT2);
    butlerT2.setCapability({ tier: 2, label: "json-mode", detectedAt: Date.now() });
    await butlerT2.scheduleFloorAnalysis("c1", "s1", "main", {
      floorId: "f2",
      userMessage: "这是给你的礼物",
      assistantMessage: "非常感谢！",
      currentState: {}
    });

    expect(recordedOps.length).toBe(1);
    expect(recordedOps[0].key).toBe("giftReceived");

    // Tier 3: Prompt + Parse (Markdown fenced JSON)
    recordedOps = [];
    const runnerT3: ButlerModelRunner = {
      run: async () => ({
        rawText: "分析结果如下：\n```json\n{\n  \"stateOps\": [{\"type\": \"set\", \"key\": \"mood\", \"value\": \"happy\"}]\n}\n```",
        tokensUsed: { input: 110, output: 30 }
      })
    };

    const butlerT3 = new ButlerService(fakeHostAbi, runnerT3);
    butlerT3.setCapability({ tier: 3, label: "prompt-parse", detectedAt: Date.now() });
    await butlerT3.scheduleFloorAnalysis("c1", "s1", "main", {
      floorId: "f3",
      userMessage: "今天心情如何？",
      assistantMessage: "很不错！",
      currentState: {}
    });

    expect(recordedOps.length).toBe(1);
    expect(recordedOps[0].key).toBe("mood");

    // Tier 4: Disabled
    recordedOps = [];
    const runnerT4: ButlerModelRunner = {
      run: async () => {
        throw new Error("Should not be called when disabled");
      }
    };
    const butlerT4 = new ButlerService(fakeHostAbi, runnerT4);
    butlerT4.setCapability({ tier: 4, label: "disabled", detectedAt: Date.now() });
    const res = await butlerT4.scheduleFloorAnalysis("c1", "s1", "main", {
      floorId: "f4",
      userMessage: "测试",
      assistantMessage: "回复",
      currentState: {}
    });
    expect(res).toBeNull();
    expect(recordedOps.length).toBe(0);
  });

  it("2. 管家一致性协议：后续 Prompt 组装等待紧邻前一楼管家结算", async () => {
    let resolved = false;
    const fakeHostAbi: ButlerHostABI = {
      getLatestFloorState: async () => ({}),
      appendStateOps: async () => {},
      updateSummary: async () => {}
    };

    const { promise: gatePromise, resolve: openGate } = Promise.withResolvers<void>();
    const runner: ButlerModelRunner = {
      run: async () => {
        await gatePromise;
        resolved = true;
        return {
          rawText: "{}",
          toolCallArgs: { stateOps: [] },
          tokensUsed: { input: 10, output: 5 }
        };
      }
    };

    const butler = new ButlerService(fakeHostAbi, runner);
    // 触发 f1 分析
    butler.scheduleFloorAnalysis("c1", "s1", "main", {
      floorId: "f1",
      userMessage: "嗨",
      assistantMessage: "你好",
      currentState: {}
    });

    expect(resolved).toBe(false);
    // 打开门禁并等待结算
    openGate();
    await butler.waitForFloorSettlement("c1", "s1", "f1");
    expect(resolved).toBe(true);
  });
  it("3. 摘要失效与版本化懒重算测试", () => {
    const manager = new SummaryManager();
    // 0 楼未达到阈值（10 楼）
    expect(manager.shouldRecalculate("main", 5, 10)).toBe(false);
    // 达到 10 楼触发初次计算
    expect(manager.shouldRecalculate("main", 10, 10)).toBe(true);

    manager.setSummary("main", "f10", 10, "前10楼讲述了旅程的开始。");
    expect(manager.getSummary("main")).toBe("前10楼讲述了旅程的开始。");

    // 第 15 楼，增量只有 5 楼，不满足新跨度，不重复重算
    expect(manager.shouldRecalculate("main", 15, 10)).toBe(false);

    // 第 20 楼，增量达到 10 楼，触发懒重算
    expect(manager.shouldRecalculate("main", 20, 10)).toBe(true);

    // 物理遗忘分支
    manager.forgetBranch("main");
    expect(manager.getSummary("main")).toBeNull();
  });

  it("4. 物理遗忘语义测试：删分支/回退后其关联的状态不可见", () => {
    const ops: StateOp[] = [
      { id: "op1", floorId: "f1", branchId: "main", type: "set", key: "quest", value: "main_quest", timestamp: 1 },
      { id: "op2", floorId: "f2", branchId: "main", type: "set", key: "gold", value: 100, timestamp: 2 },
      { id: "op3", floorId: "f3", branchId: "branch_sub", type: "set", key: "gold", value: 500, timestamp: 3 },
      { id: "op4", floorId: "f3", branchId: "branch_sub", type: "set", key: "secretItem", value: "cursed_sword", timestamp: 4 }
    ];

    // 当 branch_sub 被遗忘（仅保留 f1, f2 时）
    const visibleFloors = ["f1", "f2"];
    const projected = StateManager.projectState({}, ops, visibleFloors);

    expect(projected.quest).toBe("main_quest");
    expect(projected.gold).toBe(100);
    // 物理遗忘：branch_sub 上的状态完全不存在
    expect(projected.secretItem).toBeUndefined();
  });

  it("5. 会话复盘合并为卡级记忆测试", () => {
    const existing = {
      cardId: "card_1",
      version: 1,
      updatedAt: 1000,
      memories: [
        {
          id: "m1",
          key: "user_name",
          value: "旅行者",
          confidence: 0.9,
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    };

    const newFacts = [
      { key: "user_name", value: "旅行者空", confidence: 1.0 },
      { key: "favorite_food", value: "苹果派", confidence: 0.85 }
    ];

    const consolidated = SessionReviewConsolidator.consolidate(
      {
        cardId: "card_1",
        sessionId: "sess_100",
        finalState: {},
        existingCardMemory: existing
      },
      newFacts
    );

    expect(consolidated.version).toBe(2);
    expect(consolidated.memories.length).toBe(2);
    const nameMem = consolidated.memories.find((m) => m.key === "user_name");
    expect(nameMem?.value).toBe("旅行者空");
    expect(nameMem?.sourceSessionId).toBe("sess_100");

    const foodMem = consolidated.memories.find((m) => m.key === "favorite_food");
    expect(foodMem?.value).toBe("苹果派");
  });

  it("6. 世界书双模检索测试 (Tool priority + keyword fallback)", () => {
    const wb: Worldbook = {
      id: "wb1",
      name: "大陆编年史",
      entries: [
        {
          id: "e1",
          keys: ["圣剑", "王者之剑"],
          content: "圣剑沉睡在湖底。",
          enabled: true,
          priority: 20,
          mode: "tool_search"
        },
        {
          id: "e2",
          keys: ["酒馆", "旅店"],
          content: "老橡树酒馆总是坐满了冒险者。",
          enabled: true,
          priority: 10,
          mode: "keyword"
        },
        {
          id: "e3",
          keys: ["世界底则"],
          content: "魔力潮汐永不休止。",
          enabled: true,
          priority: 100,
          mode: "always"
        }
      ]
    };

    const retriever = new DualModeWorldbookRetriever(wb);

    // 模型主动发起工具检索查 "圣剑"，同时用户对话中出现了 "酒馆"
    const result = retriever.retrieve("我们今晚先去酒馆投宿吧。", ["圣剑"]);

    expect(result.toolRetrievedEntries.map((e) => e.id)).toContain("e1");
    expect(result.keywordMatchedEntries.map((e) => e.id)).toContain("e2");
    expect(result.keywordMatchedEntries.map((e) => e.id)).toContain("e3");
    expect(result.allActiveEntries.length).toBe(3);
    expect(result.tokensEstimated).toBeGreaterThan(0);
  });
});
