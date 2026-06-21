// os-stronger/src/patcher.js
// 通用 patch 工具:扫描、备份、恢复。不含任何增强特定逻辑。

const fs = require('fs');
const path = require('path');

/**
 * 扫描项目根下所有 .开头目录的 skills/,找 openspec-* skill。
 * 返回 [{ toolDir, skillName, skillFile }]
 */
function findOpenSpecSkills(projectDir) {
  const found = [];
  let rootEntries;
  try { rootEntries = fs.readdirSync(projectDir, { withFileTypes: true }); }
  catch (e) { return found; }

  for (const entry of rootEntries) {
    // 只扫真实目录,跳过符号链接(避免外溢到 home 等大目录)
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!entry.name.startsWith('.')) continue;
    if (entry.name === '.git' || entry.name === '.os-stronger') continue;

    const skillsDir = path.join(projectDir, entry.name, 'skills');
    if (!fs.existsSync(skillsDir)) continue;

    try {
      for (const skillEntry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!skillEntry.name.startsWith('openspec-')) continue;
        const skillFile = path.join(skillsDir, skillEntry.name, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          found.push({ toolDir: entry.name, skillName: skillEntry.name, skillFile });
        }
      }
    } catch (e) { /* skip */ }
  }
  return found;
}

function backup(filePath) {
  const backupPath = filePath + '.os-stronger.bak';
  // 只在不存在时 backup,避免多增强 patch 同一文件时覆盖原始 backup
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

function restore(filePath) {
  const backupPath = filePath + '.os-stronger.bak';
  if (!fs.existsSync(backupPath)) return false;

  // 检查当前文件是否包含 os-stronger marker（OS-STRONGER）
  // 如果不包含，说明 OpenSpec update 覆盖了 skill 文件，当前文件是新版本原始文件
  // 此时从旧 backup 恢复会导致降级——跳过并删除过期 backup
  const currentContent = fs.readFileSync(filePath, 'utf8');
  if (!currentContent.includes('OS-STRONGER')) {
    // 当前文件没有 os-stronger 标记，可能是 OpenSpec 更新覆盖了
    // 删除过期 backup，不恢复（避免降级）
    fs.unlinkSync(backupPath);
    return 'skipped-no-marker';
  }

  fs.copyFileSync(backupPath, filePath);
  fs.unlinkSync(backupPath);
  return true;
}

module.exports = { findOpenSpecSkills, backup, restore };
