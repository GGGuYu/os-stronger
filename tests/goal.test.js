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
});

runTest('instructions 返回 apply_next（proposed change）', () => {
  state.createGoal(tmpDir, 'test-goal', '测试');
  state.addChange(tmpDir, 'test-goal', { id: 'backend', title: '后端' });
  state.markProposed(tmpDir, 'test-goal', 'backend');

  const inst = getInstructions(tmpDir, 'test-goal');
  assert.strictEqual(inst.nextAction.type, 'apply_next');
  assert.strictEqual(inst.nextAction.changeToApply.id, 'backend');
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

console.log('\n  goal 测试完成\n');
