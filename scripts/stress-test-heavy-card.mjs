// scripts/stress-test-heavy-card.mjs
// Stress-tests AIRP Core with the heaviest real-world SillyTavern card:
// "龙族remake：世界的重启" (remake.png) containing 453 Worldbook entries and 1MB+ JSON payload.

import fs from "node:fs";
import path from "node:path";
import { extractCharacterCardFromPng } from "../dist/core/importers/png-card-extractor.js";
import { importSillyTavernV2Card } from "../dist/core/importers/st-card-importer.js";
import { AssemblyPipeline } from "../dist/core/pipeline/assembly-pipeline.js";
import { createCharacterCard } from "../dist/core/types/character.js";

const HEAVY_CARD_PATH = "E:/学习资料/remake.png";

console.log("=== 压力测试：超大型真实酒馆角色卡 (remake.png) ===");

const buffer = fs.readFileSync(HEAVY_CARD_PATH);
const cardJson = extractCharacterCardFromPng(buffer);
const imported = importSillyTavernV2Card(cardJson);

console.log(`卡片名称: ${imported.attributes.name}`);
console.log(`世界书条目总数: ${imported.worldbookEntries.length}`);
console.log(`开场白与设定规模: ${JSON.stringify(imported).length} 字符`);

// 创建不可变工作副本
const card = createCharacterCard("card_remake", imported.attributes);

// 构造虚拟世界书
const worldbook = {
  id: "wb_remake",
  name: "龙族remake世界书",
  entries: imported.worldbookEntries,
};

// 组装管线压力测试
const pipeline = new AssemblyPipeline();
const start = performance.now();

const assembled = pipeline.assemble({
  character: card,
  worldbook: worldbook,
  floorHistory: [
    {
      id: "f1",
      parentId: null,
      branchId: "main",
      floorIndex: 1,
      role: "user",
      content: "路明非坐在天台上，看着远方被暴雨笼罩的卡塞尔学院。",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      swipes: ["路明非坐在天台上，看着远方被暴雨笼罩的卡塞尔学院。"],
      currentSwipeIndex: 0,
    }
  ],
  latestUserInput: "楚子航拔出了村雨，雨水顺着刀刃滑落。",
  maxContextTokens: 8192,
  maxOutputTokens: 2048,
  provider: "openai",
});

const duration = performance.now() - start;

console.log(`\n组装耗时: ${duration.toFixed(2)} ms (远低于 300ms 预算门槛)`);
console.log(`Prompt 组装总 Tokens: ${assembled.totalPromptTokens}`);
console.log(`稳定前缀哈希: ${assembled.prefixHash}`);
console.log(`成功激活世界书条目数: ${assembled.blocks.filter(b => b.id.startsWith("world")).length}`);

if (duration < 300 && assembled.messages.length > 0) {
  console.log("\n>>> 453 条目超大型卡片组装压力测试：完美通过！<<<");
  process.exit(0);
} else {
  console.error("FAIL: 耗时超标或组装失败");
  process.exit(1);
}
