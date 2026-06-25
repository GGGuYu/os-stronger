---
name: os-stronger-goal
description: Orchestrate long-running goals by decomposing them into multiple sequential OpenSpec changes. Use when the user wants to build something too large for a single change, mentions "goal", "长程目标", or when multiple changes need coordinated execution. The CLI is the single source of truth — always go through `os-stronger goal` commands.
---

# os-stronger-goal

Orchestrate long-running goals by breaking them into multiple OpenSpec changes.
You are the **orchestrator**. Sub-agents do the heavy lifting with fresh context.
The CLI (`os-stronger goal`) is your state center — always go through it.

**Key principles:**
- **Alternating flow**: propose → apply → propose → apply (not batch)
- **One change per sub-agent**: each sub-agent gets fresh context
- **CLI is the brain**: `os-stronger goal instructions --json` tells you exactly what to do next
- **State on disk**: if your session breaks, re-running `instructions` resumes from where you left off
- **OpenSpec skills are the foundation**: sub-agents MUST follow OpenSpec's own skills (openspec-propose, openspec-apply-change, openspec-archive-change) when doing their work. Goal orchestration wraps OpenSpec, it does not replace it.

---

## OpenSpec Concepts You Need to Know

You are an orchestrator. You don't write code or create OpenSpec artifacts yourself — sub-agents do. But you need to understand what they're doing to orchestrate effectively.

| Concept | What it means | What the sub-agent produces |
|---|---|---|
| **change** | A unit of work in OpenSpec. One change = one folder under `openspec/changes/<name>/`. A goal breaks a large objective into multiple sequential changes. | A change folder with artifacts |
| **propose** | The planning phase. A sub-agent reads the requirement, explores the codebase, and writes the plan. | `proposal.md` (why + what), `design.md` (how), `specs/` (requirements), `tasks.md` (checklist) |
| **apply** | The implementation phase. A sub-agent reads the plan, writes code, and marks tasks complete. | Code changes + `[x]` marks in `tasks.md` |
| **archive** | The completion phase. Merges specs into `openspec/specs/` (so future changes can reference them), moves the change to `archive/`. Two steps: `openspec archive` (merge specs) → `os-stronger goal change archive` (update goal state). | Specs merged, change folder moved to archive |
| **test change** | A special change that validates the entire goal against acceptance criteria. It performs **semantic evaluation FIRST** (independent assessment of whether acceptance criteria are met, based on completed change artifacts — before writing any test code), then writes and runs goal-level integration/acceptance tests. | Evaluation results + test code + test results |
| **fix change** | A change created after a test change fails. Surgical fix, not refactor. Goes through normal propose → apply → archive. | Bug fix code |

**Your role**: You decide WHAT change to do next (via CLI). Sub-agents decide HOW to do it (via OpenSpec skills). You never write proposal.md or code yourself.

## Orchestration Mindset

**Why CLI is your brain**: Goal state lives on disk (`openspec-goals/goal_<name>/state.json`), not in your conversation. After every action, call `os-stronger goal instructions --goal <name> --json` — the CLI reads the state and tells you exactly what to do next. You never guess or remember. If your session breaks, `instructions` resumes from where you left off.

**What `instructions --json` gives you**:
- `nextAction.type`: the action you must take (`propose_next`, `apply_next`, `fix_analysis_needed`, `circuit_break`, `blocked`, `done`)
- `nextAction.subagentPrompt`: a complete, self-contained prompt to pass to a sub-agent — you don't write it yourself
- `nextAction.instruction`: step-by-step instructions for you (the orchestrator), including which CLI commands to run after the sub-agent returns
- `contextForSubagent`: context data (goal description, all changes overview, completed change artifact paths) that the sub-agent needs

**Why sub-agents**: Each propose/apply needs to read specs, write code, run tests — that's heavy context. If you did it all yourself, your context would bloat after 2-3 changes and quality would degrade. Sub-agents start fresh every time. Your context stays thin: you only hold the orchestration logic, not the implementation details.

**Your decision boundaries**:
- You **DO**: align goal with user, decompose into changes, dispatch sub-agents, call CLI to advance state, handle circuit breaks
- You **DO NOT**: write proposal.md, write code, create specs, run tests, decide implementation approach, **inspect what a running sub-agent is doing**
- When a sub-agent returns: check if it succeeded or failed (for test changes), then call `instructions` — don't try to evaluate the code yourself
- **While a sub-agent is running**: do nothing. Wait for its report. Polling its progress or checking its files wastes tokens — the sub-agent will return when it's done (or stuck). Your only triggers are its return or the user. (Note: "checking for active sub-agents *before* you dispatch" is a different, necessary step to prevent duplicate dispatch — see STRICTLY SERIAL below. That is not polling.)

---

## Phase 0: Goal Creation & Decomposition

1. **Align with user**: Understand the goal. Use AskUserQuestion if needed.

2. **Explore scope**: Read and follow the `openspec-explore` skill in your project's skills directory (e.g., `.claude/skills/openspec-explore/SKILL.md`, `.codex/skills/openspec-explore/SKILL.md`, etc.) to deeply understand the domain and codebase before decomposing. This ensures change boundaries are well-informed. **Important: use explore only as a thinking tool to understand the domain — do NOT follow explore's suggestions to create changes or proposals. After exploring, return to the goal workflow (step 3 below).**

3. **Collect reference materials**: Before writing goal.md, proactively ask the user (via AskUserQuestion) whether they have reference materials — GitHub projects, URLs, images, design mockups, style references, API docs, etc. Anything the user mentions in conversation that the fresh-context sub-agents will need. For each item, record: what it is + why it's relevant + link or local path. These go into goal.md's `## 参考资料` section in step 5. **Why this matters**: sub-agents are fresh context — materials the user gave you in conversation do NOT appear in their context unless written into goal.md. Skipping this loses the design intent and references, and sub-agents may drift from the goal. If the user has none, leave the section as a placeholder.

4. **Create the goal**:
   ```bash
   os-stronger goal create --name <goal-name> --description "..."
   ```

5. **Write goal.md**: Edit `openspec-goals/goal_<name>/goal.md` — this is the **design intent + reference center** that every fresh-context sub-agent reads. Fill in ALL sections (the template has placeholder guidance in HTML comments):
   - **目标**: detailed goal description + motivation (why this goal exists)
   - **宏观架构**: module breakdown / component relationships / tech-stack choices. May include architecture diagram links. This is the sub-agent's "global map" — without it they see trees but not the forest.
   - **设计规范**: visual style / colors / interaction norms / API style / naming conventions. Any style references the user gave in conversation MUST land here, or fresh-context sub-agents won't have them.
   - **测试维度**: what dimensions goal-level acceptance must cover (integration points / boundaries / performance / compat / error handling) — macro dimensions, not a unit-test list.
   - **参考资料**: the materials collected in step 3 (what + why + link/path). Only links/paths — never paste the content itself (sub-agents read it themselves; this honors decision 8: pass paths not content).
   - **验收标准**: checkable acceptance criteria (every item should be testable). This is what the test change's semantic evaluation checks against item by item — be specific and judgeable.

   Write it in detail but keep it macro — this is design intent, not implementation detail. The richer and more accurate goal.md is, the less sub-agents drift.

6. **Assess complexity & plan change decomposition**: Before registering changes, write a brief complexity assessment in goal.md's `## 宏观架构` section — for each planned change: its scope, dependencies, estimated effort (S/M/L), and why this granularity. Guidance: especially complex or tightly-coupled parts can be split into multiple changes; don't pack too much into one change, and don't split so fine you lose coherence. This is only a decomposition reference — final granularity is your call. **No new state fields, no CLI parameters — this is just a thinking framework written into goal.md.**

7. **Decompose into changes**: Think about what changes are needed.
   - Break the goal into sequential, reasonably-sized work units (informed by the complexity assessment in step 6)
   - **Order matters**: changes are executed in the order you register them (serial, one at a time). Register them in execution order — foundational changes first, then dependent changes, and test change last.
   - **The LAST change must be a test change** (`--type test`)
   - The test change validates the goal against acceptance criteria in goal.md
   - Minimum 2 changes (at least 1 implementation + 1 test)

   **Granularity — don't over-split.** A change is a coherent unit of work, not a single task. Small tasks that serve one purpose belong in the *same* change (as multiple tasks in its tasks.md), not as separate changes. Only split into multiple changes when the parts are genuinely separate modules — splitting them gives cleaner fresh-context sub-agents and better isolation, and the parts are large enough to be worth their own propose→apply cycle.
   - **Rule of thumb**: can this be described and done as one coherent piece with a handful of tasks? Yes → one change. Does it span clearly separate modules that each need their own design? → multiple changes.
   - **Anti-pattern**: one change per task. "Write the text" / "make the SRT" / "write the storyboard" as three separate changes when they're really one cohesive "produce the script" effort — that's over-splitting (more propose→apply cycles, more context-switching, no benefit).

   **Small goals are fine too.** Not every goal needs 5+ changes. If the whole thing is modest in scope, **one implementation change + one test change (1+1)** is a perfectly valid use of goal — you still get the test change's semantic evaluation + test as a built-in review. Don't pad a small goal with artificial changes.

8. **Register each change** in execution order:
   ```bash
   os-stronger goal change add --goal <goal-name> --id <id> --title "..." --type normal
   # ... for each implementation change ...
   os-stronger goal change add --goal <goal-name> --id testchange_1 --title "Goal 级测试" --type test
   ```

9. **Show the change list to user for confirmation.**

10. **Enter the loop**:
    ```bash
    os-stronger goal instructions --goal <goal-name> --json
    ```

### Dynamic change planning (changes can evolve)

The change list is **not** frozen at registration. You may start with only a front-loaded change + the test change, and append more changes *after* earlier ones reveal what's needed. This is the intended pattern when later changes depend on the artifacts of earlier ones — you can't plan them all upfront.

**How to append a change mid-way** — when a change archives and you now know what comes next, register the new change and it will be inserted **before the test change** automatically (so it runs before the final validation):

```bash
# After change1 archives, you realize change2 is needed:
os-stronger goal change add --goal <goal-name> --id change2 --title "..." --type normal
# ↑ smart default: normal change is auto-inserted before the active testchange.
#   Explicit control: --before <id> inserts before a specific change.
os-stronger goal change add --goal <goal-name> --id change3 --title "..." --before testchange_1
```

**Example — a video-production goal** (later changes depend on earlier artifacts):

> You can't know how many "shot" changes to register until the storyboard exists.
>
> - **Start**: register `change1` (generate script) + `testchange_1` (validate the final video). That's it — you don't yet know the middle.
> - **change1 archives** → you read its script artifact, now you know the structure. Update goal.md's `## 宏观架构` with what you learned, then register `change2` (script → SRT timeline) — it auto-inserts before `testchange_1`.
> - **change2 archives** → the SRT reveals there are, say, 15 shots. Register `change3` (SRT → storyboard). Then register shot-implementation changes as the storyboard dictates.
> - Keep evolving until the pipeline is complete, then `testchange_1` runs last.
>
> goal.md's change plan is a **living document** — update its `## 宏观架构` section as each change completes (turn "tentative" into "actual", note new module relationships). But remember: goal.md is design intent, `state.changes` is ground truth for execution order. Sub-agents read goal.md for context, the state machine drives execution.

**When you CAN'T plan all changes upfront, that's not a failure — it's the dynamic-planning pattern.** Start with what's certain (the front + the test), append the middle as it reveals itself.

---

## The Loop

Parse `nextAction.type` from CLI output and dispatch.

### `propose_next`

A sub-agent must propose the next change. The CLI returns `subagentPrompt` — pass it directly to the sub-agent.

**Launch a sub-agent** with fresh context. Pass `nextAction.subagentPrompt` as the task.

The sub-agent prompt (generated by CLI) already instructs it to:
- Follow the `openspec-propose` skill workflow
- Create proposal.md, design.md, tasks.md per OpenSpec conventions
- Add the goal archive task as the last task in tasks.md

After the sub-agent returns:
```bash
os-stronger goal change propose --goal <goalName> --id <changeId>
os-stronger goal instructions --goal <goalName> --json
```

### `apply_next`

A sub-agent must apply (implement) the next change. The CLI returns `subagentPrompt` — pass it directly.

**Launch a sub-agent** with fresh context. Pass `nextAction.subagentPrompt` as the task.

The sub-agent prompt (generated by CLI) already instructs it to:
- Follow the `openspec-apply-change` skill workflow
- Read context files (proposal, design, specs, tasks) per OpenSpec conventions
- Implement tasks sequentially, marking each complete
- The LAST task runs OpenSpec archive (`openspec archive --change <name>`) to merge specs, then runs goal archive (`os-stronger goal change archive`) to update goal state

After the sub-agent returns:
```bash
os-stronger goal instructions --goal <goalName> --json
```

### `fix_analysis_needed`

A test change failed. You need to analyze the failure and create fix change(s).

1. **Launch analysis sub-agent** (fresh context): Give it:
   - goal.md path
   - All completed change artifact paths (from `contextForSubagent.completedChangeArtifacts`)
   - The failed test change's tasks.md path
   - The failure summary (from `nextAction.failureSummary`)
   - Ask it to identify which modules need fixing and what to fix

2. **Register fix change(s)** based on analysis — **mind the granularity**:
   - **Default: one fix change holds all the small fixes this round.** Put multiple independent small problems as separate tasks in the *same* fix change's tasks.md, rather than opening one fix change per problem.
   - **Only split into multiple fix changes when a problem is "big"** — needs a refactor, a module rewrite, an architecture adjustment, or high coupling that requires isolated design. For those, a single fix change isn't enough and deserves its own propose→apply cycle.
   - **Rule of thumb:** can this fix be described and done in 1-2 tasks? Yes → fold it into the shared fix change. No, it needs its own design → separate fix change.
   - **Anti-pattern:** the failure report lists 3 unsatisfied items, so you mechanically open 3 fix changes. Unless each is a big fix, this is over-splitting — multiple fix changes mean multiple propose→apply→archive cycles, multiplied context-switching and token cost, and small fixes are often related so splitting them risks missing the connection.

   ```bash
   # Default: single fix change for the whole round
   os-stronger goal change add --goal <goalName> --id fixchange_<cycle> --title "..." --type fix
   # Only when truly splitting into multiple: add a short tag suffix
   os-stronger goal change add --goal <goalName> --id fixchange_<cycle>-<short-tag> --title "..." --type fix
   ```

3. **Continue the loop**: The CLI will dispatch propose → apply for fix changes.
   Fix changes go through the same OpenSpec propose/apply skills as normal changes.
   After all fix changes are archived, the CLI **automatically inserts** the next testchange.

### Test change apply fails

When a test change sub-agent reports failures (either **semantic evaluation failure** or **test failure**):

1. **Report to CLI**:
   ```bash
   os-stronger goal test-failed --goal <goalName> --test-change <id> --summary "失败摘要"
   ```
   The summary should include the failure type (semantic evaluation / test failure), specific details, and suggested fix directions.

2. **Check the result**:
   - If `circuitBreak: true` → handle as `circuit_break` below
   - If `circuitBreak: false` → continue to step 3

3. Run `os-stronger goal instructions --goal <goalName> --json` to get `fix_analysis_needed`.

**Semantic evaluation vs test failure**: Both go through the same fix → test → circuit break flow. The difference is only in what the fix changes need to address — semantic evaluation failures mean the implementation doesn't meet acceptance criteria (missing features, wrong direction), while test failures mean the code has bugs.

### `circuit_break`

Fix-Test loop has exceeded the limit. **STOP** and notify the user:

1. Show: failure summary, attempted fix changes, recommendation
2. Tell user: after manual fix, run `os-stronger goal resume --goal <goalName>`
3. **Do NOT continue** — wait for user action

### `blocked`

Show user: "Change `<id>` is blocked: `<reason>`"
Ask what to do. After resolution:
```bash
os-stronger goal change unblock --goal <goalName> --id <id>
os-stronger goal instructions --goal <goalName> --json
```

### `done`

Notify user: "Goal `<goalName>` achieved! 🎉"

---

## Session Recovery

If your session was interrupted (user closed IDE, context was cleared, etc.):

1. User says "继续 goal xxx" or similar
2. Run:
   ```bash
   os-stronger goal instructions --goal <goalName> --json
   ```
3. The CLI returns the exact next action — resume from there

**You do not need to remember anything.** The state is on disk.

---

## Guardrails

- **Always use sub-agents** for propose and apply — keep your orchestrator context thin
- **DO NOT inspect sub-agent work — wait for their report** — your job is orchestration, not supervision. Once you dispatch a sub-agent (propose or apply), **hand off and wait**. Do NOT check what the sub-agent is doing, do NOT poll its progress, do NOT read its in-progress files, do NOT run `os-stronger goal status` to see if it's done. Sub-agent work (reading specs, writing code, running tests) is inherently long — repeatedly checking wastes tokens and adds nothing. The only correct signals are: (a) the sub-agent returns with its report ("Propose complete for change X" / "Apply complete for change X" / "Test failed: ..."), or (b) the user tells you something. Act only on those.
- **STRICTLY SERIAL — one sub-agent at a time** — two sub-agents running simultaneously will collide on the same change. **Before dispatching**: check if there are any active sub-agents from previous steps; if yes, wait for them to return (do NOT dispatch a second one). **After dispatching**: wait for its report — do not poll its progress (see the rule above). The flow is always: check no active sub-agents → dispatch ONE sub-agent → wait for it to return → run CLI command → run instructions → repeat.
- **Never skip `os-stronger goal instructions`** between steps — it is your single source of truth
- **Never manually edit state.json** — always go through CLI commands
- **MUST auto-archive — no user confirmation needed** — in goal mode, when a change's tasks are all complete (and review passes if review enhancement is enabled), the agent MUST archive immediately via `os-stronger goal change archive`. Do NOT ask the user whether to archive. Do NOT pause for user confirmation. The only time the user is involved is: (1) during explore/goal definition, (2) when a circuit break fires, (3) when the goal is done. Everything in between is autonomous.
- **Test change failure is expected** — it's part of the flow, not an error. Failures can come from semantic evaluation (acceptance criteria not met) or test execution (code bugs). Both trigger the same fix → test → circuit break flow.
- **Fix changes should be surgical** — fix the problem, don't refactor
- **Archive completed goals** — when `nextAction.type === "done"`, the CLI will suggest running `os-stronger goal archive --goal <name>`. This is optional but recommended to keep the active goal list clean. Archived goals move to `openspec-goals/archive/`.

---

## Coexistence with Other Enhancements

os-stronger-goal is an **independent skill** — it does NOT patch any OpenSpec skill files.
It coexists transparently with `review` and `skill-align`:

- Goal's sub-agents running `openspec-propose` will trigger skill-align (if enabled)
- Goal's sub-agents running `openspec-apply-change` will trigger review (if enabled)
- Goal itself does not need to know about them

**Important: Archive behavior in goal mode** — the `review` enhancement normally asks the user whether to archive after review passes. In goal mode, this behavior is **overridden**: the agent MUST archive autonomously without asking the user. Goal mode is designed to run end-to-end without human intervention between changes. The user only comes back at circuit break or completion.

---

## CLI Reference

```
os-stronger goal create --name <name> --description "..." [--max-fix-cycles 3]
os-stronger goal change add --goal <name> --id <id> --title "..." [--type normal|test|fix] [--test-cycle N] [--based-on <id>]
os-stronger goal change propose --goal <name> --id <id>
os-stronger goal change archive --goal <name> --id <id>
os-stronger goal change block --goal <name> --id <id> --reason "..."
os-stronger goal change unblock --goal <name> --id <id>
os-stronger goal instructions --goal <name> --json
os-stronger goal test-failed --goal <name> --test-change <id> --summary "..."
os-stronger goal resume --goal <name>
os-stronger goal archive --goal <name>
os-stronger goal delete --goal <name>
os-stronger goal status --goal <name>
os-stronger goal list [--all]
```
