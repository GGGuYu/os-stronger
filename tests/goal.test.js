// tests/goal.test.js
// goal 增强的基础单元测试 — state.js 和 instructions.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const state = require('../goal/scripts/state');
const { getInstructions } = require('../goal/scripts/instructions');

// ─── 测试工具 ───

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-goal-test-'));
  // 创建假的 openspec 目录结构
  fs.mkdirSync(path.join(tmpDir, 'openspec', 'changes'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'openspec', 'specs'), { recursive: true });
}

function teardown() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runTest(name, fn) {
  setup();
  try {
    fn();
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    console.log('  \x1b[31m✗\x1b[0m ' + name);
    console.log('    ' + e.message);
    console.log(e.stack);
    process.exitCode = 1;
  } finally {
    teardown();
  }
}

// ─── 测试 ───

console.log('\n  goal/state.js tests\n');

runTest('createGoal 创建 goal 目录和文件', () => {
  const s = state.createGoal(tmpDir, 'test-goal', '测试目标');
  assert.ok(fs.existsSync(state.goalDir(tmpDir, 'test-goal')));
  assert.ok(fs.existsSync(state.statePath(tmpDir, 'test-goal')));
  assert.ok(fs.existsSync(state.goalDocPath(tmpDir, 'test-goal')));
  assert.strictEqual(s.goalName, 'test-goal');
  assert.strictEqual(s.status, 'in-progress');
  assert.deepStrictEqual(s.changes, []);
  // 决策 13: goal.md 是设计意图 + 资料中心,模板含六段章节
  const goalMd = fs.readFileSync(state.goalDocPath(tmpDir, 'test-goal'), 'utf8');
  assert.ok(goalMd.includes('## 目标'), 'goal.md 应含 ## 目标');
  assert.ok(goalMd.includes('## 宏观架构'), 'goal.md 应含 ## 宏观架构(决策 13)');
  assert.ok(goalMd.includes('## 设计规范'), 'goal.md 应含 ## 设计规范(决策 13)');
  assert.ok(goalMd.includes('## 测试维度'), 'goal.md 应含 ## 测试维度(决策 13)');
  assert.ok(goalMd.includes('## 参考资料'), 'goal.md 应含 ## 参考资料(决策 13)');
  assert.ok(goalMd.includes('## 验收标准'), 'goal.md 应含 ## 验收标准');
});

runTest('createGoal 不允许重复创建', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  assert.throws(() => state.createGoal(tmpDir, 'test-goal', '重复'), /已存在/);
});

runTest('addChange 添加 normal change', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  const c = state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端', type: 'normal' });
  assert.strictEqual(c.id, 'backend');
  assert.strictEqual(c.phase, 'skeleton');
  assert.strictEqual(c.type, 'normal');
  assert.strictEqual(c.openspecChangeName, 'test-goal-backend');
});

runTest('addChange 添加 test change', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  const c = state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  assert.strictEqual(c.type, 'test');
  assert.strictEqual(c.testCycle, 1);
});

runTest('addChange 不允许重复 id', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  assert.throws(() => state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '重复' }), /已存在/);
});

runTest('addChange 智能默认:normal change 插到未归档 testchange 之前', () => {
  state.createGoal(tmpDir, 'dyn-goal', '动态编排测试');
  state.addChange(tmpDir, 'dyn-goal', { id: 'change1', title: '前置' });
  state.addChange(tmpDir, 'dyn-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  // change1 归档后,主 agent 追加 change2 —— 应自动插到 testchange_1 之前
  state.markProposed(tmpDir, 'dyn-goal', 'change1');
  state.markArchived(tmpDir, 'dyn-goal', 'change1');
  state.addChange(tmpDir, 'dyn-goal', { id: 'change2', title: '后续' });

  const st = state.loadState(tmpDir, 'dyn-goal');
  const ids = st.changes.map(c => c.id);
  assert.deepStrictEqual(ids, ['change1', 'change2', 'testchange_1'], 'change2 应插在 testchange_1 之前');
});

runTest('addChange --before:显式插在指定 change 之前', () => {
  state.createGoal(tmpDir, 'before-goal', 'before 测试');
  state.addChange(tmpDir, 'before-goal', { id: 'change1', title: '一' });
  state.addChange(tmpDir, 'before-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  // 显式 --before testchange_1,插多个 change
  state.addChange(tmpDir, 'before-goal', { id: 'change2', title: '二', before: 'testchange_1' });
  state.addChange(tmpDir, 'before-goal', { id: 'change3', title: '三', before: 'testchange_1' });

  const st = state.loadState(tmpDir, 'before-goal');
  const ids = st.changes.map(c => c.id);
  // change2, change3 都插在 testchange_1 之前,且按插入顺序排列
  assert.deepStrictEqual(ids, ['change1', 'change2', 'change3', 'testchange_1']);
});

runTest('addChange --before 锚点已归档时报错', () => {
  state.createGoal(tmpDir, 'arch-goal', '归档锚点测试');
  state.addChange(tmpDir, 'arch-goal', { id: 'change1', title: '一' });
  state.addChange(tmpDir, 'arch-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'arch-goal', 'change1');
  state.markArchived(tmpDir, 'arch-goal', 'change1');
  // change1 已归档,不能作 --before 锚点
  assert.throws(
    () => state.addChange(tmpDir, 'arch-goal', { id: 'change2', title: '二', before: 'change1' }),
    /已归档/
  );
});

runTest('addChange 无 testchange 时 normal change push 末尾(兼容旧行为)', () => {
  state.createGoal(tmpDir, 'no-test-goal', '无 test 测试');
  state.addChange(tmpDir, 'no-test-goal', { id: 'change1', title: '一' });
  state.addChange(tmpDir, 'no-test-goal', { id: 'change2', title: '二' });

  const st = state.loadState(tmpDir, 'no-test-goal');
  const ids = st.changes.map(c => c.id);
  assert.deepStrictEqual(ids, ['change1', 'change2'], '无 testchange 时应 push 末尾');
});

runTest('deleteChange:可删 skeleton 阶段 change', () => {
  state.createGoal(tmpDir, 'del-goal', '删除测试');
  state.addChange(tmpDir, 'del-goal', { id: 'c1', title: '一' });
  state.addChange(tmpDir, 'del-goal', { id: 'c2', title: '二' });
  state.addChange(tmpDir, 'del-goal', { id: 'tc1', title: '测', type: 'test', testCycle: 1 });

  // 删中间的 c2(还是 skeleton)
  assert.ok(state.deleteChange(tmpDir, 'del-goal', 'c2'));

  const st = state.loadState(tmpDir, 'del-goal');
  assert.deepStrictEqual(st.changes.map(c => c.id), ['c1', 'tc1'], '删后应剩 c1, tc1');
});

runTest('deleteChange:proposed 阶段拒绝删除', () => {
  state.createGoal(tmpDir, 'del-prop', 'proposed 拒删');
  state.addChange(tmpDir, 'del-prop', { id: 'c1', title: '一' });
  state.markProposed(tmpDir, 'del-prop', 'c1');

  assert.throws(
    () => state.deleteChange(tmpDir, 'del-prop', 'c1'),
    /proposed.*不能删除|不能删除.*proposed/,
  );
  const st = state.loadState(tmpDir, 'del-prop');
  assert.ok(st.changes.some(c => c.id === 'c1'), 'c1 应仍在(proposed 不可删)');
});

runTest('deleteChange:archived 阶段拒绝删除', () => {
  state.createGoal(tmpDir, 'del-arch', 'archived 拒删');
  state.addChange(tmpDir, 'del-arch', { id: 'c1', title: '一' });
  state.markProposed(tmpDir, 'del-arch', 'c1');
  state.markArchived(tmpDir, 'del-arch', 'c1');

  assert.throws(
    () => state.deleteChange(tmpDir, 'del-arch', 'c1'),
    /archived.*不能删除|不能删除.*archived/,
  );
});

runTest('deleteChange:不存在的 change 报错', () => {
  state.createGoal(tmpDir, 'del-missing', '不存在');
  state.addChange(tmpDir, 'del-missing', { id: 'c1', title: '一' });

  assert.throws(
    () => state.deleteChange(tmpDir, 'del-missing', 'nope'),
    /不存在/,
  );
});

runTest('markProposed 更改 phase', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  const c = state.markProposed(tmpDir, 'test-goal', 'backend');
  assert.strictEqual(c.phase, 'proposed');
  assert.ok(c.proposedAt);
});

runTest('markArchived 更改 phase 并标记完成时间', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  const c = state.markArchived(tmpDir, 'test-goal', 'backend');
  assert.strictEqual(c.phase, 'archived');
  assert.ok(c.archivedAt);
});

runTest('listGoals 列出所有 goal', () => {
  state.createGoal(tmpDir, 'goal-a', 'A');
  state.createGoal(tmpDir, 'goal-b', 'B');
  const goals = state.listGoals(tmpDir);
  assert.strictEqual(goals.length, 2);
  assert.ok(goals.some(g => g.goalName === 'goal-a'));
  assert.ok(goals.some(g => g.goalName === 'goal-b'));
});

// ─── instructions 测试 ───

console.log('\n  goal/instructions.js tests\n');

runTest('instructions 返回 propose_next（第一个 skeleton change）', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'frontend', title: '前端' });

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'propose_next');
  assert.strictEqual(inst.nextAction.changeToPropose.id, 'backend');
  assert.ok(inst.nextAction.subagentPrompt);
  // 决策 13: propose 提示词应要求子 agent 读 goal.md 全文(不只验收标准)
  assert.ok(inst.nextAction.subagentPrompt.includes('读 goal.md 全文'), 'propose 提示词应要求读 goal.md 全文(决策 13)');
  // 嵌套兜底: goal 子 agent 不加 Review task(避免嵌套子 agent)
  assert.ok(inst.nextAction.subagentPrompt.includes('Do NOT add a Review task'), 'propose 提示词应禁止加 Review task(嵌套兜底)');
});

runTest('动态编排提醒:testchange 前 normal change 归档后,propose testchange 含提醒', () => {
  // 场景:change1 归档后,轮到 testchange_1 propose —— 应提醒主 agent 是否要先 add 中间 change
  state.createGoal(tmpDir, 'dyn-hint', '动态编排提醒测试');
  state.addChange(tmpDir, 'dyn-hint', { id: 'change1', title: '前置' });
  state.addChange(tmpDir, 'dyn-hint', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'dyn-hint', 'change1');
  state.markArchived(tmpDir, 'dyn-hint', 'change1');

  const inst = getInstructions(tmpDir, 'dyn-hint');
  assert.strictEqual(inst.nextAction.type, 'propose_next');
  assert.strictEqual(inst.nextAction.changeToPropose.id, 'testchange_1');
  // 应含动态编排提醒(决策 14)
  assert.ok(inst.nextAction.instruction.includes('动态编排检查'), 'propose testchange 时应含动态编排提醒(决策 14)');
  assert.ok(inst.nextAction.instruction.includes('change add'), '提醒应引导用 change add 追加中间 change');
});

runTest('无动态编排提醒:首个 change 是 normal 时(propose 第一个 normal change)', () => {
  // 场景:还没归档任何 normal change,propose 第一个 normal change —— 不该有动态编排提醒
  state.createGoal(tmpDir, 'no-hint', '无提醒测试');
  state.addChange(tmpDir, 'no-hint', { id: 'change1', title: '前置' });
  state.addChange(tmpDir, 'no-hint', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });

  const inst = getInstructions(tmpDir, 'no-hint');
  assert.strictEqual(inst.nextAction.type, 'propose_next');
  assert.strictEqual(inst.nextAction.changeToPropose.id, 'change1');
  // 此时还没归档 normal change,不该有动态编排提醒
  assert.ok(!inst.nextAction.instruction.includes('动态编排检查'), '首个 normal change 不应有动态编排提醒');
});

runTest('instructions 返回 apply_next（proposed change）', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.markProposed(tmpDir, 'test-goal', 'backend');

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'apply_next');
  assert.strictEqual(inst.nextAction.changeToApply.id, 'backend');
  // 嵌套兜底: goal apply 子 agent 遇到 Review task 应跳过,不起子 agent
  assert.ok(inst.nextAction.subagentPrompt.includes('do NOT launch a review sub-agent'), 'apply 提示词应禁止起 review 子 agent(嵌套兜底)');
});

runTest('instructions 返回 done（全部 archived，含 test change）', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');
  state.markProposed(tmpDir, 'test-goal', 'testchange_1');
  state.markArchived(tmpDir, 'test-goal', 'testchange_1');

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'done');
});

runTest('instructions 交替式：第一个 archived 后返回第二个的 propose_next', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'frontend', title: '前端' });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'propose_next');
  assert.strictEqual(inst.nextAction.changeToPropose.id, 'frontend');
});

runTest('test change 的 propose 提示词包含 test 提示', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.changeToPropose.id, 'testchange_1');
  assert.ok(inst.nextAction.subagentPrompt.includes('Test Change 提示'));
});

runTest('testFailed 触发 fixFlow', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');
  // testchange_1 在 skeleton → propose → apply（假设失败）
  state.markProposed(tmpDir, 'test-goal', 'testchange_1');

  const result = state.testFailed(tmpDir, 'test-goal', 'testchange_1', 'API 返回 500');
  assert.strictEqual(result.circuitBreak, false);
  assert.strictEqual(result.cycle, 1);

  const s = state.loadState(tmpDir, 'test-goal');
  assert.strictEqual(s.fixFlow.active, true);
  assert.strictEqual(s.fixFlow.failedTestChange, 'testchange_1');
});

runTest('fix change archived 后自动插入下一个 testchange', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');
  state.markProposed(tmpDir, 'test-goal', 'testchange_1');
  state.testFailed(tmpDir, 'test-goal', 'testchange_1', 'API 返回 500');

  // 添加 fix change
  state.addChange(tmpDir, 'test-goal', { id: 'fixchange_1', title: '修复', type: 'fix' });
  state.markProposed(tmpDir, 'test-goal', 'fixchange_1');
  state.markArchived(tmpDir, 'test-goal', 'fixchange_1');

  const s = state.loadState(tmpDir, 'test-goal');
  const test2 = s.changes.find(c => c.id === 'testchange_2');
  assert.ok(test2, '应该自动插入 testchange_2');
  assert.strictEqual(test2.type, 'test');
  assert.strictEqual(test2.testCycle, 2);
  assert.strictEqual(test2.basedOn, 'testchange_1');
});

runTest('熔断：超过 maxFixCycles 后 circuitBreak', () => {
  state.createGoal(tmpDir, 'test-goal', '测试', { maxFixCycles: 1 });
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');
  state.markProposed(tmpDir, 'test-goal', 'testchange_1');

  // 第一次失败（cycle=1，maxCycles=1，未熔断）
  const r1 = state.testFailed(tmpDir, 'test-goal', 'testchange_1', '失败1');
  assert.strictEqual(r1.circuitBreak, false);

  // fix → test2
  state.addChange(tmpDir, 'test-goal', { id: 'fixchange_1', title: '修复', type: 'fix' });
  state.markProposed(tmpDir, 'test-goal', 'fixchange_1');
  state.markArchived(tmpDir, 'test-goal', 'fixchange_1');

  // testchange_2 自动插入
  state.markProposed(tmpDir, 'test-goal', 'testchange_2');

  // 第二次失败（cycle=2，maxCycles=1，熔断）
  const r2 = state.testFailed(tmpDir, 'test-goal', 'testchange_2', '失败2');
  assert.strictEqual(r2.circuitBreak, true);

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'circuit_break');
});

runTest('resume 重置 fixFlow 并插入新 testchange', () => {
  state.createGoal(tmpDir, 'test-goal', '测试', { maxFixCycles: 1 });
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');
  state.markProposed(tmpDir, 'test-goal', 'testchange_1');
  state.testFailed(tmpDir, 'test-goal', 'testchange_1', '失败');

  const s = state.resumeGoal(tmpDir, 'test-goal');
  assert.strictEqual(s.fixFlow.cycle, 0);
  assert.strictEqual(s.fixFlow.active, false);

  const test2 = s.changes.find(c => c.id === 'testchange_2');
  assert.ok(test2);
  assert.strictEqual(test2.phase, 'skeleton');
});

runTest('instructions 返回 blocked（change 有 blockReason）', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.markProposed(tmpDir, 'test-goal', 'backend');

  // 手动标记 blocked
  const s = state.loadState(tmpDir, 'test-goal');
  s.changes[0].blockReason = '依赖未就绪';
  state.saveState(tmpDir, 'test-goal', s);

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'blocked');
  assert.strictEqual(inst.nextAction.blockedChange.id, 'backend');
});

runTest('contextForSubagent 包含已完成 change artifacts', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.addChange(tmpDir, 'test-goal', { id: 'frontend', title: '前端' });

  // 模拟 archive 目录存在
  const archiveDir = path.join(tmpDir, 'openspec', 'changes', 'archive', '2026-01-01-test-goal-backend');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'proposal.md'), '# proposal');
  fs.writeFileSync(path.join(archiveDir, 'design.md'), '# design');

  state.markProposed(tmpDir, 'test-goal', 'backend');
  state.markArchived(tmpDir, 'test-goal', 'backend');

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.ok(inst.contextForSubagent.completedChangeArtifacts.length > 0);
  const backendArt = inst.contextForSubagent.completedChangeArtifacts.find(a => a.id === 'backend');
  assert.ok(backendArt);
  assert.ok(backendArt.proposalPath);
  assert.ok(backendArt.designPath);
});

// ─── 边界情况测试 ───

runTest('空 goal（0 个 change）instructions 返回 done', () => {
  state.createGoal(tmpDir, 'empty-goal', '空 goal');
  const inst = getInstructions(tmpDir, 'empty-goal');
  assert.strictEqual(inst.nextAction.type, 'done');
});

runTest('instructions 对不存在的 goal 抛错', () => {
  assert.throws(() => getInstructions(tmpDir, 'nonexistent'), /不存在/);
});

runTest('重复 testFailed 被拒绝（同一 test change 已有 blockReason）', () => {
  state.createGoal(tmpDir, 'repeat-fail', '重复失败');
  state.addChange(tmpDir, 'repeat-fail', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'repeat-fail', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'repeat-fail', 'impl');
  state.markArchived(tmpDir, 'repeat-fail', 'impl');
  state.markProposed(tmpDir, 'repeat-fail', 'testchange_1');

  const r1 = state.testFailed(tmpDir, 'repeat-fail', 'testchange_1', '第一次失败');
  assert.strictEqual(r1.circuitBreak, false);
  assert.strictEqual(r1.cycle, 1);

  // 重复调用应报错，不递增 cycle
  assert.throws(
    () => state.testFailed(tmpDir, 'repeat-fail', 'testchange_1', '第二次失败'),
    /已经标记为失败/
  );
  const s = state.loadState(tmpDir, 'repeat-fail');
  assert.strictEqual(s.fixFlow.cycle, 1, 'cycle 不应递增');
});

runTest('多 fix change 逐个 archive 后自动插入 testchange', () => {
  state.createGoal(tmpDir, 'multi-fix', '多 fix', { maxFixCycles: 3 });
  state.addChange(tmpDir, 'multi-fix', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'multi-fix', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'multi-fix', 'impl');
  state.markArchived(tmpDir, 'multi-fix', 'impl');
  state.markProposed(tmpDir, 'multi-fix', 'testchange_1');
  state.testFailed(tmpDir, 'multi-fix', 'testchange_1', '失败');

  // 添加两个 fix change
  state.addChange(tmpDir, 'multi-fix', { id: 'fix-a', title: '修 A', type: 'fix' });
  state.addChange(tmpDir, 'multi-fix', { id: 'fix-b', title: '修 B', type: 'fix' });

  // archive 第一个 fix——不应插入 testchange（还有 fix-b）
  state.markProposed(tmpDir, 'multi-fix', 'fix-a');
  state.markArchived(tmpDir, 'multi-fix', 'fix-a');
  const s1 = state.loadState(tmpDir, 'multi-fix');
  const tests1 = s1.changes.filter(c => c.type === 'test');
  assert.strictEqual(tests1.length, 1); // 只有 testchange_1

  // archive 第二个 fix——应自动插入 testchange_2
  state.markProposed(tmpDir, 'multi-fix', 'fix-b');
  state.markArchived(tmpDir, 'multi-fix', 'fix-b');
  const s2 = state.loadState(tmpDir, 'multi-fix');
  const tests2 = s2.changes.filter(c => c.type === 'test');
  assert.strictEqual(tests2.length, 2); // testchange_1 + testchange_2
  assert.ok(tests2.some(t => t.id === 'testchange_2'));
});

runTest('关键路径：fix 循环后 test 通过 → done', () => {
  state.createGoal(tmpDir, 'fix-done', 'fix后完成', { maxFixCycles: 2 });
  state.addChange(tmpDir, 'fix-done', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'fix-done', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });

  // impl propose → apply
  state.markProposed(tmpDir, 'fix-done', 'impl');
  state.markArchived(tmpDir, 'fix-done', 'impl');

  // testchange_1 propose → 失败
  state.markProposed(tmpDir, 'fix-done', 'testchange_1');
  state.testFailed(tmpDir, 'fix-done', 'testchange_1', '测试失败');

  // fix change propose → apply
  state.addChange(tmpDir, 'fix-done', { id: 'fix1', title: '修复', type: 'fix' });
  state.markProposed(tmpDir, 'fix-done', 'fix1');
  state.markArchived(tmpDir, 'fix-done', 'fix1');

  // testchange_2 自动插入，propose → 通过
  const s1 = state.loadState(tmpDir, 'fix-done');
  assert.ok(s1.changes.some(c => c.id === 'testchange_2'), '应自动插入 testchange_2');
  state.markProposed(tmpDir, 'fix-done', 'testchange_2');
  state.markArchived(tmpDir, 'fix-done', 'testchange_2');

  // 验证 fixFlow 已重置
  const s2 = state.loadState(tmpDir, 'fix-done');
  assert.strictEqual(s2.fixFlow.active, false, 'fixFlow.active 应重置为 false');
  assert.strictEqual(s2.fixFlow.cycle, 0, 'fixFlow.cycle 应重置为 0');

  // 验证所有 test change 都已归档（包括之前失败的 testchange_1）
  const tests = s2.changes.filter(c => c.type === 'test');
  assert.ok(tests.every(t => t.phase === 'archived'), '所有 test change 应已归档');

  // 验证 instructions 返回 done
  const inst = getInstructions(tmpDir, 'fix-done');
  assert.strictEqual(inst.nextAction.type, 'done', '应返回 done');
  assert.strictEqual(inst.phase, 'done');
});

runTest('失败的 test change 不能被直接 archive（防假通过）', () => {
  state.createGoal(tmpDir, 'fake-pass', '假通过防护');
  state.addChange(tmpDir, 'fake-pass', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'fake-pass', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'fake-pass', 'impl');
  state.markArchived(tmpDir, 'fake-pass', 'impl');
  state.markProposed(tmpDir, 'fake-pass', 'testchange_1');
  state.testFailed(tmpDir, 'fake-pass', 'testchange_1', '测试失败');

  // 失败的 testchange_1 不能被直接 archive
  assert.throws(
    () => state.markArchived(tmpDir, 'fake-pass', 'testchange_1'),
    /已标记失败/
  );

  // 验证 goal 没有错误完成
  const s = state.loadState(tmpDir, 'fake-pass');
  assert.strictEqual(s.status, 'in-progress', 'goal 不应完成');
  assert.strictEqual(s.fixFlow.active, true, 'fixFlow 应仍在 active 状态');
});

runTest('goal delete 删除 goal 目录', () => {
  state.createGoal(tmpDir, 'delete-me', '待删除');
  state.addChange(tmpDir, 'delete-me', { id: 'impl', title: '实现' });
  assert.ok(fs.existsSync(state.goalDir(tmpDir, 'delete-me')));

  state.deleteGoal(tmpDir, 'delete-me');
  assert.ok(!fs.existsSync(state.goalDir(tmpDir, 'delete-me')), 'goal 目录应已删除');

  // delete 不存在的 goal 不报错
  state.deleteGoal(tmpDir, 'never-existed');
});

runTest('goal archive 归档已完成的 goal', () => {
  state.createGoal(tmpDir, 'archive-me', '待归档');
  state.addChange(tmpDir, 'archive-me', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'archive-me', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'archive-me', 'impl');
  state.markArchived(tmpDir, 'archive-me', 'impl');
  state.markProposed(tmpDir, 'archive-me', 'testchange_1');
  state.markArchived(tmpDir, 'archive-me', 'testchange_1');

  // goal 已完成
  const s = state.loadState(tmpDir, 'archive-me');
  assert.strictEqual(s.status, 'complete');

  // 归档
  state.archiveGoal(tmpDir, 'archive-me');
  assert.ok(!fs.existsSync(state.goalDir(tmpDir, 'archive-me')), '原目录应已移走');
  assert.ok(fs.existsSync(path.join(tmpDir, state.GOALS_DIR, 'archive', 'goal_archive-me')), '应移到 archive 目录');

  // listGoals 不含归档的 goal
  const goals = state.listGoals(tmpDir, false);
  assert.ok(!goals.some(g => g.goalName === 'archive-me'), '归档的 goal 不应出现在活跃列表');
});

runTest('goal archive 归档不存在的 goal 抛错', () => {
  assert.throws(
    () => state.archiveGoal(tmpDir, 'never-existed'),
    /不存在/,
    '归档不存在的 goal 应抛错'
  );
});

runTest('goal archive 归档目标目录已存在时抛错，且不破坏原 goal', () => {
  state.createGoal(tmpDir, 'dup-archive', '重复归档');

  // 手动创建冲突的归档目录
  const conflictDir = path.join(tmpDir, state.GOALS_DIR, 'archive', 'goal_dup-archive');
  fs.mkdirSync(conflictDir, { recursive: true });

  assert.throws(
    () => state.archiveGoal(tmpDir, 'dup-archive'),
    /已存在/,
    '归档目标已存在时应抛错'
  );

  // 原 goal 目录仍完整存在（抛错发生在 rename 前，goal 未被修改）
  assert.ok(fs.existsSync(state.goalDir(tmpDir, 'dup-archive')), '原 goal 目录不应被删除');
  const s = state.loadState(tmpDir, 'dup-archive');
  assert.strictEqual(s.status, 'in-progress', '抛错后状态应未变');
});

runTest('goal archive 归档后新位置 state.json 的 status 为 archived', () => {
  state.createGoal(tmpDir, 'verify-status', '验证归档状态');
  state.addChange(tmpDir, 'verify-status', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'verify-status', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'verify-status', 'impl');
  state.markArchived(tmpDir, 'verify-status', 'impl');
  state.markProposed(tmpDir, 'verify-status', 'testchange_1');
  state.markArchived(tmpDir, 'verify-status', 'testchange_1');

  state.archiveGoal(tmpDir, 'verify-status');

  // 验证新位置的 state.json 存在且 status='archived'
  const archiveStatePath = path.join(tmpDir, state.GOALS_DIR, 'archive', 'goal_verify-status', 'state.json');
  assert.ok(fs.existsSync(archiveStatePath), '归档后目标目录中应有 state.json');
  const archivedState = JSON.parse(fs.readFileSync(archiveStatePath, 'utf-8'));
  assert.strictEqual(archivedState.status, 'archived', '归档后 status 应为 archived');
  assert.ok(archivedState.updatedAt, 'updatedAt 应已更新');
});

runTest('goal archive 允许归档未完成的 goal（不改状态，只是移目录）', () => {
  state.createGoal(tmpDir, 'incomplete', '未完成 goal');
  state.addChange(tmpDir, 'incomplete', { id: 'impl', title: '实现' });
  // 注意：impl 还在 skeleton，没有 test change，goal 不完整

  // archiveGoal 应成功（不检查完整性，只移目录）
  state.archiveGoal(tmpDir, 'incomplete');
  assert.ok(!fs.existsSync(state.goalDir(tmpDir, 'incomplete')), '原目录应已移走');

  const archiveStatePath = path.join(tmpDir, state.GOALS_DIR, 'archive', 'goal_incomplete', 'state.json');
  assert.ok(fs.existsSync(archiveStatePath));
  const archivedState = JSON.parse(fs.readFileSync(archiveStatePath, 'utf-8'));
  assert.strictEqual(archivedState.status, 'archived', '即使原状态是 in-progress，归档后也标记为 archived');
});

runTest('blockChange / unblockChange 通过 state.js 操作', () => {
  state.createGoal(tmpDir, 'block-test', 'block 测试');
  state.addChange(tmpDir, 'block-test', { id: 'impl', title: '实现' });

  const blocked = state.blockChange(tmpDir, 'block-test', 'impl', '遇到问题');
  assert.strictEqual(blocked.blockReason, '遇到问题');

  const unblocked = state.unblockChange(tmpDir, 'block-test', 'impl');
  assert.strictEqual(unblocked.blockReason, null);
});

runTest('无 test change 时不返回 done（missing_test 警告）', () => {
  state.createGoal(tmpDir, 'no-test', '没有 test change');
  state.addChange(tmpDir, 'no-test', { id: 'impl', title: '实现' });
  // 注意：没有加 testchange

  state.markProposed(tmpDir, 'no-test', 'impl');
  state.markArchived(tmpDir, 'no-test', 'impl');

  const inst = getInstructions(tmpDir, 'no-test');
  assert.strictEqual(inst.nextAction.type, 'missing_test', '应返回 missing_test 而非 done');
  assert.ok(inst.nextAction.instruction.includes('test change'), '应提示缺少 test change');
});

runTest('completedChangeArtifacts fallback 到活跃目录', () => {
  state.createGoal(tmpDir, 'fallback-test', 'fallback');
  state.addChange(tmpDir, 'fallback-test', { id: 'impl', title: '实现' });

  // 模拟 change 已 archived 但还在活跃目录（未执行 openspec archive）
  const activeDir = path.join(tmpDir, 'openspec', 'changes', 'fallback-test-impl');
  fs.mkdirSync(activeDir, { recursive: true });
  fs.writeFileSync(path.join(activeDir, 'proposal.md'), '# proposal');
  fs.writeFileSync(path.join(activeDir, 'design.md'), '# design');

  state.markProposed(tmpDir, 'fallback-test', 'impl');
  state.markArchived(tmpDir, 'fallback-test', 'impl');

  const inst = getInstructions(tmpDir, 'fallback-test');
  const artifacts = inst.contextForSubagent.completedChangeArtifacts;
  assert.ok(artifacts.length > 0);
  const implArt = artifacts.find(a => a.id === 'impl');
  assert.ok(implArt);
  assert.ok(implArt.proposalPath, '应 fallback 到活跃目录找到 proposal');
  assert.ok(implArt.designPath, '应 fallback 到活跃目录找到 design');
});

runTest('test change propose 提示词包含语义评估关键文案', () => {
  state.createGoal(tmpDir, 'sem-test', '语义评估测试');
  state.addChange(tmpDir, 'sem-test', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'sem-test', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'sem-test', 'impl');
  state.markArchived(tmpDir, 'sem-test', 'impl');

  const inst = getInstructions(tmpDir, 'sem-test');
  assert.strictEqual(inst.nextAction.type, 'propose_next');
  assert.strictEqual(inst.nextAction.changeToPropose.id, 'testchange_1');
  const prompt = inst.nextAction.subagentPrompt;
  assert.ok(prompt.includes('独立语义评估'), 'propose 提示词应包含"独立语义评估"');
  assert.ok(prompt.includes('Task 1'), 'propose 提示词应包含 Task 1 结构');
  assert.ok(prompt.includes('评估在前'), 'propose 提示词应说明评估在前的顺序');
  // 决策 13: test change 提示词应要求读 goal.md 全文(不只验收标准)
  assert.ok(prompt.includes('goal doc 全文'), 'test change 提示词应要求读 goal doc 全文(决策 13)');
  // 决策 5: test change 是把关者不是修复者,提示词顶部应有铁律
  assert.ok(prompt.includes('把关者'), 'test change propose 提示词应声明"把关者"角色(决策 5)');
  assert.ok(prompt.includes('绝不修复产品代码'), 'test change propose 应禁止修复产品代码(决策 5)');
});

runTest('test change apply 提示词包含角色切换 + 两种失败报告格式', () => {
  state.createGoal(tmpDir, 'sem-apply', '语义评估 apply 测试');
  state.addChange(tmpDir, 'sem-apply', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'sem-apply', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'sem-apply', 'impl');
  state.markArchived(tmpDir, 'sem-apply', 'impl');
  state.markProposed(tmpDir, 'sem-apply', 'testchange_1');

  const inst = getInstructions(tmpDir, 'sem-apply');
  assert.strictEqual(inst.nextAction.type, 'apply_next');
  const prompt = inst.nextAction.subagentPrompt;
  assert.ok(prompt.includes('角色切换'), 'apply 提示词应包含角色切换指令');
  assert.ok(prompt.includes('独立评估者'), 'apply 提示词应包含"独立评估者"');
  assert.ok(prompt.includes('语义评估不通过'), 'apply 提示词应包含语义评估失败报告格式');
  assert.ok(prompt.includes('测试失败'), 'apply 提示词应包含测试失败报告格式');
  // 证据层次：不应只限定为规划文档
  assert.ok(prompt.includes('源码'), 'apply 提示词应引导读真实源码');
  // 决策 5: test change apply 提示词顶部应有"把关者不是修复者"铁律
  assert.ok(prompt.includes('把关者'), 'test change apply 提示词应声明"把关者"角色(决策 5)');
  assert.ok(prompt.includes('绝不修复产品代码'), 'apply 提示词应有"绝不修复产品代码"铁律(决策 5)');
  assert.ok(prompt.includes('fix change'), 'apply 提示词应说明由 fix change 负责修复(决策 5)');
});

runTest('apply_next instruction 包含语义评估不通过', () => {
  state.createGoal(tmpDir, 'sem-instr', '语义评估 instruction 测试');
  state.addChange(tmpDir, 'sem-instr', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'sem-instr', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'sem-instr', 'impl');
  state.markArchived(tmpDir, 'sem-instr', 'impl');
  state.markProposed(tmpDir, 'sem-instr', 'testchange_1');

  const inst = getInstructions(tmpDir, 'sem-instr');
  assert.strictEqual(inst.nextAction.type, 'apply_next');
  const instruction = inst.nextAction.instruction;
  assert.ok(instruction.includes('语义评估不通过'), 'apply_next instruction 应提及语义评估不通过');
  assert.ok(instruction.includes('测试失败'), 'apply_next instruction 应提及测试失败');
  assert.ok(instruction.includes('失败类型'), 'apply_next instruction 应要求摘要含失败类型');
  // 职责划分:change 归档是子 agent 的活,主 agent 不碰归档;goal 归档轮到用户
  assert.ok(instruction.includes('change 归档是子 agent 的活'), 'apply_next instruction 应厘清 change 归档职责(子 agent)');
  assert.ok(instruction.includes('主 agent 不碰归档'), 'apply_next instruction 应明确主 agent 不碰归档');
  assert.ok(instruction.includes('goal 归档'), 'apply_next instruction 应提及 goal 归档轮到用户');
});

runTest('fix_analysis_needed instruction 按失败类型分叉', () => {
  state.createGoal(tmpDir, 'sem-fix', '语义评估 fix 分叉测试');
  state.addChange(tmpDir, 'sem-fix', { id: 'impl', title: '实现' });
  state.addChange(tmpDir, 'sem-fix', { id: 'testchange_1', title: '测试', type: 'test', testCycle: 1 });
  state.markProposed(tmpDir, 'sem-fix', 'impl');
  state.markArchived(tmpDir, 'sem-fix', 'impl');
  state.markProposed(tmpDir, 'sem-fix', 'testchange_1');
  state.testFailed(tmpDir, 'sem-fix', 'testchange_1', '语义评估不通过：验收标准A未满足');

  const inst = getInstructions(tmpDir, 'sem-fix');
  assert.strictEqual(inst.nextAction.type, 'fix_analysis_needed');
  const instruction = inst.nextAction.instruction;
  assert.ok(instruction.includes('语义评估不通过'), 'fix_analysis instruction 应包含语义评估分叉');
  assert.ok(instruction.includes('测试失败'), 'fix_analysis instruction 应包含测试失败分叉');
  assert.ok(instruction.includes('缺什么实现'), 'fix_analysis instruction 应引导补缺失功能');
  // 决策 5 粒度红线:默认一个 fix change 装本轮所有小修,不按问题机械拆分
  assert.ok(instruction.includes('拆 fix change 的粒度原则'), 'fix_analysis instruction 应含 fix change 粒度原则(决策 5)');
  assert.ok(instruction.includes('默认一个 fix change 装本轮所有小修'), 'fix_analysis instruction 应说明默认合并小修(决策 5)');
  assert.ok(instruction.includes('过度拆分'), 'fix_analysis instruction 应警告过度拆分(决策 5)');
  assert.ok(!instruction.includes('-<module>'), 'fix_analysis instruction 不应再用 -<module> 占位符暗示按模块拆(决策 5)');
});

console.log('\n  goal 测试完成\n');
