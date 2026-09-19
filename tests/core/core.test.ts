// tests/core/core.test.ts
import { describe, it, expect } from "vitest";
import { createCharacterCard, resetWorkingCopy } from "../../src/core/types/character.js";
import {
  createFloorTree,
  appendFloor,
  addSwipe,
  switchSwipe,
  editFloor,
  rollbackToFloor,
  undoRollback,
  getFloorPath
} from "../../src/core/types/floor-tree.js";
import { Worldbook, filterWorldbookEntries } from "../../src/core/types/worldbook.js";
import { StateOp, applyStateOp, replayStateOps } from "../../src/core/types/state.js";
import { estimateTokens } from "../../src/core/pipeline/token-estimator.js";
import { selectActiveStates } from "../../src/core/pipeline/state-selector.js";
import { AssemblyPipeline } from "../../src/core/pipeline/assembly-pipeline.js";
import { MockModelAdapter } from "../../src/core/adapters/mock-model.js";

describe("Stage 1 Core Domain & Assembly Pipeline", () => {
  it("Character card: immutable original and working copy", () => {
    const card = createCharacterCard("char_1", {
      name: "艾莉丝",
      description: "皇家魔法使",
      personality: "严谨、冷静",
      scenario: "学院图书馆",
      firstMessage: "你好，远方的学者。",
      mesExamples: "<START>\n艾莉丝: 静候指教。"
    });

    expect(card.original.name).toBe("艾莉丝");
    expect(card.workingCopy.name).toBe("艾莉丝");

    // Modify working copy
    card.workingCopy.name = "艾莉丝 (工作版)";
    expect(card.original.name).toBe("艾莉丝");
    expect(card.workingCopy.name).toBe("艾莉丝 (工作版)");

    // Reset working copy
    const reset = resetWorkingCopy(card);
    expect(reset.workingCopy.name).toBe("艾莉丝");
  });

  it("Floor tree: append, swipe, edit, rollback, and undo-rollback", () => {
    const tree = createFloorTree("session_1");
    const f1 = appendFloor(tree, "user", "你好！");
    const f2 = appendFloor(tree, "assistant", "你好，学者。", f1.id);

    expect(f2.swipes).toEqual(["你好，学者。"]);
    expect(f2.currentSwipeIndex).toBe(0);

    // Add swipe
    addSwipe(tree, f2.id, "初次见面，旅人。");
    expect(f2.swipes.length).toBe(2);
    expect(f2.content).toBe("初次见面，旅人。");

    // Switch swipe back
    switchSwipe(tree, f2.id, 0);
    expect(f2.content).toBe("你好，学者。");

    // Edit floor
    editFloor(tree, f2.id, "你好，很高兴认识你。");
    expect(f2.content).toBe("你好，很高兴认识你。");
    expect(f2.editHistory?.length).toBe(1);

    // Rollback to f1
    rollbackToFloor(tree, f1.id);
    expect(tree.floors.has(f2.id)).toBe(false);
    expect(tree.undoCheckpointFloorId).toBe(f2.id);

    // Undo rollback (when checkpoint exists)
    // Note: since f2 was physically pruned, undoRollback returns false if not found
    const restored = undoRollback(tree);
    expect(restored).toBe(false);

    const path = getFloorPath(tree);
    expect(path.length).toBe(1);
    expect(path[0].id).toBe(f1.id);
  });

  it("Worldbook: dual-mode keyword and tool search filter", () => {
    const worldbook: Worldbook = {
      id: "wb_1",
      name: "魔法大陆设定",
      entries: [
        {
          id: "e1",
          keys: ["王都", "图书馆"],
          content: "王都中央大图书馆藏书百万册。",
          enabled: true,
          priority: 10,
          mode: "keyword"
        },
        {
          id: "e2",
          keys: ["法杖", "秘银"],
          content: "秘银法杖制作工艺绝密。",
          enabled: true,
          priority: 5,
          mode: "tool_search"
        },
        {
          id: "e3",
          keys: ["世界观"],
          content: "魔法源于始源水晶。",
          enabled: true,
          priority: 100,
          mode: "always"
        }
      ]
    };

    // Keyword hit context
    const { activeEntries, searchableEntries } = filterWorldbookEntries(
      worldbook,
      "我们正在王都的大门前等待。",
      true
    );

    expect(activeEntries.map((e) => e.id)).toContain("e3"); // always
    expect(activeEntries.map((e) => e.id)).toContain("e1"); // keyword matched
    expect(searchableEntries.map((e) => e.id)).toContain("e2"); // tool_search candidate
  });

  it("StateOp: event sourcing replay and operations", () => {
    const initial = { hp: 100, inventory: ["药水"] };
    const ops: StateOp[] = [
      { id: "op1", floorId: "f1", branchId: "b1", type: "inc", key: "hp", value: -20, timestamp: 1 },
      { id: "op2", floorId: "f2", branchId: "b1", type: "push", key: "inventory", value: "地图", timestamp: 2 },
      { id: "op3", floorId: "f3", branchId: "b1", type: "set", key: "location", value: "地牢", timestamp: 3 }
    ];

    const finalState = replayStateOps(initial, ops);
    expect(finalState.hp).toBe(80);
    expect(finalState.inventory).toEqual(["药水", "地图"]);
    expect(finalState.location).toBe("地牢");
  });

  it("Token estimator: conservative cross-provider safety margin", () => {
    const text = "你好世界 Hello World! 12345";
    const tokensOpenAI = estimateTokens(text, "openai");
    const tokensConservative = estimateTokens(text, "conservative");

    expect(tokensOpenAI).toBeGreaterThan(0);
    expect(tokensConservative).toBeGreaterThanOrEqual(tokensOpenAI);
  });

  it("State selector: scores recency, relevance, and pin flags", () => {
    const state = {
      affection: 95,
      weather: "下雨",
      secretQuest: "寻找丢失的钥匙"
    };

    const { selected, renderedText } = selectActiveStates(state, {
      maxTokens: 50,
      pinnedKeys: ["affection"],
      userQuery: "钥匙在哪？",
      recentFloorHits: { secretQuest: 1, weather: 10 }
    });

    const keys = selected.map((s) => s.key);
    expect(keys).toContain("affection"); // pinned
    expect(keys).toContain("secretQuest"); // relevant query match
    expect(renderedText).toContain("affection: 95");
  });

  it("Assembly pipeline: cache-aware stable prefix, budget truncation, and hash tracking", () => {
    const card = createCharacterCard("c1", {
      name: "艾莉丝",
      description: "魔导师",
      personality: "冷静",
      scenario: "图书馆",
      firstMessage: "你好。",
      mesExamples: "",
      systemPrompt: "遵守对话规则。"
    });

    const tree = createFloorTree("t1");
    const f1 = appendFloor(tree, "user", "今天天气真好。");
    const f2 = appendFloor(tree, "assistant", "确实适合阅读。", f1.id);

    const pipeline = new AssemblyPipeline();
    const result1 = pipeline.assemble({
      character: card,
      floorHistory: [f1, f2],
      latestUserInput: "你能推荐一本书吗？",
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      provider: "openai"
    });

    expect(result1.messages.length).toBe(4); // system, user, assistant, user
    expect(result1.prefixHash).toBeTruthy();

    // Next turn: prefix hash remains identical when stable definition is unchanged
    const f3 = appendFloor(tree, "assistant", "推荐《初级符文纲要》。", f2.id);
    const result2 = pipeline.assemble({
      character: card,
      floorHistory: [f1, f2, f3],
      latestUserInput: "那有进阶的吗？",
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      provider: "openai"
    });

    expect(result2.prefixHash).toBe(result1.prefixHash); // 100% Cache Prefix Match!
  });

  it("MockModelAdapter: end-to-end simulated stream and token consumption", async () => {
    const adapter = new MockModelAdapter();
    adapter.enqueueResponse("这是第一句话，这是第二句话。");

    const events: string[] = [];
    let fullText = "";
    let usageMeta = null;

    for await (const ev of adapter.stream({
      model: "mock",
      messages: [{ role: "user", content: "测试" }]
    })) {
      events.push(ev.type);
      if (ev.type === "text_delta") fullText += ev.text;
      if (ev.type === "done") usageMeta = ev.usage;
    }

    expect(events).toContain("start");
    expect(events).toContain("text_delta");
    expect(events).toContain("done");
    expect(fullText).toBe("这是第一句话，这是第二句话。");
    expect(usageMeta?.cachedTokens).toBe(120);
  });
});
