# Core 核心算法四件套设计规范

**版本**：v1.0  
**适用范围**：`src/core` 领域层与 Prompt 组装管线  
**关联决策**：总设计案 v4 项 27、84；项目实现步骤蓝图 阶段 1 任务 1

---

## 概述与设计哲学

AIRP 的定位是“酒馆生态的记忆引擎”，其首要体验指标是在**万楼对话下流畅且极度节省上下文成本**。
不同于酒馆（SillyTavern）传统“贪婪拼凑、无序拼接”的模板拼接方式，AIRP 在进入模型前执行确定性的**算法四件套**：
1. **预算优先级表与截断策略**：每一类上下文要素有清晰确定的配额与淘汰阶梯；
2. **状态→Prompt 选择策略**：如何从海量结构化事实与关系中，挑选最相关的状态注入；
3. **跨 Provider Token 估算器**：离线、快速、保守高估的跨模型估算；
4. **缓存感知组装（Cache-Aware Assembly）**：稳定前缀、变化后置、哈希追踪，达成 **≥90% 提示词缓存命中率**。

---

## 第一件套：预算优先级表与截断策略

### 1. 优先级梯队（Priority Tiers）

当整个上下文窗口（Context Window）面临预算上限（`maxContextTokens`）限制时，组装块按固定优先级降序分配，并在超限时**按优先级逆序（从低到高）执行截断或剔除**：

| 优先级 (Priority) | 上下文组装块 (Block) | 稳定性 | 截断策略 |
| :--- | :--- | :--- | :--- |
| **P0 (Critical)** | 系统基座指令 (System Core Prompt) | 永固 | 严禁截断。若超限则直接报领域错误 `BudgetExceededError` |
| **P0 (Critical)** | 当前用户最新输入 (Latest User Message) | 动态 | 严禁截断。若单条超出保留预算则拒绝发送 |
| **P1 (Spine)** | 角色卡核心设定 (不可变角色人格/原则/开场规则) | 极稳 | 极低概率截断。预留固定预算（通常 ≤ 1500 tokens） |
| **P2 (Memory State)**| 当前会话活跃状态 (角色/用户状态、关键事实) | 中等 | 软上限截断（见第二件套，按相关度与时序衰减剔除） |
| **P3 (Worldbook)** | 世界书激活条目 (Lorebook / 双模检索命中文本) | 中低 | 按检索得分降序填充；超配额直接丢弃低分条目 |
| **P4 (Chat History)**| 历史楼层正文 (倒序滑动窗口，保留最近 N 楼) | 变化 | 倒序包含：从最近一楼向前回溯，装满剩余配额为止；跨越截断的较老楼层由摘要块（P2）覆盖 |
| **P5 (Ephemeral)** | 临时感知/调试标记/单次系统提示 (One-time Notes) | 偶发 | 预算不足时最先整体丢弃 |

### 2. 截断算法伪代码与保全原则
- **原子性保留**：单个楼层如果无法完整容纳，严禁“半句话截断”，必须整楼丢弃，转由前置摘要承担；
- **保留生成空间**：总预算分配必须显式预留模型的 `maxOutputTokens`（如 2048~4096 tokens），避免被上下文占满导致模型回复截断。

---

## 第二件套：状态→Prompt 选择策略

结构化状态（StateOps 累计派生的事实字典/实体属性）往往包含几十甚至上百个字段。严禁无脑全量序列化进 Prompt。

### 1. 评分与筛选函数
对候选状态条目 $e$，其综合评分 $Score(e)$ 计算公式如下：

$$Score(e) = W_{recency} \times R(e) + W_{relevance} \times M(e) + W_{pin} \times P(e)$$

- **$R(e)$（时序近度 Recency）**：
  $$R(e) = \frac{1}{1 + \ln(1 + \Delta \text{floors})}$$
  $\Delta \text{floors}$ 表示该状态最后一次被 `StateOp` 显式读取或修改距当前楼层的间隔。
- **$M(e)$（关键词与语义命中 Relevance）**：
  计算当前用户输入及最近 2 楼文本中，与该状态 Key、Alias 或 Value 的显式词频匹配与词形重合度（归一化为 $[0, 1]$）。
- **$P(e)$（置顶/卡级核心标记 Pin）**：
  若为角色卡声明的永久常驻状态（如角色核心好感度、主线目标、血量）则为 $1$，普通琐碎临时状态为 $0$。
- **默认权重**：$W_{pin} = 0.5$, $W_{relevance} = 0.3$, $W_{recency} = 0.2$。

### 2. 预算硬上限与序列化形状
- 状态块预设固定 token 预算上限（例如默认 500 tokens）；
- 按 $Score(e)$ 降序排列，依次填充；
- 序列化采用紧凑自然键值对或最小 Markdown 表格，杜绝臃肿冗余的 JSON 结构字符浪费 token。

---

## 第三件套：跨 Provider Token 估算器

在 Core 纯 TS 领域层中，不能依赖运行时的 C++ 绑定（如 `tiktoken` 原生动态库）或网络分词 API。

### 1. 字符级离线映射与启发式算法
AIRP 建立跨 Provider 的字符到 Token 估算器：

- **基础启发式比率**：
  - 纯 ASCII / 英文单词：平均 $\approx 4$ 字符 / 1 token（或 1 词 $\approx 1.3$ token）；
  - CJK（中日韩统一表意文字）：平均 $\approx 1.2$ ~ $1.5$ 字符 / 1 token（现代分词器对中文压缩率大幅提升，如 Qwen / DeepSeek / GPT-4o 约 0.6~0.8 token/字）；
  - 代码/特殊标点/空白字符：1~2 字符 / 1 token。
- **跨 Provider 规则表**：
  - `openai-completions` (GPT-4o/mini, o1) / `qwen` / `deepseek`: 中文约 $0.65$ token/字，英文 $0.25$ token/char；
  - `anthropic-messages` (Claude 3.5/3.7): 中文约 $0.75$ token/字，英文 $0.28$ token/char；
  - `generic-conservative`（未识别 Provider）：中文按 $1.0$ token/字，英文按 $0.35$ token/char（**保守高估 20%**）。

### 2. 守卫法则
所有预算截断决策**基于估算器算出的偏高安全值**进行裁剪，确保传入真实 Provider 时绝对不会出现“预估刚好未超限、真实端点却爆上下文抛 400”的灾难。

---

## 第四件套：缓存感知组装（Cache-Aware Assembly）

现代 LLM API（Anthropic Prompt Caching、OpenAI Prompt Cache、DeepSeek Context Caching、Gemini Context Caching）均依赖于**前缀完全精确匹配（Exact Prefix Match）**。
哪怕前置内容中一个标点、时间戳变动，都会导致整段缓存击穿，使推理成本飙升 5~10 倍。

### 1. 前缀切分与排列流水线

AIRP 组装块管线强制规定以下物理物理顺序：

```
[极稳区域：100% 静态]
1. Base System Prompt (系统角色基底指令)
2. Character Core Definition (角色卡设定/不可变工作副本设定)
3. Worldbook Static Anchors (常驻静态世界观条目)
   ─── (稳定断点：Anthropic Cache Breakpoint 1 / OpenAI 静态前缀) ───

[半稳区域：楼间缓变]
4. Rolling Summary (滚动长程摘要：仅在跨度更新时变动)
5. Structured State Snapshot (长周期状态事实)
   ─── (缓变断点：Anthropic Cache Breakpoint 2) ───

[动态变化区域：尾部变动]
6. Recent Chat History (最近若干楼对话，追加式递增)
7. Worldbook Dynamic Hits (随最近发言实时命中的动态条目)
8. Current Turn User Message (最新一轮输入)
```

### 2. 变化后置原则（Append-Only Tail）
- 严禁在静态前缀（第 1~3 项）中插入动态变量（如“当前对话已进行 X 楼”、“实时时间戳”等）；
- 任何会随楼层递增而改变的元数据，必须放入动态尾部或系统尾注中；
- 滚动历史记录使用不可变文本块追加，不重新格式化已有历史。

### 3. 组装哈希追踪（Assembly Hash Tracking）
- 组装器计算每一段的前缀哈希：
  $$Hash_{prefix} = \text{SHA256}(Block_1 + Block_2 + \dots + Block_k)$$
- 比较本次组装与上一轮请求的 $Hash_{prefix}$ 匹配长度；
- 配合 ModelPort 返回的 `usage.cacheRead` 真实元数据，持续在状态面板中监控统计**缓存命中率（Cache Hit Rate）**，确保达成验收指标 **$\ge 90\%$**。
