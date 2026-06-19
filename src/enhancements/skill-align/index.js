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
      // 分层降级:在"写文档前"插入 skill 对齐
      // L1: 步骤4 "Create artifacts in sequence" 之前(精确)
      // L2: **Steps** 之后第一个步骤之前(宽松,靠前但不影响功能)
      // L3: 文件末尾追加(兜底)
      const l1 = content.search(/4\.\s+\*\*Create artifacts in sequence/);
      if (l1 !== -1) {
        const insertAt = content.lastIndexOf('\n', l1);
        return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
      }
      const stepsIdx = content.indexOf('**Steps**');
      if (stepsIdx !== -1) {
        // Steps 之后第一个换行后插入
        const afterSteps = content.indexOf('\n', stepsIdx);
        const insertAt = afterSteps !== -1 ? afterSteps + 1 : content.length;
        return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
      }
      // L3: 插到第一个数字步骤之前(比纯末尾语义正确——"Before writing" 不该放最后)
      const firstStep = content.search(/\n\d+\.\s/);
      if (firstStep !== -1) {
        const insertAt = firstStep; // \n 已含在匹配中,插到步骤行之前
        return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
      }
      // 真的没有步骤,才末尾
      return { patched: true, content: content.trimEnd() + '\n\n' + PROPOSE_BLOCK.trim() + '\n' };
    },
    'openspec-apply-change': (content) => {
      if (content.includes(APPLY_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // 分层降级:在"读上下文文件后"插入 skill 约定提醒
      // L1: "Read context files" 之后到下一个数字步骤之前
      // L2: **Steps** 之后(宽松,靠前但 agent 读到时会注意到)
      // L3: 文件末尾追加(兜底)
      const readContext = content.indexOf('Read context files');
      if (readContext !== -1) {
        const afterRead = content.indexOf('\n', readContext);
        const remainder = content.slice(afterRead);
        const nextStepRel = remainder.search(/\n\d+\.\s/);
        const insertAt = nextStepRel !== -1 ? afterRead + nextStepRel : content.length;
        return { patched: true, content: content.slice(0, insertAt) + '\n' + APPLY_BLOCK.trim() + content.slice(insertAt) };
      }
      const stepsIdx = content.indexOf('**Steps**');
      if (stepsIdx !== -1) {
        const afterSteps = content.indexOf('\n', stepsIdx);
        const insertAt = afterSteps !== -1 ? afterSteps + 1 : content.length;
        return { patched: true, content: content.slice(0, insertAt) + '\n' + APPLY_BLOCK.trim() + content.slice(insertAt) };
      }
      return { patched: true, content: content.trimEnd() + '\n\n' + APPLY_BLOCK.trim() + '\n' };
    },
  },

  // skill-align 不需要额外的支撑文件
  files: [],

  // 不需要单独的 skill 文件 (逻辑全在 patch 里)
  skillTemplate: null,
};
