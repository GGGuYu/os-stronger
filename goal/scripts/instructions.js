// goal/instructions.js
// instructions --json 生成逻辑 — 核心重注入引擎。
// 解析 state.json，返回 nextAction + 子 agent 提示词 + 上下文路径。
// 子 agent 提示词明确指导其遵循 OpenSpec 的 skill（openspec-propose / openspec-apply-change 等）。
// goal 模式下 archive 是强制的、自主的——不让用户判断。

const fs = require('fs');
const path = require('path');
const {
  loadState,
  goalDocPath,
  goalDir,
  isCircuitBroken,
  getProgress,
} = require('./state');

// ─── 辅助：获取已完成 change 的 artifact 路径 ───

function getCompletedArtifacts(projectDir, state) {
  const completed = state.changes.filter(c => c.phase === 'archived');
  return completed.map(c => {
    const archiveBase = path.join(projectDir, 'openspec', 'changes', 'archive');
    const activePath = path.join(projectDir, 'openspec', 'changes', c.openspecChangeName);

    let baseDir = null;

    if (fs.existsSync(archiveBase)) {
      const dirs = fs.readdirSync(archiveBase, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.endsWith(c.openspecChangeName))
        .map(d => d.name)
        .sort()
        .reverse();
      if (dirs.length > 0) {
        baseDir = path.join(archiveBase, dirs[0]);
      }
    }

    if (!baseDir && fs.existsSync(activePath)) {
      baseDir = activePath;
    }

    const proposalPath = baseDir ? path.join(baseDir, 'proposal.md') : null;
    const designPath = baseDir ? path.join(baseDir, 'design.md') : null;
    const tasksPath = baseDir ? path.join(baseDir, 'tasks.md') : null;
    const specsDir = path.join(projectDir, 'openspec', 'specs');

    return {
      id: c.id,
      title: c.title,
      type: c.type,
      openspecChangeName: c.openspecChangeName,
      proposalPath: (proposalPath && fs.existsSync(proposalPath)) ? proposalPath : null,
      designPath: (designPath && fs.existsSync(designPath)) ? designPath : null,
      tasksPath: (tasksPath && fs.existsSync(tasksPath)) ? tasksPath : null,
      specsDir: fs.existsSync(specsDir) ? specsDir : null,
    };
  });
}

// ─── 辅助：获取当前 change 的 OpenSpec 路径 ───

function getChangePath(projectDir, change) {
  const activePath = path.join(projectDir, 'openspec', 'changes', change.openspecChangeName);
  if (fs.existsSync(activePath)) return activePath;

  const archiveBase = path.join(projectDir, 'openspec', 'changes', 'archive');
  if (fs.existsSync(archiveBase)) {
    const dirs = fs.readdirSync(archiveBase, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.endsWith(change.openspecChangeName))
      .sort()
      .reverse();
    if (dirs.length > 0) return path.join(archiveBase, dirs[0]);
  }

  return null;
}

// ─── 辅助：获取所有 change 概览 ───

function getAllChangesOverview(state) {
  return state.changes.map(c => ({
    id: c.id,
    title: c.title,
    phase: c.phase,
    type: c.type,
    testCycle: c.testCycle || undefined,
    blockReason: c.blockReason || undefined,
  }));
}

// ─── archive 强制提示（goal 模式专用）───

const ARCHIVE_MANDATORY_NOTE = `
## ⚠️ GOAL MODE: Auto-Archive is Mandatory

You are running inside a goal orchestration loop. In goal mode:
- **You MUST archive this change autonomously** after all tasks are complete and tests pass.
- **Do NOT ask the user whether to archive.** Do NOT pause for user confirmation.
- If the \`review\` enhancement is enabled and review passes, archive **immediately** — do NOT ask the user.
- The user only intervenes at: (1) circuit break (fix-test loop exhausted), (2) goal completion.
- Everything in between is autonomous. Archiving advances the goal to the next change.
`;

// ─── 子 agent 提示词生成 ───

function buildProposePrompt(projectDir, state, change) {
  const goalDoc = goalDocPath(projectDir, state.goalName);
  const completedArtifacts = getCompletedArtifacts(projectDir, state);
  const allChanges = getAllChangesOverview(state);

  let prompt = `## Goal Context

**Goal**: ${state.goalName}
**Description**: ${state.goalDescription}
**Goal Doc**: \`${goalDoc}\`
**⚠️ 必须先读 goal.md 全文**：goal.md 不只是验收标准——它承载了目标 / 宏观架构 / 设计规范 / 测试维度 / 参考资料 / 验收标准。你是 fresh context，对话里用户给过主 agent 的资料（GitHub / 图片 / 网址 / 风格参考）只落盘在 goal.md 里，不会出现在你的上下文。只读验收标准会丢失设计意图和参考资料，导致目标偏移。开始任何工作前，完整读一遍 goal.md。

## All Changes in This Goal

${allChanges.map(c => `- [${c.phase}] ${c.id}: ${c.title}${c.type !== 'normal' ? ` (${c.type})` : ''}`).join('\n')}

## Changes Already Completed (for reference)

${completedArtifacts.length > 0
    ? completedArtifacts.map(a => `- **${a.id}** (${a.title})\n  - proposal: \`${a.proposalPath || 'N/A'}\`\n  - design: \`${a.designPath || 'N/A'}\`\n  - tasks: \`${a.tasksPath || 'N/A'}\``).join('\n')
    : '（无已完成 change）'}

${ARCHIVE_MANDATORY_NOTE}

## Your Task

Propose the following change:
- **ID**: ${change.id}
- **Title**: ${change.title}
- **OpenSpec change name**: ${change.openspecChangeName}

### Prerequisite: Follow OpenSpec Propose Workflow

**Before starting**, read and follow the \`openspec-propose\` skill in your project's skills directory (e.g., \`.claude/skills/openspec-propose/SKILL.md\`, \`.codex/skills/openspec-propose/SKILL.md\`, etc.). This skill defines the standard workflow for creating proposals, design docs, specs, and task lists. You MUST follow it — goal orchestration wraps OpenSpec, it does not replace it.

### Steps

1. Run \`openspec new change "${change.openspecChangeName}"\`
2. Follow the \`openspec-propose\` skill workflow — create proposal.md, design.md, specs/, tasks.md per OpenSpec conventions
3. **IMPORTANT**: The LAST task in tasks.md MUST be the goal archive task:
   \`\`\`markdown
   - [ ] Run all tests and verify they pass.
     Then run OpenSpec archive to merge specs:
     \`openspec archive --change "${change.openspecChangeName}"\`
     Then update goal state:
     \`os-stronger goal change archive --goal ${state.goalName} --id ${change.id}\`
     **In goal mode, archiving is MANDATORY and AUTONOMOUS — do NOT ask the user.**
   \`\`\`
   **Task ordering**: The archive task is always the absolute last task. Order: implementation tasks → archive task.
4. After proposing, report back.

### ⚠️ Boundary: Propose Only

You are a PROPOSE sub-agent. Your job is **done** after creating proposal.md, design.md, specs/, and tasks.md. 

**Do NOT:**
- Do NOT start implementing tasks (apply). That is a separate sub-agent's job.
- Do NOT spawn your own sub-agent to apply.
- Do NOT run \`openspec apply-change\` or \`openspec archive\`.
- Do NOT write any implementation code.

**DO:**
- Create the planning artifacts (proposal, design, specs, tasks).
- Add the goal archive task as the last task in tasks.md.
- Report back to the orchestrator: "Propose complete for change <id>."
- Stop. The orchestrator will dispatch a fresh sub-agent for apply.
`;

  // test change 特殊提示（含独立语义评估）
  if (change.type === 'test') {
    prompt += `
## ⚠️ Test Change 提示 — 你是把关者，不是修复者

**🚫 铁律：test change 只做评估 + 测试 + 报告，绝不修复产品代码。** 发现问题只报告给主 agent，由主 agent 派 fix change 去修。你在 propose 阶段写的 tasks.md 里，**不能有"修复产品代码"这类 task**——只有评估、测试、跑测试、archive。

这是 test change（第 ${change.testCycle} 轮）。在 propose 之前：
1. **必须读** goal doc 全文：\`${goalDoc}\`（架构 / 设计规范 / 测试维度 / 参考资料 + 验收标准，不要只读验收标准）
2. **必须读**所有已完成 change 的 design.md 和 specs

### tasks.md 结构要求（Test Change 专用）

Test change 的 tasks.md 必须按以下顺序组织，**全程不碰前序 change 的产品代码**：

**Task 1: 独立语义评估（Independent Goal Evaluation）**
- 这是 test change 的第一个 task，必须在所有测试用例之前
- 评估者在此时还没有写任何测试代码，是纯粹的外部审查视角
- 评估内容：逐条对照 goal.md 的验收标准，从已完成 change 的产物（proposal/design/specs）中找证据，判断每条是否被满足
- 评估结果：
  - 全部满足 → 标记 Task 1 完成，继续写测试
  - 有未满足的 → 记录哪条未满足、为什么、**建议**主 agent 怎么修（只是建议，不自己修），直接返回失败（不写后续测试，不改产品代码）

**Task 2 ~ Task N-1: 测试用例**
- 覆盖所有验收标准的测试
- 重点关注 change 之间的接口和集成点
- 这是 goal 级别的集成/验收测试，不是单元测试
- 只写测试代码，**不改产品代码**

**Task N: 运行全部测试 + Archive**
- 跑全部测试，通过后执行 archive（openspec archive → os-stronger goal change archive）
- 测试失败 → 报告失败，**不自己修**，让主 agent 派 fix change

### 为什么语义评估在前

- 评估时子 agent 还没写测试代码，视角更独立（不被"我写的测试都过了"bias）
- 如果方向性错误（验收标准没满足），不需要浪费 token 写无意义的测试
- 评估通过后再写测试，测试用例可以基于评估时对产物的理解
`;

    if (change.testCycle > 1 && change.basedOn) {
      const fixChanges = state.changes.filter(c => c.type === 'fix');
      prompt += `
## ⚠️ Test Change 第 ${change.testCycle} 轮

上一轮 ${change.basedOn} 失败。已通过以下 fix change 修复：
${fixChanges.map(f => `- ${f.id}: ${f.title}`).join('\n') || '（无）'}

上一轮失败信息：${state.fixFlow.lastFixResult || 'N/A'}

你的 test change 应该：
1. 语义评估：重新检查上一轮未满足的验收标准是否已被 fix change 解决
2. 测试用例：覆盖 ${change.basedOn} 的所有测试用例（读其 tasks.md），针对 fix 内容增加回归测试
3. 重新跑全部测试
`;
    }
  }

  if (change.type === 'fix') {
    prompt += `
## 🔧 Fix Change 提示

这是 fix change，用于修复测试失败的问题。
1. 参考上一个 test change 的失败信息：${state.fixFlow.lastFixResult || 'N/A'}
2. 只修复必要的问题，不要做额外重构
3. 修复后确保不引入新问题
`;
  }

  if (completedArtifacts.length > 0) {
    prompt += `
## 上下文传递

**Before starting your work**, check the completed changes above. If your change depends on or interfaces with any completed change:
1. If the paths above are valid (not N/A), READ the design.md and relevant spec files directly.
2. If paths are N/A (workspace mode or archive directory not found), run \`openspec status --change "<completed-change-name>" --json\` to get the real file paths, then read them.
3. Do not assume APIs — verify them from the actual artifacts.
`;
  }

  return prompt;
}

function buildApplyPrompt(projectDir, state, change) {
  const changePath = getChangePath(projectDir, change);
  const completedArtifacts = getCompletedArtifacts(projectDir, state);
  const allChanges = getAllChangesOverview(state);
  const goalDoc = goalDocPath(projectDir, state.goalName);

  const changeIdx = state.changes.indexOf(change);
  const remaining = state.changes.slice(changeIdx + 1).filter(c => c.phase !== 'archived');

  let prompt = `## Goal Context

**Goal**: ${state.goalName}
**Description**: ${state.goalDescription}
**Goal Doc**: \`${goalDoc}\`
**⚠️ 必须先读 goal.md 全文**：goal.md 不只是验收标准——它承载了目标 / 宏观架构 / 设计规范 / 测试维度 / 参考资料 / 验收标准。你是 fresh context，对话里用户给过主 agent 的资料（GitHub / 图片 / 网址 / 风格参考）只落盘在 goal.md 里，不会出现在你的上下文。只读验收标准会丢失设计意图和参考资料，导致目标偏移。开始任何工作前，完整读一遍 goal.md。

## All Changes in This Goal

${allChanges.map(c => `- [${c.phase}] ${c.id}: ${c.title}${c.type !== 'normal' ? ` (${c.type})` : ''}`).join('\n')}

## Change to Apply

- **ID**: ${change.id}
- **Title**: ${change.title}
- **OpenSpec change name**: ${change.openspecChangeName}
- **Path**: \`${changePath || '未找到'}\`

## Remaining After This Change

${remaining.length > 0
    ? remaining.map(c => `- ${c.id}: ${c.title}`).join('\n')
    : '（这是最后一个 change）'}

${ARCHIVE_MANDATORY_NOTE}

## Prerequisite: Follow OpenSpec Apply-Change Workflow

**Before starting**, read and follow the \`openspec-apply-change\` skill in your project's skills directory (e.g., \`.claude/skills/openspec-apply-change/SKILL.md\`, \`.codex/skills/openspec-apply-change/SKILL.md\`, etc.). This skill defines the standard workflow for reading context files, implementing tasks, and marking them complete. You MUST follow it — goal orchestration wraps OpenSpec, it does not replace it.

**⚠️ 你现在处于 SDD(规范驱动开发)套件管理的工作状态,不是普通的自由发挥。** 不要按普通情况错把系统内置的 todo 工具当成你做 plan / 跟踪任务的工具——那会触发平台持续注入"维护内置 todo"的提示词,干扰你维护真正的任务源。在 OpenSpec 工作流下,你的任务列表就是这次提案的 \`tasks.md\`,这是 goal 编排判断 change 进度、推进状态的唯一依据。你必须去**维护 OpenSpec 的规范驱动开发系列文档**:做完一个任务就在 \`tasks.md\` 把 \`- [ ]\` 标成 \`- [x]\`,不要用内置 todo 工具替代这个动作。无视 \`tasks.md\`、只用内置 todo 会导致 change 卡住、goal 流程断掉。

**关于进度可见性**:如果你担心不用内置 todo 用户看不到进度,不必担心——你可以在**完成一个任务、开始下一个**时,向用户简短输出当前进度即可,例如:
\`\`\`
- [x] 2.2 运行 generate-storyboard.mjs 生成 storyboard.json(刚完成)
- [ ] 2.3 生成审阅报告 review-report.html (下一步)
\`\`\`
不必每个任务都输出——隔几个任务、或在关键节点输出一次即可。这种"输出刚完成 + 即将要做"的方式已足够给用户进度可见性,根本不需要内置 todo 的 UI。

## Your Task

1. Follow the \`openspec-apply-change\` skill workflow:
   - Run \`openspec status --change "${change.openspecChangeName}" --json\` to get context file paths
   - Run \`openspec instructions apply --change "${change.openspecChangeName}" --json\` to get apply instructions
   - Read all context files (proposal, design, specs, tasks) per the skill's guidance
   - Implement tasks sequentially, marking each complete: \`- [ ]\` → \`- [x]\`
2. The LAST task in tasks.md will instruct you to:
   - Run all tests and verify they pass
   - **Step 1: OpenSpec archive** — run \`openspec archive --change "${change.openspecChangeName}"\` to merge specs into \`openspec/specs/\` and move the change to archive/. Read and follow the \`openspec-archive-change\` skill in your project's skills directory (e.g., \`.claude/skills/openspec-archive-change/SKILL.md\`) for the full workflow.
   - **Step 2: Goal archive** — run \`os-stronger goal change archive --goal ${state.goalName} --id ${change.id}\` to update goal state and advance to the next change.
   - **Do NOT ask the user whether to archive.** In goal mode, the agent MUST archive without user confirmation. Both steps are mandatory.
3. If you encounter a genuine blocker (not a minor issue), report it clearly rather than guessing.

## Key Principle

Focus on THIS change. The orchestrator handles the big picture.
But read completed changes' artifacts for context when needed.

### ⚠️ Boundary: Apply Only

You are an APPLY sub-agent. Your job is to implement the tasks in tasks.md for THIS change only. 

**Do NOT:**
- Do NOT propose the next change. The orchestrator decides what's next.
- Do NOT spawn your own sub-agent to propose or apply.
- Do NOT start working on a different change.
- Do NOT run \`os-stronger goal instructions\` — that is the orchestrator's job.

**DO:**
- Implement all tasks in tasks.md for THIS change.
- Run tests.
- Archive (openspec archive → os-stronger goal change archive).
- Report back to the orchestrator: "Apply complete for change <id>." or "Test failed: <summary>".
- Stop. The orchestrator will dispatch the next sub-agent.
`;

  if (completedArtifacts.length > 0) {
    prompt += `
## 已完成 Change（按需读取）

${completedArtifacts.map(a => `- **${a.id}** (${a.title})\n  - proposal: \`${a.proposalPath || 'N/A'}\`\n  - design: \`${a.designPath || 'N/A'}\`\n  - specs: \`${a.specsDir || 'N/A'}\``).join('\n')}

**Before starting**, if your change depends on or interfaces with any completed change:
1. If the paths above are valid (not N/A), READ the design.md and relevant spec files directly.
2. If paths are N/A (workspace mode or archive directory not found), run \`openspec status --change "<completed-change-name>" --json\` to get the real file paths, then read them.
3. Do not assume APIs — verify them from the actual artifacts.
`;
  }

  if (change.type === 'test') {
    prompt += `
## ⚠️ Test Change Apply 提示 — 你是把关者，不是修复者

**🚫 铁律（最高优先级，凌驾于一切之上）：你只评估和测试，绝不修复产品代码。**

这是 test change（第 ${change.testCycle} 轮）。你的职责是**把关**——判断 goal 是否达标、测试是否通过。你是 fresh context 的独立审查者，前面所有 change 的实现你都没参与。

- **发现任何问题（语义评估不通过 / 测试失败）→ 只报告，不修。** 把问题找出来、写清失败报告（哪条未满足/哪个测试挂了/建议怎么修），然后返回失败给主 agent。
- **主 agent 才能创建 fix change**，由专门的 fix change 子 agent 去修。你跳过这一步直接修，会破坏 fix 流程、绕过熔断、还可能引入你没察觉的新问题（你 fresh context，对全局理解有限）。
- **"我顺手改两行应该没事"是错的。** 哪怕只改一行、哪怕看起来很简单的修复，都不允许。你的任务列表里没有"修代码"这一项——OpenSpec apply-change skill 默认会让你"实现任务"，但 test change 的任务是**评估 + 测试 + 报告**，不是实现。
- 你能写的只有：测试代码本身、tasks.md 的勾选标记、失败报告。**不要碰任何前序 change 产出的产品代码、specs、design。**

你的 tasks.md 包含两类任务：语义评估 + 测试用例。

### Task 1: 独立语义评估

**⚠️ 角色切换：你现在是独立评估者，不是实现者。**

前面所有 change 的实现你都没有参与（你是 fresh context）。在写任何测试代码之前，先以纯粹的外部审查视角评估 goal 是否达标。

步骤：
1. 读 goal.md 全文（目标 / 宏观架构 / 设计规范 / 测试维度 / 参考资料 / 验收标准），先理解整体设计意图
2. 对每条验收标准，按下述层次找证据（由弱到强）：
   - specs/ 是否覆盖该标准
   - tasks.md 是否标 \`[x]\`
   - 必要时直接读对应源码，确认实现真实存在且与设计一致
3. 若某条验收标准依赖宏观架构或设计规范（如“模块 X 和 Y 解耦”“API 风格一致”），也从产物里确认这些规范是否被落实，不只看验收标准字面
4. **不要因为"计划里写了"或"task 打了勾"就假设已满足**——产物/代码里要有具体证据
5. 输出判断：
   - **全部满足** → 标记 Task 1 \`[x]\`，继续 Task 2 开始写测试
   - **有未满足的** → 记录哪条未满足、为什么、建议主 agent 怎么修（**只是建议，不要你自己修**）。这是 test change 的失败报告，主 agent 会用它来创建 fix change。**不需要写后续测试，不要改任何产品代码**——直接返回失败。

语义评估不通过时的失败报告格式：
\`\`\`
语义评估不通过：
- [验收标准 X]: 未满足，原因：...，建议修复方向：...（由主 agent 派 fix change 修，不是你修）
- [验收标准 Y]: 未满足，原因：...，建议修复方向：...（由主 agent 派 fix change 修，不是你修）
\`\`\`

### Task 2 ~ Task N-1: 测试用例

- 语义评估通过后，按照 tasks.md 中的测试用例逐个**写测试代码**并运行
- 你只写测试代码，**不碰产品代码**。测试挂了说明产品代码有问题，但修产品代码不是你的活——那是主 agent 派 fix change 去修的
- 如果测试失败，**🚫 不要自己改产品代码去让测试过**。报告失败信息给主 agent，让它创建 fix change。"改两行让测试过"是最坏的做法——你 fresh context，不知道这个改动会不会破坏别的地方，而且这绕过了整个 fix→熔断流程

测试失败时的失败报告格式：
\`\`\`
测试失败：
- [测试名]: 错误信息：...，涉及模块：...，建议修复方向：...（由主 agent 派 fix change 修，不是你修）
\`\`\`

### Task N: 运行全部测试 + Archive

- 测试全部通过后，执行 archive（openspec archive → os-stronger goal change archive）

### 失败报告总结

无论失败来自语义评估还是测试，返回给主 agent 的报告都应包含：
- 失败类型：语义评估不通过 / 测试失败
- 具体信息：未满足的标准或失败的测试
- 建议修复方向

主 agent 会用这个报告调用 \`os-stronger goal test-failed\`，进入 fix 流程。
`;
  }

  return prompt;
}

// ─── 核心：生成 instructions ───

function getInstructions(projectDir, goalName) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const progress = getProgress(state);
  const completedArtifacts = getCompletedArtifacts(projectDir, state);

  const baseContext = {
    goalName: state.goalName,
    goalDescription: state.goalDescription,
    goalDocPath: goalDocPath(projectDir, state.goalName),
    progress,
    fixFlowActive: state.fixFlow.active,
    fixCycle: state.fixFlow.cycle,
    maxFixCycles: state.fixFlow.maxCycles,

    contextForSubagent: {
      goalDescription: state.goalDescription,
      goalDocPath: goalDocPath(projectDir, state.goalName),
      allChanges: getAllChangesOverview(state),
      completedChangeIds: state.changes.filter(c => c.phase === 'archived').map(c => c.id),
      completedChangeArtifacts: completedArtifacts,
    },
  };

  // ─── 熔断检查 ───
  if (isCircuitBroken(state)) {
    return {
      ...baseContext,
      phase: 'circuit_broken',
      nextAction: {
        type: 'circuit_break',
        reason: `Fix-Test 循环已达上限（${state.fixFlow.maxCycles} 轮），testchange 仍然失败`,
        lastFailure: state.fixFlow.lastFixResult,
        instruction: [
          `通知用户：Goal "${state.goalName}" 在自动修复后仍未通过测试。需要人工介入。`,
          `向用户展示：`,
          `1. 失败的测试摘要: ${state.fixFlow.lastFixResult || 'N/A'}`,
          `2. 已尝试的 fix change 列表: ${state.changes.filter(c => c.type === 'fix').map(c => c.id).join(', ') || '无'}`,
          `3. 建议用户检查代码或调整 goal 描述`,
          `4. 用户修复后可运行: \`os-stronger goal resume --goal ${state.goalName}\``,
        ].join('\n'),
      },
    };
  }

  // ─── done 检查 ───
  const remainingChanges = state.changes.filter(c => c.phase !== 'archived');
  if (remainingChanges.length === 0 && state.status === 'complete') {
    return {
      ...baseContext,
      phase: 'done',
      nextAction: {
        type: 'done',
        instruction: [
          `通知用户：Goal "${state.goalName}" 已完成！所有 ${state.changes.length} 个 change 已归档。🎉`,
          `进度: ${progress}`,
          ``,
          `归档此 goal（可选，保持活跃 goal 列表干净）：`,
          `  os-stronger goal archive --goal ${state.goalName}`,
          `归档后 goal 数据移到 openspec-goals/archive/，不影响已合并的 specs。`,
        ].join('\n'),
      },
    };
  }

  // ─── 找下一个要操作的 change ───
  let nextChange;
  if (state.fixFlow.active) {
    nextChange = remainingChanges.find(c => !c.blockReason);
  } else {
    nextChange = remainingChanges[0];
  }
  if (!nextChange) {
    if (state.fixFlow.active) {
      return {
        ...baseContext,
        phase: 'fix_analysis_needed',
        nextAction: {
          type: 'fix_analysis_needed',
          failedTestChange: state.fixFlow.failedTestChange,
          failureSummary: state.fixFlow.lastFixResult,
          instruction: [
            `Test change "${state.fixFlow.failedTestChange}" 失败（第 ${state.fixFlow.cycle} 轮）。`,
            `起分析子 agent 前：先确认没有其他子 agent 还在跑（防重复派发）。`,
            `起分析子 agent（fresh context），给它：`,
            `1. goal.md 路径: ${goalDocPath(projectDir, state.goalName)}`,
            `2. 所有已完成 change 的路径（从 contextForSubagent.completedChangeArtifacts 获取）`,
            `3. 失败的 test change 的 tasks.md 路径`,
            `4. 失败摘要: ${state.fixFlow.lastFixResult || 'N/A'}`,
            `分析子 agent 输出（根据失败类型）：`,
            `- 语义评估不通过：哪条验收标准未满足、缺什么实现/要补什么 change`,
            `- 测试失败：哪个模块有 bug、每个模块修什么`,
            `分析子 agent 跑的时候**等它回报**，不要轮询。`,
            `**拆 fix change 的粒度原则（重要）**：`,
            `- 默认一个 fix change 装本轮所有小修——把多个独立的小问题写进同一个 fix change 的 tasks.md（几个 task），而不是每个问题各开一个 fix change。`,
            `- 只有当某个问题"大"到需要重构或独立设计时（整个模块要重写、架构要调整、耦合度高需单独隔离），才拆成单独的 fix change。`,
            `- 判断标准：这个修复用 1-2 个 task 能说清并改完吗？能 → 合进同一个 fix change。不能、需要重新 propose 设计 → 单独一个 fix change。`,
            `- ❌ 反模式：失败报告列了 3 条未满足项，就机械地开 3 个 fix change。除非每条都是大修，否则这是过度拆分——多个 fix change 意味着多次 propose→apply→archive 循环，上下文切换和 token 成本翻倍，且小修之间常有关联拆开反而易漏。`,
            `然后注册 fix change（必须 --type fix）：`,
            `  os-stronger goal change add --goal ${state.goalName} --id fixchange_${state.fixFlow.cycle} --title "..." --type fix`,
            `（id 用 fixchange_{cycle} 即可；只有真的拆成多个 fix change 时才加后缀 fixchange_{cycle}-<short-tag> 区分。）`,
            `注册后重新运行 os-stronger goal instructions --goal ${state.goalName} --json。`,
            `接下来 fix change 会走正常的 propose（openspec-propose skill）→ apply（openspec-apply-change skill）流程。`,
          ].join('\n'),
        },
      };
    }
    // 所有 change 都 archived——检查是否有 test change
    // 空 goal（0 个 change）直接返回 done
    const hasTestChange = state.changes.some(c => c.type === 'test');
    if (state.changes.length > 0 && !hasTestChange) {
      return {
        ...baseContext,
        phase: 'missing_test',
        nextAction: {
          type: 'missing_test',
          instruction: [
            `⚠️ Goal "${state.goalName}" 的所有 change 已归档，但没有 test change。`,
            `goal 的设计要求最后一个 change 必须是 test change（--type test），用于验证整个 goal 是否达标。`,
            `当前状态：跳过了整体验收。`,
            ``,
            `建议：`,
            `1. 如果 goal 已经完成且不需要验收：手动确认完成即可。`,
            `2. 如果需要验收：添加一个 test change，然后继续 loop。`,
            `   os-stronger goal change add --goal ${state.goalName} --id testchange_1 --title "Goal 级测试" --type test`,
            `   os-stronger goal instructions --goal ${state.goalName} --json`,
          ].join('\n'),
        },
      };
    }
    return {
      ...baseContext,
      phase: 'done',
      nextAction: {
        type: 'done',
        instruction: [
          `通知用户：Goal "${state.goalName}" 已完成！🎉`,
          ``,
          `归档此 goal（可选）：`,
          `  os-stronger goal archive --goal ${state.goalName}`,
        ].join('\n'),
      },
    };
  }

  // ─── blocked 检查 ───
  if (nextChange.blockReason && nextChange.phase !== 'archived') {
    return {
      ...baseContext,
      phase: 'blocked',
      nextAction: {
        type: 'blocked',
        blockedChange: {
          id: nextChange.id,
          title: nextChange.title,
          reason: nextChange.blockReason,
        },
        instruction: `Change "${nextChange.id}" 受阻: ${nextChange.blockReason}\n向用户展示并等待处理。`,
      },
    };
  }

  // ─── propose_next ───
  if (nextChange.phase === 'skeleton') {
    const prompt = buildProposePrompt(projectDir, state, nextChange);
    // 动态编排提醒:当下一个要 propose 的是 testchange,且前面已有归档的 normal change,
    // 说明前置已完成、即将进入整体验收。这正是"追加中间 change"的窗口——提醒主 agent
    // 在 propose testchange 之前确认是否要先 add 中间 change(决策 14)。
    const hasArchivedNormal = state.changes.some(c => c.type === 'normal' && c.phase === 'archived');
    const dynamicHint = (nextChange.type === 'test' && hasArchivedNormal)
      ? [
          ``,
          `🔄 动态编排检查(决策 14):下一个要 propose 的是 testchange "${nextChange.id}"(整体验收)。`,
          `前面已有 normal change 归档。在 propose testchange 之前,先确认:`,
          `- 前置 change 的产物是否揭示了还需要新的中间 change?如果有,现在用 \`os-stronger goal change add\` 追加(会自动插到此 testchange 之前),追加后重新运行 instructions。\`change add\` 必须在 propose testchange 之前做——一旦 propose 了 testchange,它就成了当前任务。`,
          `- 如果确实没有中间 change 要补了,直接 propose testchange。`,
          `这条只是提醒,不是阻塞——如果你已确认中间 change 都注册完了,忽略此提示继续。`,
        ]
      : [];
    return {
      ...baseContext,
      phase: 'proposing',
      nextAction: {
        type: 'propose_next',
        changeToPropose: {
          id: nextChange.id,
          title: nextChange.title,
          openspecChangeName: nextChange.openspecChangeName,
          type: nextChange.type,
          testCycle: nextChange.testCycle || undefined,
        },
        subagentPrompt: prompt,
        instruction: [
          `⚠️ 串行执行（两阶段，都要遵守）：`,
          `- 派之前：先确认没有其他子 agent 还在跑。如果之前派了一个还没收到回报，**等它返回再派下一个**——两个子 agent 同时操作同一个 change 会冲突。`,
          `- 派之后：起子 agent（fresh context），传入 subagentPrompt，然后**等它回报**——不要检查它在做什么、不要轮询进度、不要跑 os-stronger goal status 看完了没。子 agent 读 specs / 写代码 / 跑测试本来就需要时间，轮询只浪费 token。它返回报告后你才行动。`,
          `子 agent 会按照 openspec-propose skill 的工作流创建 proposal.md、design.md、tasks.md。`,
          `子 agent 返回后，运行:`,
          `  os-stronger goal change propose --goal ${state.goalName} --id ${nextChange.id}`,
          `然后重新运行 os-stronger goal instructions --goal ${state.goalName} --json 获取下一步。`,
          `注意：goal 模式下 archive 是自主的、强制的——子 agent 完成任务后必须直接 archive，不等用户确认。`,
          ...dynamicHint,
        ].join('\n'),
      },
    };
  }

  // ─── apply_next ───
  if (nextChange.phase === 'proposed') {
    const prompt = buildApplyPrompt(projectDir, state, nextChange);
    const changePath = getChangePath(projectDir, nextChange);

    return {
      ...baseContext,
      phase: 'applying',
      nextAction: {
        type: 'apply_next',
        changeToApply: {
          id: nextChange.id,
          title: nextChange.title,
          openspecChangeName: nextChange.openspecChangeName,
          type: nextChange.type,
          testCycle: nextChange.testCycle || undefined,
          changePath,
        },
        remaining: remainingChanges.slice(1).map(c => ({
          id: c.id,
          title: c.title,
          type: c.type,
        })),
        subagentPrompt: prompt,
        instruction: [
          `⚠️ 串行执行（两阶段，都要遵守）：`,
          `- 派之前：先确认没有其他子 agent 还在跑。如果之前派了一个还没收到回报，**等它返回再派下一个**——两个子 agent 同时操作同一个 change 会冲突。`,
          `- 派之后：起子 agent（fresh context），传入 subagentPrompt，然后**等它回报**——不要检查它在做什么、不要轮询进度、不要跑 os-stronger goal status 看完了没。它返回报告后你才行动。`,
          `子 agent 会按照 openspec-apply-change skill 的工作流读取上下文、实现 tasks、跑测试，并自主完成 change 归档（openspec archive → os-stronger goal change archive）。`,
          `子 agent 返回后，重新运行 os-stronger goal instructions --goal ${state.goalName} --json 获取下一步。`,
          `注意：change 归档是子 agent 的活，主 agent 不碰归档——子 agent 实现+测试+归档全包，返回后你只需重跑 instructions。goal 归档（整个 goal 完成）才轮到用户决定，不在此阶段。`,
          `如果子 agent 报告失败（语义评估不通过 或 测试失败），运行:`,
          `  os-stronger goal test-failed --goal ${state.goalName} --test-change ${nextChange.id} --summary "失败摘要"`,
          `摘要须含失败类型（语义评估不通过/测试失败）+ 具体信息 + 建议修复方向。`,
        ].join('\n'),
      },
    };
  }

  return {
    ...baseContext,
    phase: 'unknown',
    nextAction: {
      type: 'unknown',
      instruction: `状态异常。检查 state.json: change ${nextChange.id} phase=${nextChange.phase}`,
    },
  };
}

module.exports = {
  getInstructions,
  getCompletedArtifacts,
  getChangePath,
  buildProposePrompt,
  buildApplyPrompt,
};
