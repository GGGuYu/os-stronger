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
- **OpenSpec skills are the foundation**: sub-agents MUST follow OpenSpec's own skills (openspec-propose, openspec-apply-change, openspec-archive) when doing their work. Goal orchestration wraps OpenSpec, it does not replace it.

---

## OpenSpec Concepts You Need to Know

You are an orchestrator. You don't write code or create OpenSpec artifacts yourself — sub-agents do. But you need to understand what they're doing to orchestrate effectively.

| Concept | What it means | What the sub-agent produces |
|---|---|---|
| **change** | A unit of work in OpenSpec. One change = one folder under `openspec/changes/<name>/`. A goal breaks a large objective into multiple sequential changes. | A change folder with artifacts |
| **propose** | The planning phase. A sub-agent reads the requirement, explores the codebase, and writes the plan. | `proposal.md` (why + what), `design.md` (how), `specs/` (requirements), `tasks.md` (checklist) |
| **apply** | The implementation phase. A sub-agent reads the plan, writes code, and marks tasks complete. | Code changes + `[x]` marks in `tasks.md` |
| **archive** | The completion phase. Merges specs into `openspec/specs/` (so future changes can reference them), moves the change to `archive/`. Two steps: `openspec archive` (merge specs) → `os-stronger goal change archive` (update goal state). | Specs merged, change folder moved to archive |
| **test change** | A special change that validates the entire goal against acceptance criteria (not unit tests — goal-level integration/acceptance tests). | Test code + test results |
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
- You **DO NOT**: write proposal.md, write code, create specs, run tests, decide implementation approach
- When a sub-agent returns: check if it succeeded or failed (for test changes), then call `instructions` — don't try to evaluate the code yourself

---

## Phase 0: Goal Creation & Decomposition

1. **Align with user**: Understand the goal. Use AskUserQuestion if needed.

2. **Explore scope**: Read and follow the `openspec-explore` skill in your project's skills directory (e.g., `.claude/skills/openspec-explore/SKILL.md`, `.codex/skills/openspec-explore/SKILL.md`, etc.) to deeply understand the domain and codebase before decomposing. This ensures change boundaries are well-informed. **Important: use explore only as a thinking tool to understand the domain — do NOT follow explore's suggestions to create changes or proposals. After exploring, return to the goal workflow (step 3 below).**

3. **Create the goal**:
   ```bash
   os-stronger goal create --name <goal-name> --description "..."
   ```

4. **Write goal.md**: Edit `openspec-goals/goal_<name>/goal.md` — fill in:
   - **目标**: detailed goal description
   - **验收标准**: checkable acceptance criteria (every item should be testable)

5. **Decompose into changes**: Think about what changes are needed.
   - Break the goal into sequential, reasonably-sized work units
   - **Order matters**: changes are executed in the order you register them (serial, one at a time). Register them in execution order — foundational changes first, then dependent changes, and test change last.
   - **The LAST change must be a test change** (`--type test`)
   - The test change validates the goal against acceptance criteria in goal.md
   - Minimum 2 changes (at least 1 implementation + 1 test)

6. **Register each change** in execution order:
   ```bash
   os-stronger goal change add --goal <goal-name> --id <id> --title "..." --type normal
   # ... for each implementation change ...
   os-stronger goal change add --goal <goal-name> --id testchange_1 --title "Goal 级测试" --type test
   ```

7. **Show the change list to user for confirmation.**

8. **Enter the loop**:
   ```bash
   os-stronger goal instructions --goal <goal-name> --json
   ```

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

A test change failed. You need to analyze the failure and create fix changes.

1. **Launch analysis sub-agent** (fresh context): Give it:
   - goal.md path
   - All completed change artifact paths (from `contextForSubagent.completedChangeArtifacts`)
   - The failed test change's tasks.md path
   - The failure summary (from `nextAction.failureSummary`)
   - Ask it to identify which modules need fixing and what to fix

2. **Register fix changes** based on analysis:
   ```bash
   os-stronger goal change add --goal <goalName> --id fixchange_1-<module> --title "..." --type fix
   ```

3. **Continue the loop**: The CLI will dispatch propose → apply for fix changes.
   Fix changes go through the same OpenSpec propose/apply skills as normal changes.
   After all fix changes are archived, the CLI **automatically inserts** the next testchange.

### Test change apply fails

When a test change sub-agent reports test failures:

1. **Report to CLI**:
   ```bash
   os-stronger goal test-failed --goal <goalName> --test-change <id> --summary "失败摘要"
   ```

2. **Check the result**:
   - If `circuitBreak: true` → handle as `circuit_break` below
   - If `circuitBreak: false` → continue to step 3

3. Run `os-stronger goal instructions --goal <goalName> --json` to get `fix_analysis_needed`.

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
- **STRICTLY SERIAL — one sub-agent at a time** — NEVER have two sub-agents running simultaneously. Before dispatching a sub-agent, check if there are any active sub-agents from previous steps. If yes, wait for them to complete (or close them) before dispatching. The flow is always: check no active sub-agents → dispatch ONE sub-agent → wait for it to return → run CLI command → run instructions → repeat.
- **Never skip `os-stronger goal instructions`** between steps — it is your single source of truth
- **Never manually edit state.json** — always go through CLI commands
- **MUST auto-archive — no user confirmation needed** — in goal mode, when a change's tasks are all complete (and review passes if review enhancement is enabled), the agent MUST archive immediately via `os-stronger goal change archive`. Do NOT ask the user whether to archive. Do NOT pause for user confirmation. The only time the user is involved is: (1) during explore/goal definition, (2) when a circuit break fires, (3) when the goal is done. Everything in between is autonomous.
- **Test change failure is expected** — it's part of the flow, not an error
- **Fix changes should be surgical** — fix the problem, don't refactor
- **Archive completed goals** — when `nextAction.type === "done"`, the CLI will suggest running `os-stronger goal archive --goal <name>`. This is optional but recommended to keep the active goal list clean. Archived goals move to `openspec-goals/archive/`.
- If a sub-agent seems stuck, check `os-stronger goal status --goal <name>` and re-dispatch

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
os-stronger goal create --name <name> --description "..." [--max-fix-cycles 2]
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
