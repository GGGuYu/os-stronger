# os-stronger

> 给 OpenSpec 加增强——模块化、可插拔、零依赖。

OpenSpec 的 skill 文件都是本地明文，os-stronger 通过**原地 patch** 这些文件来注入增强能力。跑一次 `os-stronger init`，选你要的增强，agent 走 OpenSpec 流程时自动遇到增强步骤。

```
openspec-apply-change 原流程:
  做 task → 全部 [x] → 🎉 archive

加了 review 增强后:
  做 task → 全部 [x] → 🔍 起 review 子 agent → 评估 → archive（或修完再 review）

加了 skill-align 增强后:
  openspec-propose:
    对齐需求 → 扫描可用 skill → 推荐给用户 → 写入 design.md
  openspec-apply-change:
    读 design.md → 遵守 skill 约定（must-use / optional）→ 做 task
```

## 安装

```bash
npm install -g GGGuYu/os-stronger   # 从 GitHub 直接装
```

## 使用

在**已经跑过 `openspec init`** 的项目里：

```bash
os-stronger init                                    # 交互式多选增强
os-stronger init --enhancements review,skill-align,goal  # 静默指定
os-stronger init --restore                          # 撤销项目中的增强
```

跑完重启 IDE / 重载会话即可。

> **注意**：`--restore` 会删除 `.os-stronger/` 目录（含 review 时写的 `requirement-summary.md`）。如需保留，先备份再 restore。`openspec-goals/` 目录不会被自动删除（可能含 goal.md 等用户数据），需手动清理。

## 更新与卸载

```bash
os-stronger --update      # 更新全局 CLI（从 GitHub 拉最新）
os-stronger --uninstall   # 卸载全局 CLI
os-stronger --version     # 查看版本
```

> **⚠️ 卸载顺序**：请**先**在各项目目录跑 `os-stronger init --restore` 撤销增强，**再**跑 `--uninstall` 卸载 CLI。如果先卸载了 CLI，需要重新安装后跑 restore，再卸载。

> **restore 安全机制**：如果 OpenSpec 更新覆盖了 skill 文件（文件里没有 os-stronger 标记），restore 会跳过恢复并删除过期 backup，避免把新版本降级回旧版本。restore 不会自动删除 `openspec-goals/` 目录（可能含用户数据），会提示用户手动清理。

## 可用增强

### review — 全部 task 完成后起子 agent 审查（档位化）

**触发方式**：propose 时主 agent 先用 `AskUserQuestion` 问 review 档位（low/high/max，默认 low），把 `[tier=XXX]` 写进 tasks.md 末尾的 Review task。agent 走到这个 task 时触发 review 工作流（不依赖长上下文记忆）。all_done 分支作兜底（兜底无 tier 标识 → 默认 low）。**问了没明确答复（沉默/含糊/跑题）→ 立即 default low 继续，不阻塞**；工具不可用 → 直接 low。

**档位**：

| 档位 | 最大轮数 | 第 1 轮严格度 | 后续轮 |
|------|----------|---------------|--------|
| **low**（默认） | 2 | 属实**且值得修**才修 | 第 2 轮熔断，修完 archive |
| **high** | 3 | 严格：属实的尽量修（不值得也**可**不修） | 正确性为主，小问题可不修；第 3 轮熔断 |
| **max** | 3 | 严格 **+ 起两个独立 review 子 agent**（并行优先否则串行），主 agent 融合 two findings 交叉确认 | 单子 agent；第 3 轮熔断 |

tier 只写在 Review task 文字里（`- [ ] Review [tier=high]: ...`），apply 时解析，纯提示词无 CLI/state。goal 模式下 review 仍静默跳过（嵌套兜底），档位不生效。

**工作流**：

1. **STEP -1 嵌套自检**：识别自己是子 agent（goal 模式等）→ 静默跳过 review，不起子 agent
2. **STEP 0 tier 解析 + 熔断**：从 Review task 文字解析 `[tier=XXX]` → `maxCycle = low?2:3`。扫 tasks.md，`lastCompleted >= maxCycle` → 询问用户是否 archive，不启动子 agent
3. 主 agent 检查 `.os-stronger/review-guide.md` 是否存在（只看存在，不读内容）
4. 写需求总结到 `.os-stronger/requirement-summary.md`
5. 起子 agent（max 档 cycle 1 起两个），先跑 `openspec status --change <name> --json` 拿文件路径（不写死路径，兼容 workspace 模式），甩路径给子 agent（review-guide + requirement-summary + tasks.md + design.md + proposal.md + git diff HEAD）
6. 子 agent 按 CRITICAL/ISSUE/SUGGEST 分档输出 findings（max 档 cycle 1 主 agent 融合两个子 agent 的 findings，去重交叉）
7. 主 agent 独立判断每条（按 tier 严格度）：是否属实？是否值得现在立即修？
8. 属实且值得修的 → 建 `Review N Fix - <desc>` task
9. `currentCycle < maxCycle` 有 fix → 修完加 `Review [tier=...] N+1` task（同 tier 贯穿）；`currentCycle === maxCycle` 有 fix → 修完熔断，不加 N+1；无 fix → 询问用户是否 archive

findings 不强制——主 agent 有最终决定权，任何档（含 CRITICAL）均可忽略。档位只调"修的倾向"，不改成命令式。**archive 决定权在用户**，agent 只能询问不能自动做。

### skill-align — propose 时主动询问用户要用哪些 skill

**openspec-propose 侧**（所有 artifact 生成后、show status 前）：
1. 扫描项目可用 skills（`.*/skills/*/SKILL.md`）
2. 根据需求推荐相关 skill，用 AskUserQuestion 让用户多选
3. 用户选的 = must-use（agent 实现时必须读且主动用），没选的 = optional
4. 写入 `design.md` 的 `## Skill Alignment` 章节

**openspec-apply-change 侧**（读文档后）：
- 读到 `design.md` 的 Skill Alignment 章节 → must-use 的必须用，optional 的自行判断

### goal — 长程目标编排（多 change 交替 propose→apply + test→fix 循环）

**触发方式**：用户说"goal"或明确要构建一个需要多个 change 的大目标时触发。goal 是**独立 skill**，不 patch 任何 OpenSpec 文件。

**工作流**：
1. 和用户对齐目标（explore 阶段，人参与）→ 写 goal.md（含验收标准）
2. 拆分成多个 change（最后一个必须是 test change）
3. 交替式 loop：propose change 1 → apply change 1 → propose change 2 → apply change 2 → ...
4. 最后一个 test change 验证整个 goal：先做独立语义评估（fresh context 子 agent 读 goal.md + 产物判断验收标准是否满足），评估通过后再写测试跑测试
5. 语义评估或测试失败 → 进入 fix→test 循环（有熔断兜底），通过 → done 🎉

**核心特点**：主 agent 调度（薄上下文）+ 子 agent 执行（fresh context）+ CLI 状态中心做重注入。确定目标后全自动跑，agent 自主 archive，用户只在熔断或完成时回来。

**详细文档**：[goal/README.md](goal/README.md)（使用说明）| [goal/AGENTS.md](goal/AGENTS.md)（设计文档）

## os-stronger init 做了什么

1. **扫描**项目里所有 OpenSpec skill 安装（自动发现 `.claude`、`.codex`、`.cursor` 等所有 dot 目录）
2. 对选中的每个增强：
   - Patch 对应的 OpenSpec skill 文件（`openspec-apply-change` / `openspec-propose`）
   - 创建支撑文件（如 `.os-stronger/review-guide.md`）
   - 创建 skill 说明文件（`os-stronger-<增强名>/SKILL.md`）
3. Patch 前自动备份（`.os-stronger.bak`），`--restore` 一键恢复
4. 往 `.gitignore` 追加规则：`.os-stronger/`、`*.os-stronger.bak`、`openspec-goals/*/state.json`（幂等）

> **restore 安全机制**：如果 skill 文件被 OpenSpec 更新覆盖（不含 os-stronger 标记），restore 会跳过并删除过期 backup，避免降级。

## 设计原则

- **零依赖**：纯 Node.js 内置模块
- **模块化**：每个增强是 `src/enhancements/<name>/` 下的独立模块，含自己的 patch 逻辑和模板
- **非侵入**：patch 前备份，`--restore` 完全恢复原样
- **幂等**：重复跑 `init` 不会重复注入
- **自动发现**：扫描 dot 目录找 OpenSpec 安装，不维护硬编码工具列表
- **多增强共存**：多个增强可以 patch 同一文件，backup 只保留第一次的原始版本
- **分层降级**：patch 注入用 L1 精确 → L2 宽松 → L3 兜底 三级锚点，OpenSpec 改措辞/步骤标题时仍能注入

## 目录结构

```
os-stronger/
├── bin/os-stronger                    ← CLI 入口
├── src/
│   ├── init.js                        ← 主流程:多选增强 → 分发
│   ├── patcher.js                     ← 通用工具:扫描/备份/恢复
│   └── enhancements/
│       ├── review/
│       │   ├── index.js               ← review 增强 patch 逻辑
│       │   ├── review-guide.md        ← 子 agent 审查规则
│       │   └── skill.md               ← os-stronger-review skill 说明
│       └── skill-align/
│           └── index.js               ← skill-align 增强 patch 逻辑
├── goal/                              ← goal 增强（独立目录，不 patch）
│   ├── README.md                      ← 使用说明
│   ├── AGENTS.md                      ← 设计文档
│   ├── skill.md                       ← SKILL.md 模板
│   ├── scripts/                       ← CLI + 状态机 + 重注入引擎
│   └── reference/                     ← 额外提示词（如有）
└── tests/
    ├── patch.test.js                  ← patch 单元测试
    ├── integration.test.js            ← 集成测试
    └── goal.test.js                   ← goal 单元测试
```

init 后项目里会多出：

```
项目根/
├── .os-stronger/                       ← review 增强创建（restore 时删除）
│   ├── review-guide.md
│   └── requirement-summary.md
├── openspec-goals/                     ← goal 增强创建（restore 时不删除，需手动清理）
│   └── goal_<name>/
│       ├── state.json                  ← 运行时状态（已加入 .gitignore）
│       └── goal.md                     ← 人编辑的目标文档（可提交）
├── .claude/skills/
│   ├── openspec-apply-change/        ← 被 patch 了（review / skill-align）
│   ├── openspec-propose/             ← 被 patch 了（skill-align）
│   ├── os-stronger-review/           ← review skill 说明
│   └── os-stronger-goal/             ← goal skill 说明（不 patch，独立 skill）
└── ...（其他工具的 skills 目录同理）
```

## 兼容性

os-stronger 通过 patch OpenSpec 的 skill 文件 + 调用 OpenSpec 的 CLI 工作，所以对 OpenSpec 版本有依赖。我们定期在以下版本上验证，保证 patch 锚点匹配、goal 用的 CLI/JSON 字段一致。

| OpenSpec 版本 | 状态 | 验证时间 |
|---------------|------|----------|
| 1.4.1 | ✅ 已验证 | 2026-06 |
| < 1.4 | ⚠️ 未验证（workspace 模式字段 `artifactPaths.*.resolvedOutputPath` 可能缺失，goal 流程不兼容） | — |
| 其他 | ⚠️ 未验证 | — |

**验证什么**:
- `os-stronger init` 的 patch 注入能在 `openspec-apply-change`、`openspec-propose` 上命中锚点（分层降级到 L3 也算）
- `openspec status --change <name> --json` 返回的字段（`changeRoot`、`artifactPaths.*.resolvedOutputPath`）和注入文本里引用的一致
- skill 名 `openspec-archive-change`（1.4.x 起；更早版本可能是别的名字）

**用未验证版本怎么办**:大概率能用，但若 patch 报 `pattern-not-found` 或 goal 流程里 CLI 输出对不上，多半是 OpenSpec 版本变了。欢迎反馈版本号 + 报错信息，我们验证后会更新上面的清单。

> 设计选择：os-stronger **适配** OpenSpec，不集成某个固定版本进来。原因：用户可能已装好自己偏好的 OpenSpec 版本，集成会冲突且堵住升级；os-stronger 定位是增强层而非分发渠道。见 [AGENTS.md](AGENTS.md) 的兼容性策略。

## 限制

- **纯提示词约束**：没有 hook，agent 可能跳过增强步骤。但 OpenSpec 自身就是靠 agent 遵循 SKILL.md 跑起来的，同样的机制。review 主触发靠 tasks.md 里的显式 Review task，all_done 分支仅作兜底
- **patch 依赖文本匹配**：OpenSpec 改措辞或步骤标题时，分层降级策略会尝试更宽松的锚点（如 `**Handle states:**` → `all_done` → `**Steps**`）。只有关键词完全消失才会 `pattern-not-found`
- **非 git 项目 review 覆盖有限**：review 子 agent 用 `git diff HEAD` 看改动，非 git 项目或改动已 commit 时需直接读 tasks.md 涉及的文件（注入文本已含此兜底指导）
- **workspace 模式**：OpenSpec 1.4+ 的 workspace 模式 changes 目录不在 `openspec/changes/`。注入文本已改为先跑 `openspec status --json` 拿路径，不写死
- **OpenSpec 更新后需重跑**：`openspec update` 会覆盖 skill 文件，之后跑一次 `os-stronger init` 重新注入。注意：如果误跑 `--restore`，检测到文件无 os-stronger 标记会自动跳过并删除过期 backup，不会降级
- **嵌套子 agent（已解决）**：goal + review 同时启用时，apply 子 agent 遇到 Review task 理论上要起 review 子 agent（嵌套），部分平台不支持。已加双层兜底——goal 侧 propose 子 agent 不加 Review task、apply 子 agent 遇到 Review task 直接标 `[x]` 跳过；review 侧 STEP -1 自检识别自己是子 agent 就静默跳过。goal + review 可同时启用，goal 模式下 review 静默失效（goal 的 fix→test 循环本身是质量门，不依赖 review）
- **goal 串行执行**：goal 不支持并行 change，batch=1。这是稳健性选择，后续可扩展

## 扩展：加新增强

1. 新建 `src/enhancements/<name>/index.js`
2. 导出 `{ id, label, patches, files, skillTemplate }`
3. 在 `src/init.js` 的 `enhancements` 对象里注册一行
4. patch 函数遵循分层降级（L1 精确 → L2 宽松 → L3 兜底）
5. 完成
