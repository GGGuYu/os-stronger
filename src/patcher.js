// os-stronger/src/patcher.js
// OpenSpec skill file patching — injects review workflow into openspec-apply-change
// and review reminder into openspec-propose.

const fs = require('fs');
const path = require('path');

// ─── Markers for detecting existing patches ───
const PATCH_MARKER = '<!-- OS-STRONGER-REVIEW -->';
const PROPOSE_MARKER = '<!-- OS-STRONGER-PROPOSE -->';

// ─── Constants for OpenSpec skill mapping ───
const OPENSEC_SKILLS = ['openspec-apply-change', 'openspec-propose'];

// ─── Tool directories to scan (from OpenSpec's AI_TOOLS config) ───
const TOOL_SKILLS_DIRS = [
  '.claude', '.codex', '.cursor', '.gemini', '.github',
  '.windsurf', '.continue', '.amazonq', '.agent', '.augment',
  '.bob', '.cline', '.forge', '.codebuddy', '.cospec', '.crush',
  '.factory', '.iflow', '.junie', '.kilocode', '.kimi', '.kiro',
  '.lingma', '.vibe', '.opencode', '.pi', '.qoder', '.qwen',
  '.roo', '.trae',
];

// ─── Review workflow injection text for openspec-apply-change ───

const REVIEW_WORKFLOW_BLOCK = `
${PATCH_MARKER}
   - If \`state: "all_done"\`:
     - Check if \`.todopro/review-guide.md\` exists in the project root (**only check existence, do NOT read its contents** — the review guide is for the subagent, not for you).
     - If it does NOT exist: congratulate, suggest archive (unchanged behavior).
     - If it EXISTS:
       a. **Write requirement summary**: Write a brief summary of what this change was supposed to accomplish to \`.todopro/requirement-summary.md\`. Base this on the proposal and design documents. Overwrite if already exists.
       b. **Determine review cycle**: Scan \`tasks.md\` for task lines matching \`Review N Fix -\`. Find the highest N where ALL \`Review N Fix\` tasks are marked \`[x]\` (complete). The current cycle is that N+1. If no completed review markers exist, this is Review 1. (If Review 1 Fix tasks still have \`[ ]\` items, you are still in Review 1 — do NOT advance to Review 2.)
       c. **Launch review subagent**: Use the built-in subagent mechanism. Tell the subagent to read these files (pass PATHS, not contents):
          - \`.todopro/review-guide.md\` — review rules and output format
          - \`.todopro/requirement-summary.md\` — what to check against
          - \`openspec/changes/<name>/tasks.md\` — what was done
          - \`git diff\` — what actually changed
          If this is Review 2, add: "This is the FINAL review cycle. Only flag CRITICAL issues that would break functionality."
       d. **Evaluate subagent findings**: When the subagent returns, evaluate each finding:
          1. Is it actually TRUE? (use your knowledge of the codebase)
          2. Is it worth fixing IMMEDIATELY? (consider: does the delay of fixing this outweigh the cost?)
          Only create fix tasks for findings that are BOTH true AND worth immediate fix.
       e. **Create fix tasks**: In \`tasks.md\`, add new tasks for accepted findings:
          \`- [ ] Review N Fix - <brief description>\`
          Where N is the current review cycle number.
          Example: \`- [ ] Review 1 Fix - Missing error handling in auth module\`
       f. **Archive or continue**:
          - If NO findings were worth fixing: suggest archive immediately.
          - If this is Review 2 (scan tasks.md for \`Review 2 Fix\` markers): this is the FINAL review cycle. Fix the Review 2 tasks, then suggest archive. Do NOT trigger Review 3.
          - If this is Review 1: fix the Review 1 tasks, then when all complete, the review workflow will trigger again for Review 2.
${PATCH_MARKER}`;

// ─── Propose injection text ───

const PROPOSE_BLOCK = `
${PROPOSE_MARKER}
**os-stronger review reminder**: If this project has os-stronger enabled (check if \`.todopro/review-guide.md\` exists), consider adding a final note in the generated tasks.md: "After all tasks complete, the review workflow in openspec-apply-change will trigger automatically — no manual action needed."
${PROPOSE_MARKER}`;

// ─── Patch functions ───

/**
 * Patch openspec-apply-change SKILL.md: replace the "all_done" branch
 * with the review workflow block.
 */
function patchApplyChange(content) {
  // Check if already patched
  if (content.includes(PATCH_MARKER)) {
    return { patched: false, reason: 'already-patched', content };
  }

  // Find the "all_done" line and replace the surrounding text
  // OpenSpec's text: `If state: "all_done": congratulate, suggest archive`
  const allDonePattern = /If `state: "all_done"`:\s*\w+,\s*suggest archive/;
  
  if (!allDonePattern.test(content)) {
    // Try alternative pattern (OpenSpec may have changed the text)
    const altPattern = /state:\s*"all_done".*?(?:congratulate|suggest archive)/i;
    if (!altPattern.test(content)) {
      return { patched: false, reason: 'pattern-not-found', content };
    }
    // Replace using the alternative pattern
    const newContent = content.replace(altPattern, REVIEW_WORKFLOW_BLOCK.trim());
    return { patched: true, reason: 'patched-alt', content: newContent };
  }

  const newContent = content.replace(allDonePattern, REVIEW_WORKFLOW_BLOCK.trim());
  return { patched: true, reason: 'patched', content: newContent };
}

/**
 * Patch openspec-propose SKILL.md: add a note about os-stronger review.
 */
function patchPropose(content) {
  if (content.includes(PROPOSE_MARKER)) {
    return { patched: false, reason: 'already-patched', content };
  }

  // Find the end of the Guardrails section (last section before EOF)
  const guardrailsSection = content.lastIndexOf('**Guardrails**');
  if (guardrailsSection === -1) {
    // Try to append at the very end of the file
    const trimmed = content.trimEnd();
    const newContent = trimmed + '\n\n' + PROPOSE_BLOCK.trim() + '\n';
    return { patched: true, reason: 'patched-end', content: newContent };
  }

  // Find the end of the Guardrails section (next "---" or EOF)
  const afterGuardrails = content.indexOf('\n---', guardrailsSection);
  const insertAt = afterGuardrails !== -1 ? afterGuardrails : content.length;
  
  const newContent = content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt);
  return { patched: true, reason: 'patched-guardrails', content: newContent };
}

/**
 * Create a backup of a file before patching.
 */
function backup(filePath) {
  const backupPath = filePath + '.os-stronger.bak';
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/**
 * Restore from backup.
 */
function restore(filePath) {
  const backupPath = filePath + '.os-stronger.bak';
  if (fs.existsSync(backupPath)) {
    fs.copyFileSync(backupPath, filePath);
    fs.unlinkSync(backupPath);
    return true;
  }
  return false;
}

/**
 * Scan a project directory for all OpenSpec skill installations.
 * Returns array of { toolDir, skillPath } for each openspec-apply-change found.
 */
function findOpenSpecSkills(projectDir) {
  const found = [];
  for (const toolDir of TOOL_SKILLS_DIRS) {
    const skillsDir = path.join(projectDir, toolDir, 'skills');
    if (!fs.existsSync(skillsDir)) continue;
    try {
      const entries = fs.readdirSync(skillsDir);
      for (const entry of entries) {
        if (!entry.startsWith('openspec-')) continue;
        const skillDir = path.join(skillsDir, entry);
        const skillFile = path.join(skillDir, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          found.push({ toolDir, skillName: entry, skillFile });
        }
      }
    } catch (e) {
      // Skip directories we can't read
    }
  }
  return found;
}

module.exports = {
  patchApplyChange,
  patchPropose,
  backup,
  restore,
  findOpenSpecSkills,
  PATCH_MARKER,
  PROPOSE_MARKER,
  OPENSEC_SKILLS,
  TOOL_SKILLS_DIRS,
};
