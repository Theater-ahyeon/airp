// scripts/test-real-cards.mjs
// Test runner scanning real SillyTavern character cards from E:/学习资料.

import fs from "node:fs";
import path from "node:path";
import { extractCharacterCardFromPng } from "../dist/core/importers/png-card-extractor.js";
import { importSillyTavernV2Card } from "../dist/core/importers/st-card-importer.js";

const TARGET_DIR = "E:/学习资料";

function scanPngFiles(dir) {
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(scanPngFiles(full));
      } else if (entry.name.toLowerCase().endsWith(".png")) {
        results.push(full);
      }
    }
  } catch (err) {
    console.error(`Cannot read directory: ${dir}`, err);
  }
  return results;
}

const allPngs = scanPngFiles(TARGET_DIR);
console.log(`=== Found ${allPngs.length} PNG files in ${TARGET_DIR} ===\n`);

let validCards = 0;
let plainImages = 0;
let errors = 0;
const parsedCardStats = [];

for (const pngPath of allPngs) {
  const fileName = path.basename(pngPath);
  try {
    const buffer = fs.readFileSync(pngPath);
    let cardJson;
    try {
      cardJson = extractCharacterCardFromPng(buffer);
    } catch {
      // Normal image without embedded card metadata
      plainImages++;
      continue;
    }

    const imported = importSillyTavernV2Card(cardJson);
    validCards++;
    parsedCardStats.push({
      file: fileName,
      name: imported.attributes.name,
      firstMesLength: imported.attributes.firstMessage.length,
      descLength: imported.attributes.description.length,
      worldbookEntries: imported.worldbookEntries.length,
      alternateGreetings: imported.alternateGreetings.length,
      tags: imported.attributes.tags.length,
    });
  } catch (err) {
    errors++;
    console.error(`FAIL: Error parsing card from ${fileName}:`, err.message);
  }
}

console.log("\n--- Top 15 Parsed Character Cards Summary ---");
for (const card of parsedCardStats.slice(0, 15)) {
  console.log(`✓ [${card.name}] (文件: ${card.file})`);
  console.log(`   开场白字数: ${card.firstMesLength} | 人设描述字数: ${card.descLength} | 内嵌世界书条目: ${card.worldbookEntries} | 备用问候: ${card.alternateGreetings}`);
}

console.log("\n=== 真实卡片测试最终统计 ===");
console.log(`总图片数: ${allPngs.length}`);
console.log(`成功解析酒馆角色卡: ${validCards} 张`);
console.log(`普通二次元/插画图片: ${plainImages} 张`);
console.log(`解析失败/损坏异常: ${errors} 张`);

if (errors === 0 && validCards > 0) {
  console.log("\n>>> 全部真实酒馆卡片 100% 成功提取与导入！<<<");
  process.exit(0);
} else {
  process.exit(errors > 0 ? 1 : 0);
}
