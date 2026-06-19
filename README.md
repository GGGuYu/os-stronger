# os-stronger

> 给 OpenSpec 加一道独立 review 关卡——全部 task 完成后，先起子 agent 审查，再 archive。

OpenSpec 的 `openspec-apply-change` 流程在所有 task 标记完成后直接建议 archive，没有质量门禁。agent 可能把 task 全标 `[x]` 就宣告完成，即使实现有遗漏或逻辑错误。os-stronger 通过**原地 patch OpenSpec 的 skill 文件**，在 "all done → archive" 之间插入一个独立子 agent review 步骤。

```
openspec-apply-change 原流程:
  做 task → 全部 [x] → 🎉 archive

加了 os-stronger 后:
  做 task → 全部 [x] → 🔍 起 review 子 agent → 评估 findings
                                              ├─ 无问题 → archive
                                              ├─ 有问题 → 建 Review N Fix task → 修完再 review
                                              └─ Review 2 完成 → archive（熔断）
```

## 它解决什么问题

多步、多文件的 change 里，agent 跨轮次容易丢上下文：标了 `[x]` 但实际没做对、漏了边界条件、引入了和需求相反的逻辑。一个独立视角的子 agent（不受主 agent 对话历史污染）能在 archive 前发现这些问题。

## 安装

```bash
git clone https://github.com/GGGuYu/os-stronger.git
cd os-stronger
npm install -g .
```

## 使用

在**已经跑过 `openspec init`** 的项目里：

```bash
os-stronger init              # 增强：注入 review 流程
os-stronger init --restore    # 撤销：恢复原始 OpenSpec skill 文件
```

跑完重启 IDE / 重载会话即可。review 会在 `openspec-apply-change` 到达 `all_done` 时自动触发，不需要手动调用。

## os-stronger init 做了什么

1. **扫描**项目里所有 OpenSpec skill 安装（支持 OpenSpec 的全部 30 种工具：`.claude`、`.codex`、`.cursor`、`.gemini`...）
2. **Patch `openspec-apply-change/SKILL.md`**：把 `all_done → archive` 替换为 review workflow
3. **Patch `openspec-propose/SKILL.md`**：追加 review 提醒
4. **创建 `.os-stronger/review-guide.md`**：子 agent 审查规则
5. **创建 `os-stronger/SKILL.md`**：skill 说明（每个工具目录各一份）

Patch 前自动备份（`.os-stronger.bak`），`--restore` 一键恢复。

## Review 工作流

当 `openspec-apply-change` 报告 `state: "all_done"`：

| 步骤 | 动作 | 谁做 |
|------|------|------|
| 1. 检查 | `.os-stronger/review-guide.md` 是否存在 | 主 agent（只看存在，不读内容） |
| 2. 写总结 | 需求总结写到 `.os-stronger/requirement-summary.md` | 主 agent |
| 3. 起子 agent | 传文件路径（review-guide + requirement-summary + tasks.md + git diff） | 主 agent |
| 4. 审查 | 读文件，按 CRITICAL/ISSUE/SUGGEST 分档输出 findings | 子 agent（全新上下文） |
| 5. 评估 | 每条 finding：是否属实？是否值得现在立即修？ | 主 agent |
| 6. 修复 | 属实且值得修的 → 建 `Review N Fix - <desc>` task | 主 agent |
| 7. 循环 | 修完 → 再次触发 review；最多 2 轮 | 自动 |

### 熔断

- 最多 **2 轮** review。Review 2 是最后一轮，修完直接 archive。
- 通过扫描 `tasks.md` 里的 `Review N Fix` 标记计数。只有 Review N 的所有 task 都标记 `[x]` 才进入 N+1。
- 如果 Review 1 就没发现问题 → 直接 archive，不进 Review 2。

### Findings 不强制

子 agent 的输出是**建议**，不是命令。主 agent 收到后独立判断：
- 这条 finding **是否属实**（用自己对代码的了解核实）
- 即使属实，**是否值得现在立即修**（修复会推迟给用户返回产物）

任何档（包括 CRITICAL）均可忽略。主 agent 有最终决定权。

## 设计原则

- **零依赖**：纯 Node.js 内置模块，和 OpenSpec 一样
- **非侵入**：patch 前备份，`--restore` 完全恢复原样
- **幂等**：重复跑 `init` 不会重复注入
- **路径传递**：主 agent 不读 review-guide.md（避免上下文膨胀），只把路径甩给子 agent
- **OpenSpec 更新后需重跑**：`openspec update` 会覆盖 skill 文件，之后跑一次 `os-stronger init` 重新注入

## 目录结构

os-stronger init 后项目里会多出：

```
项目根/
├── .os-stronger/
│   ├── review-guide.md           ← 子 agent 审查规则（init 创建）
│   └── requirement-summary.md    ← 主 agent 写的需求总结（review 时生成）
├── .claude/skills/
│   ├── openspec-apply-change/    ← OpenSpec 原有的，被 patch 了
│   ├── openspec-propose/         ← OpenSpec 原有的，被 patch 了
│   └── os-stronger/              ← os-stronger 的 skill 说明
└── ...（其他工具的 skills 目录同理）
```

## 限制

- **纯提示词约束**：没有 hook，agent 可能跳过 review 步骤。但 OpenSpec 自身就是靠 agent 遵循 SKILL.md 跑起来的，同样的机制。
- **patch 依赖文本匹配**：如果 OpenSpec 大幅改写 skill 文本，patch 可能失败。`os-stronger init` 会报告 `pattern-not-found`。
- **无文件追踪**：子 agent 用 `git diff` 看改动，非 git 项目看不到。TodoPro 的 touched-files 功能这里没有。
