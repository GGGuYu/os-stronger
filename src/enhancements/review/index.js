// src/enhancements/review/index.js
// review 增强: 全部 task 完成后起子 agent 审查,档位化(low/maxCycle=2, high/maxCycle=3 严格第二轮普通, max/严格+双子agent交叉), 熔断兜底。

const PATCH_MARKER = '<!-- OS-STRONGER-REVIEW -->';
const PROPOSE_MARKER = '<!-- OS-STRONGER-REVIEW-PROPOSE -->';

const REVIEW_WORKFLOW_BLOCK = `
${PATCH_MARKER}
   **⚠️ 你现在走的是 OpenSpec 的工作流,不是普通的自由发挥。** 本次 apply 的计划就是 OpenSpec 这次提案的 \`tasks.md\`——它就是你的 todo list / 任务列表。你必须维护 OpenSpec 的 task 文档:做完一个任务就在 \`tasks.md\` 把对应的 \`- [ ]\` 标成 \`- [x]\`,这是 OpenSpec 判断进度、触发 review、推进 change 状态的唯一依据。在 OpenSpec 工作流下,**系统内置的 todo 工具不是你的主任务列表**——不要用它替代 \`tasks.md\` 的维护(可以用它镜像状态给用户看,但"完成"这个动作必须落在 \`tasks.md\` 的 \`[x]\` 上)。无视 \`tasks.md\`、只用内置 todo 会导致 OpenSpec 流程断掉、change 卡住。

   **os-stronger review workflow** — triggered when the current task is a Review task (e.g. "Review: 按照...启动 Review N...") OR when \`state: "all_done"\` is reached without a Review task having run yet.

   **When you encounter a Review task** (the task description contains "Review" and "启动 Review"):

     **STEP 0 — TIER PARSE + CIRCUIT BREAKER (highest priority, check FIRST before anything else)**:
     1. **Parse tier**: read the CURRENT Review task's text for \`[tier=<low|high|max>]\`. If found, \`tier\` = that value. If not found (older changes without a tier tag), default \`tier = 'low'\` (backward compatible).
     2. **Compute maxCycle**: \`maxCycle = (tier === 'low') ? 2 : 3\`.
     3. **Circuit breaker**: scan \`tasks.md\` for \`Review N Fix -\` markers. Find the highest N where all \`Review N Fix\` tasks are \`[x]\`. Call it \`lastCompleted\`.
        - If \`lastCompleted >= maxCycle\`: **STOP. Do NOT launch subagents. Mark this Review task \`[x]\`. Ask user: "Review 已完成 \${maxCycle} 轮(硬上限,tier=\${tier}),是否归档此 change?" Do NOT auto-archive.** Hard limit, no exceptions.
        - This check fires BEFORE steps 0a-f. Skip them entirely if it fires.

     **Tier semantics reference** (main agent's per-cycle strictness, applies to STEP d/f):
     - \`low\`  (maxCycle=2): every cycle — fix only issues that are BOTH true AND worth immediate fix. No "strict" cycle.
     - \`high\` (maxCycle=3): \`currentCycle === 1\` → strict: fix issues that are true (issues not worth fixing *may* still be skipped, but lean toward fixing). \`currentCycle >= 2\` → normal: prioritize correctness, minor issues can wait.
     - \`max\`  (maxCycle=3): same strictness curve as \`high\`, PLUS \`currentCycle === 1\` launches **two** independent review sub-agents (see STEP c).
     - Note on the FINAL cycle (STEP c): when \`currentCycle === maxCycle\`, the review subagent is briefed to "only flag CRITICAL issues". This is a subagent-side narrowing of *what to report*, independent of your main-agent strictness above — you still apply your tier's judgment to whatever it returns (a CRITICAL it flags still needs your "true + worth fixing" check; a non-CRITICAL it omits you simply won't see). So there's no conflict: the FINAL briefing makes the last cycle lighter on the subagent side, which pairs naturally with the tiered strictness easing in later cycles.

     0a. Check if \`.os-stronger/review-guide.md\` exists in the project root (**only check existence, do NOT read its contents**). If it does NOT exist, skip review and mark this task \`[x]\`.
     a. **Write requirement summary** to \`.os-stronger/requirement-summary.md\` (overwrite if exists). Base it on proposal.md + design.md.
     b. **Determine review cycle** (same scan as STEP 0, now knowing lastCompleted < maxCycle):
        - No completed markers → \`currentCycle = 1\`.
        - \`lastCompleted\` exists and < maxCycle → \`currentCycle = lastCompleted + 1\`.
     c. **Launch review subagent(s)**:
        First, run \`openspec status --change "<name>" --json\` to get \`changeRoot\` and \`artifactPaths\` (do NOT hardcode paths — workspace mode differs).
        Subagent briefing (give each (sub)agent the same briefing):
        - You are reviewing an **OpenSpec change** named **\`<name>\`** (cwd).
        - Read these files (use PATHS from the status JSON):
          - \`.os-stronger/review-guide.md\` — review rules + output format
          - \`.os-stronger/requirement-summary.md\` — what to check against
          - \`tasks.md\` — \`artifactPaths.tasks.resolvedOutputPath\` (or \`existingOutputPaths[0]\`)
          - \`design.md\` — \`artifactPaths.design.resolvedOutputPath\` (if exists)
          - \`proposal.md\` — \`artifactPaths.proposal.resolvedOutputPath\` (if exists)
          - \`git diff HEAD\` — actual changes vs last commit. If not git / empty, read files listed in tasks.md.
        If \`currentCycle === maxCycle\` (FINAL cycle), add: "This is the FINAL review cycle (Review \${maxCycle}). Only flag CRITICAL issues that would break functionality."

        **\`tier === 'max'\` AND \`currentCycle === 1\` ONLY** — launch **two independent** review subagents with the briefing above. Launch in parallel if your platform supports it; otherwise sequentially. After both return: **merge their findings** — deduplicate, cross-confirm items flagged by both (higher confidence), and treat the union as the combined findings input to STEP d/e. (Other tiers and other cycles: single subagent only.)
     d. **Evaluate findings** (per-cycle strictness from Tier semantics above):
        - Is each finding actually TRUE? (use your codebase knowledge)
        - Is it worth fixing now?
        Strictness (cycle 1 of high/max): true → lean fix (skip only if clearly not worth it). Normal (cycle >= 2, or any low cycle): fix only if BOTH true AND worth immediate fix.
     e. **Create fix tasks**: In \`tasks.md\`, add accepted findings:
        \`- [ ] Review \${currentCycle} Fix - <brief>\`
        Example: \`- [ ] Review 1 Fix - Missing error handling in auth module\`
     f. **After review** (uses currentCycle from step b):
        - If NO findings worth fixing: mark Review task \`[x]\`. Ask user: "Review 通过,是否归档此 change?" Do NOT auto-archive.
        - If findings worth fixing AND \`currentCycle < maxCycle\` (cycles remain):
          mark Review task \`[x]\`, do the fix tasks, then add:
          \`- [ ] Review [tier=\${tier}]: 按照 openspec-apply-change skill 中注入的 os-stronger review 工作流,启动 Review \${currentCycle + 1} 子 agent 对本次 change 做独立审查\`
        - If findings worth fixing AND \`currentCycle === maxCycle\` (final cycle, no cycles left):
          mark Review task \`[x]\`, fix them, then the STEP 0 circuit breaker fires on the next Review task. Do NOT add a Review N+1 task. Do NOT auto-archive — ask the user.
        (Reuse the SAME \`tier\` value in every subsequent Review task's \`[tier=...]\` tag — the tier chosen at propose time carries through the whole change's review cycles.)

   **Fallback (ONLY if review was NOT done this round — do NOT re-trigger if review already ran)**:
     - First, check \`tasks.md\`: is there any task containing "Review" that is marked \`[x]\`? If YES → review already happened this round, do NOT trigger again. Ask the user: "是否归档此 change?" Do NOT auto-archive.
     - If NO Review task was ever marked \`[x]\` (review was skipped — e.g. Review task missing from tasks.md, or propose didn't add it): Check if \`.os-stronger/review-guide.md\` exists. If NOT: ask the user whether to archive (unchanged behavior).
     - If it EXISTS: review was skipped this round. Run the workflow above (steps a-f) with \`currentCycle = 1\`, \`tier = 'low'\` (no tier tag to parse → default), then decide archive or add fix tasks + Review 2 task as above.
${PATCH_MARKER}`;

const PROPOSE_BLOCK = `
${PROPOSE_MARKER}
**os-stronger review reminder**: This project has os-stronger review enabled. When generating \`tasks.md\`, you MUST add a **Review task as the last task** (absolute last, after all implementation tasks). Before writing it, ask the user which review tier to use.

**怎么问**(两种都行,任选其一):
- 优先用 **AskUserQuestion**(single-select):"本次 review 用哪档?" 选项 low / high / max(见下)。
- 若平台无 AskUserQuestion 工具,**直接用文本回复问**用户"本次 review 用哪档?(low/high/max,默认 low)"——文本问也是问,一样有效。

**档位说明**(问的时候带上):
- **low** (推荐/默认):最多 2 轮。第 1 轮建议性审查——属实**且值得修**才修。第 2 轮熔断,修完直接 archive。适合多数任务。
- **high**:最多 3 轮。第 1 轮严格——属实的尽量修(不值得也**可**不修,但倾向修)。第 2 轮起回归正确性为主,小问题可不修。第 3 轮熔断。质量要求较高时选。
- **max**:最多 3 轮。第 1 轮严格 **且起两个独立 review 子 agent**(支持并行则并行,否则串行),主 agent 融合两份 findings、交叉确认、属实的能修尽量修。第 2 轮起正确性为主。第 3 轮熔断。最严,也最贵。

**问了没明确答复 → default low,别卡住**:
propose 完本就会停下来等用户确认,这是问档位的天然窗口。但若用户**看到了却没专门答复档位**(沉默 / 含糊 / 只说"继续""随便""你定""默认吧" / 跑题)→ **立即 default \`low\` 继续写 Review task**,不要重复追问、不要阻塞流程。仅当用户明确说出 high / max(或等价表达如"要严格""高质量""多查几轮")才用对应档位。一句话:**问了没明确答复 = low,直接往下走**。(这条与用哪种方式问无关——工具问或文本问,没明确答复都走 low。)

Write the tier into the Review task text using this exact format (the apply workflow parses \`[tier=...]\` from the task):

\`\`\`markdown
- [ ] Review [tier=<low|high|max>]: 按照 openspec-apply-change skill 中注入的 os-stronger review 工作流,启动 Review 1 子 agent 对本次 change 做独立审查
\`\`\`

(This task is not optional — it ensures the review workflow is triggered. The agent executing tasks will see this as the final task and follow the review workflow instructions in openspec-apply-change. Default tier is \`low\` per the rule above — don't block on getting an answer.)
${PROPOSE_MARKER}`;

module.exports = {
  id: 'review',
  label: 'review — 全部 task 完成后起子 agent 审查 (档位: low=2轮 / high=3轮严格 / max=3轮严格+双子agent)',

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
