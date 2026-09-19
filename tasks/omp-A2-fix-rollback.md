# 任务书 A2 · AIRP 阶段 2「撤销回退正确性修复」（红队验收发现的真实缺陷）

你是资深 Node/TypeScript 工程师。架构层对已交付的 Runtime 存储地基做了**独立对抗性验收**，用探针脚本 `probes/stage2-probe.mjs` 实证出两个真实缺陷。本任务修复它们，并补齐防回归不变量测试。

## 一、先读

1. `probes/stage2-probe.mjs` —— 探针脚本。**先运行 `node probes/stage2-probe.mjs` 亲眼看到 A、B 两项失败**。
2. `src/runtime/contracts.ts` —— 架构层已修改 `UndoRollbackEvent`（新增必填 `restoredFloors: FloorMessage[]`），并写明了硬约束，**必须遵守，不得改回**。
3. `src/runtime/card-store.ts` —— 你要修的主文件。
4. `docs/runtime/阶段2-存储地基.md` —— 上一轮的交付文档与「契约缺口」说明（该缺口方案已被判定不成立，见下）。
5. `项目实现步骤蓝图.md` —— 阶段 2 退出条件。

## 二、缺陷定义（探针实证，不接受"设计如此"的辩解）

### 缺陷 A：快照边界之后 undo_rollback 完全失效（数据永久丢失）

复现：`snapshotInterval=1`，append 三楼 → rollback 到一楼 → undoRollback → 重放。
预期可见 3 楼，**实际只有 1 楼**，二、三楼永久丢失。

根因：`replay()` 中的 `floorArchive` 是**单次重放的局部内存状态**（`card-store.ts` 约 497 行起）。当最新快照是在 rollback 之后生成的，快照内的 `tree.floors` 已不含被遗忘楼层，归档随之从空开始，`undo_rollback` 到达时归档里没有任何可恢复数据。

上一轮交付文档声称"通过增量楼层归档平滑解决"——该结论不成立，因为归档不跨快照边界。

### 缺陷 B：连续两次 rollback 后 undo 会复活"已确认遗忘"的楼层

复现：append 五楼 → rollback 到三楼（遗忘 4、5 楼）→ rollback 到二楼（遗忘 3 楼）→ undoRollback。
预期可见 3 楼（1、2、3），**实际可见 5 楼**——4、5 楼被错误复活。

根因：`undoRollback()` 用"全量 `floor_appended` 集合减去当前可见集合"计算恢复集（约 421-430 行），得到的是**历史上所有被遗忘过的楼层**，而不是最近一次 rollback 遗忘的楼层。第二次 rollback 已经覆盖了恢复点，4、5 楼的遗忘必须保持永久。

## 三、修复要求

### 1. `undoRollback()`：恢复集只取最近一次 rollback，且自包含

- 从头重放事件日志（**不使用快照**）建立参照状态，记录**最后一次** `rollback` 事件遗忘的楼层完整数据（深拷贝 `FloorMessage`，含 `swipes`、`editHistory`、`currentSwipeIndex`）。
- 写入 `undo_rollback` 事件时填 `payload.restoredFloors`（必填，按 `restoredFloorIds` 同序）与 `payload.restoredFloorIds`。
- 若最后一条 `rollback` 之后已发生任何 `floor_appended` / `floor_edited` / `floor_swiped`，说明恢复点已失效——`replay()` 得到的 `undoCheckpointFloorId` 为 `null`，此时仍按现状抛错（不得放宽）。
- 若不存在任何 rollback 事件，抛错。

### 2. `replay()`：重放 `undo_rollback` 只依赖事件自身

- `case "undo_rollback"` 改为从 `ev.payload.restoredFloors` 恢复楼层（深拷贝后写入 `tree.floors`），`restoredFloorIds` 仅作校验/诊断。
- **删除** `floorArchive` 这套跨事件的内存归档机制（它是缺陷 A 的根因，且没有任何其他消费者）。`applyEventToMemory` 的签名相应简化。
- 恢复后 `tree.undoCheckpointFloorId = null`（保持现有语义）。
- 若 `restoredFloors` 与实际 `restoredFloorIds` 不一致，抛出明确错误（不要静默）。

### 3. 快照与重放的不变量

`createCheckpointInternal` 生成的快照必须满足：**「快照 + 增量重放」与「全量重放（无快照）」结果逐字段一致**（`tree`、`state`、`summary`、`lastSeq`）。这条不变量是本轮修复的核心验收项，必须写成自动化测试（见下）。

## 四、文件边界

允许修改：

- `src/runtime/card-store.ts`
- `tests/runtime/store/card-store.test.ts`（追加用例，不要删除既有用例）
- `tests/runtime/store/invariants.test.ts`（新建）
- `docs/runtime/阶段2-存储地基.md`（追加「红队验收修复记录」小节，并修正原「契约缺口」一节的错误结论）
- `probes/stage2-probe.mjs`（**只允许在修复后补充新场景**，不得修改既有 5 个场景的断言口径）

**严禁修改**：`package.json`、`tsconfig.json`、`vitest.config.ts`、`src/runtime/contracts.ts`（已由架构层改好）、`src/core/**`、`tests/core/**`、`scripts/**`、`src/runtime/server/**`、`src/runtime/session/**`（并行同事正在开发中，**绝对不要碰**）、`src/runtime/event-log.ts`、`src/runtime/snapshot-store.ts`、`src/runtime/paths.ts`、`src/runtime/fs-atomic.ts`、`src/runtime/migrations.ts`、三份根文档。

**禁止新增依赖，禁止 git 操作。**

## 五、验收标准

1. `node probes/stage2-probe.mjs` → **5/5 全 PASS**（这是硬门槛，修复前是 3/5）。
2. 新增不变量测试：随机生成 ≥150 条混合事件（含多次 rollback / undo_rollback / swipe / edit / state_op），在同一份事件日志上分别执行「全量重放」与「小间隔快照 + 增量重放」，两者 `tree` / `state` / `summary` / `lastSeq` 深度一致。
3. 新增回归测试：缺陷 A 场景（快照覆盖 rollback 事件后 undo 仍能完整恢复三楼）。
4. 新增回归测试：缺陷 B 场景（连续两次 rollback 后 undo 只恢复 3 楼，4、5 楼保持遗忘）。
5. 既有全部测试不得回归：`pnpm test` 全绿（当前基线 53 passed + 你新增的用例）。
6. `pnpm build` 零错误；`pnpm check:isolation` PASS。

注意：`src/runtime/session/**` 由并行同事开发，`pnpm build` 或 `pnpm test` 可能因其未完成文件而失败。若失败原因属于 session 层，**不要修改**，在报告中注明；你负责的文件必须零错误、你的测试必须通过（可用 `npx vitest run tests/runtime/store` 定向验证）。

## 六、交付物

1. 修复后的 `card-store.ts` 与新增/追加的测试。
2. `docs/runtime/阶段2-存储地基.md` 追加「红队验收修复记录」：缺陷 A/B 的复现步骤、根因分析、修复方案、修复后探针 5/5 证据、不变量测试说明；并**明确修正**原文「契约缺口」一节中"通过内存归档解决"的错误结论。
3. 文档末尾追加 ≤20 行中文执行总结：改动文件、探针与测试实际结果、遗留问题。

开始前先运行探针看到失败，修复后再运行看到全绿——把两次运行的原始输出都贴进文档作为证据。
