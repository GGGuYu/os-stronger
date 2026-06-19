// src/enhancements/skill-align/index.js
// skill-align 增强: propose 时主动询问用户要用哪些 skill,写入 design.md;
//                    apply-change 时提醒 agent 遵守 skill 约定。

const PROPOSE_MARKER = '<!-- OS-STRONGER-SKILL-ALIGN-PROPOSE -->';
const APPLY_MARKER = '<!-- OS-STRONGER-SKILL-ALIGN-APPLY -->';

// 注入到 openspec-propose: 在 "Read context files" 之前插入 skill 对齐步骤
const PROPOSE_BLOCK = `
${PROPOSE_MARKER}
**Skill Alignment (os-stronger)**: Before writing artifacts, do a skill alignment step:
1. Scan available skills: list all directories matching \`.*/skills/*/\` in the project root (e.g., \`.claude/skills/*/\`, \`.codex/skills/*/\`). For each, read the \`SKILL.md\` frontmatter \`name\` and \`description\`.
2. Based on the user's change request, recommend skills that seem relevant. Present them to the user with the **AskUserQuestion tool** (multiSelect):
   - Question: "Which skills should be prioritized for this change?"
   - Options: each relevant skill's name + short description
3. The user selects skills. Categorize them:
   - **Must-use** (user explicitly selected): the agent SHALL read and actively use these skills during implementation.
   - **Optional** (not selected, but available): the agent MAY use them if relevant, but doesn't have to.
4. Write the alignment result into \`design.md\` under a new section:

\`\`\`markdown
## Skill Alignment

> Managed by os-stronger. Do not remove this section.

**Must-use skills** (read and actively use during implementation):
- \`<skill-name>\` — <one-line description>

**Available but optional**:
- \`<skill-name>\` — <one-line description>
\`\`\`

If the user skips selection (selects nothing), write "No skills explicitly selected — use your judgment."
${PROPOSE_MARKER}`;

// 注入到 openspec-apply-change: 在 "Read context files" 步骤后提醒
const APPLY_BLOCK = `
${APPLY_MARKER}
**Skill Alignment check (os-stronger)**: After reading context files, check if \`design.md\` contains a \`## Skill Alignment\` section. If it does:
- **Must-use skills**: You SHALL read and actively use these skills during implementation. Do not skip them.
- **Optional skills**: Use your judgment — invoke if relevant, skip if not.
If the section is absent or says "No skills explicitly selected", proceed normally without skill constraints.
${APPLY_MARKER}`;

module.exports = {
  id: 'skill-align',
  label: 'skill-align — propose 时主动询问用户要用哪些 skill,写入 design.md',

  patches: {
    'openspec-propose': (content) => {
      if (content.includes(PROPOSE_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // propose 的步骤4是 "Create artifacts in sequence" —— 在这之前插入 skill 对齐
      // (对齐应在写文档前,但在确定 change name 之后)
      const step4 = content.search(/4\.\s+\*\*Create artifacts in sequence/);
      if (step4 === -1) {
        // Fallback: 文件末尾追加
        return { patched: true, content: content.trimEnd() + '\n\n' + PROPOSE_BLOCK.trim() + '\n' };
      }
      // 在步骤4的行首之前插入
      const insertAt = content.lastIndexOf('\n', step4);
      return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
    },
    'openspec-apply-change': (content) => {
      if (content.includes(APPLY_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // Insert after "Read context files" step — find the next numbered step
      const readContext = content.indexOf('Read context files');
      if (readContext === -1) {
        // Fallback: insert before "Show current progress"
        const showProgress = content.indexOf('Show current progress');
        if (showProgress === -1) {
          return { patched: true, content: content.trimEnd() + '\n\n' + APPLY_BLOCK.trim() + '\n' };
        }
        const insertAt = content.lastIndexOf('\n', showProgress);
        return { patched: true, content: content.slice(0, insertAt) + '\n' + APPLY_BLOCK.trim() + content.slice(insertAt) };
      }
      // Find the next numbered step after "Read context files"
      const afterRead = content.indexOf('\n', readContext);
      // search 不支持起始位置,用 slice + search
      const remainder = content.slice(afterRead);
      const nextStepRel = remainder.search(/\n\d+\.\s/);
      const insertAt = nextStepRel !== -1 ? afterRead + nextStepRel : content.length;
      return { patched: true, content: content.slice(0, insertAt) + '\n' + APPLY_BLOCK.trim() + content.slice(insertAt) };
    },
  },

  // skill-align 不需要额外的支撑文件
  files: [],

  // 不需要单独的 skill 文件 (逻辑全在 patch 里)
  skillTemplate: null,
};
