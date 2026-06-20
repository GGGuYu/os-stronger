// tests/patch.test.js
// patch 函数单元测试:喂真实 OpenSpec skill 文本快照,验证 patch/幂等/恢复。
// 运行: node tests/patch.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const reviewEnh = require('../src/enhancements/review');
const skillAlignEnh = require('../src/enhancements/skill-align');
const patcher = require('../src/patcher');

let PASS = 0, FAIL = 0;
function test(name, fn) {
  try { fn(); console.log('  ✓ ' + name); PASS++; }
  catch (e) { console.log('  ✗ ' + name + '\n    ' + e.message); FAIL++; }
}

// 真实 OpenSpec apply-change SKILL.md 片段(含 Handle states + all_done 行)
const APPLY_CHANGE_SAMPLE = `4. **Read context files**

   Read every file path listed under contextFiles.

5. **Show current progress**

   **Handle states:**
   - If \`state: "blocked"\`: suggest using openspec-continue-change
   - If \`state: "all_done"\`: congratulate, suggest archive
   - Otherwise: proceed to implementation
`;

// 真实 OpenSpec propose SKILL.md 片段(含步骤4和 Guardrails)
const PROPOSE_SAMPLE = `1. **If no clear input provided, ask what they want to build**

2. **Create the change directory**

3. **Get the artifact build order**

4. **Create artifacts in sequence until apply-ready**

   Use the TodoWrite tool to track progress.

5. **Show final status**

**Guardrails**
- Keep going through tasks until done
- Always read context files before starting
`;

console.log('os-stronger patch 单元测试\n');

// ─── review 增强 ───
test('review: patchApplyChange 在 Handle states 整块之前注入(不劈开列表)', () => {
  const result = reviewEnh.patches['openspec-apply-change'](APPLY_CHANGE_SAMPLE);
  assert.ok(result.patched, '应 patched=true');
  assert.ok(result.content.includes('OS-STRONGER-REVIEW'), '应含 marker');
  assert.ok(result.content.includes('review-guide.md'), '应含 review-guide 路径');
  assert.ok(result.content.includes('congratulate, suggest archive'), '原 all_done 行应保留(兜底)');
  assert.ok(result.content.includes('Review task'), '应含 Review task 触发逻辑');
  // review 块应在 Handle states 之前
  const markerPos = result.content.indexOf('OS-STRONGER-REVIEW');
  const handleStatesPos = result.content.indexOf('**Handle states:**');
  assert.ok(markerPos < handleStatesPos, '应在 Handle states 之前');
  // Handle states 列表应完整(blocked + all_done + otherwise 都在)
  assert.ok(result.content.includes('state: "blocked"'), 'blocked 行应在');
  assert.ok(result.content.includes('Otherwise: proceed'), 'otherwise 行应在');
});

test('review: patchApplyChange 幂等(再 patch 返回 already-patched)', () => {
  const r1 = reviewEnh.patches['openspec-apply-change'](APPLY_CHANGE_SAMPLE);
  const r2 = reviewEnh.patches['openspec-apply-change'](r1.content);
  assert.strictEqual(r2.patched, false);
  assert.strictEqual(r2.reason, 'already-patched');
});

test('review: patchApplyChange 找不到 pattern 返回 pattern-not-found', () => {
  const result = reviewEnh.patches['openspec-apply-change']('no relevant keywords here at all');
  assert.strictEqual(result.patched, false);
  assert.strictEqual(result.reason, 'pattern-not-found');
});

test('review: patchPropose 追加到末尾', () => {
  const result = reviewEnh.patches['openspec-propose'](PROPOSE_SAMPLE);
  assert.ok(result.patched);
  assert.ok(result.content.includes('OS-STRONGER-REVIEW-PROPOSE'));
  // 应在 Guardrails 之后
  const markerPos = result.content.indexOf('OS-STRONGER-REVIEW-PROPOSE');
  const guardrailsPos = result.content.indexOf('**Guardrails**');
  assert.ok(markerPos > guardrailsPos, '应在 Guardrails 之后');
});

test('review: patchPropose 幂等', () => {
  const r1 = reviewEnh.patches['openspec-propose'](PROPOSE_SAMPLE);
  const r2 = reviewEnh.patches['openspec-propose'](r1.content);
  assert.strictEqual(r2.patched, false);
  assert.strictEqual(r2.reason, 'already-patched');
});

// ─── skill-align 增强 ───
test('skill-align: patchPropose 注入到步骤5之前(所有 artifact 生成后)', () => {
  const result = skillAlignEnh.patches['openspec-propose'](PROPOSE_SAMPLE);
  assert.ok(result.patched);
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-PROPOSE'));
  // 应在步骤5之前,步骤4之后
  const markerPos = result.content.indexOf('OS-STRONGER-SKILL-ALIGN-PROPOSE');
  const step4Pos = result.content.indexOf('4. **Create artifacts');
  const step5Pos = result.content.indexOf('5. **Show final status');
  assert.ok(markerPos > step4Pos, '应在步骤4之后');
  assert.ok(markerPos < step5Pos, '应在步骤5之前');
});

test('skill-align: patchPropose 幂等', () => {
  const r1 = skillAlignEnh.patches['openspec-propose'](PROPOSE_SAMPLE);
  const r2 = skillAlignEnh.patches['openspec-propose'](r1.content);
  assert.strictEqual(r2.patched, false);
  assert.strictEqual(r2.reason, 'already-patched');
});

test('skill-align: patchApplyChange 注入 skill 约定提醒', () => {
  const result = skillAlignEnh.patches['openspec-apply-change'](APPLY_CHANGE_SAMPLE);
  assert.ok(result.patched);
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-APPLY'));
  assert.ok(result.content.includes('Skill Alignment'), '应含 Skill Alignment 检查');
});

test('skill-align: patchApplyChange 注入到 Read context files 之后', () => {
  const result = skillAlignEnh.patches['openspec-apply-change'](APPLY_CHANGE_SAMPLE);
  assert.ok(result.patched);
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-APPLY'));
  const markerPos = result.content.indexOf('OS-STRONGER-SKILL-ALIGN-APPLY');
  const readContextPos = result.content.indexOf('Read context files');
  const showProgressPos = result.content.indexOf('5. **Show current progress');
  assert.ok(markerPos > readContextPos, '应在 Read context files 之后');
  assert.ok(markerPos < showProgressPos, '应在步骤5之前');
});

test('skill-align: patchApplyChange 幂等', () => {
  const r1 = skillAlignEnh.patches['openspec-apply-change'](APPLY_CHANGE_SAMPLE);
  const r2 = skillAlignEnh.patches['openspec-apply-change'](r1.content);
  assert.strictEqual(r2.patched, false);
  assert.strictEqual(r2.reason, 'already-patched');
});

// ─── 多增强共存 ───
test('多增强: review + skill-align 都 patch propose 不冲突', () => {
  let content = PROPOSE_SAMPLE;
  // review 先 patch propose
  content = reviewEnh.patches['openspec-propose'](content).content;
  // skill-align 再 patch propose
  const result = skillAlignEnh.patches['openspec-propose'](content);
  assert.ok(result.patched, 'skill-align 应能 patch 已被 review patch 过的 propose');
  assert.ok(result.content.includes('OS-STRONGER-REVIEW-PROPOSE'), 'review marker 应还在');
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-PROPOSE'), 'skill-align marker 应在');
});

test('多增强: review + skill-align 都 patch apply-change 不冲突', () => {
  let content = APPLY_CHANGE_SAMPLE;
  content = reviewEnh.patches['openspec-apply-change'](content).content;
  const result = skillAlignEnh.patches['openspec-apply-change'](content);
  assert.ok(result.patched);
  assert.ok(result.content.includes('OS-STRONGER-REVIEW'), 'review marker 应还在');
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-APPLY'), 'skill-align marker 应在');
});

// ─── patcher 通用工具 ───
test('patcher: backup 只在不存在时做(防覆盖)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-test-'));
  const tmpFile = path.join(tmpDir, 'test.txt');
  fs.writeFileSync(tmpFile, 'original');

  // 第一次 backup
  patcher.backup(tmpFile);
  const bakContent1 = fs.readFileSync(tmpFile + '.os-stronger.bak', 'utf8');
  assert.strictEqual(bakContent1, 'original');

  // 修改文件,再 backup(应不覆盖)
  fs.writeFileSync(tmpFile, 'modified');
  patcher.backup(tmpFile);
  const bakContent2 = fs.readFileSync(tmpFile + '.os-stronger.bak', 'utf8');
  assert.strictEqual(bakContent2, 'original', 'backup 应保持原始内容');

  // restore 应恢复原始
  patcher.restore(tmpFile);
  assert.strictEqual(fs.readFileSync(tmpFile, 'utf8'), 'original');
  assert.ok(!fs.existsSync(tmpFile + '.os-stronger.bak'), 'backup 应被删除');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('patcher: findOpenSpecSkills 跳过符号链接', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-stronger-scan-'));
  // 创建真实 .claude 目录带 openspec skill
  fs.mkdirSync(path.join(tmpDir, '.claude', 'skills', 'openspec-apply-change'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.claude', 'skills', 'openspec-apply-change', 'SKILL.md'), 'test');
  // 创建符号链接 .evil -> /tmp (不应被扫描)
  try { fs.symlinkSync(os.tmpdir(), path.join(tmpDir, '.evil')); } catch (e) { /* skip if symlink fails */ }

  const found = patcher.findOpenSpecSkills(tmpDir);
  assert.ok(found.some(s => s.toolDir === '.claude'), '应找到 .claude');
  assert.ok(!found.some(s => s.toolDir === '.evil'), '不应扫描符号链接 .evil');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── 分层降级测试(OpenSpec 改格式时仍能注入) ───
test('review: 无 Handle states 但有 all_done 整句仍匹配(L2)', () => {
  const modified = 'Some text\n- If `state: "all_done"`: you are done!\n';
  const result = reviewEnh.patches['openspec-apply-change'](modified);
  assert.ok(result.patched, 'L2 应匹配含 all_done 的行');
  assert.ok(result.content.includes('OS-STRONGER-REVIEW'));
});

test('review: 无 Handle states,all_done 只剩关键词仍匹配(L3 含 state)', () => {
  const modified = '   - When state is all_done: stop\n';
  const result = reviewEnh.patches['openspec-apply-change'](modified);
  assert.ok(result.patched, 'L3 应匹配含 state + all_done 的行');
});

test('review: 纯解释性文字含 all_done 但不含 state → 不匹配', () => {
  const modified = 'The all_done state means everything is complete.\nNo branch here.';
  const result = reviewEnh.patches['openspec-apply-change'](modified);
  assert.strictEqual(result.patched, false, 'L3 要求同时含 state 和 all_done');
  assert.strictEqual(result.reason, 'pattern-not-found');
});

test('review: 完全没有 all_done 返回 pattern-not-found', () => {
  const result = reviewEnh.patches['openspec-apply-change']('nothing relevant here');
  assert.strictEqual(result.patched, false);
  assert.strictEqual(result.reason, 'pattern-not-found');
});

test('skill-align: propose 步骤5标题变了仍匹配(L2 步骤4之后)', () => {
  const modified = PROPOSE_SAMPLE.replace('Show final status', 'Display completion summary');
  const result = skillAlignEnh.patches['openspec-propose'](modified);
  assert.ok(result.patched, 'L2 应匹配步骤4之后');
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-PROPOSE'));
  const markerPos = result.content.indexOf('OS-STRONGER-SKILL-ALIGN-PROPOSE');
  const step4Pos = result.content.indexOf('4. **Create artifacts');
  assert.ok(markerPos > step4Pos, '应在步骤4之后');
});

test('skill-align: propose 无 Steps 但有数字步骤 → L3 插第一个步骤前', () => {
  const modified = 'Some intro text\n\n1. Do something\n2. Do another thing\n';
  const result = skillAlignEnh.patches['openspec-propose'](modified);
  assert.ok(result.patched, 'L3 应命中(插第一个步骤前)');
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-PROPOSE'));
  const markerPos = result.content.indexOf('OS-STRONGER-SKILL-ALIGN-PROPOSE');
  const firstStepPos = result.content.indexOf('1. Do something');
  assert.ok(markerPos < firstStepPos, '应在第一个数字步骤之前');
});

test('skill-align: propose 完全没有 Steps 仍追加(L3 末尾)', () => {
  const modified = 'Some random skill file without Steps section';
  const result = skillAlignEnh.patches['openspec-propose'](modified);
  assert.ok(result.patched, 'L3 应追加末尾');
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-PROPOSE'));
});

test('skill-align: apply-change 没有 Read context files 仍注入(L2 Steps 之后)', () => {
  const modified = '**Steps**\n\n1. Do something\n2. Do another thing\n';
  const result = skillAlignEnh.patches['openspec-apply-change'](modified);
  assert.ok(result.patched);
  assert.ok(result.content.includes('OS-STRONGER-SKILL-ALIGN-APPLY'));
});

console.log('\n结果: ' + PASS + ' 通过, ' + FAIL + ' 失败');
process.exit(FAIL > 0 ? 1 : 0);
