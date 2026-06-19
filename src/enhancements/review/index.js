// src/enhancements/review/index.js
// review 增强: 全部 task 完成后起子 agent 审查,最多 2 轮,熔断兜底。

const PATCH_MARKER = '<!-- OS-STRONGER-REVIEW -->';
const PROPOSE_MARKER = '<!-- OS-STRONGER-REVIEW-PROPOSE -->';

const REVIEW_WORKFLOW_BLOCK = `
${PATCH_MARKER}
   - If \`state: "all_done"\`:
     - Check if \`.os-stronger/review-guide.md\` exists in the project root (**only check existence, do NOT read its contents** — the review guide is for the subagent, not for you).
     - If it does NOT exist: congratulate, suggest archive (unchanged behavior).
     - If it EXISTS:
       a. **Write requirement summary**: Write a brief summary of what this change was supposed to accomplish to \`.os-stronger/requirement-summary.md\`. Base this on the proposal and design documents. Overwrite if already exists.
       b. **Determine review cycle**: Scan \`tasks.md\` for task lines matching \`Review N Fix -\`. Find the highest N where ALL \`Review N Fix\` tasks are marked \`[x]\` (complete). The current cycle is that N+1. If no completed review markers exist, this is Review 1. (If Review 1 Fix tasks still have \`[ ]\` items, you are still in Review 1 — do NOT advance to Review 2.)
       c. **Launch review subagent**: Use the built-in subagent mechanism. Tell the subagent to read these files (pass PATHS, not contents):
          - \`.os-stronger/review-guide.md\` — review rules and output format
          - \`.os-stronger/requirement-summary.md\` — what to check against
          - \`openspec/changes/<name>/tasks.md\` — what was done
          - \`openspec/changes/<name>/design.md\` — design intent (if exists)
          - \`openspec/changes/<name>/proposal.md\` — original requirements (if exists)
          - \`git diff HEAD\` — actual changes vs last commit. If not a git repo or diff is empty, read the files listed in tasks.md directly.
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

const PROPOSE_BLOCK = `
${PROPOSE_MARKER}
**os-stronger review reminder**: If this project has os-stronger review enabled (check if \`.os-stronger/review-guide.md\` exists), consider adding a final note in the generated tasks.md: "After all tasks complete, the review workflow in openspec-apply-change will trigger automatically — no manual action needed."
${PROPOSE_MARKER}`;

module.exports = {
  id: 'review',
  label: 'review — 全部 task 完成后起子 agent 审查 (最多 2 轮)',

  // 返回要 patch 的文件和对应的 patch 函数
  patches: {
    'openspec-apply-change': (content) => {
      if (content.includes(PATCH_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // 分层降级匹配 all_done 注入点:
      // L1: 精确匹配整句 "If state: all_done: congratulate, suggest archive"
      // L2: 宽松匹配含 all_done 的行(到行尾)
      // L3: 匹配 all_done 关键词所在行(最宽松,只认关键词)
      const l1 = /If `state: "all_done"`:\s*\w+,\s*suggest archive/;
      const l2 = /If `state: "all_done"`:[^\n]*/;
      const l3 = /^.*all_done.*$/m;

      let matched = null;
      for (const p of [l1, l2, l3]) {
        if (p.test(content)) { matched = p; break; }
      }
      if (!matched) return { patched: false, reason: 'pattern-not-found', content };
      return { patched: true, content: content.replace(matched, REVIEW_WORKFLOW_BLOCK.trim()) };
    },
    'openspec-propose': (content) => {
      if (content.includes(PROPOSE_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // propose 的 Guardrails 是最后一节,其后通常无 --- 分隔符。
      // 显式追加到文件末尾(比依赖 indexOf('\n---') 更可靠)。
      return { patched: true, content: content.trimEnd() + '\n\n' + PROPOSE_BLOCK.trim() + '\n' };
    },
  },

  // 要创建的支撑文件 (相对于项目根)
  files: [
    { dest: '.os-stronger/review-guide.md', template: 'review-guide.md' },
  ],

  // 要创建的 skill 说明 (放在每个工具的 skills/os-stronger-review/)
  skillTemplate: 'skill.md',
};
