// probes/stage2-probe.mjs
// 独立对抗性验收探针：不依赖被测方自测，直接对编译产物施压。
// 运行：node probes/stage2-probe.mjs
//
// 验证目标：
//   A. 快照边界之后执行 undo_rollback，被遗忘楼层能否恢复（怀疑缺口）
//   B. 连续两次 rollback 后 undo，是否只恢复最近一次被遗忘的楼层（怀疑过度恢复）
//   C. 基线对照：无快照介入时 undo_rollback 是否正常
//   D. undo 之后恢复点是否失效（二次 undo 必须失败）

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CardStore } from "../dist/runtime/card-store.js";

const ATTRS = {
  name: "探针角色",
  description: "用于验收探针的合成角色",
  personality: "冷静",
  scenario: "探针场景",
  firstMessage: "开始。",
  mesExamples: ""
};

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      ${detail}`);
}

async function withStore(snapshotInterval, fn) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "airp-probe-"));
  const store = new CardStore(home, snapshotInterval);
  try {
    const { cardId } = await store.createCard({ cardId: "c1", attributes: ATTRS });
    const { sessionId } = await store.createSession(cardId, "s1");
    return await fn({ store, cardId, sessionId, home });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

function visibleIds(replay) {
  return Object.keys(replay.tree.floors).sort();
}

// --- 场景 A：快照边界后 undo_rollback ---------------------------------------
await withStore(1, async ({ store, cardId, sessionId }) => {
  const f1 = await store.appendFloor(cardId, sessionId, { role: "user", content: "一楼" });
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "二楼" });
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "三楼" });

  await store.rollback(cardId, sessionId, f1.payload.floorId);
  const afterRollback = await store.replay(cardId, sessionId);

  // snapshotInterval=1 时，rollback 事件本身会立即触发快照，
  // 因此 undo 的重放起点是一个"看不见被遗忘楼层"的快照。
  await store.undoRollback(cardId, sessionId);
  const afterUndo = await store.replay(cardId, sessionId);

  const ok = visibleIds(afterUndo).length === 3;
  record(
    "A. 快照边界后 undo_rollback 应恢复全部被遗忘楼层",
    ok,
    `rollback 后可见=${visibleIds(afterRollback).length}（期望 1）；undo 后可见=${visibleIds(afterUndo).length}（期望 3）` +
      `；ids=[${visibleIds(afterUndo).join(", ")}]`
  );
});

// --- 场景 B：连续两次 rollback 后的 undo -------------------------------------
await withStore(1000, async ({ store, cardId, sessionId }) => {
  const ids = [];
  for (let i = 1; i <= 5; i++) {
    const ev = await store.appendFloor(cardId, sessionId, { role: "assistant", content: `第${i}楼` });
    ids.push(ev.payload.floorId);
  }

  await store.rollback(cardId, sessionId, ids[2]); // 遗忘 4、5 楼
  await store.rollback(cardId, sessionId, ids[1]); // 遗忘 3 楼（恢复点应指向 3 楼）

  await store.undoRollback(cardId, sessionId);
  const afterUndo = await store.replay(cardId, sessionId);
  const visible = visibleIds(afterUndo);

  const ok = visible.length === 3;
  record(
    "B. 连续两次 rollback 后 undo 只应恢复最近一次被遗忘的楼层",
    ok,
    `undo 后可见=${visible.length}（期望 3 = 1、2、3 楼）；ids=[${visible.join(", ")}]` +
      `（4、5 楼应保持物理遗忘）`
  );
});

// --- 场景 C：基线对照，无快照介入 --------------------------------------------
await withStore(1000, async ({ store, cardId, sessionId }) => {
  const f1 = await store.appendFloor(cardId, sessionId, { role: "user", content: "一楼" });
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "二楼" });
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "三楼" });

  await store.rollback(cardId, sessionId, f1.payload.floorId);
  await store.undoRollback(cardId, sessionId);
  const afterUndo = await store.replay(cardId, sessionId);

  record(
    "C. 基线（无快照）undo_rollback 应恢复被遗忘楼层",
    visibleIds(afterUndo).length === 3,
    `undo 后可见=${visibleIds(afterUndo).length}（期望 3）`
  );
});

// --- 场景 D：恢复点失效语义 ---------------------------------------------------
await withStore(1000, async ({ store, cardId, sessionId }) => {
  const f1 = await store.appendFloor(cardId, sessionId, { role: "user", content: "一楼" });
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "二楼" });
  await store.rollback(cardId, sessionId, f1.payload.floorId);
  await store.undoRollback(cardId, sessionId);

  let secondUndoThrew = false;
  try {
    await store.undoRollback(cardId, sessionId);
  } catch {
    secondUndoThrew = true;
  }

  record(
    "D. undo 之后恢复点应失效，二次 undo 必须失败",
    secondUndoThrew,
    secondUndoThrew ? "二次 undo 正确抛出" : "二次 undo 未抛错（恢复点未失效）"
  );
});

// --- 场景 E：新生成使恢复点失效（设计案第 28 项） -----------------------------
await withStore(1000, async ({ store, cardId, sessionId }) => {
  const f1 = await store.appendFloor(cardId, sessionId, { role: "user", content: "一楼" });
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "二楼" });
  await store.rollback(cardId, sessionId, f1.payload.floorId);
  await store.appendFloor(cardId, sessionId, { role: "assistant", content: "新生成" });

  let threw = false;
  try {
    await store.undoRollback(cardId, sessionId);
  } catch {
    threw = true;
  }

  record(
    "E. 回退后新生成应使恢复点失效",
    threw,
    threw ? "新生成后 undo 正确拒绝" : "新生成后 undo 仍成功（恢复点未失效）"
  );
});

const failed = results.filter((r) => !r.pass);
console.log("");
console.log(`探针结果：${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exitCode = 1;
}
