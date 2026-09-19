# 任务书 A · AIRP 阶段 2「Runtime 持久化地基」

你是一名资深 Node/TypeScript 工程师，负责实现 AIRP 项目的 Runtime 存储地基。这是一次**真实交付**，不是演示代码：所有验收点必须用可复现的自动化测试证明。

## 一、先读这些文件（权威输入）

1. `总设计案.md` —— 重点：Core Spine 第 2 条（Runtime 存储形态）、安全红线。
2. `项目实现步骤蓝图.md` —— 重点：**阶段 2** 的任务清单与退出条件。
3. `NEXT.md` —— 当前进度与阶段 1 产出。
4. `src/runtime/contracts.ts` —— **架构层冻结契约**。你必须实现其中 `CardStoreFacade` 的全部能力，事件类型、常量、`SerializedFloorTree`、`SessionCheckpoint`、`ExportBundle` 全部按此文件使用。
5. `src/core/types/*.ts`、`src/core/pipeline/*.ts` —— 阶段 1 的纯领域层，可以 import，**禁止修改**。

## 二、你的文件边界（只准动这些）

允许创建/修改：

- `src/runtime/paths.ts`
- `src/runtime/fs-atomic.ts`（可选，原子写与目录工具）
- `src/runtime/event-log.ts`
- `src/runtime/snapshot-store.ts`
- `src/runtime/migrations.ts`
- `src/runtime/card-store.ts`
- `tests/runtime/store/*.test.ts`
- `docs/runtime/阶段2-存储地基.md`

**严禁修改**：`package.json`、`tsconfig.json`、`vitest.config.ts`、`src/runtime/contracts.ts`、`src/core/**`、`tests/core/**`、`scripts/**`、`总设计案.md`、`项目实现步骤蓝图.md`、`NEXT.md`，以及 `src/runtime/server/**`、`src/runtime/session/**`、`src/runtime/credentials/**`（这些是并行同事的地盘）。

**禁止新增依赖**（可用 `node:fs/promises`、`node:path`、`node:os`、`node:crypto`、`zod`，zod 已在 devDependencies 中）。若确实需要新依赖，写进报告，不要自己装。

**禁止 git 操作**（本项目当前不是 git 仓库，也不要初始化）。

## 三、必须实现的语义（逐条落实）

### 1. AIRP_HOME 解析（`paths.ts`）

- 优先 `process.env.AIRP_HOME`（相对路径要 `path.resolve` 成绝对路径）。
- 未设置时回退 `path.join(os.homedir(), ".airp")`。
- 导出：`resolveAirpHome(env?)`、`cardDir(home, cardId)`、`sessionDir(home, cardId, sessionId)`、`runsDir(...)`、`snapshotsDir(...)`、`backupsDir(...)`。
- **ID 安全校验**：`cardId` / `sessionId` 只允许 `[A-Za-z0-9_-]{1,64}`，否则抛错。这是路径穿越防线，必须有测试。

### 2. 一卡一目录（物理独立）

```
<AIRP_HOME>/cards/<cardId>/
  meta.json                 # CardMeta（schemaVersion / cardId / name / createdAt / updatedAt）
  card.json                 # { original, workingCopy }
  sessions/<sessionId>/events.jsonl
  sessions/<sessionId>/snapshots/<seq>.json
  sessions/<sessionId>/runs/<runId>.json   # 由 session 层写，你只保证目录可建
  backups/<timestamp>/      # 迁移前备份
```

拷贝一个卡目录到新 `cardId` 目录即等价于迁移，`listCards()` 必须能发现它（有测试）。

### 3. JSONL append-only 事件日志（`event-log.ts`）

- 每行一个 `RuntimeEvent` JSON 对象，UTF-8，`\n` 结尾。
- `append(draft)`：分配 `seq`（会话内从 1 单调递增，绝不重复）、生成 `id`（`crypto.randomUUID()`）、写 `ts`，追加一行并 `fsync` 后才返回。
- **追加必须原子**：使用 `fs.open(path, "a")` + `write` + `fsync` + `close`，或用 `FileHandle` 复用；并发 append 必须串行化（内部队列或互斥），保证 seq 严格递增且不丢行。
- `readAll()` / `readFrom(seq)`：逐行解析，**容忍崩溃尾行**——最后一行若不是合法 JSON（进程被 kill -9 时写入一半），必须丢弃该行且不影响前面所有事件；同时提供 `repairTail()` 把文件截断到最后一条完整行，返回被截断的字节数。
- `lastSeq()`：返回文件中最大合法 `seq`（不用全量反序列化也可，但要正确）。
- 每累计 `snapshotEveryNEvents`（默认 `DEFAULT_SNAPSHOT_INTERVAL = 50`）条事件后触发一次快照写入（快照内容由 `card-store` 提供，或用回调注入，避免循环依赖）。

### 4. 快照 checkpoint（`snapshot-store.ts`）

- `save(checkpoint: SessionCheckpoint)`：写 `snapshots/<seq>.json`，原子写（临时文件 + `rename`）。
- `latest()`：返回 `seq` 最大的快照；无快照返回 `null`。
- `list()`：返回已存在的快照 seq 数组（升序）。
- 快照文件损坏时不得让整个会话不可读：跳过损坏快照，回退到更早的快照或全量重放。

### 5. 重放（`card-store.ts` 的 `replay`）

- 取 `latest()` 快照作为起点，读取 `seq > checkpoint.seq` 的事件顺序 apply。
- apply 规则（与 `src/core/types/floor-tree.ts`、`src/core/types/state.ts` 语义一致）：
  - `session_created`：初始化空树。
  - `floor_appended`：插入楼层（`swipes = [content]`，`currentSwipeIndex = 0`，`editHistory = []`）。
  - `floor_swiped`：追加 swipe 并把 `currentSwipeIndex` 指向新内容，`content` 同步更新。
  - `floor_edited`：把旧内容压入 `editHistory`，更新 `content` 与 `swipes[currentSwipeIndex]`。
  - `rollback`：物理遗忘 `forgottenFloorIds` 对应楼层，并记录撤销检查点。
  - `undo_rollback`：恢复 `restoredFloorIds`（楼层内容需能从事件重放得到，因此 `rollback` 事件必须把被遗忘楼层的完整数据编码进 payload 才能支持撤销——**这是契约缺口**：如果 `contracts.ts` 的 `RollbackEvent.payload` 不足以恢复，请在报告「契约缺口」一节明确写出你采用的编码方式，例如在 `forgottenFloorIds` 之外另建同会话事件或使用 `checkpoint` 事件承载，**但不要修改 contracts.ts**）。
  - `state_op`：用 `applyStateOp` 折叠进 `StateSnapshot`。
  - `summary_updated`：更新当前 `summary`（按 `branchId`）。
  - `run_*` / `checkpoint`：不影响楼层树与状态，重放时忽略但不报错。
- 返回 `ReplayResult`：`tree`（`SerializedFloorTree`）、`state`、`summary`、`lastSeq`、`replayedEvents`、`fromCheckpointSeq`。

### 6. 版本化迁移（`migrations.ts`）

- `meta.json` 中 `schemaVersion` 与 `RUNTIME_SCHEMA_VERSION` 不一致时触发迁移。
- 迁移前**自动备份**整个卡目录到 `backups/<ISO 时间戳>/`，返回 `backupPath`。
- 版本相同时 `migrate()` 返回 `{ from, to, backupPath: null }`（幂等，不产生备份）。
- 至少提供 `0 -> 1` 的迁移路径（v0 视作"无 meta.json 或 schemaVersion 缺失"的旧目录），迁移后 `meta.json` 写入 `lastMigratedAt`。
- 迁移失败必须留下备份且不破坏原目录。

### 7. 导出 / 导入（往返必须无损）

- `exportCard(cardId)` 产出 `ExportBundle`：`meta` + `character.original/workingCopy` + 每个会话的**完整事件数组**。
- `importCard(bundle, { newCardId })` 写入新卡目录；不带 `newCardId` 时用原 id（若已存在则抛错，不要静默覆盖）。
- 往返验收：导入后的 `replay()` 结果（`tree`、`state`、`summary`、`lastSeq`）与源卡**逐字段一致**，事件类型序列一致。

### 8. 其他门面方法

`listCards`、`createCard`、`readCard`、`createSession`、`listSessions`、`appendFloor`、`swipeFloor`、`editFloor`、`rollback`、`undoRollback`、`applyStateOp`、`appendEvent`、`readEvents` —— 全部按 `CardStoreFacade` 签名实现。`appendFloor` 需要正确处理 `parentId` 为空时的"接在当前活跃分支末尾"语义与 `floorIndex` 递增。

## 四、工程约束

- ESM + `"module": "NodeNext"`：**所有相对 import 必须带 `.js` 后缀**（例如 `import { resolveAirpHome } from "./paths.js"`）。
- TypeScript strict 零错误；不要用 `any` 兜底，不要 `@ts-ignore`。
- 所有磁盘写入用原子模式（临时文件 + `rename`）或 append + `fsync`。
- 代码注释用中文，简洁，只在非显而易见处写。
- 单测用 vitest，`describe/it/expect`，每个测试用 `fs.mkdtemp` 建独立临时 `AIRP_HOME`，测试后清理。

## 五、验收标准（缺一不可，且必须留下证据）

1. **事件重放一致性**：随机生成 ≥200 条混合事件（append/swipe/edit/rollback/state_op/summary），`replay()` 结果与"从头逐条 apply 的参照实现"完全一致。
2. **快照正确性**：事件数超过快照间隔后必须产生快照；`replay()` 的 `fromCheckpointSeq` 非空且结果与无快照全量重放一致。
3. **崩溃尾行恢复**：手工把 `events.jsonl` 末尾写成半个 JSON 对象，重新打开后：`readAll()` 返回全部完整事件、`lastSeq()` 正确、`repairTail()` 报告被截断字节数 > 0，修复后文件可继续 append。
4. **并发 append 安全**：并发发起 ≥50 次 append，最终 `seq` 为 1..N 连续无重复无缺口，行数 == N。
5. **迁移 + 备份演练**：把 `meta.json` 的 `schemaVersion` 改成 0 → `migrate()` 返回 `backupPath` 且备份目录内含迁移前原件；再调一次 `migrate()` 返回 `backupPath: null`。
6. **导出-重导往返**：往返后 `replay()` 全字段一致。
7. **ID 路径穿越防护**：`cardId = "../evil"` 必须抛错。
8. **一卡一目录物理独立**：卡 A 与卡 B 事件互不可见；复制目录后 `listCards()` 能列出新卡。
9. **物理遗忘**：`rollback` 后重放中该分支楼层不可见；`undoRollback` 能恢复。

命令（必须在仓库根目录 `E:\agentcoding\airpbuild` 执行）：

```
pnpm build          # tsc -b，必须零错误
pnpm test           # 全量测试必须全绿
pnpm check:isolation  # 必须 PASS（你不得让 src/core 被污染）
```

如果 `pnpm build` 因**并行同事尚未完成的文件**（`src/runtime/server/**`、`src/runtime/session/**`、`src/runtime/credentials/**`）而失败，不要修改那些文件，在报告里注明即可；你自己的文件必须零错误。

## 六、交付物

1. 上述实现文件与测试文件。
2. `docs/runtime/阶段2-存储地基.md`，包含：文件清单与职责、事件重放算法说明、存储布局图、测试用例清单与运行结果、验收点 1-9 的逐条证据（命令 + 关键输出摘录）、**契约缺口**（若有）、已知限制与后续阶段注意事项。
3. 任务结束时，把一份 ≤30 行的中文总结追加到 `docs/runtime/阶段2-存储地基.md` 末尾的「执行总结」小节，内容包含：改动文件、`pnpm build`/`pnpm test` 实际结果、遗留问题。

开始前先读契约文件，实现过程中若发现契约与需求冲突，以「不修改 contracts.ts、在报告中记录缺口」为准则。
