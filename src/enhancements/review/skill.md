---
name: os-stronger-review
description: OpenSpec enhancement — adds tiered independent subagent review before archiving. Automatically active after os-stronger init. propose 时问档位(low/high/max),写进 Review task 的 [tier=...];apply 遇到 Review task 时解析 tier 决定 maxCycle(low=2, high/max=3) + 每轮严格度(max 档第 1 轮起两个独立子 agent 交叉)。Do NOT manually invoke this skill; it activates automatically through the patched openspec-propose / openspec-apply-change workflow.
---

# OS-Stronger — OpenSpec Enhancement

This skill is automatically active when a project has been initialized with `os-stronger init`.

## What it does

**propose 阶段**(openspec-propose skill 被注入):写 tasks.md 末尾的 Review task 前,用 AskUserQuestion 问 review 档位(low/high/max,默认 low),把 `[tier=XXX]` 嵌进 Review 1 task 文字。**问了没明确答复(沉默/含糊/跑题)→ 立即 default low 继续,不重复追问、不阻塞**;AskUserQuestion 不可用 → 直接 low。仅用户明确说 high/max(或"严格""高质量"等)才升档。

**apply 阶段**(openspec-apply-change skill 被注入):遇到 Review task 时:
1. **STEP -1 嵌套自检**:是子 agent(goal 模式等)→ 静默跳过 review
2. **STEP 0 tier 解析 + 熔断**:从 Review task 文字解析 `[tier=XXX]` → `maxCycle = low?2:3`。`lastCompleted >= maxCycle` → 询问用户 archive,不启动子 agent
3. **Check**: `.os-stronger/review-guide.md` exists? (boolean check — do NOT read its contents)
4. **Write**: requirement summary to `.os-stronger/requirement-summary.md`
5. **Review**: launch review subagent (pass file paths, not contents)。**max 档 cycle 1**:起两个独立子 agent(并行优先否则串行),主 agent 融合两份 findings 交叉
6. **Evaluate**: 按 tier 严格度判断每条 finding — low 全程"属实且值得修";high/max cycle 1 严格倾向修、cycle 2+ 正确性为主
7. **Fix**: create `Review N Fix - <desc>` tasks in tasks.md for accepted findings
8. **Cycle**: `currentCycle < maxCycle` 有 fix → 加 `Review [tier=同] N+1` task;`currentCycle === maxCycle` 有 fix → 熔断,询问用户 archive;无 fix → 询问用户 archive

## Tier reference

| tier | maxCycle | cycle 1 | 后续 cycle |
|------|----------|---------|------------|
| low(默认) | 2 | 属实且值得修才修 | cycle 2 熔断 |
| high | 3 | 严格:属实的尽量修 | 正确性为主;cycle 3 熔断 |
| max | 3 | 严格 + 两个独立子 agent 交叉 | 单 agent;cycle 3 熔断 |

## Important

- The review guide (`.os-stronger/review-guide.md`) is for the SUBAGENT to read, not you
- You only need to know it EXISTS — pass the path to the subagent
- Subagent findings are advisory, not mandatory (档位只调"修的倾向",不命令式)
- You decide what's worth fixing now vs. deferring
- archive 决定权在用户,agent 只能询问不能自动做
- goal 模式下 review 静默跳过(嵌套兜底),档位不生效

## Removal

Run `os-stronger init --restore` to remove this enhancement.
