# os-stronger

> 给 OpenSpec 加增强——模块化、可插拔、零依赖。

OpenSpec 的 skill 文件都是本地明文，os-stronger 通过**原地 patch** 这些文件来注入增强能力。跑一次 `os-stronger init`，选你要的增强，agent 走 OpenSpec 流程时自动遇到增强步骤。

```
openspec-apply-change 原流程:
  做 task → 全部 [x] → 🎉 archive

加了 review 增强后:
  做 task → 全部 [x] → 🔍 起 review 子 agent → 评估 → archive（或修完再 review）

加了 skill-align 增强后:
  openspec-propose:
    对齐需求 → 扫描可用 skill → 推荐给用户 → 写入 design.md
  openspec-apply-change:
    读 design.md → 遵守 skill 约定（must-use / optional）→ 做 task
```

## 安装

```bash
git clone https://github.com/GGGuYu/os-stronger.git
cd os-stronger
npm install -g .
```

## 使用

在**已经跑过 `openspec init`** 的项目里：

```bash
os-stronger init                                    # 交互式多选增强
os-stronger init --enhancements review,skill-align  # 静默指定
os-stronger init --restore                          # 撤销所有增强
```

跑完重启 IDE / 重载会话即可。

## 可用增强

### review — 全部 task 完成后起子 agent 审查

当 `openspec-apply-change` 报告 `state: "all_done"`：

1. 主 agent 检查 `.os-stronger/review-guide.md` 是否存在（只看存在，不读内容）
2. 写需求总结到 `.os-stronger/requirement-summary.md`
3. 起子 agent，甩文件路径（review-guide + requirement-summary + tasks.md + git diff）
4. 子 agent 按 CRITICAL/ISSUE/SUGGEST 分档输出 findings
5. 主 agent 独立判断每条：是否属实？是否值得现在立即修？
6. 属实且值得修的 → 建 `Review N Fix - <desc>` task
7. 修完触发下一轮 review，**最多 2 轮**，Review 2 修完直接 archive

findings 不强制——主 agent 有最终决定权，任何档（含 CRITICAL）均可忽略。

### skill-align — propose 时主动询问用户要用哪些 skill

**openspec-propose 侧**（写文档前）：
1. 扫描项目可用 skills（`.*/skills/*/SKILL.md`）
2. 根据需求推荐相关 skill，用 AskUserQuestion 让用户多选
3. 用户选的 = must-use（agent 实现时必须读且主动用），没选的 = optional
4. 写入 `design.md` 的 `## Skill Alignment` 章节

**openspec-apply-change 侧**（读文档后）：
- 读到 `design.md` 的 Skill Alignment 章节 → must-use 的必须用，optional 的自行判断

## os-stronger init 做了什么

1. **扫描**项目里所有 OpenSpec skill 安装（自动发现 `.claude`、`.codex`、`.cursor` 等所有 dot 目录）
2. 对选中的每个增强：
   - Patch 对应的 OpenSpec skill 文件（`openspec-apply-change` / `openspec-propose`）
   - 创建支撑文件（如 `.os-stronger/review-guide.md`）
   - 创建 skill 说明文件（`os-stronger-<增强名>/SKILL.md`）
3. Patch 前自动备份（`.os-stronger.bak`），`--restore` 一键恢复

## 设计原则

- **零依赖**：纯 Node.js 内置模块
- **模块化**：每个增强是 `src/enhancements/<name>/` 下的独立模块，含自己的 patch 逻辑和模板
- **非侵入**：patch 前备份，`--restore` 完全恢复原样
- **幂等**：重复跑 `init` 不会重复注入
- **自动发现**：扫描 dot 目录找 OpenSpec 安装，不维护硬编码工具列表
- **多增强共存**：多个增强可以 patch 同一文件，backup 只保留第一次的原始版本
- **分层降级**：patch 注入用 L1 精确 → L2 宽松 → L3 兜底 三级锚点，OpenSpec 改措辞/步骤标题时仍能注入

## 目录结构

```
os-stronger/
├── bin/os-stronger                    ← CLI 入口
└── src/
    ├── init.js                        ← 主流程:多选增强 → 分发
    ├── patcher.js                     ← 通用工具:扫描/备份/恢复
    └── enhancements/
        ├── review/
        │   ├── index.js               ← review 增强 patch 逻辑
        │   ├── review-guide.md        ← 子 agent 审查规则
        │   └── skill.md               ← os-stronger-review skill 说明
        └── skill-align/
            └── index.js               ← skill-align 增强 patch 逻辑
└── tests/
    └── patch.test.js                  ← patch 函数单元测试 (20 个)
```

init 后项目里会多出：

```
项目根/
├── .os-stronger/
│   ├── review-guide.md               ← review 增强创建
│   └── requirement-summary.md        ← review 时主 agent 写
├── .claude/skills/
│   ├── openspec-apply-change/        ← 被 patch 了
│   ├── openspec-propose/             ← 被 patch 了
│   └── os-stronger-review/           ← review skill 说明 (启用 review 时创建)
└── ...（其他工具的 skills 目录同理）
```

## 限制

- **纯提示词约束**：没有 hook，agent 可能跳过增强步骤。但 OpenSpec 自身就是靠 agent 遵循 SKILL.md 跑起来的，同样的机制
- **patch 依赖文本匹配**：OpenSpec 改措辞或步骤标题时，分层降级策略会尝试更宽松的锚点（如只认 `all_done` / `**Steps**` 关键词）。只有关键词完全消失才会 `pattern-not-found`
- **非 git 项目 review 覆盖有限**：review 子 agent 用 `git diff HEAD` 看改动，非 git 项目或改动已 commit 时需直接读 tasks.md 涉及的文件（注入文本已含此兜底指导）
- **OpenSpec 更新后需重跑**：`openspec update` 会覆盖 skill 文件，之后跑一次 `os-stronger init` 重新注入

## 扩展：加新增强

1. 新建 `src/enhancements/<name>/index.js`
2. 导出 `{ id, label, patches, files, skillTemplate }`
3. 在 `src/init.js` 的 `enhancements` 对象里注册一行
4. patch 函数遵循分层降级（L1 精确 → L2 宽松 → L3 兜底）
5. 完成
