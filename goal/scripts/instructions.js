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
   **Task ordering**: If the \`review\` enhancement is enabled (openspec-propose skill was patched to add a Review task), the Review task comes BEFORE the archive task. The archive task is always the absolute last task. Order: implementation tasks → Review task (if present) → archive task.
4. After proposing, report back.
`;

  // test change 特殊提示
  if (change.type === 'test') {
    prompt += `
## ⚠️ Test Change 提示

这是 test change（第 ${change.testCycle} 轮）。在 propose 之前：
1. **必须读** goal doc: \`${goalDoc}\`（验收标准）
2. **必须读**所有已完成 change 的 design.md 和 specs
3. 你的 tasks.md 应该包含覆盖所有验收标准的测试用例
4. 最后一个 task 是跑全部测试 + 调用 CLI 归档

测试范围：
- 验收标准中的每一项都要有测试
- 重点关注 change 之间的接口和集成点
- 这是 goal 级别的集成/验收测试，不是单元测试
`;

    if (change.testCycle > 1 && change.basedOn) {
      const fixChanges = state.changes.filter(c => c.type === 'fix');
      prompt += `
## ⚠️ Test Change 第 ${change.testCycle} 轮

上一轮 ${change.basedOn} 失败。已通过以下 fix change 修复：
${fixChanges.map(f => `- ${f.id}: ${f.title}`).join('\n') || '（无）'}

你的测试应该：
1. 覆盖 ${change.basedOn} 的所有测试用例（读其 tasks.md）
2. 针对上述 fix 内容增加回归测试
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

## Your Task

1. Follow the \`openspec-apply-change\` skill workflow:
   - Run \`openspec status --change "${change.openspecChangeName}" --json\` to get context file paths
   - Run \`openspec instructions apply --change "${change.openspecChangeName}" --json\` to get apply instructions
   - Read all context files (proposal, design, specs, tasks) per the skill's guidance
   - Implement tasks sequentially, marking each complete: \`- [ ]\` → \`- [x]\`
2. The LAST task in tasks.md will instruct you to:
   - Run all tests and verify they pass
   - **Step 1: OpenSpec archive** — run \`openspec archive --change "${change.openspecChangeName}"\` to merge specs into \`openspec/specs/\` and move the change to archive/. Read and follow the \`openspec-archive\` skill in your project's skills directory (e.g., \`.claude/skills/openspec-archive/SKILL.md\`) for the full workflow.
   - **Step 2: Goal archive** — run \`os-stronger goal change archive --goal ${state.goalName} --id ${change.id}\` to update goal state and advance to the next change.
   - **Do NOT ask the user whether to archive.** In goal mode, the agent MUST archive without user confirmation. Both steps are mandatory.
3. If you encounter a genuine blocker (not a minor issue), report it clearly rather than guessing.

## Key Principle

Focus on THIS change. The orchestrator handles the big picture.
But read completed changes' artifacts for context when needed.
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
## ⚠️ Test Change Apply 提示

这是 test change（第 ${change.testCycle} 轮）。
- 按照 tasks.md 中的测试用例逐个实现并运行
- 如果测试失败，**不要自己修代码**，报告失败信息给主 agent
- 失败报告格式：列出失败的测试名 + 错误信息 + 涉及的模块
- 主 agent 会启动 fix 流程
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
        instruction: `通知用户：Goal "${state.goalName}" 已完成！所有 ${state.changes.length} 个 change 已归档。🎉\n进度: ${progress}`,
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
            `起分析子 agent（fresh context），给它：`,
            `1. goal.md 路径: ${goalDocPath(projectDir, state.goalName)}`,
            `2. 所有已完成 change 的路径（从 contextForSubagent.completedChangeArtifacts 获取）`,
            `3. 失败的 test change 的 tasks.md 路径`,
            `4. 失败摘要: ${state.fixFlow.lastFixResult || 'N/A'}`,
            `分析子 agent 输出：需要修哪些模块、每个模块修什么。`,
            `然后注册 fix change（必须 --type fix）：`,
            `  os-stronger goal change add --goal ${state.goalName} --id fixchange_${state.fixFlow.cycle}-<module> --title "..." --type fix`,
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
        instruction: `通知用户：Goal "${state.goalName}" 已完成！🎉`,
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
          `起子 agent（fresh context），传入 subagentPrompt 作为任务。`,
          `子 agent 会按照 openspec-propose skill 的工作流创建 proposal.md、design.md、tasks.md。`,
          `子 agent 返回后，运行:`,
          `  os-stronger goal change propose --goal ${state.goalName} --id ${nextChange.id}`,
          `然后重新运行 os-stronger goal instructions --goal ${state.goalName} --json 获取下一步。`,
          `注意：goal 模式下 archive 是自主的、强制的——子 agent 完成任务后必须直接 archive，不等用户确认。`,
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
          `起子 agent（fresh context），传入 subagentPrompt 作为任务。`,
          `子 agent 会按照 openspec-apply-change skill 的工作流读取上下文、实现 tasks、跑测试，`,
          `然后按照 openspec-archive 惯例自主归档（调用 os-stronger goal change archive）。`,
          `子 agent 返回后，重新运行 os-stronger goal instructions --goal ${state.goalName} --json 获取下一步。`,
          `注意：goal 模式下 archive 是自主的、强制的——子 agent 完成任务后必须直接 archive，不等用户确认。`,
          `如果子 agent 报告测试失败（test change），运行:`,
          `  os-stronger goal test-failed --goal ${state.goalName} --test-change ${nextChange.id} --summary "失败摘要"`,
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
