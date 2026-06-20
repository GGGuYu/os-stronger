// src/enhancements/review/index.js
// review 增强: 全部 task 完成后起子 agent 审查,最多 2 轮,熔断兜底。

const PATCH_MARKER = '<!-- OS-STRONGER-REVIEW -->';
const PROPOSE_MARKER = '<!-- OS-STRONGER-REVIEW-PROPOSE -->';

const REVIEW_WORKFLOW_BLOCK = `
${PATCH_MARKER}
   **os-stronger review workflow** — triggered when the current task is a Review task (e.g. "Review: 按照...启动 Review N...") OR when \`state: "all_done"\` is reached without a Review task having run yet.

   **When you encounter a Review task** (the task description contains "Review" and "启动 Review"):
     0. Check if \`.os-stronger/review-guide.md\` exists in the project root (**only check existence, do NOT read its contents** — the review guide is for the subagent, not for you). If it does NOT exist, skip review and mark this task \`[x]\`.
     a. **Write requirement summary**: Write a brief summary of what this change was supposed to accomplish to \`.os-stronger/requirement-summary.md\`. Base this on the proposal and design documents. Overwrite if already exists.
     b. **Determine review cycle** (single source of truth for cycle number):
        - Scan \`tasks.md\` for task lines matching \`Review N Fix -\`.
        - Find the highest N where ALL \`Review N Fix\` tasks are marked \`[x]\` (complete). Call this \`lastCompleted\`.
        - If no completed review markers exist: \`currentCycle = 1\`.
        - If \`lastCompleted\` exists and \`lastCompleted < 2\`: \`currentCycle = lastCompleted + 1\`.
        - **Circuit breaker**: If \`lastCompleted >= 2\` (Review 2 already fully completed): do NOT launch any subagent. Mark the Review task \`[x]\` and suggest archive. The 2-cycle limit is hard.
     c. **Launch review subagent** (only reached if currentCycle <= 2):
        Use the built-in subagent mechanism. Tell the subagent to read these files (pass PATHS, not contents):
        - \`.os-stronger/review-guide.md\` — review rules and output format
        - \`.os-stronger/requirement-summary.md\` — what to check against
        - \`openspec/changes/<name>/tasks.md\` — what was done
        - \`openspec/changes/<name>/design.md\` — design intent (if exists)
        - \`openspec/changes/<name>/proposal.md\` — original requirements (if exists)
        - \`git diff HEAD\` — actual changes vs last commit. If not a git repo or diff is empty, read the files listed in tasks.md directly.
        If \`currentCycle === 2\`, add: "This is the FINAL review cycle (Review 2). Only flag CRITICAL issues that would break functionality. After this, the change will be archived regardless."
     d. **Evaluate subagent findings**: When the subagent returns, evaluate each finding:
        1. Is it actually TRUE? (use your knowledge of the codebase)
        2. Is it worth fixing IMMEDIATELY? (consider: does the delay of fixing this outweigh the cost?)
        Only create fix tasks for findings that are BOTH true AND worth immediate fix.
     e. **Create fix tasks**: In \`tasks.md\`, add new tasks for accepted findings:
        \`- [ ] Review N Fix - <brief description>\`
        Where N is \`currentCycle\`.
        Example: \`- [ ] Review 1 Fix - Missing error handling in auth module\`
     f. **After review** (uses same currentCycle from step b):
        - If NO findings were worth fixing: mark the Review task \`[x]\`, suggest archive.
        - If \`currentCycle === 1\` and there are fix tasks: mark the Review task \`[x]\`, then do the fix tasks. After all fix tasks are done, add a new task: \`- [ ] Review: 按照 openspec-apply-change skill 中注入的 os-stronger review 工作流,启动 Review 2 子 agent 对本次 change 做独立审查\`. This becomes the next Review trigger.
        - If \`currentCycle === 2\` and there are fix tasks: mark the Review task \`[x]\`, fix them, then the circuit breaker fires — suggest archive. Do NOT add a Review 3 task.

   **Fallback: If \`state: "all_done"\` is reached but the last completed task was NOT a Review task** (meaning this round never ran review — e.g. the Review task was missing from tasks.md, or propose didn't add it):
     - Check if \`.os-stronger/review-guide.md\` exists. If NOT: congratulate, suggest archive (unchanged behavior).
     - If it EXISTS: review was skipped this round. Run the review workflow above (steps a-f) with \`currentCycle = 1\`, then decide archive or add fix tasks + Review 2 task as above.
${PATCH_MARKER}`;

const PROPOSE_BLOCK = `
${PROPOSE_MARKER}
**os-stronger review reminder**: This project has os-stronger review enabled. When generating \`tasks.md\`, you MUST add the following as the **last task**:

\`\`\`markdown
- [ ] Review: 按照 openspec-apply-change skill 中注入的 os-stronger review 工作流,启动 Review 1 子 agent 对本次 change 做独立审查
\`\`\`

This task is not optional — it ensures the review workflow is triggered. The agent executing tasks will see this as the final task and follow the review workflow instructions in openspec-apply-change.
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
      // L2: 宽松匹配含 `state: "all_done"` 的行(到行尾)
      // L3: 匹配含 state 且含 all_done 的行(最宽松,但要求是状态判断行,非解释性文字)
      const l1 = /If `state: "all_done"`:\s*\w+,\s*suggest archive/;
      const l2 = /If `state: "all_done"`:[^\n]*/;
      const l3 = /^(.*state.*all_done.*)$/m;

      let matched = null;
      for (const p of [l1, l2, l3]) {
        if (p.test(content)) { matched = p; break; }
      }
      if (!matched) return { patched: false, reason: 'pattern-not-found', content };
      // 在 all_done 行之前插入 review workflow(保留原行作为兜底)
      return { patched: true, content: content.replace(matched, (m) => REVIEW_WORKFLOW_BLOCK.trim() + '\n   ' + m) };
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
