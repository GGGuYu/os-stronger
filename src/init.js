// os-stronger/src/init.js
// 主流程:多选增强 → 扫描 OpenSpec skills → 逐个 patch → 创建支撑文件。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const patcher = require('./patcher');

// 加载所有增强模块
const enhancements = {
  'review':      require('./enhancements/review'),
  'skill-align': require('./enhancements/skill-align'),
  'goal':        require('../goal/scripts/index'),
};

// 互斥组:同组内的增强只能选一个。
// 现状:goal 与所有其他增强互斥——goal 是独立编排层(自己起 propose/apply 子 agent),
// 而 review/skill-align 会 patch 同样的 openspec skill 注入"起子 agent"指令,
// 两套并存会让弱模型在读 skill 时分不清该起什么子 agent,实测冲突。互斥从源头杜绝。
// 结构:key 是"锁",值是数组——选了 key 就不能选数组里的任何项。
// 当前 goal 是 review 和 skill-align 的共同锁(一组多 others)。
function getMutexGroups() {
  return {
    'goal': ['review', 'skill-align'],
  };
}

// 校验选中的增强是否违反互斥。违反返回错误信息字符串,不违反返回 null。
function checkMutex(selectedIds, mutexGroups) {
  for (const [lock, others] of Object.entries(mutexGroups)) {
    if (selectedIds.includes(lock)) {
      const conflict = others.filter(o => selectedIds.includes(o));
      if (conflict.length > 0) {
        return `${lock} 与 ${conflict.join(', ')} 互斥,不能同时启用。\n` +
               `  原因:${lock} 是独立编排层,与 ${conflict.join('/')} 同 patch 同 skill 文件会注入多套子 agent 指令,弱模型会混乱。\n` +
               `  解决:要么只用 ${lock}(编排 + 自带 fix→test→熔断质量门),要么用 ${conflict.join('/')}(流程增强)。\n` +
               `  若要 ${lock} + 审查:${lock} 自己有 test change 做语义评估 + 测试,已是质量门。`;
      }
    }
  }
  return null;
}

// ─── CLI 输出 ───
function ok(msg)   { console.log('  \x1b[32m✓\x1b[0m ' + msg); }
function warn(msg) { console.log('  \x1b[33m!\x1b[0m ' + msg); }
function err(msg)  { console.error('  \x1b[31m✗\x1b[0m ' + msg); }
function info(msg) { console.log('  ' + msg); }

const ANSI = {
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  dim: '\x1b[2m', reset: '\x1b[0m',
  cursorUp: (n) => `\x1b[${n}A`, cursorShow: '\x1b[?25h', cursorHide: '\x1b[?25l',
  clearLine: '\x1b[K',
};

// ─── 交互式多选 ───
// mutexGroups: { lockId: [otherId, ...] } 选了 lockId 自动取消 others,反之亦然
function multiSelect(options, mutexGroups = {}) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    // 非 TTY 由 init.js 调用前拦截报错,这里不处理

    let selected = options.map(() => true); // 默认全选
    let current = 0, renderCount = 0, lastRows = 0;
    const BASE_ROWS = options.length + 2; // 1 行标题 + options.length 行选项 + 1 行 hint

    // 互斥联动:toggle id 时,若 id 是某组的锁 → 取消组内其他;若 id 是某组的"其他" → 取消该组的锁
    function applyMutex(toggledId) {
      for (const [lock, others] of Object.entries(mutexGroups)) {
        if (toggledId === lock && selected[options.findIndex(o => o.id === lock)]) {
          // 刚选中了锁 → 取消组内其他
          for (const otherId of others) {
            const idx = options.findIndex(o => o.id === otherId);
            if (idx !== -1) selected[idx] = false;
          }
        } else if (others.includes(toggledId)) {
          // 刚选中了某个"其他" → 取消锁
          const lockIdx = options.findIndex(o => o.id === lock);
          if (lockIdx !== -1 && selected[options.findIndex(o => o.id === toggledId)]) {
            selected[lockIdx] = false;
          }
        }
      }
    }

    function render() {
      const rows = BASE_ROWS;
      if (renderCount > 0) {
        process.stdout.write(ANSI.cursorUp(lastRows - 1) + '\r');
      }
      let out = `  \x1b[2m?\x1b[0m 选择要启用的增强 (\x1b[2m↑/↓\x1b[0m 导航, \x1b[2m空格\x1b[0m 切换, \x1b[2m回车\x1b[0m 确认):\n`;
      for (let i = 0; i < options.length; i++) {
        const checkbox = selected[i] ? `${ANSI.green}◼${ANSI.reset}` : '◻';
        const pointer = i === current ? `${ANSI.cyan}❯${ANSI.reset}` : ' ';
        const style = i === current ? ANSI.cyan : '';
        out += `  ${pointer} ${checkbox} ${style}${options[i].label}${ANSI.reset}${ANSI.clearLine}\n`;
      }
      const lockNames = Object.keys(mutexGroups).join('/');
      const mutexHint = lockNames
        ? ` | \x1b[2m${lockNames} 与其他互斥\x1b[0m`
        : '';
      out += `  ${ANSI.dim}(空格切换, 回车确认, a 全选/取消${mutexHint})${ANSI.reset}${ANSI.clearLine}`;
      process.stdout.write(out);
      lastRows = rows;
      renderCount++;
    }

    function cleanup() {
      stdin.setRawMode(false); stdin.pause();
      stdin.removeListener('keypress', onKeypress);
      process.stdout.write(ANSI.cursorShow);
    }
    function onKeypress(str, key) {
      if (key.name === 'up')   { current = (current - 1 + options.length) % options.length; render(); }
      else if (key.name === 'down') { current = (current + 1) % options.length; render(); }
      else if (key.name === 'space') {
        selected[current] = !selected[current];
        if (selected[current]) applyMutex(options[current].id);
        render();
      }
      else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(options.filter((_, i) => selected[i]).map(o => o.id));
      }
      else if (key.name === 'c' && key.ctrl) { cleanup(); process.exit(0); }
      else if (str === 'a') {
        const all = selected.every(s => s);
        selected = selected.map(() => !all);
        if (!all) {
          // 全选时按 mutex 联动取消冲突项(避免全亮却回车报互斥)
          for (let i = 0; i < options.length; i++) {
            if (selected[i]) applyMutex(options[i].id);
          }
        }
        render();
      }
    }

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    process.stdout.write(ANSI.cursorHide);
    render();
    stdin.on('keypress', onKeypress);
  });
}

// ─── 主流程 ───
async function init(projectDir, options = {}) {
  projectDir = path.resolve(projectDir || process.cwd());

  if (options.restore) return doRestore(projectDir);

  console.log('\n  os-stronger init\n');
  info('Project: ' + projectDir);

  // 1. 找 OpenSpec
  const skills = patcher.findOpenSpecSkills(projectDir);
  if (!skills.some(s => s.skillName === 'openspec-apply-change')) {
    err('OpenSpec not found. Run \x1b[36mopenspec init\x1b[0m first.');
    return false;
  }
  // 校验 propose 是否存在(review 和 skill-align 都需要 patch 它)
  const hasPropose = skills.some(s => s.skillName === 'openspec-propose');
  if (!hasPropose) {
    warn('openspec-propose not found. Some enhancements (review, skill-align) will be partially applied.');
  }
  info(`Found OpenSpec in ${skills.length} skill files across ${new Set(skills.map(s => s.toolDir)).size} tool(s).\n`);

  // 2. 选增强
  let selectedIds;
  if (options.enhancements) {
    selectedIds = options.enhancements;
  } else if (!process.stdin.isTTY) {
    // 非 TTY(如 CI/管道)不默认全选——修改 skill 文件有副作用,要求显式指定
    err('非交互式环境需用 --enhancements 显式指定增强(如 --enhancements review,skill-align)');
    return false;
  } else {
    const opts = Object.values(enhancements).map(e => ({ id: e.id, label: e.label }));
    selectedIds = await multiSelect(opts, getMutexGroups());
  }
  if (selectedIds.length === 0) { info('未选择任何增强,退出。'); return true; }

  // 校验增强 id 有效(防 typo 静默吞掉)
  const invalid = selectedIds.filter(id => !enhancements[id]);
  if (invalid.length > 0) {
    err('未知增强: ' + invalid.join(', '));
    info('可用增强: ' + Object.keys(enhancements).join(', '));
    return false;
  }

  // 互斥校验:goal 与所有其他增强互斥(同 patch 同 skill 文件会塞多套子 agent 指令,
  // 弱模型分不清自己该起什么子 agent,实测冲突。goal 是独立编排层,不和流程增强层混)
  const mutexViolation = checkMutex(selectedIds, getMutexGroups());
  if (mutexViolation) {
    err(mutexViolation);
    return false;
  }

  const activeEnhancements = selectedIds.map(id => enhancements[id]);
  info(`启用增强: ${activeEnhancements.map(e => e.id).join(', ')}\n`);

  // 3. 逐个 patch
  for (const enh of activeEnhancements) {
    info(`[${enh.id}] Patching...`);
    for (const [skillName, patchFn] of Object.entries(enh.patches)) {
      const matching = skills.filter(s => s.skillName === skillName);
      for (const skill of matching) {
        const content = fs.readFileSync(skill.skillFile, 'utf8');
        const result = patchFn(content);
        if (result.patched) {
          patcher.backup(skill.skillFile);
          fs.writeFileSync(skill.skillFile, result.content, 'utf8');
          ok(`${skill.toolDir}/skills/${skillName} — patched`);
        } else {
          ok(`${skill.toolDir}/skills/${skillName} — ${result.reason}`);
        }
      }
    }
  }

  // 4. 创建支撑文件
  for (const enh of activeEnhancements) {
    for (const file of enh.files) {
      const destPath = path.join(projectDir, file.dest);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const templatePath = path.join(__dirname, 'enhancements', enh.id, file.template);
      fs.copyFileSync(templatePath, destPath);
      ok(`Created ${file.dest}`);
    }
  }

  // 5. 创建 skill 说明文件 (每个增强一个 skill,每个工具目录各一份)
  const toolDirs = [...new Set(skills.map(s => s.toolDir))];
  for (const enh of activeEnhancements) {
    if (!enh.skillTemplate) continue;
    // 增强模块可以提供 skillTemplateDir（绝对路径），否则用默认的 src/enhancements/<id>/
    const templateBase = enh.skillTemplateDir || path.join(__dirname, 'enhancements', enh.id);
    const templatePath = path.join(templateBase, enh.skillTemplate);
    for (const toolDir of toolDirs) {
      const skillDir = path.join(projectDir, toolDir, 'skills', `os-stronger-${enh.id}`);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.copyFileSync(templatePath, path.join(skillDir, 'SKILL.md'));
      ok(`Created ${toolDir}/skills/os-stronger-${enh.id}/SKILL.md`);
    }
  }

  // 6. 往 .gitignore 追加规则(幂等),防止 backup 和 .os-stronger/ 被提交
  const gitignorePath = path.join(projectDir, '.gitignore');
  const ignoreRules = ['.os-stronger/', '*.os-stronger.bak', 'openspec-goals/*/state.json'];
  let existing = '';
  if (fs.existsSync(gitignorePath)) existing = fs.readFileSync(gitignorePath, 'utf8');
  const toAdd = ignoreRules.filter(r => !existing.includes(r));
  if (toAdd.length > 0) {
    const addition = (existing && !existing.endsWith('\n') ? '\n' : '') + toAdd.join('\n') + '\n';
    fs.appendFileSync(gitignorePath, addition, 'utf8');
    ok(`Added ${toAdd.length} rule(s) to .gitignore`);
  }

  console.log();
  ok('os-stronger init complete.');
  info('If OpenSpec updates: re-run \x1b[36mos-stronger init\x1b[0m to re-apply patches.');
  info('To remove: run \x1b[36mos-stronger init --restore\x1b[0m');
  console.log();
  return true;
}

function doRestore(projectDir) {
  console.log('\n  os-stronger init --restore\n');
  info('Project: ' + projectDir);

  const skills = patcher.findOpenSpecSkills(projectDir);
  let restored = 0;
  for (const skill of skills) {
    if (patcher.restore(skill.skillFile)) {
      ok(`Restored ${skill.toolDir}/skills/${skill.skillName}/SKILL.md`);
      restored++;
    }
  }

  // 删 .os-stronger/
  const osStrongerDir = path.join(projectDir, '.os-stronger');
  if (fs.existsSync(osStrongerDir)) {
    fs.rmSync(osStrongerDir, { recursive: true, force: true });
    ok('Removed .os-stronger/');
  }

  // 删各工具下的 os-stronger-* skill 目录
  let rootEntries;
  try { rootEntries = fs.readdirSync(projectDir, { withFileTypes: true }); }
  catch (e) { rootEntries = []; }
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
    if (entry.name === '.git') continue;
    const skillsDir = path.join(projectDir, entry.name, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    try {
      for (const sub of fs.readdirSync(skillsDir)) {
        if (sub.startsWith('os-stronger-')) {
          fs.rmSync(path.join(skillsDir, sub), { recursive: true, force: true });
          ok(`Removed ${entry.name}/skills/${sub}/`);
        }
      }
    } catch (e) { /* skip */ }
  }

  // 清理 .gitignore 里的 os-stronger 规则
  const gitignorePath = path.join(projectDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const lines = fs.readFileSync(gitignorePath, 'utf8').split('\n');
    const cleaned = lines.filter(l =>
      l !== '.os-stronger/' &&
      l !== '*.os-stronger.bak' &&
      l !== 'openspec-goals/*/state.json'
    );
    if (cleaned.length !== lines.length) {
      fs.writeFileSync(gitignorePath, cleaned.join('\n'), 'utf8');
      ok('Cleaned .gitignore (removed os-stronger rules)');
    }
  }

  // 检查 openspec-goals/ 是否存在（不自动删——可能有用户数据）
  const goalsDir = path.join(projectDir, 'openspec-goals');
  if (fs.existsSync(goalsDir)) {
    warn('openspec-goals/ 目录未清理（可能包含 goal.md 等用户数据）。');
    info('如需删除: rm -rf openspec-goals/');
  }

  console.log();
  ok(`Restore complete. Restored ${restored} file(s).`);
  console.log();
  return true;
}

module.exports = { init, enhancements };
