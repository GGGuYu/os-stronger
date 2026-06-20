// src/enhancements/review/index.js
// review 增强: 全部 task 完成后起子 agent 审查,最多 2 轮,熔断兜底。

const PATCH_MARKER = '<!-- OS-STRONGER-REVIEW -->';
const PROPOSE_MARKER = '<!-- OS-STRONGER-REVIEW-PROPOSE -->';

const REVIEW_WORKFLOW_BLOCK = `
${PATCH_MARKER}
   **os-stronger review workflow** — triggered when the current task is a Review task (e.g. "Review: 按照...启动 Review N...") OR when \`state: "all_done"\` is reached without a Review task having run yet.

   **When you encounter a Review task** (the task description contains "Review" and "启动 Review"):

     **STEP 0 — CIRCUIT BREAKER (highest priority, check FIRST before anything else)**:
     Scan \`tasks.md\` for task lines matching \`Review N Fix -\`. Find the highest N where ALL \`Review N Fix\` tasks are marked \`[x]\` (complete). Call this \`lastCompleted\`.
     - If \`lastCompleted >= 2\` (Review 2 already fully completed): **STOP. Do NOT launch any subagent. Do NOT write anything. Mark this Review task \`[x]\`. Then ask the user: "Review 已完成 2 轮(硬上限),是否归档此 change?" Do NOT auto-archive — the user decides.** The 2-cycle limit is HARD. No exceptions.
     - This check must happen before any other step. If it fires, skip steps 0a-f entirely.

     0a. Check if \`.os-stronger/review-guide.md\` exists in the project root (**only check existence, do NOT read its contents** — the review guide is for the subagent, not for you). If it does NOT exist, skip review and mark this task \`[x]\`.
     a. **Write requirement summary**: Write a brief summary of what this change was supposed to accomplish to \`.os-stronger/requirement-summary.md\`. Base this on the proposal and design documents. Overwrite if already exists.
     b. **Determine review cycle** (same scan as STEP 0, but now we know lastCompleted < 2):
        - If no completed review markers exist: \`currentCycle = 1\`.
        - If \`lastCompleted\` exists and \`lastCompleted < 2\`: \`currentCycle = lastCompleted + 1\`.
     c. **Launch review subagent**:
        First, run \`openspec status --change "<name>" --json\` to get the \`changeRoot\` and \`artifactPaths\` (do NOT hardcode \`openspec/changes/<name>/\` — workspace mode uses a different path).
        Use the built-in subagent mechanism. Tell the subagent to read these files (pass PATHS from the status JSON, not hardcoded paths):
        - \`.os-stronger/review-guide.md\` — review rules and output format
        - \`.os-stronger/requirement-summary.md\` — what to check against
        - \`tasks.md\` (from \`artifactPaths.tasks\`) — what was done
        - \`design.md\` (from \`artifactPaths.design\`, if exists) — design intent
        - \`proposal.md\` (from \`artifactPaths.proposal\`, if exists) — original requirements
        - \`git diff HEAD\` — actual changes vs last commit. If not a git repo or diff is empty, read the files listed in tasks.md directly.
        If \`currentCycle === 2\`, add: "This is the FINAL review cycle (Review 2). Only flag CRITICAL issues that would break functionality."
     d. **Evaluate subagent findings**: When the subagent returns, evaluate each finding:
        1. Is it actually TRUE? (use your knowledge of the codebase)
        2. Is it worth fixing IMMEDIATELY? (consider: does the delay of fixing this outweigh the cost?)
        Only create fix tasks for findings that are BOTH true AND worth immediate fix.
     e. **Create fix tasks**: In \`tasks.md\`, add new tasks for accepted findings:
        \`- [ ] Review N Fix - <brief description>\`
        Where N is \`currentCycle\`.
        Example: \`- [ ] Review 1 Fix - Missing error handling in auth module\`
     f. **After review** (uses same currentCycle from step b):
        - If NO findings were worth fixing: mark the Review task \`[x]\`. Then ask the user: "Review 通过,是否归档此 change?" Do NOT auto-archive.
        - If \`currentCycle === 1\` and there are fix tasks: mark the Review task \`[x]\`, then do the fix tasks. After all fix tasks are done, add a new task: \`- [ ] Review: 按照 openspec-apply-change skill 中注入的 os-stronger review 工作流,启动 Review 2 子 agent 对本次 change 做独立审查\`. This becomes the next Review trigger.
        - If \`currentCycle === 2\` and there are fix tasks: mark the Review task \`[x]\`, fix them, then the circuit breaker in STEP 0 will fire on the next Review task. Do NOT add a Review 3 task. Do NOT auto-archive — ask the user.

   **Fallback (ONLY if review was NOT done this round — do NOT re-trigger if review already ran)**:
     - First, check \`tasks.md\`: is there any task containing "Review" that is marked \`[x]\`? If YES → review already happened this round, do NOT trigger again. Ask the user: "是否归档此 change?" Do NOT auto-archive.
     - If NO Review task was ever marked \`[x]\` (meaning review was skipped — e.g. the Review task was missing from tasks.md, or propose didn't add it): Check if \`.os-stronger/review-guide.md\` exists. If NOT: ask the user if they want to archive (unchanged behavior).
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
      // 分层降级匹配注入点:
      // L1: 在 **Handle states:** 整块之前插入(不劈开状态列表)
      // L2: 在 all_done 行之前插入(保留原行,但可能脱离列表缩进)
      // L3: 在含 state+all_done 的行之前插入
      const l1 = /(\*\*Handle states?:\*\*)/;
      const l2 = /If `state: "all_done"`:[^\n]*/;
      const l3 = /^(.*state.*all_done.*)$/m;

      // L1: 在 Handle states 整块之前插入
      if (l1.test(content)) {
        return { patched: true, content: content.replace(l1, REVIEW_WORKFLOW_BLOCK.trim() + '\n\n   $1') };
      }
      // L2/L3: 在 all_done 行之前插入(保留原行)
      let matched = null;
      for (const p of [l2, l3]) {
        if (p.test(content)) { matched = p; break; }
      }
      if (!matched) return { patched: false, reason: 'pattern-not-found', content };
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
