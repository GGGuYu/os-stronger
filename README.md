# os-stronger

**OpenSpec enhancement layer — adds independent subagent review before archiving.**

Works by patching OpenSpec's skill files in-place. After `os-stronger init`, every time `openspec-apply-change` reaches "all tasks complete", a review workflow triggers automatically.

## Install

```bash
git clone https://github.com/GGGuYu/os-stronger.git
cd os-stronger
npm install -g .   # or: ln -s $(pwd)/bin/os-stronger /usr/local/bin/os-stronger
```

## Usage

In any project that already has OpenSpec initialized:

```bash
os-stronger init              # Enhance OpenSpec with review workflow
os-stronger init --restore    # Remove enhancements, restore originals
```

## How it works

1. Scans project for OpenSpec skill installations (supports all 30 tools OpenSpec supports)
2. Patches `openspec-apply-change/SKILL.md` — injects review step at `all_done`
3. Patches `openspec-propose/SKILL.md` — adds review reminder
4. Creates `.os-stronger/review-guide.md` — subagent review rules
5. Creates `os-stronger/SKILL.md` — skill description

## Review workflow

When all OpenSpec tasks complete:

1. **Check**: `.os-stronger/review-guide.md` exists → trigger review
2. **Write**: requirement summary to `.os-stronger/requirement-summary.md`
3. **Review**: launch subagent (reads review-guide.md, requirement-summary, tasks.md, git diff)
4. **Evaluate**: main agent judges each finding — true? worth fixing NOW?
5. **Fix**: create `Review N Fix - <desc>` tasks for accepted findings
6. **Circuit breaker**: max 2 review cycles. Review 2 is final.

## Design

- Zero dependencies, pure Node.js
- Non-invasive: `--restore` undoes everything
- Idempotent: running `init` twice is safe
- Path-passing: main agent never reads review-guide.md (avoids context bloat)
- Advisory findings: subagent's output is suggestions, not commands
