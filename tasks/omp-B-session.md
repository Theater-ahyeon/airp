# 任务书 B · AIRP 阶段 2「生成生命周期：Run 状态机 / 取消 / 断线 reattach / kill -9 恢复」

你是一名资深 Node/TypeScript 工程师。本任务是 AIRP 阶段 2 的核心：**后端拥有生成生命周期**——Run 状态持久化，SSE 仅为视图，断线/刷新后可 reattach 恢复进行中的输出。这是**真实交付**，所有韧性断言必须有自动化测试证据。

## 一、先读这些文件（权威输入）

1. `总设计案.md` —— 重点：**核心循环**（后端拥有生成生命周期）、Core Spine 第 2 条、管家一致性协议。
2. `项目实现步骤蓝图.md` —— 重点：**阶段 2** 第 2、3 条任务与退出条件（kill -9 恢复测试、reattach 恢复测试）。
3. `NEXT.md` —— 当前进度。
4. `src/runtime/contracts.ts` —— **架构层冻结契约**。`RunRecord`、`RunStatus`、`StartRunInput`、`RunEventSink`、`RunManagerFacade`、`ModelStreamPort`、`ModelStreamChunk`、`RuntimeEventDraft` 全部按此使用。
5. `src/runtime/card-store.ts`、`src/runtime/event-log.ts`、`src/runtime/paths.ts` —— **已完成的上游存储地基（同事交付，已被验收）**。你只能调用它们导出的能力，**禁止修改**。
6. `src/core/adapters/mock-model.ts` —— 假模型适配器，用它包装出 `ModelStreamPort`。
7. `docs/runtime/阶段2-存储地基.md` —— 上游存储层的实现说明与契约缺口记录，**必须先读**，尤其「契约缺口」一节。

## 二、你的文件边界（只准动这些）

允许创建/修改：

- `src/runtime/session/run-manager.ts`
- `src/runtime/session/run-store.ts`
- `src/runtime/session/mock-port.ts`
- `src/runtime/session/index.ts`
- `tests/runtime/session/*.test.ts`
- `tests/runtime/fixtures/*.mjs`（跨进程强杀用的子进程 fixture，允许 .mjs 或 .ts 由 vitest 直接 spawn node 执行）
- `docs/runtime/阶段2-生成生命周期.md`

**严禁修改**：`package.json`、`tsconfig.json`、`vitest.config.ts`、`src/runtime/contracts.ts`、`src/core/**`、`tests/core/**`、`scripts/**`、`src/runtime/store` 相关上游文件、`src/runtime/server/**`、`src/runtime/credentials/**`、三个根文档（`总设计案.md`/`项目实现步骤蓝图.md`/`NEXT.md`）。

**禁止新增依赖**。**禁止 git 操作**。

## 三、必须实现的语义

### 1. Run 状态机（`run-manager.ts`）

```
queued ──start──> running ──┬──> completed
                            ├──> cancelled
                            └──> failed
进程崩溃时遗留的 queued/running ──recoverOnBoot──> interrupted
```

- 终态（`completed` / `cancelled` / `failed` / `interrupted`）不可再迁移；对终态 Run 调 `cancelRun` 返回 `false`。
- 每次状态迁移都必须**先落盘事件、再改内存**（write-ahead），保证崩溃后事件日志是权威。
- `RunRecord.prompt` 必须持久化（reattach 与调试需要）。

### 2. Run 元数据持久化（`run-store.ts`）

- 路径：`<AIRP_HOME>/cards/<cardId>/sessions/<sessionId>/runs/<runId>.json`（布局常量见契约 `SESSION_LAYOUT.runs`）。
- 原子写（临时文件 + `rename`）；`RunRecord` 全字段可 JSON 化。
- 提供 `save(record)`、`load(runId)`、`list(cardId, sessionId)`、`listAllCardRuns(cardId)`（`recoverOnBoot` 需要跨会话扫描）。

### 3. 增量落盘节流（关键性能约束）

- 模型流每产生一个 `text_delta` 就写一条 `run_delta` 事件会爆掉事件日志，**禁止逐字符/逐 delta 落盘**。
- 节流策略：**150ms 或累计 4KB 文本，先到先触发**；`run_completed` / `run_cancelled` / `run_failed` 之前必须 **flush** 未落盘的尾部文本，保证重放能得到完整输出。
- 落盘通过 `cardStore.appendEvent(cardId, sessionId, draft)` 写 `run_delta` 事件，`payload.text` 只含**自上次 delta 事件以来的新增文本**。
- 内存中同时维护 `RunRecord.text` 的累积值，用于 `getRun` 快速返回。

### 4. 取消语义

- `startRun` 内部创建 `AbortController`，把 `abortSignal` 传入 `ModelStreamPort.stream()`。
- `cancelRun(runId)`：对进行中的 Run 调 `controller.abort()`，等待流结束，写 `run_cancelled` 事件（`payload.reason` 记录来源），`RunRecord.text` 保留**取消前已生成的部分**（不得清空）。
- 假模型适配器收到 abort 后会抛错（`Request aborted during stream`），你必须区分"因取消而抛错"（→ cancelled）与"真实异常"（→ failed）。

### 5. reattach 订阅（`subscribe`）

- `subscribe(runId, fromSeq, sink)`：
  1. 先从事件日志读取该 Run 的 `seq > fromSeq` 的已持久化事件，按序 `sink.onEvent`；
  2. 若 Run 仍在进行，把 sink 挂到实时订阅表，后续事件继续推送；
  3. 若 Run 已结束，重放完毕后调用 `sink.onEnd(record)` 并返回一个 no-op 退订函数；
  4. 返回真实退订函数，退订后不得再收到任何 `onEvent`。
- **多订阅者**：同一 Run 可有多个 sink（多个浏览器标签页 reattach），退订一个不影响其他。
- **无内存缓冲也能正确服务**：即使服务器在 Run 进行中重启（内存订阅表丢失），新连接靠 `from=0` 从事件日志重放也能拿到全部历史输出；正在进行的新增量从重启后继续追加。这是本设计的核心主张，报告里要写清。

### 6. `recoverOnBoot()`

- 扫描 `<AIRP_HOME>` 下所有卡的所有会话的 run 记录，把状态为 `queued` / `running` 的 Run 标记为 `interrupted`，写 `run_failed`（或约定事件）说明中断原因，更新 `endedAt`，返回被标记的记录数组。
- 必须幂等：连续调用两次，第二次返回空数组。

### 7. `mock-port.ts`

- 用 `src/core/adapters/mock-model.ts` 的 `MockModelAdapter` 包装出符合 `ModelStreamPort` 的实现：把 `MockStreamEvent` 映射为 `ModelStreamChunk`（`start`/`text_delta`/`done`/`error`），并把 `abortSignal` 透传。
- 支持可配置的 delta 间隔（默认 0ms，测试可设 20ms 模拟慢速流）。

## 四、工程约束

- ESM + `"module": "NodeNext"`：**所有相对 import 必须带 `.js` 后缀**。
- TypeScript strict 零错误；不用 `any` 兜底，不用 `@ts-ignore`。
- 测试用 vitest，每个测试用 `fs.mkdtemp` 建独立临时 `AIRP_HOME`。
- 注释用中文，简洁。

## 五、验收标准（缺一不可，且必须留下证据）

1. **状态机全路径**：`startRun` → `completed`；`startRun` → `cancelRun` → `cancelled`；异常端口 → `failed`；终态不可再迁移。
2. **节流有效性**：模拟 500 个 delta、间隔 5ms 的慢速流，断言落盘 `run_delta` 事件数 **≤ 50**（远小于 500），且 `replay` 出的文本与 `RunRecord.text` **完全一致**。
3. **取消保留部分输出**：生成到一半取消，`RunRecord.text` 非空且等于已落盘 delta 拼接结果。
4. **reattach 正确性**：Run 完成后 `subscribe(runId, 0, sink)` 能收到全部 `run_delta` 且 `onEnd` 被调用；`subscribe(runId, k, sink)` 只收到 `seq > k` 的事件。
5. **进行中 reattach**：慢速流进行中订阅，能收到"历史重放 + 后续实时"两段连续无缺口的事件序列（断言 seq 严格连续）。
6. **多订阅者隔离**：两个 sink 同时订阅，退订其一后，另一个仍能收到后续事件。
7. **`recoverOnBoot` 幂等**：第一次返回中断记录、第二次返回空数组；被中断 Run 的状态为 `interrupted` 且 `endedAt` 非空。
8. **跨进程强杀恢复（阶段 2 退出条件）**：spawn 一个子进程 fixture，它在真实 `AIRP_HOME` 上创建 Run 并持续写事件，父进程在若干毫秒后用 `child.kill()` **强制终止**（Windows 上等价于 TerminateProcess，即 kill -9 语义，报告里说明这一等价性）；随后新进程打开同一 `AIRP_HOME`：事件日志无半行损坏、`replay` 可完整恢复已落盘输出、`recoverOnBoot` 把该 Run 标记为 `interrupted`。
9. **无内存缓冲恢复（服务器重启等价）**：Run 进行中销毁 `RunManager` 实例（模拟进程重启，但事件日志保留），用新实例 `subscribe(runId, 0, sink)` 仍能重放全部历史输出。

命令（仓库根目录 `E:\agentcoding\airpbuild`）：

```
pnpm build            # tsc -b，必须零错误
pnpm test             # 全量测试必须全绿
pnpm check:isolation  # 必须 PASS
```

## 六、交付物

1. 上述实现文件与测试文件。
2. `docs/runtime/阶段2-生成生命周期.md`：文件清单与职责、Run 状态机图、事件落盘时序图（含节流与 flush 点）、reattach 时序说明、跨进程强杀测试方法与等价性说明、测试用例清单与结果、验收点 1-9 的逐条证据（命令 + 关键输出摘录）、契约缺口（若有）、已知限制。
3. 文档末尾「执行总结」小节追加 ≤30 行中文总结：改动文件、`pnpm build`/`pnpm test` 实际结果、遗留问题。

开始前必须先读 `docs/runtime/阶段2-存储地基.md`，按上游实际导出的 API 编码；若上游 API 与你的需要不匹配，以「不改上游文件、在报告中记录」为准则。
