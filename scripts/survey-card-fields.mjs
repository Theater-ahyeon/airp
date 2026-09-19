// scripts/survey-card-fields.mjs
// clean-room 字段普查：从真实卡库推导 ST 卡实际字段面（data 层 / 世界书条目层 / extensions 层）。
// 输出频率表，指导 importer 字段清单与兼容报告。

import fs from "node:fs";
import path from "node:path";
import { extractCharacterCardFromPng } from "../dist/core/importers/png-card-extractor.js";

const TARGET_DIR = "E:/学习资料";

function scanPngFiles(dir) {
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results = results.concat(scanPngFiles(full));
      else if (entry.name.toLowerCase().endsWith(".png")) results.push(full);
    }
  } catch {
    /* skip */
  }
  return results;
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

const specMap = new Map();
const dataKeys = new Map();
const rootKeys = new Map();
const entryKeys = new Map();
const bookKeys = new Map();
const extKeys = new Map();
const entryExtKeys = new Map();
const selectiveLogic = new Map();
let cards = 0;
let withBook = 0;
let entryTotal = 0;

for (const p of scanPngFiles(TARGET_DIR)) {
  let json;
  try {
    json = extractCharacterCardFromPng(fs.readFileSync(p));
  } catch {
    continue;
  }
  cards++;
  bump(specMap, json.spec ?? (json.data ? "chara_card_v2(implicit)" : "legacy_v1"));
  for (const k of Object.keys(json)) {
    if (k !== "data") bump(rootKeys, k);
  }
  if (!json.data || typeof json.data !== "object") continue;
  for (const k of Object.keys(json.data)) bump(dataKeys, k);
  const ext = json.data.extensions;
  if (ext && typeof ext === "object" && !Array.isArray(ext)) {
    for (const k of Object.keys(ext)) bump(extKeys, k);
  }
  const book = json.data.character_book;
  if (book && typeof book === "object") {
    withBook++;
    for (const k of Object.keys(book)) bump(bookKeys, k);
    if (Array.isArray(book.entries)) {
      for (const e of book.entries) {
        if (!e || typeof e !== "object") continue;
        entryTotal++;
        for (const k of Object.keys(e)) {
          bump(entryKeys, k);
          if (k === "extensions" && e.extensions && typeof e.extensions === "object") {
            for (const ek of Object.keys(e.extensions)) bump(entryExtKeys, ek);
          }
        }
        if ("selectiveLogic" in e) bump(selectiveLogic, String(e.selectiveLogic));
      }
    }
  }
}

const show = (label, map) => {
  console.log(`\n## ${label}`);
  for (const [k, n] of sorted(map)) console.log(`  ${k}: ${n}`);
};

console.log(`卡片总数: ${cards}（含世界书: ${withBook}，条目总数: ${entryTotal}）`);
show("spec", specMap);
show("根级字段", rootKeys);
show("data 层字段", dataKeys);
show("extensions.* 键", extKeys);
show("character_book 字段", bookKeys);
show("条目字段", entryKeys);
show("条目 extensions.* 键", entryExtKeys);
show("selectiveLogic 取值", selectiveLogic);
