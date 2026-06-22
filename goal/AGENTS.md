# AGENTS.md — os-stronger goal 增强维护者指南

> 本文是给后来维护者（人或 AI agent）的**设计遗嘱**。记录 goal 增强的动机、设计决策、架构和红线。
>
> 代码会变，这份文档要跟着变。改了设计就同步改这里，别让它和代码脱节。

---

## 一、这是什么

goal 增强是 os-stronger 的第三个增强模块（前两个是 review 和 skill-align）。

一句话概括：

> **在 OpenSpec 的 change 粒度之上加一层编排：把一个大目标拆成多个 change，主 agent 调度、子 agent 执行、CLI 状态中心做重注入，交替式 propose→apply 直到完成。**

### 为什么不直接用一个大 change？

OpenSpec 的 change 是"一次 propose → 一次 apply → 一次 archive"的单元。当目标太大时：
- tasks.md 会很长，上下文膨胀，agent 质量下降
- 一个 change 中途断了，恢复困难（没有跨 change 的状态管理）
- 无法做"整体验收"——单 change 的 review 只看自己，不看全局

goal 解决的是**粒度问题**：从 task 级提升到 change 级编排。

### 和社区其他方案的关系

| 方案 | 核心机制 | 粒度 | 并行 | 编排者 |
|------|----------|------|------|--------|
| Ralph Loop | shell while 循环，fresh context | task | 无 | 外部脚本 |
| Quantum-Loop | DAG + worktree + 两阶段 review | story | 有 | 内嵌 agent |
| Codex Goal Mode | automations + goal + maker-verifier | task | 有 | CLI 平台层 |
| **os-stronger goal** | **CLI 状态中心 + 串行子 agent + OpenSpec change** | **change** | **无** | **主 agent（会话内）** |

goal 的定位是**轻量、通用、零依赖**——不依赖特定 agent 平台的 hook/worktree/automation 能力，任何支持 subagent + slash command 的 agent 都能用。

---

## 二、设计目标

1. **轻**：对 agent 软件无依赖，纯 Node.js 零依赖，不启用时零影响
2. **通用**：任何支持 subagent 的 agent 都能跑（不绑定 Claude Code / Codex / Cursor）
3. **独立**：不 patch 任何 OpenSpec skill 文件，是独立 skill，和其他增强透明共存
4. **可恢复**：状态全在磁盘，会话断了重新读 state 就能接上
5. **有兜底**：fix→test 循环有熔断，不死循环

---

## 三、核心设计决策

### 决策 1：交替式 propose→apply（非批次）

**选择**：`propose change 1 → apply change 1 → propose change 2 → apply change 2 → ...`

**为什么**：apply change 1 的实际实现可能影响 change 2 的设计。交替式让每个 propose 都基于前一个 apply 的实际结果，而不是 design.md 里的设想。特别是最后一个 test change——它必须基于前面所有 change 的实际代码来写测试。

**否决的备选**：先全部 propose 再逐个 apply。否决理由：test change 在其他 change 还没实现时就 propose 了，测试用例可能对不上实际代码。

**红线**：不要改成"先全 propose 再逐个 apply"。test change 必须是最后一个 propose 的。

### 决策 2：CLI 是唯一信息管道（重注入）

**选择**：主 agent 不自己维护状态，每次操作后都调 `os-stronger goal instructions --json`，CLI 返回 nextAction + 子 agent 提示词 + 上下文路径。

**为什么**：
- 主 agent 的上下文会膨胀——如果把状态记在对话里，几轮之后就乱了
- CLI 返回的提示词是完整的、自包含的——主 agent 直接传给子 agent，不需要自己拼
- 会话断了重新调 instructions 就能恢复——状态在磁盘上，不在对话里

**红线**：不要让主 agent 自己维护状态或拼提示词。一切走 CLI。

### 决策 3：batch=1（一个子 agent 做一个 change）

**选择**：每个子 agent 只做一个 change 的 propose 或 apply。

**为什么**：社区经验（Ralph Loop）证明 fresh context 是质量的关键。一个 change 的 propose 或 apply 已经需要读 proposal + design + tasks + 代码，上下文不小。如果让一个子 agent 做 3 个 change，第 3 个的质量会明显下降。

**否决的备选**：batch=3（一个子 agent 连续做 3 个 change）。否决理由：上下文膨胀风险。某些模型（如 glm-5.2）并发会被限制，串行已经是稳健选择，batch=1 是最安全的。

**红线**：不要为了"效率"引入 batch。如果未来要加 batch，需要实测上下文膨胀的影响。

### 决策 4：最后一个 change 是 test change

**选择**：goal 的最后一个 change 必须是 `--type test`，它按 goal.md 的验收标准做 goal 级测试。

**为什么**：
- review 增强做的是 change 级审查（这个 change 的实现符不符合它的 proposal）
- test change 做的是 goal 级验收（所有 change 合在一起符不符合 goal 的目标）
- 把测试融入 OpenSpec 自然流程——test change 就是一个标准 change，走 propose→apply→archive，不需要额外机制

**红线**：不要把 test change 做成特殊流程。它就是一个 type=test 的标准 change，走同样的 propose→apply→archive 流程。唯一的区别是 CLI 在 propose 时注入 test 相关提示词。

### 决策 5：test 失败 → fix → test 循环 + 熔断

**选择**：test change 的 apply 如果测试失败，进入 fix 流程：
1. 主 agent 调 `os-stronger goal test-failed`
2. CLI 更新 fixFlow 状态（cycle++）
3. 主 agent 起分析子 agent，确定要修什么
4. 注册 fix change（type=fix）
5. 正常 propose→apply fix change
6. fix change archive 后，CLI 自动插入下一个 testchange
7. 如果 testchange 又失败，重复 1-6
8. 超过 maxFixCycles → 熔断，通知用户

**为什么**：
- test 失败是正常的——前面的 change 可能有 bug
- 不自动重试 test change（因为代码没变，重跑也一样）
- fix change 是正常的 change，走标准流程，不特殊
- 熔断防止死循环

**熔断语义**：`maxFixCycles=3` 意味着最多 3 轮 fix→test 循环。第 4 轮 test 失败时 `cycle=4 > 3` → 熔断。

**红线**：
- 不要去掉熔断。没有熔断会死循环。
- 不要让 test change 子 agent 自己修代码。它只报告失败，主 agent 负责 fix 流程。**这是流程的关键分界**：test change = 把关者，fix change = 修复者。test 子 agent 自己修会绕过 fix 流程、绕过熔断、还可能引入 fresh-context 看不到全局的新 bug。提示词（instructions.js 的 test change propose + apply 两段顶部）有"🚫 铁律：你是把关者不是修复者"的强角色声明，不能去掉或弱化。子 agent 可能因为读 OpenSpec apply-change skill 默认心态是"实现任务"，所以这条铁律必须放在 test change 提示词最顶部、最高优先级。
- fix change 必须是 surgical 的——只修问题，不重构。
- **fix change 粒度:默认一个 fix change 装本轮所有小修，不要按问题/模块机械拆分**。失败报告列了 N 条未满足项，默认全部塞进同一个 fix change 的 tasks.md（几个 task），而不是开 N 个 fix change。只有当某条问题"大"到需要重构/模块重写/架构调整时，才拆成单独的 fix change。判断标准:这个修复用 1-2 个 task 能说清并改完吗?能 → 合进同一个 fix change;不能、需要重新 propose 设计 → 单独一个 fix change。
  - **为什么**:多个 fix change 意味着多次 propose→apply→archive 循环，上下文切换和 token 成本翻倍;小修之间常有关联，拆开反而易漏;且 fix 子 agent 是 fresh context，每多一个 fix change 就多一次"重新理解全局"的开销。出现过"test 评估列了 3 条未满足，主 agent 机械开了 3 个 fix change，但其实都是小修"的过度拆分案例。
  - **反模式**:看到失败报告有 N 条就开 N 个 fix change。除非每条都是大修，否则是过度拆分。
  - **id 命名**:单个 fix change 用 `fixchange_{cycle}` 即可;只有真拆成多个时才加后缀 `fixchange_{cycle}-<short-tag>` 区分。提示词（instructions.js 的 fix_analysis_needed + skill.md）已写明此规则。

### 决策 6：显式目录 `openspec-goals/`（非隐藏）

**选择**：goal 的数据放在项目根的 `openspec-goals/goal_<name>/`，是显式目录。

**为什么**：
- 和 OpenSpec 的 `openspec/` 目录对齐——OpenSpec 也是显式的
- goal.md 是人需要看和编辑的（设计意图 + 资料 + 验收标准，见决策 13），放隐藏目录不友好
- 支持多个 goal 并行（每个 goal 一个文件夹）

**红线**：不要改成隐藏目录（如 `.os-stronger-goal/`）。goal.md 需要用户直接编辑。

### 决策 7：goal 不 patch 任何文件

**选择**：goal 是独立 skill，不 patch OpenSpec 的 skill 文件。

**为什么**：
- review 和 skill-align 通过 patch 注入增强步骤——因为它们需要"在 OpenSpec 流程中自然遇到"
- goal 不需要——goal 有自己的触发条件（用户说"goal"或 CLI 命令）
- 不 patch 意味着零侵入：不启用时完全不影响 OpenSpec 和其他增强

**红线**：不要把 goal 做成 patch。goal 是编排层，不是流程增强层。

### 决策 8：上下文通过路径传递

**选择**：CLI 的 `instructions --json` 返回 `contextForSubagent.completedChangeArtifacts`——已完成 change 的文件路径列表（proposal.md / design.md / specs 目录的路径），不是内容。

**为什么**：
- 和 review 增强的原则一致——传路径不传内容
- 子 agent 自己决定要不要读、读哪些
- 避免主 agent 上下文膨胀（如果主 agent 读内容再传给子 agent，上下文会爆炸）

**红线**：不要让 CLI 返回文件内容。只返回路径。

### 决策 9：子 agent 必须遵循 OpenSpec skill

**选择**：子 agent 提示词（subagentPrompt）和主 agent 指令（nextAction.instruction）都明确引用 OpenSpec 的 skill 文件。

**为什么**：
- 子 agent 是 fresh context，不知道项目里有哪些 skill 可用
- 如果只写 "Execute openspec-propose"，子 agent 不一定知道去读 `.claude/skills/openspec-propose/SKILL.md`
- 明确写 "read and follow the openspec-propose skill in your project's skills directory" 才能确保子 agent 走 OpenSpec 的标准工作流
- 主 agent 的 instruction 也要引用 skill，让主 agent 理解整个流程在做什么

**三层引用**：
1. SKILL.md（主 agent 读）：Phase 0 引用 openspec-explore，Loop 描述引用 openspec-propose / openspec-apply-change
2. instructions.js 子 agent 提示词（subagentPrompt）：propose 提示词引用 openspec-propose，apply 提示词引用 openspec-apply-change + openspec-archive
3. instructions.js 主 agent 指令（nextAction.instruction）：propose_next 引用 openspec-propose，apply_next 引用 openspec-apply-change + openspec-archive，fix_analysis_needed 引用后续的 propose/apply 流程

**红线**：不要在提示词里只写命令名（如 "Execute openspec-propose"）。必须明确指导子 agent 去读 skill 文件。goal 编排层不替代 OpenSpec 工作流。

### 决策 10：goal 模式下自主 archive（覆盖 review 的“问用户”）

**选择**：goal 模式下，agent 必须自主 archive，不让用户判断。在三个层面明确说明：
1. SKILL.md 的 Guardrails："MUST auto-archive — no user confirmation needed"
2. 子 agent 提示词：`ARCHIVE_MANDATORY_NOTE` 常量块 + propose/apply 提示词里的具体指令
3. 主 agent 指令（nextAction.instruction）："goal 模式下 archive 是自主的、强制的"

**为什么**：
- review 增强在设计上“archive 决定权在用户”——每个 change apply 完，review 通过后会问用户“是否 archive？”
- 但 goal 的核心价值是“确定目标后全自动跑”——如果每个 change 都停下来问用户，就不是 loop 了
- 人在 explore 阶段参与对齐目标后，后续 propose→apply→archive→fix→test 全部自主，直到熔断或完成

**与 review 的兼容**：goal 不修改 review 的代码。review 的“问用户”指令仍在 openspec-apply-change 的 SKILL.md 里，但 goal 的子 agent 提示词明确覆盖：“In goal mode, archiving is MANDATORY and AUTONOMOUS — do NOT ask the user.”。子 agent 同时看到两条指令，goal 的指令优先。

**红线**：
- 不要去掉 `ARCHIVE_MANDATORY_NOTE`。它是子 agent 看到的第一条指令之一。
- 不要在 goal 模式下恢复“问用户是否 archive”。用户只在 explore、熔断、完成时参与。
- 不要修改 review 增强的代码来适配 goal。覆盖是提示词层面的，不是代码层面的。

### 决策 11：test change 内嵌独立语义评估（评估在前，测试在后）

**选择**：test change 的 tasks.md 第一个 task 是「独立语义评估」，在写任何测试代码之前，子 agent 以 fresh context 的独立视角，读 goal.md 验收标准 + 所有已完成 change 的产物，逐条判断是否满足。评估通过后才写测试。

**为什么**：
- test change 的 apply 子 agent 是 fresh context，没参与过前面任何 change 的实现——相对于「目标是怎么实现的」，它是独立的
- 评估在前时，子 agent 还没写测试代码，视角更纯粹（不被「我写的测试都过了」bias）
- 如果方向性错误（验收标准没满足），不需要浪费 token 写无意义的测试——直接返回失败
- 类比 Claude Code /goal 的独立裁判模型（Haiku）：os-stronger 没有小模型 Hook，但 fresh context 子 agent 的独立性已经足够——它和 Haiku 一样只读产物做判断，不参与实现

**和 Claude Code Haiku 的对比**：

| 维度 | Claude Code Haiku | os-stronger 语义评估 |
|------|-------------------|---------------------|
| 不同模型？ | ✅ Haiku ≠ Sonnet/Opus | ❌ 同一个模型 |
| 看过实现过程？ | ❌ 只读 transcript | ❌ fresh context |
| 写过测试？ | ❌ 不能写代码 | ❌ 评估在前，还没写 |
| 判断依据 | session transcript | goal.md + 产物文件 |
| 对前面 change 的独立性 | ✅ | ✅ |
| 对测试代码的独立性 | ✅ | ✅ |

**评估不通过后的流程**：和测试失败走同一个 fix → test → 熔断路径。评估返回的失败报告（哪条未满足 + 原因 + 建议）作为 fix change 的输入，主 agent 调 `test-failed` 后进入 fix 分析流程。

**fix 分析的分叉**：语义评估不通过和测试失败的 fix 方向不同。分析子 agent 根据失败类型分叉：
- 语义评估不通过：哪条验收标准未满足、缺什么实现/要补什么 change
- 测试失败：哪个模块有 bug、每个模块修什么

**为什么不做嵌套子 agent**：理论上更独立的做法是让 test change 的 apply 子 agent 起一个独立的评估子 agent（类似 review 增强）。但 goal 的 apply 子 agent 已经是子 agent，再嵌套就是二级子 agent，部分平台不支持（max_depth=1）。且评估只需要读文件做判断，fresh context 子 agent 切换角色已经足够独立。

**证据层次**：语义评估不能只看规划文档（proposal/design/specs），必须按下述层次找证据（由弱到强）：
1. specs/ 是否覆盖该验收标准
2. tasks.md 是否标 `[x]`
3. 必要时直接读对应源码，确认实现真实存在且与设计一致

只看规划文档等于"规划覆盖度检查"，不是真正的语义评估。

**红线**：
- 不要把语义评估移到测试之后。评估在前的独立性更强。
- 不要让评估子 agent 起嵌套子 agent。用角色切换代替。
- 不要为语义评估新增 state 字段或 CLI 命令。复用现有 test-failed → fix → 熔断流程。
- 评估不通过时必须返回具体的「哪条未满足 + 原因 + 建议」，不能只说「不通过」。
- 不要把证据来源限定为规划文档。必须引导子 agent 读真实代码。

### 决策 12：主 agent 的子 agent 交互分两阶段——派前防重，派后等回报

**选择**：主 agent 和子 agent 的交互明确分两个阶段，提示词里分别给规则：

- **派前（防重复派发）**：派一个新子 agent 之前，先确认没有其他子 agent 还在跑。如果之前派了一个还没收到回报，等它返回再派下一个。
- **派后（禁止轮询）**：派出去之后，只等回报。不检查它在做什么、不轮询进度、不读它在写的文件、不跑 `os-stronger goal status` 看完了没。

**为什么**：
- 这两件事是**不同的事**，必须分开。早期版本（commit 403db9e）专门给 apply_next 补了"派前 check 防重"，是因为出现过两个子 agent 同时操作同一个 change 导致冲突。这个 check 是必要的，不能去。
- 但"派前一次性 check"和"派出去之后反复 check 进度"是两回事。后者是真实跑下来发现的问题：部分主 agent 不知道自己的职责，会持续轮询子 agent 完成没有——子 agent 干的活（读 specs、写代码、跑测试）天然就慢，动辄几分钟到几十分钟，轮询每一轮都烧 token 而信息量为零（没回报就是还没完，check 100 次结论也一样）。
- 主 agent 派出之后的正确触发条件只有两个：(a) 子 agent 返回报告（"Propose complete" / "Apply complete" / "Test failed: ..."），(b) 用户说话。其他时候什么都不该做。

**怎么区分（给后来维护者）**：
- "派前 check 是否有 active sub-agent" = **必要**，防两个子 agent 撞同一个 change。一次性，check 完就派。
- "派后 check 子 agent 进度 / 跑 status 看完了没 / 读它在写的文件" = **禁止**，纯轮询，烧 token 无信息量。
- 判断标准：check 的对象是"有没有别的子 agent在跑"（派前，OK）还是"我派的这个子 agent 做到哪了"（派后，禁止）。

**注入位置**（三层，和决策 9 的 skill 引用同构）：
1. `skill.md` 顶部 Orchestration Mindset 的 decision boundaries：加 "DO NOT inspect what a running sub-agent is doing" + "While a sub-agent is running: do nothing"，并明确标注"派前 check 防重"不在此列
2. `skill.md` Guardrails：`STRICTLY SERIAL` 条保留"派前 check no active sub-agents"，明确"派后 wait for its report, do not poll"；新增一条 `DO NOT inspect sub-agent work — wait for their report`（针对派后）；删掉 "If a sub-agent seems stuck, check os-stronger goal status" 这条（它诱导派后轮询）
3. `instructions.js` 的 propose_next / apply_next / fix_analysis_needed 的 instruction：统一改成两阶段式——"派之前：确认没有其他子 agent 在跑（防重复派发）；派之后：等它回报，不要轮询、不要跑 status"

**红线**：
- 不要去掉"派前 check 防重"。commit 403db9e 专门加的，去掉会重新打开"两个子 agent 同时操作同一 change"的冲突 bug。
- 不要在提示词里写"派后 check 子 agent 进度""子 agent 卡住就 check status"这类诱导派后轮询的措辞。
- 不要把"派前防重"和"派后轮询"混为一谈。前者必要，后者禁止。判断标准见上。
- 不要让主 agent 读子 agent 正在写的文件来判断进度。等它回报。

### 决策 13：goal.md 是设计意图 + 资料中心

**选择**：goal.md 不只是"目标 + 验收标准"，而是承载六段的设计意图 + 资料中心：
1. **目标** — 一句话目标 + 动机（为什么做）
2. **宏观架构** — 模块划分 / 组件关系 / 技术栈选型要点（可附架构图链接）。复杂度评估也写在这一节
3. **设计规范** — 视觉风格 / 颜色 / 交互规范 / API 风格 / 命名约定
4. **测试维度** — goal 级验收要覆盖的维度（集成点/边界/性能/兼容），是宏观维度不是单测清单
5. **参考资料** — 用户给的 GitHub / 图片 / 网址 / 设计稿，每条带"是什么 + 为什么参考 + 链接/路径"
6. **验收标准** — 可验证的勾选项，test change 语义评估逐条对照的依据

子 agent 之间的上下文共享 = **goal.md + 前序 change 的产物**。

**为什么**：
- 子 agent 是 fresh context，对话里用户给过主 agent 的资料（GitHub 链接、图片、网址、风格参考）**不会出现在子 agent 上下文里**。唯一落盘点是 goal.md。不落盘就丢失，子 agent 拿不到最初设计意图，目标会偏移。
- 早期 goal.md 只有"目标 + 验收标准"两段，承载不了这些。用户在对话里说"参考这个 GitHub 项目"，但 goal.md 里连链接都没有，子 agent 根本不知道有这回事。
- 把资料内容内嵌进 goal.md 会违反决策 8（上下文通过路径传递）且让 goal.md 膨胀。所以只放链接/路径，子 agent 自己去读。
- 复杂度评估放在 goal.md 的宏观架构章节，作为拆 change 的思考框架——**零新 state 字段、零新 CLI 命令**，纯提示。用户明确：只提示不改程序。

**怎么落地**（提示词层，不改程序逻辑）：
1. `state.js` 的 goal.md 模板（`createGoal` 生成）扩成六段，每段带 HTML 注释引导，让用户知道不填的代价
2. `skill.md` Phase 0 加两步：(a) 主动用 AskUserQuestion 问用户要参考资料，写入 `## 参考资料`；(b) 在 `## 宏观架构` 写复杂度评估 + change 拆分策略，提示"特别复杂的部分可拆成多个 change，不要太大也不要过细，最终粒度由主 agent 判断"
3. `instructions.js` 的 propose / apply / test change 子 agent 提示词统一改成"必须先读 goal.md 全文，不要只读验收标准"——设计意图和参考资料只在 goal.md 里

**红线**：
- 不要把资料内容（非链接）内嵌进 goal.md。只放链接/路径（守决策 8）。
- 不要为复杂度评估加 state 字段或 CLI 命令。用户明确：只提示不改程序。
- 不要让子 agent 只读验收标准跳过其他章节。设计意图和资料会丢，目标会偏移。
- 不要把 goal.md 拆成多文件。单文件让 fresh context 一次读全；多文件子 agent 可能漏读。
- goal.md 仍要写得**详细但宏观**——是设计意图，不是实现细节。章节填不全会让子 agent 缺视角，模板有占位引导但不强制填。

---

## 四、架构总览

```
os-stronger/
├── bin/os-stronger                      ← CLI 入口（goal 子命令路由到 goal/scripts/cli.js）
├── src/
│   ├── init.js                          ← init 时注册 goal（创建 skill 文件，不 patch）
│   └── enhancements/                    ← review / skill-align（现有）
├── goal/                                ← goal 增强全部代码
│   ├── README.md                        ← 给人看的使用说明
│   ├── AGENTS.md                        ← 本文件
│   ├── skill.md                         ← SKILL.md 模板（init 时拷贝到各工具目录）
│   ├── scripts/                         ← 所有 JS 代码
│   │   ├── index.js                     ← 增强注册模块（导出 id/label/skillTemplate）
│   │   ├── state.js                     ← state.json 读写 + 状态机
│   │   ├── instructions.js              ← 核心重注入引擎（生成 nextAction + 提示词）
│   │   └── cli.js                       ← CLI 命令入口（参数解析 → 调 state/instructions）
│   └── reference/                       ← 额外提示词/参考文档（如有）
└── tests/
    └── goal.test.js                     ← 单元测试
```

### 分层

```
┌──────────────────────────────────┐
│  bin/os-stronger                  │  解析 `goal` 子命令 → 转发到 cli.js
├──────────────────────────────────┤
│  goal/scripts/cli.js              │  参数解析 → 调 state.js / instructions.js
├──────────────────────────────────┤
│  goal/scripts/instructions.js     │  核心重注入引擎：解析 state → 生成 nextAction + 提示词
├──────────────────────────────────┤
│  goal/scripts/state.js            │  state.json 读写 + 状态机（所有状态变更的逻辑）
├──────────────────────────────────┤
│  openspec-goals/goal_<name>/      │  运行时数据（CLI 创建和读写）
│  ├── state.json                   │  状态机
│  ├── goal.md                      │  目标+架构+设计规范+测试维度+资料+验收标准（人编辑，决策 13）
│  └── changes.yaml                 │  change 骨架
└──────────────────────────────────┘
```

**关键**：state.js 是所有状态变更的唯一入口。instructions.js 只读状态、生成指令，不写状态。cli.js 只解析参数、调用 state/instructions，不含业务逻辑。

---

## 五、状态机

### Change Phase

```
skeleton → proposed → archived
              │
              ├──→ blocked（有 blockReason，fixFlow 时跳过）
              └──→ (test change 失败时不走 archived，走 fixFlow)
```

### Fix Flow

```
testchange_N apply → 失败
  → test-failed (cycle++)
  → cycle > maxCycles?
      → YES: 熔断（circuit_break），等用户 resume
      → NO:  fix_analysis_needed
              → 分析子 agent 确定要修什么
              → 注册 fix change(s)
              → propose → apply fix change(s)
              → fix change archive → 自动插入 testchange_{N+1}
              → propose → apply testchange_{N+1}
                  → 失败 → 回到 test-failed
                  → 通过 → done 🎉
```

### Instructions 的 nextAction 类型

| type | 触发条件 | 主 agent 行为 |
|------|----------|---------------|
| `propose_next` | 有 skeleton change | 起子 agent propose |
| `apply_next` | 有 proposed change | 起子 agent apply |
| `fix_analysis_needed` | fixFlow active 但无 fix change | 起分析子 agent |
| `blocked` | 有 blocked change 且非 fixFlow | 通知用户 |
| `circuit_break` | fixFlow.cycle > maxCycles | 通知用户，等 resume |
| `done` | 所有 change archived | 通知用户完成 |

---

## 六、代码组织规范

### 文件职责

| 文件 | 职责 | 不应做 |
|------|------|--------|
| `goal/scripts/state.js` | state.json 读写 + 所有状态变更逻辑 | 不生成提示词，不解析参数 |
| `goal/scripts/instructions.js` | 读状态 → 生成 nextAction + 提示词 | 不写状态（只读） |
| `goal/scripts/cli.js` | 解析 CLI 参数 → 调 state/instructions | 不含业务逻辑 |
| `goal/scripts/index.js` | 导出增强注册信息 | 不含逻辑 |
| `goal/skill.md` | agent 读的工作流指令（SKILL.md 模板） | 不含 CLI 实现细节 |

### 加新 nextAction 类型的步骤

1. 在 `instructions.js` 的 `getInstructions()` 里加判断分支
2. 在 `skill.md` 里加对应的 agent 行为说明
3. 在 `cli.js` 的人类可读输出里加显示
4. 在本文件的 nextAction 类型表里加一行
5. 写测试

### 加新 CLI 命令的步骤

1. 在 `state.js` 里加状态操作函数（如果有状态变更）
2. 在 `cli.js` 里加命令处理函数 + 注册到 switch
3. 在 `skill.md` 的 CLI Reference 里加一行
4. 在 `README.md` 的 CLI 命令表里加一行
5. 写测试

---

## 七、维护红线速查

| 想做 | 能不能 | 为什么 |
|------|--------|--------|
| 改成"先全 propose 再逐个 apply" | ❌ | 违背决策 1。test change 必须最后 propose |
| 让主 agent 自己维护状态 | ❌ | 违背决策 2。CLI 是唯一信息管道 |
| 引入 batch（一个子 agent 做多个 change） | ❌ | 违背决策 3。上下文膨胀风险 |
| 把 test change 做成特殊流程 | ❌ | 违背决策 4。它是标准 change，只是 type 不同 |
| 去掉熔断 | ❌ | 违背决策 5。会死循环 |
| 让 test change 子 agent 自己修代码 | ❌ | 违背决策 5。test change = 把关者，fix change = 修复者。自己修绕过 fix 流程 + 熔断，还可能引入 fresh-context 看不到全局的新 bug。提示词顶部有"🚫 铁律：你是把关者不是修复者"强角色声明，不能弱化 |
| 去掉 test change 提示词顶部的"把关者不是修复者"铁律 | ❌ | 违背决策 5。子 agent 读 OpenSpec apply-change skill 默认心态是"实现任务"，铁律必须放最顶部最高优先级才能盖过 |
| 在 test change 的 tasks.md 里加"修复产品代码"task | ❌ | 违背决策 5。test change 的 task 只有评估/测试/跑测试/archive，修产品代码是 fix change 的活 |
| 按问题/模块机械拆分 fix change（失败报告 N 条就开 N 个 fix change） | ❌ | 违背决策 5。默认一个 fix change 装本轮所有小修，只有大修/重构才拆。过度拆分翻倍 propose→apply 循环和 token 成本，且小修常有关联拆开易漏 |
| 把 goal 数据放隐藏目录 | ❌ | 违背决策 6。goal.md 需要用户编辑 |
| 把 goal 做成 patch | ❌ | 违背决策 7。goal 是编排层，不是流程增强 |
| 让 CLI 返回文件内容而非路径 | ❌ | 违背决策 8。上下文膨胀 |
| 提示词里只写命令名不引用 skill 文件 | ❌ | 违背决策 9。子 agent 不知道去读哪 |
| goal 模式下问用户是否 archive | ❌ | 违背决策 10。goal 模式 archive 是自主的 |
| 去掉 ARCHIVE_MANDATORY_NOTE | ❌ | 违背决策 10。子 agent 需要明确的 archive 覆盖指令 |
| 把语义评估移到测试之后 | ❌ | 违背决策 11。评估在前的独立性更强 |
| 为语义评估新增 state 字段或 CLI 命令 | ❌ | 违背决策 11。复用现有 test-failed → fix → 熔断流程 |
| 让评估子 agent 起嵌套子 agent | ❌ | 违背决策 11。用角色切换代替，避免平台兼容问题 |
| 去掉"派前 check 防重"（check no active sub-agents before dispatch） | ❌ | 违背决策 12 + commit 403db9e。会重新打开"两个子 agent 同时操作同一 change"的冲突 bug |
| 提示词里写"派后 check 子 agent 进度""子 agent 卡住就 check status" | ❌ | 违背决策 12。诱导派后轮询，烧 token 且无信息量。派出去就等回报 |
| 把"派前防重"和"派后轮询"混为一谈一刀切 | ❌ | 违背决策 12。前者必要后者禁止，判断标准：check 的是"有没有别的子 agent 在跑"(派前,OK) 还是"我派的这个做到哪了"(派后,禁止) |
| 让主 agent 读子 agent 正在写的文件判断进度 | ❌ | 违背决策 12。等它回报 |
| 把资料内容（非链接）内嵌进 goal.md | ❌ | 违背决策 8 + 13。只放链接/路径，子 agent 自己读 |
| 为复杂度评估加 state 字段或 CLI 命令 | ❌ | 违背决策 13。用户明确：只提示不改程序 |
| 让子 agent 只读验收标准跳过 goal.md 其他章节 | ❌ | 违背决策 13。设计意图/资料会丢，目标偏移 |
| 把 goal.md 拆成多文件 | ❌ | 违背决策 13。单文件让 fresh context 一次读全，多文件可能漏读 |
| 改 fixFlow 的熔断判断条件 | ⚠️ 谨慎 | `cycle > maxCycles` 是有意为之。maxCycles=3 允许 3 轮 fix，第 4 轮失败才熔断 |
| 加新的 change type | ✅ | 在 state.js 的 addChange 里支持，在 instructions.js 里加提示词 |
| 加新的 CLI 命令 | ✅ | 在 cli.js 里加，在 skill.md 和 README.md 里更新 |
| 调提示词措辞 | ✅ | 在 instructions.js 的 buildProposePrompt / buildApplyPrompt 里改 |
| 加 goal 级别的验证 | ✅ | 可以在 done 之前加一个验证步骤，但不要破坏现有 test→fix→熔断 流程 |

---

## 八、已知限制

1. **会话内 loop**：主 agent 是 loop 的执行者。如果会话断了（用户关 IDE），loop 停止。用户需要手动说"继续 goal xxx"，agent 调 instructions 恢复。不做外部 loop runner（如 shell 脚本），因为那引入平台依赖。

2. **串行执行**：不支持并行。一个 change 做完才做下一个。这是有意为之——串行更稳健，且兼容并发受限的模型。未来可以加并行开关，但需要实测。

3. **fix 分析依赖子 agent 质量**：test 失败后需要分析子 agent 确定修什么。如果分析子 agent 判断失误，fix 可能不对。但这是所有 agent 方案的通病——靠 fresh context + 明确提示词缓解。语义评估的失败报告会提供「哪条未满足 + 原因 + 建议」，帮助分析子 agent 更准确地定位问题。

4. **OpenSpec 路径假设**：instructions.js 假设 OpenSpec 的 change 在 `openspec/changes/<name>/` 或 `openspec/changes/archive/<date>-<name>/`。workspace 模式（OpenSpec 1.4+）路径不同——目前通过 `openspec status --change <name> --json` 拿路径的方式不完全兼容，需要子 agent 自己处理。

5. **goal 不自动创建 OpenSpec change**：CLI 只管理 goal 状态，不调 `openspec new change`。子 agent 自己调。这是有意为之——保持 CLI 的单一职责。

6. **archive 目录匹配用 endsWith**：`getCompletedArtifacts` 和 `getChangePath` 用 `d.name.endsWith(openspecChangeName)` 匹配 archive 目录。OpenSpec 的 archive 格式是 `<date>-<openspecChangeName>`，endsWith 精确匹配。早期用 includes() 会误匹配子串（如 `mygoal-auth` 匹配到 `mygoal-fix-auth`），已修复。

7. **fix change 类型误注册防御**：`addChange` 在 `fixFlow.active` 时检查新 change 的 type 是否为 `fix`，如果不是会拋警告。防止主 agent 注册 fix change 时写错 type 导致 `archiveFixChange` 不触发、`pendingFixChanges` 不清空、goal 卡死。

8. **嵌套子 agent 问题**：goal 的 apply 子 agent 遵循 `openspec-apply-change` skill，而 review 增强已 patch 这个 skill，注入了“起 review 子 agent”的指令。这意味着 apply 子 agent 需要启动自己的子 agent（嵌套）。部分平台不支持嵌套子 agent（如 max_depth=1 限制）。当前不解决这个问题——`ARCHIVE_MANDATORY_NOTE` 在提示词层面覆盖了 review 的“问用户是否 archive”行为，但嵌套调度本身依赖平台能力。如果目标平台不支持嵌套子 agent，建议不要同时启用 goal 和 review，或者接受 review 步骤可能被跳过。

9. **失败的 test change 在 OpenSpec 侧残留**：语义评估或测试失败时，apply 子 agent 在 archive task 之前就 bail 了。state 侧通过 test-failed + blockReason 处理，后续某个 test change 通过时 archiveTestChange 会把所有非 archived 的 test change 一次性标 archived。但 OpenSpec 侧没人对失败的 testchange 跑 `openspec archive`，它的文件夹一直留在 `openspec/changes/`。功能上不坏（getCompletedArtifacts 用 endsWith 匹配 archive 目录再 fallback 到活跃目录），但 goal 完成后 `openspec/changes/` 会残留若干没归档的 test change 文件夹。语义评估失败比测试失败更早 bail（连测试代码都没写），所以这个残留更常见。后续可由最后一个 test change 的 apply 子 agent 在 archive 阶段顺带清理。

---

## 九、相关文档

- `goal/README.md` — 面向用户的安装/使用说明
- `goal/skill.md` — agent 读的工作流指令（SKILL.md 模板）
- `AGENTS.md`（项目根）— os-stronger 整体的维护者指南
- OpenSpec 文档 — 理解 propose/apply/archive 工作流

改设计时，同步更新本文件。不要让它和代码脱节。
