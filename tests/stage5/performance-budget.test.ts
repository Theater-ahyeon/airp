// tests/stage5/performance-budget.test.ts
// Stage 5 Performance Budget & Prefix Cache Verification:
// 1. Single prompt assembly latency < 300ms
// 2. Stable-prefix token ratio >= 90% — necessary condition for prefix cache hits
//    (real hit rate requires a real provider's usage.cacheRead; not fabricated here)
// 3. 10,000-floor cold boot replay budget — synthetic snapshot benchmark (bypasses the real write path; see in-test note)
// 4. Real write path: 300 appendFloor calls trigger real threshold snapshots; snapshot replay ≡ full event replay

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CardStore } from "../../src/runtime/card-store.js";
import { AssemblyPipeline } from "../../src/core/pipeline/assembly-pipeline.js";
import { createCharacterCard } from "../../src/core/types/character.js";
import { FloorMessage } from "../../src/core/types/floor-tree.js";
import { snapshotsDir } from "../../src/runtime/paths.js";

describe("Stage 5 Performance Budget & Prefix Cache Verification", () => {
  let tempHome: string;
  let cardStore: CardStore;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "airp-perf-budget-"));
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

  it("性能指标 1: 单次 Prompt 组装延迟 < 300ms (实测应远低于 50ms)", () => {
    const card = createCharacterCard("card_perf", {
      name: "艾莉丝",
      description: "皇家大魔导师，拥有海量典籍知识。",
      personality: "冷静，严谨",
      scenario: "学院大图书馆",
      firstMessage: "欢迎来到禁忌区。",
      mesExamples: "",
      systemPrompt: "遵循标准角色扮演设定。",
    });

    const floors: FloorMessage[] = [];
    for (let i = 1; i <= 200; i++) {
      floors.push({
        id: `f_${i}`,
        parentId: i > 1 ? `f_${i - 1}` : null,
        branchId: "main",
        floorIndex: i,
        role: i % 2 === 0 ? "assistant" : "user",
        content: `这是第 ${i} 楼的长篇对话历史，记录了关于魔法、符文与古代文献的探讨。`,
        createdAt: 1700000000000 + i * 1000,
        updatedAt: 1700000000000 + i * 1000,
        swipes: [`这是第 ${i} 楼的长篇对话历史。`],
        currentSwipeIndex: 0,
      });
    }

    const pipeline = new AssemblyPipeline();
    const start = performance.now();

    const result = pipeline.assemble({
      character: card,
      floorHistory: floors,
      latestUserInput: "请问关于古代符文的第七法则是什么？",
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      provider: "openai",
    });

    const duration = performance.now() - start;

    expect(result.messages.length).toBeGreaterThan(0);
    // 严格断言：单次组装必须在 300ms 以内（实测通常仅数毫秒）
    expect(duration).toBeLessThan(300);
  });

  it("性能指标 2: 稳定前缀 token 占比 ≥ 90%（前缀缓存命中的必要条件）", () => {
    // 卡片静态素材（systemPrompt / 角色核心定义）构成稳定前缀的主体。本场景刻意让静态素材
    // 显著大于单轮用户输入，对应"静态设定主导、逐轮追加"的真实长对话形态。
    const card = createCharacterCard("card_cache", {
      name: "汐",
      description: "守灯人，世代驻守北崖灯塔的孤独守望者。熟知海图、星象与旧航路的禁忌传说，性情克制而温和，只在涨潮时分开口讲述往事。",
      personality: "冷静、寡言、观察敏锐，对承诺有着近乎固执的坚持",
      scenario: "北崖灯塔的守灯人小屋，窗外是终年不散的海雾与灯塔酒馆的灯火",
      firstMessage: "夜潮初起。",
      mesExamples: "",
      systemPrompt: "严肃叙事小说风格。以第三人称有限视角推进剧情，保持灯塔酒馆世界观的一致性，禁止替用户角色做出决定或改写其行为。",
    });

    const pipeline = new AssemblyPipeline();

    // Turn 1 组装
    const r1 = pipeline.assemble({
      character: card,
      floorHistory: [],
      latestUserInput: "第一轮提问",
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      provider: "openai",
    });

    // Turn 2 组装（角色卡核心定义与静态设定不变，仅追加新楼层）
    const r2 = pipeline.assemble({
      character: card,
      floorHistory: [
        {
          id: "f_1",
          parentId: null,
          branchId: "main",
          floorIndex: 1,
          role: "user",
          content: "第一轮提问",
          createdAt: 1,
          updatedAt: 1,
          swipes: ["第一轮提问"],
          currentSwipeIndex: 0,
        },
      ],
      latestUserInput: "第二轮提问",
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
      provider: "openai",
    });

    // 核心断言 1：静态稳定前缀哈希跨轮次保持一致——这是前缀可整体复用（缓存命中）的必要条件
    expect(r2.prefixHash).toBe(r1.prefixHash);

    // 核心断言 2（真实测量，取代旧 940/1000 字面常量同义反复）：
    // 稳定前缀 token 占比 = r1.blocks 中 isStablePrefix 块的 tokens 之和 / r1.totalPromptTokens。
    // 占比 ≥ 90% 是前缀缓存命中的必要条件（稳定前缀不变，追加新轮次时前缀部分才可整体复用）；
    // 真实命中率需接入真实 provider 并读取其返回的 usage.cacheRead 才可测得，此处不伪造该数字。
    const stablePrefixTokens = r1.blocks
      .filter((block) => block.isStablePrefix)
      .reduce((sum, block) => sum + block.tokens, 0);
    // 非空守卫：稳定前缀必须有实际内容，防止占比断言空洞化
    expect(stablePrefixTokens).toBeGreaterThan(0);
    if (r1.totalPromptTokens > 0) {
      const stablePrefixRatio = stablePrefixTokens / r1.totalPromptTokens;
      expect(stablePrefixRatio).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("性能指标 3: 万楼数据集冷启动重放延迟预算（合成快照基准，< 2000ms）", async () => {
    const cardId = "card_10k";
    const sessionId = "sess_10k";
    await cardStore.createCard({ cardId, attributes: { name: "10K Character", description: "test", personality: "p", scenario: "s", firstMessage: "m", mesExamples: "" } });
    await cardStore.createSession(cardId, sessionId);

    // 【合成基准声明】以下场景为人工构造：直接把 9800 楼的完整树一次性写入单个快照文件，
    // 绕过了真实写入路径（appendFloor → events.jsonl 追加 → 每 50 条事件阈值触发快照）。
    // 它只测量"从单个大快照文件冷启动加载"的读取性能，不能作为真实重放管线的证据；
    // 真实写入路径的行为由本文件末尾的"真实写入路径"测试单独覆盖。
    // Unchecked cast（具名化以显式声明越界访问）：getSnapshotStore 为私有方法，
    // 合成基准需要绕过真实写入路径直接持有 SnapshotStore。
    const storeInternals = cardStore as unknown as {
      getSnapshotStore: (c: string, s: string) => { save: (cp: unknown) => Promise<void> };
    };
    const snapStore = storeInternals.getSnapshotStore(cardId, sessionId);

    const checkpointFloors: Record<string, unknown> = {};
    for (let i = 1; i <= 9800; i++) {
      checkpointFloors[`f_${i}`] = {
        id: `f_${i}`,
        parentId: i > 1 ? `f_${i - 1}` : null,
        branchId: "main",
        floorIndex: i,
        role: i % 2 === 0 ? "assistant" : "user",
        content: `第 ${i} 楼的历史对话内容`,
        swipes: [`第 ${i} 楼的历史对话内容`],
        currentSwipeIndex: 0,
        createdAt: 1000000 + i,
        updatedAt: 1000000 + i,
      };
    }

    // 直接调用私有 SnapshotStore.save 写入合成快照（绕过真实阈值触发链路）
    await snapStore.save({
      schemaVersion: 1,
      cardId,
      sessionId,
      seq: 9800,
      createdAt: Date.now(),
      tree: {
        id: sessionId,
        rootFloorId: "f_1",
        activeBranchId: "main",
        floors: checkpointFloors,
        undoCheckpointFloorId: null,
      },
      state: { affection: 100 },
      summary: "前 9800 楼已完整总结归档",
    });

    // 测算从最新快照恢复 9800 楼的冷启动加载耗时
    const startReplay = performance.now();
    const replayResult = await cardStore.replay(cardId, sessionId);
    const duration = performance.now() - startReplay;

    expect(Object.keys(replayResult.tree.floors).length).toBe(9800);
    expect(replayResult.fromCheckpointSeq).toBe(9800);
    // 万楼冷启动必须在 2000ms 预算之内（实测因为有快照优化，耗时仅数十毫秒）
    expect(duration).toBeLessThan(2000);
  });

  it("真实写入路径：300 楼 appendFloor 触发真实阈值快照，快照重放与全量重放一致", { timeout: 30000 }, async () => {
    // 与上方万楼合成基准不同：这里走完整真实链路
    // appendFloor → events.jsonl 追加（fsync）→ 每 50 条事件阈值触发 createCheckpoint 落盘快照
    const store = new CardStore(tempHome, 50);
    const cardId = "card_real_write";
    const sessionId = "sess_real_write";
    await store.createCard({ cardId, attributes: { name: "Real Write", description: "test", personality: "p", scenario: "s", firstMessage: "m", mesExamples: "" } });
    await store.createSession(cardId, sessionId);

    for (let i = 1; i <= 300; i++) {
      await store.appendFloor(cardId, sessionId, {
        role: i % 2 === 1 ? "user" : "assistant",
        content: `第${i}楼`,
      });
    }

    // (a) snapshots 目录下真实落盘 ≥5 个快照文件（seq 50/100/.../300 各触发一次，共 6 个）
    const snapDir = snapshotsDir(store.home, cardId, sessionId);
    const snapshotFiles = (await fs.readdir(snapDir)).filter((name) => name.endsWith(".json"));
    expect(snapshotFiles.length).toBeGreaterThanOrEqual(5);

    // (b) 最终快照重放与忽略快照的全量重放结果一致（楼层键集合与 lastSeq）
    const fromSnapshot = await store.replay(cardId, sessionId);
    const fromScratch = await store.replay(cardId, sessionId, { ignoreSnapshot: true });

    expect(Object.keys(fromSnapshot.tree.floors).sort()).toEqual(Object.keys(fromScratch.tree.floors).sort());
    expect(fromSnapshot.lastSeq).toBe(fromScratch.lastSeq);
    // 非空守卫：防止"两边都为空"使一致性断言空洞通过。
    // session_created 占 seq 1，300 条 floor_appended → lastSeq = 301，楼层共 300 个
    expect(Object.keys(fromSnapshot.tree.floors)).toHaveLength(300);
    expect(fromSnapshot.lastSeq).toBe(301);
  });
});
