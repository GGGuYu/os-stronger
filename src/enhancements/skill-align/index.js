// src/enhancements/skill-align/index.js
// skill-align 增强: propose 时主动询问用户要用哪些 skill,写入 design.md;
//                    apply-change 时提醒 agent 遵守 skill 约定。

const PROPOSE_MARKER = '<!-- OS-STRONGER-SKILL-ALIGN-PROPOSE -->';
const APPLY_MARKER = '<!-- OS-STRONGER-SKILL-ALIGN-APPLY -->';
const EXPLORE_MARKER = '<!-- OS-STRONGER-SKILL-ALIGN-EXPLORE -->';

// 注入到 openspec-propose: 在 "Read context files" 之前插入 skill 对齐步骤
const PROPOSE_BLOCK = `
${PROPOSE_MARKER}
**Skill Alignment (os-stronger)**: After creating all artifacts (step 4), before showing final status, do a skill alignment step:
1. Scan available skills: list all directories matching \`.*/skills/*/\` in the project root (e.g., \`.claude/skills/*/\`, \`.codex/skills/*/\`). For each, read the \`SKILL.md\` frontmatter \`name\` and \`description\`.
2. Based on the change being proposed, recommend skills that seem relevant for implementation. Present them to the user with the **AskUserQuestion tool** (multiSelect):
   - Question: "Which skills should be prioritized for this change?"
   - Options: each relevant skill's name + short description
3. The user selects skills. Categorize them:
   - **Must-use** (user explicitly selected): the agent SHALL read and actively use these skills during implementation.
   - **Optional** (not selected, but available): the agent MAY use them if relevant, but doesn't have to.
4. Write the alignment result into \`design.md\` (which should now exist from step 4). Append a new section:

\`\`\`markdown
## Skill Alignment

> Managed by os-stronger. Do not remove this section.

**Must-use skills** (read and actively use during implementation):
- \`<skill-name>\` — <one-line description>

**Available but optional**:
- \`<skill-name>\` — <one-line description>
\`\`\`

If \`design.md\` does not exist yet (edge case), create it with just this section. If the user skips selection (selects nothing, or says "随便/随意/你决定"), do NOT force a selection — write "No skills explicitly selected — agent to use its own judgment based on the requirements." and proceed. The skill alignment is advisory, not mandatory.
${PROPOSE_MARKER}`;

// 注入到 openspec-apply-change: 在 "Read context files" 步骤后提醒
const APPLY_BLOCK = `
${APPLY_MARKER}
**Skill Alignment check (os-stronger)**: After reading context files, check if \`design.md\` contains a \`## Skill Alignment\` section. If it does:
- **Must-use skills**: You SHALL read and actively use these skills during implementation. Do not skip them.
- **Optional skills**: Use your judgment — invoke if relevant, skip if not.
If the section is absent or says "No skills explicitly selected", proceed normally without skill constraints.
${APPLY_MARKER}`;

// 注入到 openspec-explore: 在 "Ending Discovery" 段加提醒
const EXPLORE_BLOCK = `
${EXPLORE_MARKER}
**os-stronger reminder**: If exploration feels complete and the user is ready to move forward, suggest entering propose mode (\`openspec-propose\`). When propose runs, os-stronger will automatically remind the agent to do a skill alignment step (asking the user which skills to prioritize). You don't need to do skill alignment here — just let the user know it will happen in propose.
${EXPLORE_MARKER}`;

module.exports = {
  id: 'skill-align',
  label: 'skill-align — propose 时主动询问用户要用哪些 skill,写入 design.md',

  patches: {
    'openspec-propose': (content) => {
      if (content.includes(PROPOSE_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // 分层降级:在"所有 artifact 生成后、show status 前"插入 skill 对齐
      // L1: 步骤5 "Show final status" 之前(精确,此时 design.md 已存在)
      // L2: 步骤4 "Create artifacts" 之后(宽松,靠后)
      // L3: 第一个数字步骤之前(兜底,靠前但语义不坏)
      const l1 = content.search(/5\.\s+\*\*Show final status/);
      if (l1 !== -1) {
        const insertAt = content.lastIndexOf('\n', l1);
        return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
      }
      const step4End = content.search(/4\.\s+\*\*Create artifacts[\s\S]*?\n\d+\.\s/);
      if (step4End !== -1) {
        // 步骤4 内容结束后、下一个步骤之前
        const nextStepMatch = content.slice(step4End).match(/\n(\d+\.\s)/);
        if (nextStepMatch) {
          const insertAt = step4End + nextStepMatch.index;
          return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
        }
      }
      const stepsIdx = content.indexOf('**Steps**');
      if (stepsIdx !== -1) {
        const afterSteps = content.indexOf('\n', stepsIdx);
        const insertAt = afterSteps !== -1 ? afterSteps + 1 : content.length;
        return { patched: true, content: content.slice(0, insertAt) + '\n' + PROPOSE_BLOCK.trim() + content.slice(insertAt) };
      }
      // L3: 插到第一个数字步骤之前
      const firstStep = content.search(/\n\d+\.\s/);
      if (firstStep !== -1) {
        const insertAt = firstStep;
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
    'openspec-explore': (content) => {
      if (content.includes(EXPLORE_MARKER)) {
        return { patched: false, reason: 'already-patched', content };
      }
      // 在 "Ending Discovery" 段之后插入提醒
      // L1: "Ending Discovery" 标题之后
      // L2: "Flow into a proposal" 之后
      // L3: 文件末尾
      const endingIdx = content.indexOf('## Ending Discovery');
      if (endingIdx !== -1) {
        // 找到 Ending Discovery 段的末尾(下一个 ## 或文件末尾)
        const afterHeading = content.indexOf('\n', endingIdx);
        const nextSection = content.indexOf('\n## ', afterHeading);
        const insertAt = nextSection !== -1 ? nextSection : content.length;
        return { patched: true, content: content.slice(0, insertAt) + '\n' + EXPLORE_BLOCK.trim() + content.slice(insertAt) };
      }
      const flowIdx = content.indexOf('Flow into a proposal');
      if (flowIdx !== -1) {
        const insertAt = content.indexOf('\n', flowIdx);
        return { patched: true, content: content.slice(0, insertAt) + '\n' + EXPLORE_BLOCK.trim() + content.slice(insertAt) };
      }
      return { patched: true, content: content.trimEnd() + '\n\n' + EXPLORE_BLOCK.trim() + '\n' };
    },
  },

  // skill-align 不需要额外的支撑文件
  files: [],

  // 不需要单独的 skill 文件 (逻辑全在 patch 里)
  skillTemplate: null,
};
