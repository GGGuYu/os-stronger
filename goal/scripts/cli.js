// goal/cli.js
// CLI 命令入口 — 解析参数，调用 state.js / instructions.js。
// 被 bin/os-stronger 的 goal 子命令路由调用。

const path = require('path');
const state = require('./state');
const { getInstructions } = require('./instructions');

// ─── CLI 输出 ───

function ok(msg)   { console.log('  \x1b[32m✓\x1b[0m ' + msg); }
function warn(msg) { console.log('  \x1b[33m!\x1b[0m ' + msg); }
function err(msg)  { console.error('  \x1b[31m✗\x1b[0m ' + msg); }
function info(msg) { console.log('  ' + msg); }

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

// ─── 参数解析辅助 ───

function getArg(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

// ─── 命令处理 ───

function handleGoal(args) {
  const subcmd = args[0];

  if (!subcmd || subcmd === '--help' || subcmd === '-h') {
    printGoalHelp();
    return 0;
  }

  switch (subcmd) {
    case 'create':         return cmdCreate(args.slice(1));
    case 'change':         return cmdChange(args.slice(1));
    case 'instructions':   return cmdInstructions(args.slice(1));
    case 'test-failed':    return cmdTestFailed(args.slice(1));
    case 'resume':         return cmdResume(args.slice(1));
    case 'status':         return cmdStatus(args.slice(1));
    case 'list':           return cmdList(args.slice(1));
    case 'delete':         return cmdDelete(args.slice(1));
    case 'archive':        return cmdArchive(args.slice(1));
    default:
      err(`未知子命令: ${subcmd}`);
      printGoalHelp();
      return 1;
  }
}

// ─── goal create ───

function cmdCreate(args) {
  const projectDir = process.cwd();
  const name = getArg(args, '--name');
  const description = getArg(args, '--description') || '';
  const json = hasFlag(args, '--json');
  const maxFixCycles = parseInt(getArg(args, '--max-fix-cycles') || String(state.DEFAULT_MAX_FIX_CYCLES), 10);

  if (!name) { err('--name 必填'); return 1; }

  try {
    const s = state.createGoal(projectDir, name, description, { maxFixCycles });
    if (json) {
      printJson({ ok: true, goalName: name, state: s });
    } else {
      ok(`Goal 创建: ${name}`);
      info(`描述: ${description || '(未设置)'}`);
      info(`目录: ${state.goalDir(projectDir, name)}`);
      info(`maxFixCycles: ${maxFixCycles}`);
      info('');
      info('下一步: 添加 change 骨架:');
      info(`  os-stronger goal change add --goal ${name} --id <id> --title "..."`);
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal change ... ───

function cmdChange(args) {
  const action = args[0];
  if (!action) { err('用法: goal change add|propose|archive|block|unblock'); return 1; }

  switch (action) {
    case 'add':     return cmdChangeAdd(args.slice(1));
    case 'propose': return cmdChangePropose(args.slice(1));
    case 'archive': return cmdChangeArchive(args.slice(1));
    case 'block':   return cmdChangeBlock(args.slice(1));
    case 'unblock': return cmdChangeUnblock(args.slice(1));
    default:
      err(`未知 change 子命令: ${action}`);
      return 1;
  }
}

function cmdChangeAdd(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const id = getArg(args, '--id');
  const title = getArg(args, '--title');
  const type = getArg(args, '--type') || 'normal';
  const testCycle = getArg(args, '--test-cycle') ? parseInt(getArg(args, '--test-cycle'), 10) : undefined;
  const basedOn = getArg(args, '--based-on');
  const dependsOn = getArg(args, '--depends-on');
  const before = getArg(args, '--before');
  const json = hasFlag(args, '--json');

  // --before 出现但缺值(末尾无参)时报错,避免静默降级为智能默认
  if (hasFlag(args, '--before') && !before) {
    err('--before 需要一个 change id 作为参数(如 --before testchange_1)');
    return 1;
  }

  if (!goalName || !id || !title) {
    err('--goal, --id, --title 必填');
    return 1;
  }

  try {
    const change = state.addChange(projectDir, goalName, { id, title, type, testCycle, basedOn, dependsOn, before });
    if (json) {
      printJson({ ok: true, change });
    } else {
      ok(`Change 添加: ${id} → goal ${goalName}`);
      info(`  标题: ${title}`);
      info(`  类型: ${type}${testCycle ? ` (cycle ${testCycle})` : ''}`);
      info(`  OpenSpec change name: ${change.openspecChangeName}`);
      if (before) {
        info(`  插入位置: ${before} 之前`);
      } else if (type === 'normal') {
        info(`  插入位置: 自动(testchange 之前,若无则末尾)`);
      }
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

function cmdChangePropose(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const changeId = getArg(args, '--id');
  const json = hasFlag(args, '--json');

  if (!goalName || !changeId) { err('--goal 和 --id 必填'); return 1; }

  try {
    const change = state.markProposed(projectDir, goalName, changeId);
    if (json) printJson({ ok: true, change });
    else ok(`Change "${changeId}" 标记为 proposed`);
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

function cmdChangeArchive(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const changeId = getArg(args, '--id');
  const json = hasFlag(args, '--json');

  if (!goalName || !changeId) { err('--goal 和 --id 必填'); return 1; }

  try {
    const change = state.markArchived(projectDir, goalName, changeId);
    if (json) {
      printJson({ ok: true, change });
    } else {
      ok(`Change "${changeId}" 已归档`);
      // 提示下一步
      const s = state.loadState(projectDir, goalName);
      if (s && s.status === 'complete') {
        info(`🎉 Goal "${goalName}" 已完成！`);
      } else {
        info('下一步: os-stronger goal instructions --goal ' + goalName + ' --json');
      }
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

function cmdChangeBlock(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const changeId = getArg(args, '--id');
  const reason = getArg(args, '--reason') || '';
  const json = hasFlag(args, '--json');

  if (!goalName || !changeId) { err('--goal 和 --id 必填'); return 1; }

  try {
    const change = state.blockChange(projectDir, goalName, changeId, reason);
    if (json) printJson({ ok: true, change });
    else ok(`Change "${changeId}" 标记为受阻: ${reason}`);
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

function cmdChangeUnblock(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const changeId = getArg(args, '--id');
  const json = hasFlag(args, '--json');

  if (!goalName || !changeId) { err('--goal 和 --id 必填'); return 1; }

  try {
    const change = state.unblockChange(projectDir, goalName, changeId);
    if (json) printJson({ ok: true, change });
    else ok(`Change "${changeId}" 已解除受阻`);
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal instructions ───

function cmdInstructions(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const json = hasFlag(args, '--json');

  if (!goalName) { err('--goal 必填'); return 1; }

  try {
    const instructions = getInstructions(projectDir, goalName);
    if (json) {
      printJson(instructions);
    } else {
      // 人类可读输出
      info(`Goal: ${instructions.goalName}`);
      info(`进度: ${instructions.progress}`);
      info(`阶段: ${instructions.phase}`);
      info('');
      const na = instructions.nextAction;
      info(`Next Action: ${na.type}`);
      if (na.changeToPropose) info(`  Change: ${na.changeToPropose.id} — ${na.changeToPropose.title}`);
      if (na.changeToApply)   info(`  Change: ${na.changeToApply.id} — ${na.changeToApply.title}`);
      if (na.blockedChange)   info(`  Blocked: ${na.blockedChange.id} — ${na.blockedChange.reason}`);
      if (na.reason)          info(`  原因: ${na.reason}`);
      info('');
      info('指令:');
      info(na.instruction);
      if (na.subagentPrompt) {
        info('');
        info('--- 子 agent 提示词 ---');
        console.log(na.subagentPrompt);
      }
    }
    return 0;
  } catch (e) {
    if (json) printJson({ error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal test-failed ───

function cmdTestFailed(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const testChangeId = getArg(args, '--test-change');
  const summary = getArg(args, '--summary') || '';
  const json = hasFlag(args, '--json');

  if (!goalName || !testChangeId) { err('--goal 和 --test-change 必填'); return 1; }

  try {
    const result = state.testFailed(projectDir, goalName, testChangeId, summary);
    if (json) {
      printJson({ ok: true, ...result });
    } else {
      if (result.circuitBreak) {
        warn(`🔥 熔断！Fix-Test 循环已达上限（${result.maxCycles} 轮）`);
        info('需要人工介入。修复后运行:');
        info(`  os-stronger goal resume --goal ${goalName}`);
      } else {
        ok(`Test change "${testChangeId}" 标记失败`);
        info(`Fix-Test 循环: ${result.cycle}/${result.maxCycles}`);
        info('');
        info('下一步: 起分析子 agent 确定要修什么，然后:');
        info(`  os-stronger goal change add --goal ${goalName} --id fixchange_1 --title "..." --type fix`);
        info(`  os-stronger goal instructions --goal ${goalName} --json`);
      }
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal resume ───

function cmdResume(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const json = hasFlag(args, '--json');

  if (!goalName) { err('--goal 必填'); return 1; }

  try {
    const s = state.resumeGoal(projectDir, goalName);
    if (json) {
      printJson({ ok: true, state: s });
    } else {
      ok(`Goal "${goalName}" 已恢复`);
      info('Fix-Test 循环已重置，新的 test change 已插入');
      info('下一步: os-stronger goal instructions --goal ' + goalName + ' --json');
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal status ───

function cmdStatus(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const json = hasFlag(args, '--json');

  if (!goalName) { err('--goal 必填'); return 1; }

  try {
    const s = state.loadState(projectDir, goalName);
    if (!s) throw new Error(`Goal "${goalName}" 不存在`);

    if (json) {
      printJson(s);
    } else {
      info(`Goal: ${s.goalName}`);
      info(`状态: ${s.status}`);
      info(`描述: ${s.goalDescription}`);
      info(`进度: ${state.getProgress(s)}`);
      info(`Fix-Test 循环: ${s.fixFlow.cycle}/${s.fixFlow.maxCycles}`);
      info('');
      info('Changes:');
      for (const c of s.changes) {
        const status = c.phase === 'archived' ? '\x1b[32m✓\x1b[0m' : c.blockReason ? '\x1b[33m!\x1b[0m' : '○';
        const typeTag = c.type !== 'normal' ? ` [${c.type}]` : '';
        console.log(`  ${status} ${c.id}: ${c.title}${typeTag}`);
      }
    }
    return 0;
  } catch (e) {
    if (json) printJson({ error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal list ───

function cmdList(args) {
  const projectDir = process.cwd();
  const json = hasFlag(args, '--json');
  const includeArchived = hasFlag(args, '--all');

  try {
    const goals = state.listGoals(projectDir, includeArchived);
    if (json) {
      printJson({ goals });
    } else {
      if (goals.length === 0) {
        info('没有找到 goal。运行 os-stronger goal create --name <name> 创建。');
      } else {
        info(`Goals (${goals.length}):`);
        for (const g of goals) {
          const status = g.status === 'complete' ? '\x1b[32m✓\x1b[0m' : '○';
          console.log(`  ${status} ${g.goalName} — ${g.status} (${g.changesArchived}/${g.changesTotal})`);
        }
      }
    }
    return 0;
  } catch (e) {
    if (json) printJson({ error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── goal archive ───

function cmdArchive(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const json = hasFlag(args, '--json');

  if (!goalName) { err('--goal 必填'); return 1; }

  try {
    state.archiveGoal(projectDir, goalName);
    if (json) {
      printJson({ ok: true, goalName, archived: true });
    } else {
      ok(`Goal "${goalName}" 已归档到 openspec-goals/archive/`);
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

function cmdDelete(args) {
  const projectDir = process.cwd();
  const goalName = getArg(args, '--goal');
  const json = hasFlag(args, '--json');
  // --force 接受但忽略(no-op): deleteGoal 内部已用 rmSync force:true 删目录;
  // help 里保留 [--force] 仅为兼容已存在的脚本/文档,无实际语义。
  // (参数解析是宽松的 indexOf/includes,未知 flag 自动忽略,无需显式消费。)
  if (!goalName) { err('--goal 必填'); return 1; }

  try {
    const existed = state.deleteGoal(projectDir, goalName);
    if (json) {
      printJson({ ok: true, goalName, deleted: true, existed });
    } else {
      ok(`Goal "${goalName}" ${existed ? '已删除' : '本就不存在(视为已删除)'}`);
    }
    return 0;
  } catch (e) {
    if (json) printJson({ ok: false, error: e.message });
    else err(e.message);
    return 1;
  }
}

// ─── 帮助 ───

function printGoalHelp() {
  console.log('os-stronger goal — 长程目标编排\n');
  console.log('Usage:');
  console.log('  os-stronger goal create --name <name> --description "..."');
  console.log('  os-stronger goal change add --goal <name> --id <id> --title "..." [--type normal|test|fix] [--before <id>]');
  console.log('  os-stronger goal change propose --goal <name> --id <id>');
  console.log('  os-stronger goal change archive --goal <name> --id <id>');
  console.log('  os-stronger goal change block --goal <name> --id <id> --reason "..."');
  console.log('  os-stronger goal change unblock --goal <name> --id <id>');
  console.log('  os-stronger goal instructions --goal <name> --json');
  console.log('  os-stronger goal test-failed --goal <name> --test-change <id> --summary "..."');
  console.log('  os-stronger goal resume --goal <name>');
  console.log('  os-stronger goal archive --goal <name>');
  console.log('  os-stronger goal delete --goal <name> [--force]');
  console.log('  os-stronger goal status --goal <name>');
  console.log('  os-stronger goal list [--all]');
}

module.exports = { handleGoal };
