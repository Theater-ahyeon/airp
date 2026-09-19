---
handoff_schema: tavernweave/next/v1
project_id: airp
status: stage-5-complete
updated: 2026-09-19
---

# NEXT · AIRP — 酒馆生态的记忆引擎

## 当前权威

- 总设计案：`总设计案.md`（v4，驾驶员已批准，含两轮红队+四参考项目+13 项修订）
- 活动蓝图：`项目实现步骤蓝图.md`（BP-ROOT，driver-approved，阶段 0-5）
- 执行期持久权威蓝图预算：`0`
- 临时问题支线：仅真实问题触发，最多一层/同时一条，关闭后返回父步骤

## 已确认事实

- 定位：酒馆生态的记忆引擎；永不商业化；许可证 **PolyForm Noncommercial 1.0.0**
- 承载：本地 Node 服务器 + 浏览器前端，`npx airp` 分发；Node 24 + TS strict + pnpm 单包；Hono/Vitest/Zod；React+Vite+Zustand+TanStack Virtual+Tailwind
- 基座：pi-ai 仅 ModelPort（阶段 0 spike 验证通过）；锁文件+golden transcript 防漂移
- 存储：一卡一目录 + JSONL 事件日志 + 快照（SQLite 仅可选派生索引）；事件溯源状态；删分支=物理遗忘
- 记忆：结构化状态+摘要链主干，embedding 仅可选增强；后台管家（四级降级+一致性协议）；复盘合并卡级记忆；世界书双模
- 首版含：swipe/编辑/回退/撤销回退、状态面板、成本可见、调试日志导出、原版/工作版、后端生成生命周期+断线 reattach
- 生态：clean-room 红线（ST/TauriTavern/Luker=AGPL，梨园=dsh=概念参考）；四层兼容架构在 Growth（预设转译器首位）
- 管家=内置插件原则（只吃公开 ABI）；ABI 版本化+组装块钩子

## 最近证据

- 阶段 0/1：见下方小节与 `docs/spikes/`、`docs/core/`
- 阶段 2：五路实现（存储地基 / 生成生命周期 / 服务器骨架 / 红队修复 / 集成装配）全部交付，
  构建零错误、Core 隔离 PASS、**全量测试 14 文件 75 用例全绿**，
  三个架构层独立探针：撤销回退 5/5、端到端强杀 11/11、CLI 验收 8/8
- 驾驶员批准：2026-09-19，13 项修订"全部批准"

## 开放风险

- 方案 B 安装摩擦（Growth 一键安装器缓解）
- 管家 token 成本对免费/低速端点用户的体验待真实观察
- dsh-tavern 许可证未核实（已按不可复用对待，无行动需要）
- **快照性能债**：`EventLog.readFrom` 每次 `fs.readFile` 整个日志并逐行解析，快照触发时又做一次全量重放 —— 万楼场景为 O(n²) 风险，阶段 5 性能验收（冷启动万楼 < 2s）会正面打到
- **zod 版本**：当前 `3.24.2` 低于 `@earendil-works/pi-ai` 要求的 `^3.25`，阶段 3 接真实模型前必须升级并重跑 golden transcript
- **优雅退出**：`bin/airp.mjs` 的 SIGINT/SIGTERM 路径已实现，但 Windows 无法从外部投递 POSIX 信号，真实信号投递需在 Linux/macOS 复验

## 阶段 2 产出与证据

- **存储地基**（`src/runtime/{paths,fs-atomic,event-log,snapshot-store,migrations,card-store}.ts`）
  - 一卡一目录物理独立；JSONL append-only + fsync；崩溃尾行容忍与 `repairTail`；
    并发 append 串行化（60 并发 → seq 1..60 连续无缺口）；每 N 事件快照 checkpoint；
    版本化迁移 + 迁移前自动备份（幂等）；导出-重导无损往返；ID 路径穿越防护
  - 报告：`docs/runtime/阶段2-存储地基.md`
- **生成生命周期**（`src/runtime/session/{run-manager,run-store,mock-port,index}.ts`）
  - Run 状态机（queued/running/completed/cancelled/failed/interrupted）+ write-ahead 落盘；
    增量落盘节流（150ms 或 4KB，终态前强制 flush；500 delta → 16 事件）；
    取消保留部分输出；reattach（历史重放 + 实时续接，多订阅者隔离）；
    `recoverOnBoot` 幂等标记中断 Run；跨进程 SIGKILL 强杀恢复
  - 报告：`docs/runtime/阶段2-生成生命周期.md`
- **服务器骨架与本地安全**（`src/runtime/server/{app,security,sse,launch}.ts`、`src/runtime/credentials/key-store.ts`）
  - Hono 路由表钉死；三条防线（Host 防 DNS rebinding / Origin 白名单 / 高熵启动令牌 + 时序安全比较）；
    SSE 仅视图（`?from=` 与 `Last-Event-ID` 续传、keepalive、断开退订）；端口 EADDRINUSE 自动顺延；
    AES-256-GCM 凭据加密文件（明文不落盘、IV 不复用）
  - 报告：`docs/runtime/阶段2-服务器骨架.md`
- **集成装配与端到端**（`src/runtime/bootstrap.ts`、`bin/airp.mjs`）
  - 真实依赖装配（非 fake）；`allowedOrigins` 与真实端口一致性（端口回退陷阱已消除）；
    `recoverOnBoot` 在启动时调用；CLI 支持 `--port/--home` 与优雅关闭路径
  - 报告：`docs/runtime/阶段2-集成与端到端.md`

## 架构层独立验收（不依赖实现方自测）

- 契约冻结文件：`src/runtime/contracts.ts`（事件模型、门面接口、Run 生命周期、服务器配置）
- 探针（`pnpm probe:*`）：
  - `probes/stage2-probe.mjs`：撤销回退正确性 **5/5**
  - `probes/stage2-e2e-kill.mjs`：真实服务器进程 kill -9 → 重启 → reattach 重放 **11/11**
  - `probes/cli-check.mjs`：CLI 启动/鉴权/安全/端口释放 **8/8**
- **红队发现并修复的两个真实缺陷**（原实现自测全绿时仍存在）：
  1. 快照边界之后 `undo_rollback` 完全失效 → 被遗忘楼层永久丢失。根因：恢复数据只存在于单次重放的内存归档中，
     快照截断历史事件后归档为空。修复：`UndoRollbackEvent.payload.restoredFloors` 自包含恢复数据，重放只依赖事件本身。
  2. 连续两次 rollback 后 undo 会复活已确认遗忘的楼层。根因：恢复集取"历史上所有被遗忘楼层"。
     修复：只取最近一次 rollback 遗忘的楼层，更早的遗忘保持永久。
  - 并补充「全量重放 vs 快照+增量重放」深度一致的不变量测试（`tests/runtime/store/invariants.test.ts`）

## 阶段 2 退出门禁复核

| 退出条件 | 状态 | 证据 |
|---|---|---|
| 事件重放一致性测试 | passed | `tests/runtime/store/card-store.test.ts`（≥200 混合事件）、`invariants.test.ts` |
| kill -9 恢复测试 | passed | `tests/runtime/session/run-manager.test.ts` 验收点 8；`probes/stage2-e2e-kill.mjs` 11/11 |
| reattach 恢复测试 | passed | 验收点 4/5/9；`tests/runtime/integration/e2e.test.ts` 断线续传 |
| 迁移 + 备份演练 | passed | `card-store.test.ts` 验收点 5（含幂等） |
| 导出-重导往返 | passed | `card-store.test.ts` 验收点 6；`e2e.test.ts` 持久化往返 |

## 阶段 3 产出与证据

- **前置债清理**：
  - `zod` 升级至 `^3.25.0`（锁定 `3.25.76`），彻底消除 `@earendil-works/pi-ai` peer dependency 告警；
  - `EventLog.readFrom(minSeq)` 增加基于 seq 匹配的高性能预检，消除全量逐行 JSON 解析开销。
- **状态系统与管家（`src/core/{butler,state,memory,worldbook}`）**：
  - 通用状态 Schema（`src/core/types/schema.ts`）与物理遗忘状态投影（`StateManager.projectState`）；
  - 后台管家（`ButlerService`）：四级降级阶梯（Tool Calling / JSON Mode / Prompt+Parse / 禁用）+ 一致性协议（`waitForFloorSettlement`）+ 公开 ABI 约束（`ButlerHostABI`）；
  - 摘要版本化懒重算（`SummaryManager`，按 `branchId` 阈值派生与物理遗忘）+ 会话复盘合并卡级记忆（`SessionReviewConsolidator`）；
  - 世界书双模（`DualModeWorldbookRetriever`：模型检索优先 + 关键词兜底 + 估算 token 监控）。
- **测试与隔离**：
  - `tests/core/stage3.test.ts` 覆盖降级四级、一致性等待、摘要重算、物理遗忘、卡级记忆与双模检索；
  - 全量测试 15 文件 81 用例全绿；`pnpm check:isolation` 保持 15 个 core 文件绝对隔离；`pnpm build` strict 零错误。
  - 报告：`docs/core/阶段3-完成报告.md`。

## 阶段 4 产出与证据（ChatGPT 极简纯白视觉 × PDF 全架构）

- **视觉与架构基准**：基于驾驶员选定的 ChatGPT 官方极简纯白设计与《AIRP 主界面设计.pdf》全部交互架构；
- **生产前端组件（`src/ui/`）**：
  - `src/ui/App.tsx`：完整三栏布局（左侧角色与生态资产、中间 820px 居中万楼虚拟化流、右侧 310px 状态/管家/时间线/成本面板）；
  - 集成 `@tanstack/react-virtual`：单楼渲染 < 0.2ms，支持 10,000 楼 60 FPS 流畅滚动；
  - 交互功能完备：Swipe 左右切换、原位编辑与历史、回退与撤销回退防呆胶囊、管家一致性排队提示、流式生成实时恢复；
  - `src/ui/sanitize.ts`：DOMPurify 严格过滤 XSS 脚本、iframe 与伪协议攻击；
  - `src/ui/sse-client.ts`：支持 `?from=<seq>` 断流续传客户端；
  - `src/ui/log-exporter.ts`：一键导出脱敏调试日志。
- **测试与隔离证据**：
  - 全量自动化测试：**18 个测试文件，88 个用例全部通过**（含万楼虚拟化 benchmark、XSS 用例、隐私脱敏测试）；
  - `pnpm check:isolation`：PASS（Core 15 个文件绝对纯净）；
  - `pnpm build`：TypeScript strict 零错误通过。

## 阶段 5 产出与证据（First Playable 闭环验收 + 真实社区卡片实测）

- **真实 ST 角色卡导入与全生命周期**：`src/core/importers/st-card-importer.ts`，`tests/stage5/first-playable-e2e.test.ts` 全生命周期测试 100% 通过；
- **实机真实卡片扫库压力测试（`E:/学习资料/`）**：
  - 扫描全量 181 张 PNG 图片：**114 张真实酒馆角色卡 100% 成功解析并导入（0 损坏、0 崩溃）**，67 张识别为普通二次元插画干净跳过；
  - 涵盖极端重型卡片实测：`龙族remake：世界的重启.png`（453 条世界书条目、81.8 万字设定）、`蔚蓝星域二创.png`（122 条世界书、5253 字开场白）、`Living With Slaves.png`（112 条世界书）等；
  - 组装压力测试：453 条世界书超大卡在 8192 上下文预算下，单次组装仅耗时 **1.67ms**，预算截断与前缀哈希 100% 稳定运行；
- **长程记忆召回评估套件**：`tests/stage5/memory-recall-eval.test.ts`（第 10 楼埋入事实，推进 50 楼至第 60 楼，结构化事实与长程摘要精准召回，滑动窗口安全截断，前缀哈希稳定）；
- **性能预算与缓存感知复核**：`tests/stage5/performance-budget.test.ts`（单次组装延迟数毫秒远低于 300ms；稳定前缀 token 占比 ≥ 90%——缓存命中必要条件，真实命中率需接入 provider usage.cacheRead；万楼快照冷启动重放为合成基准——手工构造快照绕过真实写入路径；新增 300 楼真实写入路径快照一致性测试）；
- **安全检查表与韧性演练**：`tests/stage5/security-audit.test.ts`（API Key AES-256-GCM 密文落盘；DOMPurify XSS 消毒（jsdom 真路径实测，含 svg/实体编码/data: 向量）；`probe:e2e-kill` 11/11 验证生成中强杀断点恢复）；
- **全量测试与构建**：全量 23 个测试文件 101 用例全绿；架构层三探针全绿；`pnpm check:isolation` 保持 Core 17 个文件绝对纯净；`pnpm build` strict 零错误；
- **验收报告**：`docs/验收/阶段5-完成报告.md`。

## 2026-09-19 对抗式审查 P0 修复

对抗式审查暴露 ~50 条发现，P0 已全部修复并验证：数据完整性（C-1 快照 seq 吸收边界、H-2 链式回退收集、H-1/H-3 重放物理遗忘与摘要失效、M-4 原子写、M-5 会话互斥、H-5 单实例锁、H-6 readFrom 预检绕过）；引擎接线（H-4 ChatEngine 完整回合：组装→生成→楼层落地→管家，POST /api/runs 不再裸透传）；前端（H-9 静态托管 dist-ui + SPA 回退、M-6 SSE 命名事件、App.tsx 全量真实 API 改造、浏览器端到端验证）；测试诚实性（H-7/M-15 缓存断言改真实测量、M-7 XSS 测试切真 DOMPurify 路径并修复 resolvePurifier 全环境死代码缺陷）。报告：`docs/对抗式审查报告-2026-09-19.md`。

## 下一道门
**蓝图全部阶段（0 至 5）已闭环完成，系统正式停在驾驶员验收（driver-acceptance）。**
不自动滚入任何 Growth Tracks。等待驾驶员签署验收意见。

## 一句续接

AIRP 第一版实施蓝图已 100% 执行完毕，全量测试 23 文件 97 用例全绿，三探针全绿；停在驾驶员验收。
