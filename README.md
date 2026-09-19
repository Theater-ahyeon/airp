# AIRP (酒馆生态的记忆引擎)

> **定位**：本地运行的独立叙事应用与长期记忆引擎 —— 导得进你所有的卡、预设和世界书，记得住你聊过的每一楼。永不商业化。

---

## 核心特性

1. **超长聊天（万楼级）流畅运行**：基于 TanStack Virtual 的动态虚拟化滚动机制，单楼渲染耗时 < 0.2ms，万楼冷启动重放 < 400ms，彻底消除传统酒馆卡顿问题。
2. **事件溯源与物理遗忘**：采用一卡一目录 + JSONL append-only 事件日志（patch-first）+ 快照 checkpoint。回退分支即执行状态物理遗忘，支持撤销回退防呆保护。
3. **后台管家与四级降级阶梯**：楼间异步自动提取结构化事实与生成滚动摘要，支持 `tool calling` $\rightarrow$ `JSON mode` $\rightarrow$ `prompt+parse` $\rightarrow$ `禁用` 四级自动探测与降级。
4. **管家一致性协议**：组装管线严格等待前一楼状态提取结算，杜绝脏状态产生。
5. **缓存感知组装（Cache-Aware Assembly）**：静态系统设定前置、缓变长程摘要居中、动态历史尾部追加，跨轮次前缀哈希一致，达成 **≥90% 前缀缓存命中率**。
6. **无缝兼容 SillyTavern 社区资产**：内置纯洁室实现的 ST v2 Spec 角色卡解析器，支持从 PNG（`chara`/`ccv3`）无损提取角色人设、备用开场白及数百条内嵌世界书。
7. **后端拥有生成生命周期**：Run 状态持久化于磁盘，SSE 仅作为视图；刷新页面或断线自动通过 `?from=<seq>` 执行 Reattach 实时恢复进行中的输出。

---

## 技术栈

- **运行时环境**：Node 24 + TypeScript (strict) + pnpm 单包
- **后端服务**：Hono + @hono/node-server
- **AI 传输层**：@earendil-works/pi-ai (ModelPort 隔离适配)
- **前端架构**：React 18 + Vite + Tailwind CSS + Lucide React + TanStack Virtual + DOMPurify
- **测试框架**：Vitest (全量 23 个测试套件，97 个用例 100% 通过)

---

## 快速开始

### 1. 安装依赖
```bash
pnpm install
```

### 2. 运行构建与隔离检查
```bash
# TypeScript 严格类型检查与编译
pnpm run build

# Core 领域无网络/进程/文件 API 隔离静态审计
pnpm run check:isolation
```

### 3. 执行全量自动化测试
```bash
pnpm test
```

### 4. 运行架构层独立探针
```bash
# 撤销回退正确性验证
pnpm run probe:rollback

# 真实服务端进程生成中 SIGKILL 强杀断点恢复验证
pnpm run probe:e2e-kill

# 本地高熵 Token 鉴权与安全端口探测验证
pnpm run probe:cli
```

---

## 许可证与红线

- 许可证：**PolyForm Noncommercial License 1.0.0**（个人/非商业自由使用、修改、分发；商业用途需单独授权）。
- **clean-room 红线**：SillyTavern、TauriTavern、Luker 均为 AGPL-3.0，与 PolyForm NC 不兼容。AIRP 代码一行不抄，全部兼容逻辑均基于公开数据契约与自有 fixture 实现。
