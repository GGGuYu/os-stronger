---
name: os-stronger-review
description: OpenSpec enhancement — adds independent subagent review before archiving. Automatically active after os-stronger init. When openspec-apply-change reports all tasks complete, a review workflow triggers: requirement summary → subagent review → fix tasks → archive. Max 2 review cycles. Do NOT manually invoke this skill; it activates automatically through the patched openspec-apply-change workflow.
---

# OS-Stronger — OpenSpec Enhancement

This skill is automatically active when a project has been initialized with `os-stronger init`.

## What it does

When you use `openspec-apply-change` and all tasks are marked complete:

1. **Check**: `.os-stronger/review-guide.md` exists? (boolean check — do NOT read its contents)
2. **Write**: requirement summary to `.os-stronger/requirement-summary.md`
3. **Review**: launch a review subagent (pass file paths, not contents)
4. **Evaluate**: judge each subagent finding — is it true? Worth fixing NOW?
5. **Fix**: create `Review N Fix - <desc>` tasks in tasks.md for accepted findings
6. **Cycle**: max 2 review cycles. Review 2 is the final review — archive after.

## Important

- The review guide (`.os-stronger/review-guide.md`) is for the SUBAGENT to read, not you
- You only need to know it EXISTS — pass the path to the subagent
- Subagent findings are advisory, not mandatory
- You decide what's worth fixing now vs. deferring

## Removal

Run `os-stronger init --restore` to remove this enhancement.
