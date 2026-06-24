// tests/integration.test.js
// 集成测试:造假的 OpenSpec skill 文件,跑 init → 验证 patch + backup → restore → 验证还原。
// 运行: node tests/integration.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

let PASS = 0, FAIL = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); PASS++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); FAIL++; }
}

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'os-stronger');

// 真实 OpenSpec skill 文本快照
const APPLY_CHANGE = `---
name: openspec-apply-change
description: test
---

Implement tasks.

**Steps**

1. **Select the change**

2. **Read context files**

3. **Show current progress**

   - If \`state: "all_done"\`: congratulate, suggest archive
   - Otherwise: proceed to implementation

**Guardrails**
- Keep going
`;

const PROPOSE = `---
name: openspec-propose
description: test
---

Propose a change.

**Steps**

1. **If no clear input provided, ask what they want to build**

2. **Create the change directory**

3. **Get the artifact build order**

4. **Create artifacts in sequence until apply-ready**

5. **Show final status**

**Guardrails**
- Keep going
`;

// 造一个假项目,跑 init/restore
function setupFakeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-int-'));
  // .claude/skills/openspec-apply-change/SKILL.md
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'openspec-apply-change'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md'), APPLY_CHANGE);
  // .claude/skills/openspec-propose/SKILL.md
  fs.mkdirSync(path.join(dir, '.claude', 'skills', 'openspec-propose'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'skills', 'openspec-propose', 'SKILL.md'), PROPOSE);
  return dir;
}

function runInit(dir, enhancements) {
  const flag = enhancements ? `--enhancements ${enhancements}` : '';
  execSync(`node "${BIN}" init ${flag}`, { cwd: dir, stdio: 'pipe' });
}

function runRestore(dir) {
  execSync(`node "${BIN}" init --restore`, { cwd: dir, stdio: 'pipe' });
}

console.log('os-stronger 集成测试\n');

// ─── init + restore 完整流程 ───
test('集成: init 两个增强 → patch 生效 → restore 完全还原', () => {
  const dir = setupFakeProject();
  const applyPath = path.join(dir, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md');
  const proposePath = path.join(dir, '.claude', 'skills', 'openspec-propose', 'SKILL.md');

  // init
  runInit(dir, 'review,skill-align');

  // 验证 patch 生效
  const patchedApply = fs.readFileSync(applyPath, 'utf8');
  assert.ok(patchedApply.includes('OS-STRONGER-REVIEW'), 'apply-change 应含 review marker');
  assert.ok(patchedApply.includes('OS-STRONGER-SKILL-ALIGN-APPLY'), 'apply-change 应含 skill-align marker');

  const patchedPropose = fs.readFileSync(proposePath, 'utf8');
  assert.ok(patchedPropose.includes('OS-STRONGER-REVIEW-PROPOSE'), 'propose 应含 review marker');
  assert.ok(patchedPropose.includes('OS-STRONGER-SKILL-ALIGN-PROPOSE'), 'propose 应含 skill-align marker');

  // 验证 backup 存在且是原始内容
  const applyBak = fs.readFileSync(applyPath + '.os-stronger.bak', 'utf8');
  assert.strictEqual(applyBak, APPLY_CHANGE, 'backup 应是原始内容(决策 3:只 backup 一次)');

  // 验证支撑文件
  assert.ok(fs.existsSync(path.join(dir, '.os-stronger', 'review-guide.md')), '应创建 review-guide.md');

  // 验证 skill 目录
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'os-stronger-review', 'SKILL.md')), '应创建 os-stronger-review skill');

  // restore
  runRestore(dir);

  // 验证完全还原
  const restoredApply = fs.readFileSync(applyPath, 'utf8');
  assert.strictEqual(restoredApply, APPLY_CHANGE, 'apply-change 应完全还原');
  assert.ok(!restoredApply.includes('OS-STRONGER'), 'apply-change 不应有 marker 残留');

  const restoredPropose = fs.readFileSync(proposePath, 'utf8');
  assert.strictEqual(restoredPropose, PROPOSE, 'propose 应完全还原');
  assert.ok(!restoredPropose.includes('OS-STRONGER'), 'propose 不应有 marker 残留');

  // 验证清理
  assert.ok(!fs.existsSync(path.join(dir, '.os-stronger')), '.os-stronger/ 应删除');
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'skills', 'os-stronger-review')), 'os-stronger-review/ 应删除');
  assert.ok(!fs.existsSync(applyPath + '.os-stronger.bak'), 'backup 应删除');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 幂等: init 两次不重复注入 ───
test('集成: init 两次幂等(不重复注入,backup 不覆盖)', () => {
  const dir = setupFakeProject();
  const applyPath = path.join(dir, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md');

  runInit(dir, 'review,skill-align');
  const after1 = fs.readFileSync(applyPath, 'utf8');

  // 第二次 init
  runInit(dir, 'review,skill-align');
  const after2 = fs.readFileSync(applyPath, 'utf8');

  assert.strictEqual(after1, after2, '二次 init 后内容应一致(幂等)');

  // backup 仍是原始内容
  const bak = fs.readFileSync(applyPath + '.os-stronger.bak', 'utf8');
  assert.strictEqual(bak, APPLY_CHANGE, 'backup 应保持原始(决策 3)');

  runRestore(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── .gitignore 追加 ───
test('集成: init 往 .gitignore 追加规则(幂等)', () => {
  const dir = setupFakeProject();
  runInit(dir, 'review');

  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(gi.includes('.os-stronger/'), '.gitignore 应含 .os-stronger/');
  assert.ok(gi.includes('*.os-stronger.bak'), '.gitignore 应含 *.os-stronger.bak');
  assert.ok(gi.includes('openspec-goals/*/state.json'), '.gitignore 应含 openspec-goals/*/state.json');

  // 二次 init 不重复追加
  runInit(dir, 'review');
  const gi2 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  const count = (gi2.match(/\.os-stronger\//g) || []).length;
  assert.strictEqual(count, 1, '不应重复追加');

  runRestore(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 无 OpenSpec 时报错 ───
test('集成: 无 OpenSpec 时 init 报错退出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-empty-'));
  let exitCode = 0;
  try {
    execSync(`node "${BIN}" init --enhancements review`, { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    exitCode = e.status;
  }
  assert.ok(exitCode !== 0, '应非 0 退出');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── 无效增强 id 报错 ───
test('集成: --enhancements typo 报错退出,不修改 .gitignore', () => {
  const dir = setupFakeProject();
  let exitCode = 0;
  try {
    execSync(`node "${BIN}" init --enhancements reviw`, { cwd: dir, stdio: 'pipe' });
  } catch (e) { exitCode = e.status; }
  assert.ok(exitCode !== 0, 'typo 应非 0 退出');
  assert.ok(!fs.existsSync(path.join(dir, '.gitignore')), '不应创建 .gitignore');
  // skill 文件不应被修改
  const apply = fs.readFileSync(path.join(dir, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md'), 'utf8');
  assert.ok(!apply.includes('OS-STRONGER'), '不应有 patch 痕迹');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── restore 清理 .gitignore ───
test('集成: restore 清理 .gitignore 里的 os-stronger 规则', () => {
  const dir = setupFakeProject();
  // 先写一个有内容的 .gitignore
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\ndist/\n');
  runInit(dir, 'review');
  const gi1 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(gi1.includes('.os-stronger/'), 'init 后应有规则');
  assert.ok(gi1.includes('node_modules/'), '原有规则应保留');

  runRestore(dir);
  const gi2 = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.ok(!gi2.includes('.os-stronger/'), 'restore 后应清除 os-stronger 规则');
  assert.ok(!gi2.includes('os-stronger.bak'), 'restore 后应清除 bak 规则');
  assert.ok(gi2.includes('node_modules/'), '原有规则应保留');

  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── goal delete CLI 不再 ReferenceError ───
test('集成: goal delete 不再崩溃且真删目录(修复 cmdDelete 未定义 bug)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-del-'));
  // goal create 只需要能写 openspec-goals/,不需要 openspec 目录
  execSync(`node "${BIN}" goal create --name delme --description "test"`, { cwd: dir, stdio: 'pipe' });
  const goalDir = path.join(dir, 'openspec-goals', 'goal_delme');
  assert.ok(fs.existsSync(goalDir), 'create 后应有 goal 目录');

  // delete 不应抛 ReferenceError,且应真删目录
  execSync(`node "${BIN}" goal delete --goal delme`, { cwd: dir, stdio: 'pipe' });
  assert.ok(!fs.existsSync(goalDir), 'delete 后目录应消失');

  // --force no-op 不报错
  execSync(`node "${BIN}" goal create --name delme2 --description "test"`, { cwd: dir, stdio: 'pipe' });
  execSync(`node "${BIN}" goal delete --goal delme2 --force`, { cwd: dir, stdio: 'pipe' });
  assert.ok(!fs.existsSync(path.join(dir, 'openspec-goals', 'goal_delme2')), '--force 也应删除');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('集成: --before 缺值时报错(不静默降级为智能默认)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-before-'));
  execSync(`node "${BIN}" goal create --name bv --description "test"`, { cwd: dir, stdio: 'pipe' });
  execSync(`node "${BIN}" goal change add --goal bv --id c1 --title "一"`, { cwd: dir, stdio: 'pipe' });
  execSync(`node "${BIN}" goal change add --goal bv --id tc1 --title "测" --type test`, { cwd: dir, stdio: 'pipe' });

  // --before 末尾无值:应非零退出并报错
  let threw = false;
  try {
    execSync(`node "${BIN}" goal change add --goal bv --id c2 --title "二" --before`, { cwd: dir, stdio: 'pipe' });
  } catch (e) {
    threw = true;
    assert.ok(e.status !== 0, '--before 缺值应非零退出');
    const stderr = e.stderr ? e.stderr.toString() : '';
    assert.ok(stderr.includes('--before'), '错误信息应提及 --before');
  }
  assert.ok(threw, '--before 缺值应抛错');

  // 确认没误加 c2
  const stateJson = JSON.parse(fs.readFileSync(path.join(dir, 'openspec-goals', 'goal_bv', 'state.json'), 'utf8'));
  assert.ok(!stateJson.changes.some(c => c.id === 'c2'), 'c2 不应被添加(--before 缺值时)');

  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('\n结果: ' + PASS + ' 通过, ' + FAIL + ' 失败');
process.exit(FAIL > 0 ? 1 : 0);
