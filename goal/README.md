# os-stronger goal — 长程目标编排

> 给 OpenSpec 加一层「目标 → 多 change → 逐个完成」的编排能力。
> 主 agent 调度（薄上下文）+ 子 agent 执行（fresh context）+ CLI 状态中心。

## 这是什么

一个大目标（goal）往往需要多个 OpenSpec change 才能完成。goal 增强把这些 change 编排起来：

```
explore（人机对齐目标）
→ propose change 1 → apply change 1
→ propose change 2 → apply change 2
→ ...
→ propose testchange_1 → apply testchange_1
  ├── Task 1: 独立语义评估（读 goal.md + 产物，判断验收标准是否满足）
  │   ├── 不通过 → 报告失败 → fix change(s) → testchange_2
  │   └── 通过 → 继续 Task 2~N 写测试 + 跑测试
  ├── 测试失败 → fix change(s) → testchange_2
  └── 全部通过 → done 🎉
```

**核心特点：**

- **人机边界清晰**：只有 explore 阶段需要人参与，确定 goal 后全自动
- **交替式流程**：propose → apply → propose → apply，不是先全 propose 再逐个 apply
- **子 agent fresh context**：每个 propose/apply 都是全新上下文的子 agent，主 agent 只做调度
- **OpenSpec skill 联动**：子 agent 遵循 openspec-propose / openspec-apply-change / openspec-archive skill 的工作流
- **自主 archive**：goal 模式下 agent 必须自主归档，不等用户确认——用户只在熔断或完成时回来
- **CLI 是大脑**：`os-stronger goal instructions --json` 返回下一步该做什么 + 子 agent 提示词 + skill 引用
- **状态在磁盘**：会话断了？重新跑 `instructions` 就能接上
- **Test → Fix 循环**：最后一个 change 是 test change，失败后自动进入 fix 流程，有熔断兜底。test change 内部先做语义评估（独立判断验收标准是否满足），再做测试验证
- **独立不侵入**：不 patch 任何 OpenSpec 文件，不启用时零影响

## 快速开始

### 1. 安装

```bash
npm install -g GGGuYu/os-stronger
```

### 2. 在已跑过 `openspec init` 的项目里启用 goal

```bash
os-stronger init --enhancements goal
# 或和其他增强一起：
os-stronger init --enhancements review,skill-align,goal
```

### 3. 告诉你的 AI

> 我想做一个 goal：构建一个 Todo 应用，包含后端 API 和前端页面

AI 会：
1. 跟随 `openspec-explore` skill 和你对齐目标
2. 创建 goal，写 goal.md（含验收标准）
3. 拆分成多个 change（最后一个自动是 test change）
4. 逐个 propose（遵循 `openspec-propose` skill）→ apply（遵循 `openspec-apply-change` skill），交替进行
5. 每个 change 完成后自主 archive，不等用户确认
6. 最后跑 test change 验证，失败则 fix，通过则完成

## 目录结构

启用后项目里会多出：

```
项目根/
├── openspec-goals/                        ← goal 增强创建（显式目录）
│   └── goal_<name>/                       ← 一个 goal 一个文件夹
│       ├── state.json                     ← 状态机（CLI 读写）
│       └── goal.md                        ← 目标描述 + 验收标准
│
├── .claude/skills/                        ← （或其他工具的 skills 目录）
│   └── os-stronger-goal/
│       └── SKILL.md                       ← goal 工作流（agent 读）
│
└── openspec/changes/                      ← OpenSpec 原有
    ├── <goal-name>-backend/               ← goal 拆出的 change
    ├── <goal-name>-frontend/
    └── <goal-name>-testchange_1/          ← test change
```

## CLI 命令

### 生命周期

```bash
# 创建 goal
os-stronger goal create --name <name> --description "..." [--max-fix-cycles 3]

# 注册 change 骨架
os-stronger goal change add --goal <name> --id <id> --title "..." [--type normal|test|fix]

# 标记 change 进入 proposed（propose 子 agent 返回后调用）
os-stronger goal change propose --goal <name> --id <id>

# 标记 change 进入 archived（apply 子 agent 最后一个 task 调用，自主归档）
os-stronger goal change archive --goal <name> --id <id>

# test change 失败时调用
os-stronger goal test-failed --goal <name> --test-change <id> --summary "失败摘要"

# 熔断后恢复（重置 fix 循环，插入新 testchange）
os-stronger goal resume --goal <name>
```

### 查询

```bash
# 获取当前进度 + 下一步指令 + 子 agent 提示词（核心重注入点）
os-stronger goal instructions --goal <name> --json

# 查看整体状态
os-stronger goal status --goal <name>

# 列出所有 goal
os-stronger goal list
```

## 工作流详解

### Phase 0：创建 & 拆解（人参与）

1. AI 跟随 `openspec-explore` skill 和你对齐目标
2. 创建 goal：`os-stronger goal create --name <name> --description "..."`
3. 写 goal.md（目标 + 验收标准）
4. 拆分成多个 change，最后一个必须是 test change
5. 逐个注册：`os-stronger goal change add ...`
6. 确认后进入 loop——此后全自动

### Loop：交替 propose → apply（全自动）

```
instructions → propose_next → 起子 agent（按 openspec-propose skill）→ change propose → instructions
            → apply_next   → 起子 agent（按 openspec-apply-change skill）→ change archive  → instructions
            → 重复...
```

CLI 的 `instructions --json` 返回的 `nextAction.instruction` 会明确告诉主 agent：
- 子 agent 会按哪个 OpenSpec skill 工作
- 子 agent 返回后该运行什么 CLI 命令
- archive 是自主的、强制的

每个子 agent 拿到的 `subagentPrompt` 会明确指导：
- 要读哪个 OpenSpec skill 文件（如 `.claude/skills/openspec-propose/SKILL.md`）
- 按 skill 工作流做什么
- 已完成 change 的 artifact 路径（按需读取，不假设 API）
- archive 是强制的，不等用户确认

### Test → Fix 循环

最后一个 change 是 test change，验证整个 goal 是否达标。test change 的 apply 子 agent 执行两类任务：

**Task 1: 独立语义评估** — 在写任何测试代码之前，子 agent 以 fresh context 的独立视角，读 goal.md 验收标准 + 所有已完成 change 的产物，逐条判断是否满足。不满足直接返回失败，不写测试。

**Task 2~N: 测试用例** — 语义评估通过后，写测试、跑测试。

```
testchange_1 apply
  → Task 1: 语义评估
    ├── 不通过 → 报告失败（哪条未满足 + 原因 + 建议）
    └── 通过 → Task 2~N: 写测试 + 跑测试
      ├── 测试失败 → 报告失败（测试名 + 错误 + 模块）
      └── 测试通过 → archive → done 🎉

→ test-failed CLI 命令（cycle +1）
→ 分析子 agent 确定要修什么
→ 注册 fix change(s)（必须 --type fix）
→ propose → apply fix change(s)
→ 自动插入 testchange_2
  → 如果通过 → done 🎉
  → 如果失败 → 继续 fix → testchange_3
  → 超过 maxFixCycles → 熔断，通知用户（人回来）
→ 用户修复后 → resume → 新 testchange → 通过 → done 🎉
```

语义评估和测试失败走同一个 fix → test → 熔断流程，不区分处理。

熔断上限默认 3 轮，创建 goal 时可配置：

```bash
os-stronger goal create --name <name> --description "..." --max-fix-cycles 3
```

## 和其他增强的关系

goal 是**独立 skill**，不 patch 任何 OpenSpec 文件。它和 review、skill-align 透明共存：

```
os-stronger init --enhancements review,skill-align,goal

结果：
  .claude/skills/
  ├── openspec-apply-change/     ← 被 review + skill-align patch
  ├── openspec-propose/          ← 被 skill-align patch
  └── os-stronger-goal/          ← 独立 skill，不 patch 任何文件
```

- goal 的子 agent 执行 `openspec-propose` 时会自动触发 skill-align
- goal 的子 agent 执行 `openspec-apply-change` 时会自动触发 review
- goal 本身不需要知道它们的存在

**重要：archive 行为覆盖** — review 增强通常在 review 通过后问用户"是否 archive"。在 goal 模式下，这个行为被覆盖：agent 必须自主 archive，不等用户确认。用户只在熔断或 goal 完成时回来。

**⚠️ 嵌套子 agent 注意** — goal 的 apply 子 agent 遵循 `openspec-apply-change` skill，而 review 增强已 patch 这个 skill，注入了"起 review 子 agent"的指令。这意味着 apply 子 agent 需要启动自己的子 agent（嵌套）。部分平台不支持嵌套子 agent（如 `max_depth=1` 限制）。如果你的目标平台不支持嵌套子 agent，建议不要同时启用 `goal` 和 `review`，或者接受 review 步骤可能被跳过。

## 设计原则

- **对 agent 无依赖**：skill 是纯文本指令，CLI 是纯 Node.js，任何支持 subagent + slash command 的 agent 都能用
- **零依赖**：纯 Node.js 内置模块
- **非侵入**：不 patch 任何文件，不启用时零影响
- **幂等**：重复操作不会出错
- **可恢复**：状态全在磁盘，断了重跑 `instructions` 即可接上

## 限制

- **纯提示词约束**：没有 hook，agent 可能跳过步骤。和 OpenSpec 自身用同样的机制
- **串行执行**：不支持并行 change（第一版设计决策，后续可扩展）
- **无 change 间依赖编排**：第一版只做线性顺序，DAG 后续加

## 更多信息

- `AGENTS.md` — 给维护者的设计文档（动机、架构、决策、规范）
- 项目的 `README.md` — os-stronger 整体说明
