// goal/state.js
// state.json 读写 + 状态机管理。纯 Node.js，零依赖。

const fs = require('fs');
const path = require('path');

// ─── 常量 ───

const GOALS_DIR = 'openspec-goals';

const CHANGE_TYPES = ['normal', 'test', 'fix'];
const CHANGE_PHASES = ['skeleton', 'proposed', 'archived'];

const DEFAULT_MAX_FIX_CYCLES = 3;

// ─── 工具函数 ───

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function goalDir(projectDir, goalName) {
  return path.join(projectDir, GOALS_DIR, `goal_${goalName}`);
}

function statePath(projectDir, goalName) {
  return path.join(goalDir(projectDir, goalName), 'state.json');
}

function goalDocPath(projectDir, goalName) {
  return path.join(goalDir(projectDir, goalName), 'goal.md');
}

function changesYamlPath(projectDir, goalName) {
  return path.join(goalDir(projectDir, goalName), 'changes.yaml');
}

// ─── State 读写 ───

function loadState(projectDir, goalName) {
  const p = statePath(projectDir, goalName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`无法解析 state.json: ${e.message}`);
  }
}

function saveState(projectDir, goalName, state) {
  const dir = goalDir(projectDir, goalName);
  ensureDir(dir);
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(statePath(projectDir, goalName), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ─── Goal 创建 ───

function createGoal(projectDir, goalName, description, options = {}) {
  const dir = goalDir(projectDir, goalName);
  if (fs.existsSync(dir)) {
    throw new Error(`Goal "${goalName}" 已存在: ${dir}`);
  }
  ensureDir(dir);

  const now = new Date().toISOString();
  const state = {
    version: 1,
    goalName,
    goalDescription: description,
    goalDocPath: `${GOALS_DIR}/goal_${goalName}/goal.md`,
    status: 'in-progress',
    createdAt: now,
    updatedAt: now,

    settings: {
      maxFixCycles: options.maxFixCycles || DEFAULT_MAX_FIX_CYCLES,
    },

    changes: [],
    fixFlow: {
      active: false,
      cycle: 0,
      maxCycles: options.maxFixCycles || DEFAULT_MAX_FIX_CYCLES,
      failedTestChange: null,
      pendingFixChanges: [],
      lastFixResult: null,
    },
  };

  saveState(projectDir, goalName, state);

  // 创建空的 goal.md 模板
  const goalMd = `# Goal: ${goalName}\n\n## 目标\n\n${description}\n\n## 验收标准\n\n<!-- 在此列出可验证的验收标准 -->\n- [ ] \n`;
  fs.writeFileSync(goalDocPath(projectDir, goalName), goalMd, 'utf8');

  return state;
}

// ─── Change 管理 ───

function addChange(projectDir, goalName, changeOpts) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const { id, title, type = 'normal', testCycle, basedOn, dependsOn } = changeOpts;
  if (!id || !title) throw new Error('id 和 title 必填');

  // 检查 id 唯一
  if (state.changes.some(c => c.id === id)) {
    throw new Error(`Change id "${id}" 已存在`);
  }

  const change = {
    id,
    title,
    type,
    phase: 'skeleton',
    openspecChangeName: `${goalName}-${id}`,
    batchIndex: null, // batch 概念已去除，保留字段兼容
    proposedAt: null,
    archivedAt: null,
    blockReason: null,
  };

  if (type === 'test') {
    change.testCycle = testCycle || 1;
    change.basedOn = basedOn || null;
  }

  if (dependsOn) {
    change.dependsOn = dependsOn;
  }

  if (type === 'fix') {
    // fix change 加入 pendingFixChanges
    if (!state.fixFlow.pendingFixChanges) state.fixFlow.pendingFixChanges = [];
    state.fixFlow.pendingFixChanges.push(id);
  }

  // 防御性检查：fixFlow 处于活跃状态时，新注册的 change 必须是 fix 类型
  if (state.fixFlow.active && type !== 'fix') {
    throw new Error(
      `fixFlow 当前处于活跃状态（等待 fix change），但新 change "${id}" 的类型是 "${type}" 而非 "fix"。` +
      `\n在 fix 流程中注册的 change 必须使用 --type fix，否则归档时不会触发 fixFlow 清理逻辑，导致 goal 卡死。`
    );
  }

  state.changes.push(change);
  saveState(projectDir, goalName, state);
  return change;
}

function markProposed(projectDir, goalName, changeId) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const change = state.changes.find(c => c.id === changeId);
  if (!change) throw new Error(`Change "${changeId}" 不存在`);
  if (change.phase !== 'skeleton') return change;

  change.phase = 'proposed';
  change.proposedAt = new Date().toISOString();
  saveState(projectDir, goalName, state);
  return change;
}

// ─── 内部：各类型 change 的 archive 后处理 ───

function archiveFixChange(state, change, goalName) {
  // 从 pendingFixChanges 移除
  if (state.fixFlow.pendingFixChanges) {
    state.fixFlow.pendingFixChanges = state.fixFlow.pendingFixChanges.filter(id => id !== change.id);
  }

  // 所有 fix change 都 archived 了，自动插入下一个 testchange
  if (state.fixFlow.pendingFixChanges.length === 0 && state.fixFlow.active) {
    const lastTestChange = state.changes
      .filter(c => c.type === 'test')
      .sort((a, b) => (b.testCycle || 0) - (a.testCycle || 0))[0];
    const nextCycle = (lastTestChange?.testCycle || 0) + 1;
    const nextTestId = `testchange_${nextCycle}`;

    state.changes.push({
      id: nextTestId,
      title: `Goal 级测试（第${nextCycle}轮）`,
      type: 'test',
      phase: 'skeleton',
      openspecChangeName: `${goalName}-${nextTestId}`,
      proposedAt: null,
      archivedAt: null,
      blockReason: null,
      testCycle: nextCycle,
      basedOn: lastTestChange?.id || null,
    });
  }
}

function archiveTestChange(state) {
  // 归档所有之前失败的 test change（它们有 blockReason 或 phase 不是 archived）
  for (const c of state.changes) {
    if (c.type === 'test' && c.phase !== 'archived') {
      c.phase = 'archived';
      c.archivedAt = new Date().toISOString();
      c.blockReason = null;
    }
  }
  // 重置 fixFlow——test 通过了，fix 流程结束
  state.fixFlow.active = false;
  state.fixFlow.cycle = 0;
  state.fixFlow.failedTestChange = null;
  state.fixFlow.pendingFixChanges = [];
  state.fixFlow.lastFixResult = null;
  // 检查是否完成
  const remaining = state.changes.filter(c => c.phase !== 'archived');
  if (remaining.length === 0) {
    state.status = 'complete';
  }
}

function markArchived(projectDir, goalName, changeId) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const change = state.changes.find(c => c.id === changeId);
  if (!change) throw new Error(`Change "${changeId}" 不存在`);
  if (change.phase !== 'proposed') return change;

  // 阻止对失败的 test change 调 archive（防止假通过）
  if (change.type === 'test' && change.blockReason) {
    throw new Error(
      `Test change "${changeId}" 已标记失败（${change.blockReason}）。\n` +
      `在 goal 模式下，失败的 test change 应通过 'os-stronger goal test-failed' 处理，不能直接 archive。\n` +
      `若测试实际已通过（误报），请先 resume 再重跑。`
    );
  }

  change.phase = 'archived';
  change.archivedAt = new Date().toISOString();

  // 按类型分发后处理
  if (change.type === 'fix') {
    archiveFixChange(state, change, goalName);
  } else if (change.type === 'test') {
    archiveTestChange(state);
  }
  // normal change 无额外后处理

  saveState(projectDir, goalName, state);
  return change;
}

// ─── Block / Unblock ───

function blockChange(projectDir, goalName, changeId, reason) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const change = state.changes.find(c => c.id === changeId);
  if (!change) throw new Error(`Change "${changeId}" 不存在`);

  change.blockReason = reason || '';
  saveState(projectDir, goalName, state);
  return change;
}

function unblockChange(projectDir, goalName, changeId) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const change = state.changes.find(c => c.id === changeId);
  if (!change) throw new Error(`Change "${changeId}" 不存在`);

  change.blockReason = null;
  saveState(projectDir, goalName, state);
  return change;
}

// ─── Fix Flow ───

function testFailed(projectDir, goalName, testChangeId, summary) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  const testChange = state.changes.find(c => c.id === testChangeId);
  if (!testChange || testChange.type !== 'test') {
    throw new Error(`"${testChangeId}" 不是 test change`);
  }

  // 防重复调用：如果 test change 已经有 blockReason（已经标记失败过），拒绝重复 testFailed
  if (testChange.blockReason) {
    throw new Error(`"${testChangeId}" 已经标记为失败（${testChange.blockReason}）。不能重复调用 test-failed——先做 fix 再跑下一轮 test。`);
  }

  // 熔断检查
  state.fixFlow.cycle++;
  if (state.fixFlow.cycle > state.fixFlow.maxCycles) {
    state.fixFlow.active = true;
    state.fixFlow.failedTestChange = testChangeId;
    state.fixFlow.lastFixResult = summary;
    saveState(projectDir, goalName, state);
    return { circuitBreak: true, cycle: state.fixFlow.cycle, maxCycles: state.fixFlow.maxCycles };
  }

  state.fixFlow.active = true;
  state.fixFlow.failedTestChange = testChangeId;
  state.fixFlow.lastFixResult = summary;
  state.fixFlow.pendingFixChanges = []; // 待分析子 agent 确定后 addChange

  // 标记 test change 为 blocked（不归档）
  testChange.blockReason = `测试失败（第${testChange.testCycle}轮）: ${summary}`;

  saveState(projectDir, goalName, state);
  return { circuitBreak: false, cycle: state.fixFlow.cycle, maxCycles: state.fixFlow.maxCycles };
}

function resumeGoal(projectDir, goalName) {
  const state = loadState(projectDir, goalName);
  if (!state) throw new Error(`Goal "${goalName}" 不存在`);

  // 重置 fixFlow
  state.fixFlow.active = false;
  state.fixFlow.cycle = 0;
  state.fixFlow.failedTestChange = null;
  state.fixFlow.pendingFixChanges = [];
  state.fixFlow.lastFixResult = null;
  state.status = 'in-progress';

  // 插入一个新的 testchange
  const lastTestChange = state.changes
    .filter(c => c.type === 'test')
    .sort((a, b) => (b.testCycle || 0) - (a.testCycle || 0))[0];
  const nextCycle = (lastTestChange?.testCycle || 0) + 1;
  const nextTestId = `testchange_${nextCycle}`;

  // 清除所有 test change 的 blockReason，并标记为 archived（失败的 test change 不再阻塞）
  for (const c of state.changes) {
    if (c.type === 'test' && c.phase !== 'archived') {
      c.blockReason = null;
      c.phase = 'archived';
      c.archivedAt = new Date().toISOString();
    }
  }

  state.changes.push({
    id: nextTestId,
    title: `Goal 级测试（第${nextCycle}轮，恢复后）`,
    type: 'test',
    phase: 'skeleton',
    openspecChangeName: `${goalName}-${nextTestId}`,
    proposedAt: null,
    archivedAt: null,
    blockReason: null,
    testCycle: nextCycle,
    basedOn: lastTestChange?.id || null,
  });

  saveState(projectDir, goalName, state);
  return state;
}

function isCircuitBroken(state) {
  return state.fixFlow.cycle > state.fixFlow.maxCycles;
}

// ─── 查询 ───

function listGoals(projectDir, includeArchived) {
  const goalsRoot = path.join(projectDir, GOALS_DIR);
  if (!fs.existsSync(goalsRoot)) return [];

  const goals = [];
  for (const entry of fs.readdirSync(goalsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('goal_')) continue;
    const goalName = entry.name.slice(5); // 去掉 "goal_" 前缀
    const state = loadState(projectDir, goalName);
    if (state) {
      goals.push({
        goalName,
        status: state.status,
        createdAt: state.createdAt,
        updatedAt: state.updatedAt,
        changesTotal: state.changes.length,
        changesArchived: state.changes.filter(c => c.phase === 'archived').length,
      });
    }
  }
  return goals;
}

function getProgress(state) {
  const total = state.changes.length;
  const archived = state.changes.filter(c => c.phase === 'archived').length;
  return `${archived}/${total} changes done`;
}

// ─── Delete ───

function deleteGoal(projectDir, goalName) {
  const dir = goalDir(projectDir, goalName);
  if (!fs.existsSync(dir)) {
    return false; // 不存在视为已删除
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function archiveGoal(projectDir, goalName) {
  const dir = goalDir(projectDir, goalName);
  if (!fs.existsSync(dir)) {
    throw new Error(`Goal "${goalName}" 不存在`);
  }

  // 移动到 archive 目录
  const archiveDir = path.join(projectDir, GOALS_DIR, 'archive');
  ensureDir(archiveDir);
  const destDir = path.join(archiveDir, `goal_${goalName}`);
  if (fs.existsSync(destDir)) {
    throw new Error(`归档目标已存在: ${destDir}`);
  }
  fs.renameSync(dir, destDir);

  // 更新新位置的状态文件（先 rename 再改状态，防错误路径状态不一致）
  const destStatePath = path.join(destDir, 'state.json');
  if (fs.existsSync(destStatePath)) {
    const state = JSON.parse(fs.readFileSync(destStatePath, 'utf-8'));
    state.status = 'archived';
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(destStatePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  return true;
}

// ─── 导出 ───

module.exports = {
  GOALS_DIR,
  DEFAULT_MAX_FIX_CYCLES,
  goalDir,
  statePath,
  goalDocPath,
  loadState,
  saveState,
  createGoal,
  addChange,
  markProposed,
  markArchived,
  blockChange,
  unblockChange,
  testFailed,
  resumeGoal,
  isCircuitBroken,
  listGoals,
  deleteGoal,
  archiveGoal,
  getProgress,
};
