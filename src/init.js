// os-stronger/src/init.js
// Main init logic: scan for OpenSpec skills, patch them, create supporting files.

const fs = require('fs');
const path = require('path');
const patcher = require('./patcher');

// ─── CLI output helpers ───
function ok(msg)  { console.log('  \x1b[32m✓\x1b[0m ' + msg); }
function warn(msg) { console.log('  \x1b[33m!\x1b[0m ' + msg); }
function err(msg) { console.error('  \x1b[31m✗\x1b[0m ' + msg); }
function info(msg) { console.log('  ' + msg); }

// ─── Globals ───
const REVIEW_GUIDE_PATH = '.todopro/review-guide.md';

/**
 * Main init function.
 * @param {string} projectDir - project root directory
 * @param {{ restore?: boolean }} options
 */
function init(projectDir, options = {}) {
  projectDir = path.resolve(projectDir || process.cwd());

  // ─── Restore mode ───
  if (options.restore) {
    return doRestore(projectDir);
  }

  console.log('\n  os-stronger init\n');
  info('Project: ' + projectDir);

  // 1. Find all OpenSpec skill installations
  const skills = patcher.findOpenSpecSkills(projectDir);
  
  const applySkills = skills.filter(s => s.skillName === 'openspec-apply-change');
  const proposeSkills = skills.filter(s => s.skillName === 'openspec-propose');

  if (applySkills.length === 0) {
    err('OpenSpec not found in this project.');
    info('Run \x1b[36mopenspec init\x1b[0m first, then re-run os-stronger init.');
    return false;
  }

  info(`Found OpenSpec in ${skills.length} skill files across ${new Set(skills.map(s => s.toolDir)).size} tool(s).`);
  console.log();

  // 2. Patch openspec-apply-change
  info('Patching openspec-apply-change...');
  for (const skill of applySkills) {
    const backupPath = patcher.backup(skill.skillFile);
    const content = fs.readFileSync(skill.skillFile, 'utf8');
    const result = patcher.patchApplyChange(content);
    
    if (result.patched) {
      fs.writeFileSync(skill.skillFile, result.content, 'utf8');
      ok(`${skill.toolDir}/skills/${skill.skillName} — review workflow injected (backup: ${backupPath})`);
    } else {
      ok(`${skill.toolDir}/skills/${skill.skillName} — ${result.reason}, skipped`);
    }
  }

  // 3. Patch openspec-propose
  info('Patching openspec-propose...');
  for (const skill of proposeSkills) {
    const backupPath = patcher.backup(skill.skillFile);
    const content = fs.readFileSync(skill.skillFile, 'utf8');
    const result = patcher.patchPropose(content);
    
    if (result.patched) {
      fs.writeFileSync(skill.skillFile, result.content, 'utf8');
      ok(`${skill.toolDir}/skills/${skill.skillName} — review reminder injected (backup: ${backupPath})`);
    } else {
      ok(`${skill.toolDir}/skills/${skill.skillName} — ${result.reason}, skipped`);
    }
  }

  // 4. Create .todopro/review-guide.md
  const reviewGuidePath = path.join(projectDir, REVIEW_GUIDE_PATH);
  const reviewGuideDir = path.dirname(reviewGuidePath);
  fs.mkdirSync(reviewGuideDir, { recursive: true });
  
  const templatePath = path.join(__dirname, 'templates', 'review-guide.md');
  const reviewGuideContent = fs.readFileSync(templatePath, 'utf8');
  fs.writeFileSync(reviewGuidePath, reviewGuideContent, 'utf8');
  ok(`Created ${REVIEW_GUIDE_PATH}`);

  // 5. Create os-stronger SKILL.md for each tool
  const skillTemplatePath = path.join(__dirname, 'templates', 'skill.md');
  const skillTemplateContent = fs.readFileSync(skillTemplatePath, 'utf8');
  
  for (const toolDir of new Set(applySkills.map(s => s.toolDir))) {
    const skillDir = path.join(projectDir, toolDir, 'skills', 'os-stronger');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, skillTemplateContent, 'utf8');
    ok(`Created ${toolDir}/skills/os-stronger/SKILL.md`);
  }

  console.log();
  ok('os-stronger init complete.');
  info('The review workflow will trigger automatically when openspec-apply-change reaches all_done.');
  info('To remove: run \x1b[36mos-stronger init --restore\x1b[0m');
  info('If OpenSpec updates: re-run \x1b[36mos-stronger init\x1b[0m to re-apply patches.');
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

  // Remove review-guide.md
  const reviewGuidePath = path.join(projectDir, REVIEW_GUIDE_PATH);
  if (fs.existsSync(reviewGuidePath)) {
    fs.unlinkSync(reviewGuidePath);
    ok(`Removed ${REVIEW_GUIDE_PATH}`);
  }

  // Remove os-stronger skill dirs
  for (const toolDir of patcher.TOOL_SKILLS_DIRS) {
    const skillDir = path.join(projectDir, toolDir, 'skills', 'os-stronger');
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
      ok(`Removed ${toolDir}/skills/os-stronger/`);
    }
  }

  console.log();
  ok(`Restore complete. Restored ${restored} file(s).`);
  console.log();
  return true;
}

module.exports = { init };
