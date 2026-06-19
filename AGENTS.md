# AGENTS.md — os-stronger 维护者指南

> 本文是给后来维护者(人或 AI agent)的**设计遗嘱**。记录每个关键决定**为什么这么定**,以及哪些地方**不能乱改的红线**。
>
> 代码会变,这份文档要跟着变。改了设计就同步改这里,别让它和代码脱节。

---

## 一、这是什么

os-stronger 是一套 **OpenSpec 增强层**。一句话概括:

> **通过原地 patch OpenSpec 的 skill 文件,在 OpenSpec 的工作流中注入增强能力——不需要 hook,不需要外部服务,纯提示词 + 文件操作。**

OpenSpec 的 skill 文件(`openspec-apply-change/SKILL.md` 等)都是本地明文 markdown,agent 靠遵循这些指令跑起来。os-stronger 的洞察是:**既然 agent 遵循 OpenSpec 的 SKILL.md,那我们 patch 这些文件注入新步骤,agent 同样会遵循**——和 OpenSpec 自身用完全相同的机制,零额外依赖。

### 它和 TodoPro 的关系

os-stronger 的 review 增强复用了 TodoPro 的审查方法论(CRITICAL/ISSUE/SUGGEST 分档、功能优先、反钻牛角尖、advisory 声明),但**是独立项目**:
- TodoPro 用平台 hook(Stop/PostToolUse/SubagentStop),重但可靠
- os-stronger 用纯提示词 patch,轻但靠 agent 自觉
- 两者可以共存于同一项目(TodoPro 的 `.todopro/` vs os-stronger 的 `.os-stronger/`)

---

## 二、核心设计原则(红线)

### 原则 1:patch 优先,不造新机制

增强通过 patch OpenSpec 已有的 skill 文件实现,不创建新的触发机制。agent 走 OpenSpec 流程时**自然遇到**增强步骤,不需要记住"还要调另一个 skill"。

**红线**:不要把增强做成需要 agent 主动调用的独立 skill。那等于依赖 agent 记忆,违背"自然遇到"的设计。

### 原则 2:路径传递,主 agent 不读增强文件

review-guide.md 等支撑文件是给**子 agent** 读的。主 agent 只检查文件是否存在(布尔判断),把路径甩给子 agent,自己不读内容。

**为什么**:支撑文件可能很长(几 KB)。如果主 agent 每轮都读,上下文膨胀。子 agent 在全新上下文里读,干净且不受主 agent 对话历史污染。

**红线**:不要让主 agent 读 `.os-stronger/review-guide.md` 的内容。只检查存在性。

### 原则 3:findings 不强制

子 agent 的审查输出是**建议**,不是命令。主 agent 收到后独立判断:是否属实?是否值得现在立即修?任何档(含 CRITICAL)均可忽略。

**为什么**:防止子 agent 用风格偏好阻塞进度。主 agent(代表用户)有最终决定权——修复会推迟给用户返回产物,这个代价由主 agent 权衡。

**红线**:不要在 review-guide.md 里写"必须修复""应当立即"这类命令式语气。把判断权交给主 agent。

### 原则 4:熔断兜底

review 最多 2 轮。Review 2 修完直接 archive,不管还有没有问题。cycle counting 通过扫描 tasks.md 的 `Review N Fix` 标记实现,只有 Review N 的所有 task 都 `[x]` 才进入 N+1。

**为什么**:复杂项目可能永远有可改的地方。不熔断会无限循环,用户体验灾难。

**红线**:不要去掉 2 轮上限。不要让 cycle counting 在 Review N task 未完成时就进入 N+1。

### 原则 5:零依赖、纯 Node

和 OpenSpec、TodoPro 一样,只用 Node.js 内置模块。不引入 npm 依赖。

**红线**:有测试守着(虽然 os-stronger 目前测试较少,但这是约束)。

### 原则 6:非侵入、可恢复

patch 前自动 backup(`.os-stronger.bak`),`--restore` 完全恢复原样。多增强 patch 同一文件时,backup 只在第一次做(保留原始版本)。

**红线**:不要让 backup 被覆盖。`patcher.backup()` 已实现"只在不存在时 backup"。

---

## 三、架构总览

```
os-stronger/
├── bin/os-stronger                    ← CLI 入口(转发参数到 init.js)
└── src/
    ├── init.js                        ← 主流程:多选增强 → 扫描 → 分发 patch → 创建文件
    ├── patcher.js                     ← 通用工具:findOpenSpecSkills / backup / restore
    └── enhancements/
        ├── review/
        │   ├── index.js               ← review 增强(patch 逻辑 + 注入文本)
        │   ├── review-guide.md        ← 子 agent 审查规则(模板,init 时拷贝到 .os-stronger/)
        │   └── skill.md               ← os-stronger-review skill 说明(模板)
        └── skill-align/
            └── index.js               ← skill-align 增强(patch 逻辑 + 注入文本)
```

### 分层

```
┌─────────────────────────────────┐
│  bin/os-stronger (CLI 入口)      │  解析参数,调 init()
├─────────────────────────────────┤
│  src/init.js (主流程)            │  多选增强 → 遍历 → 调各增强的 patch
├─────────────────────────────────┤
│  src/enhancements/<id>/index.js │  各增强的 patch 逻辑(含注入文本)
├─────────────────────────────────┤
│  src/patcher.js (通用工具)       │  扫描/备份/恢复,不含增强特定逻辑
└─────────────────────────────────┘
```

**关键**:patcher.js 是被各增强模块调用的底层工具,不含任何增强特定逻辑。加新增强只需要新建 `enhancements/<name>/` 目录,不改 patcher.js。

### 增强模块接口

每个增强模块导出一个对象:

```js
module.exports = {
  id: 'review',           // 唯一标识
  label: '...',            // 多选时显示的标签
  patches: {               // 要 patch 的 OpenSpec skill → patch 函数
    'openspec-apply-change': (content) => { ... return { patched, content, reason } },
    'openspec-propose':     (content) => { ... },
  },
  files: [                 // 要创建的支撑文件(相对项目根)
    { dest: '.os-stronger/review-guide.md', template: 'review-guide.md' },
  ],
  skillTemplate: 'skill.md',  // skill 说明模板(每个工具目录各放一份),null 则不创建
  markers: [...],             // patch 标记(用于检测已 patch)
};
```

---

## 四、关键设计决策

### 决策 1:patch OpenSpec skill 而非创建独立 skill

**选择**:原地修改 `openspec-apply-change/SKILL.md` 和 `openspec-propose/SKILL.md`。

**为什么**:独立 skill 需要 agent 记住去调用它。patch 已有的 skill,agent 走 OpenSpec 流程时**自然遇到**增强步骤——和 OpenSpec 自身用完全相同的机制(指令在 system prompt 里,agent 自愿遵循)。

**否决的备选**:创建 `openspec-review` 独立 skill,apply 完成后手动调用。否决理由:agent 可能忘记调,覆盖率低。

### 决策 2:自动扫描 dot 目录而非硬编码工具列表

**选择**:`findOpenSpecSkills` 扫描项目根下所有 `.开头` 目录的 `skills/`,找 `openspec-*` 子目录。

**为什么**:OpenSpec 支持 30+ 种工具,每个有不同的 `skillsDir`(.claude / .codex / .cursor / .gemini...)。硬编码列表需要手动跟 OpenSpec 更新,容易漏(实际就漏了 `.zcode`)。自动扫描零维护。

**否决的备选**:从 OpenSpec 的 `AI_TOOLS` config 读取工具列表。否决理由:需要解析 OpenSpec 的 npm 包内部文件,耦合太紧,版本变更风险。

### 决策 3:多增强 patch 同一文件时 backup 只做一次

**选择**:`patcher.backup()` 检查 `.os-stronger.bak` 是否已存在,只在不存在时 backup。

**为什么**:review 和 skill-align 都 patch `openspec-apply-change`。如果每次 patch 都 backup,第二次会覆盖第一次的原始 backup(因为第二次 backup 的是已 patched 文件)。restore 时只能恢复到最后一次 patch 前的状态,而非原始状态。

**修复历史**:早期版本每次都 backup,导致 restore 后残留 patch 痕迹。改为"只 backup 一次"后修复。

### 决策 4:cycle counting 要求 Review N 全部完成

**选择**:扫描 tasks.md 找 `Review N Fix -` 标记,只有 N 的所有 task 都 `[x]` 才认为 N 轮完成,当前是 N+1。

**为什么**:如果 Review 1 的 fix task 还没做完(agent 中途停了),下次 all_done 时不应该跳到 Review 2。必须 Review 1 全部完成才进 Review 2。

**修复历史**:早期版本只看标记是否存在,不看是否完成。agent 中断后重连会误判 cycle。

### 决策 5:模块化增强架构

**选择**:每个增强是 `src/enhancements/<id>/` 下的独立模块,导出统一接口。`init.js` 遍历选中的增强,调各自的 patch。

**为什么**:不同用户需要不同增强组合。有人只要 review,有人只要 skill-align,有人都要。模块化让用户自选,加新增强不改现有代码。

**红线**:加新增强只新建 `enhancements/<name>/`,不要改 init.js 的核心逻辑(只在 `enhancements` 对象里注册一行)。

### 决策 6:skill-align 写入 design.md

**选择**:skill 对齐结果写入 `design.md` 的 `## Skill Alignment` 章节。

**为什么**:design.md 是"怎么做"的文档,skill 选择属于实现策略,放这里语义最自然。apply-change 本来就读 design.md,不需要额外触发。

**否决的备选**:单独建 `.os-stronger/skills.md`。否决理由:apply-change 不会主动读这个文件,需要额外 patch 提醒,多一层间接。放 design.md 里 apply-change 天然读到。

---

## 五、两个增强详解

### review 增强

**patch 位置**:
- `openspec-apply-change`: `state: "all_done"` 分支,替换 "congratulate, suggest archive" 为 review workflow
- `openspec-propose`: Guardrails 段后追加 review 提醒

**注入的 review workflow**(7 步):
1. 检查 `.os-stronger/review-guide.md` 存在性(不读内容)
2. 写需求总结到 `.os-stronger/requirement-summary.md`
3. 起 review 子 agent(甩路径:review-guide + requirement-summary + tasks.md + git diff)
4. 子 agent 按 CRITICAL/ISSUE/SUGGEST 分档输出
5. 主 agent 评估:是否属实?是否值得立即修?
6. 属实且值得修 → 建 `Review N Fix - <desc>` task
7. 修完触发下一轮,最多 2 轮,Review 2 修完 archive

**支撑文件**:
- `.os-stronger/review-guide.md` — 子 agent 审查规则(模板,init 时拷贝)
- `.os-stronger/requirement-summary.md` — 主 agent review 时写

**skill 文件**:每个工具目录创建 `os-stronger-review/SKILL.md`

### skill-align 增强

**patch 位置**:
- `openspec-propose`: "Read context files" 步骤前插入 skill 对齐步骤
- `openspec-apply-change`: "Read context files" 步骤后插入 skill 约定提醒

**注入的 skill 对齐流程**(propose 侧):
1. 扫描项目可用 skills(`.*/skills/*/SKILL.md` 的 frontmatter)
2. 根据需求推荐相关 skill,用 AskUserQuestion 让用户多选
3. 用户选的 = must-use,没选的 = optional
4. 写入 `design.md` 的 `## Skill Alignment` 章节

**注入的 skill 约定提醒**(apply-change 侧):
- 读 design.md → 发现 `## Skill Alignment` → must-use 必须用,optional 自行判断

**支撑文件**:无(逻辑全在 patch 里)
**skill 文件**:无(skillTemplate 为 null)

---

## 六、代码组织规范

### 目录与职责

| 文件 | 职责 | 不应做 |
|------|------|--------|
| `bin/os-stronger` | 解析 CLI 参数,调 init() | 不含业务逻辑 |
| `src/init.js` | 多选增强 → 扫描 → 分发 patch → 创建文件 | 不含增强特定 patch 逻辑 |
| `src/patcher.js` | findOpenSpecSkills / backup / restore | 不含增强特定逻辑 |
| `src/enhancements/<id>/index.js` | 该增强的 patch 逻辑 + 注入文本 | 不含通用工具 |

### 加新增强的步骤

1. 新建 `src/enhancements/<name>/index.js`
2. 导出 `{ id, label, patches, files, skillTemplate, markers }`
3. 在 `src/init.js` 的 `enhancements` 对象里加一行: `'<name>': require('./enhancements/<name>')`
4. 如有模板文件,放同目录
5. 完成

**红线**:不要为了加新增强去改 patcher.js 或 init.js 的核心逻辑。

### patch 函数规范

```js
patches: {
  'openspec-apply-change': (content) => {
    // 1. 检查已 patch(用 marker)
    if (content.includes(MARKER)) return { patched: false, reason: 'already-patched', content };
    // 2. 找注入点(用正则匹配 OpenSpec 原文)
    const pattern = /.../;
    if (!pattern.test(content)) return { patched: false, reason: 'pattern-not-found', content };
    // 3. 替换
    return { patched: true, content: content.replace(pattern, INJECT_BLOCK.trim()) };
  },
}
```

**红线**:
- 必须检查已 patch(幂等)
- 找不到 pattern 时返回 `pattern-not-found`,不要静默失败
- 注入文本用 HTML 注释 marker 包裹(便于检测和未来的移除)

---

## 七、已知限制

1. **纯提示词约束**:没有 hook,agent 可能跳过增强步骤。但 OpenSpec 自身就是靠 agent 遵循 SKILL.md 跑起来的,同样的机制,同样的可靠性。

2. **patch 依赖文本匹配**:OpenSpec 大幅改写 skill 文本时 patch 可能失败。`os-stronger init` 会报告 `pattern-not-found`。缓解:每个 patch 函数有 fallback pattern。

3. **OpenSpec 更新覆盖 patch**:`openspec update` 会重新生成 skill 文件,覆盖我们的 patch。用户需重跑 `os-stronger init`。文档已说明。

4. **无文件追踪**:review 子 agent 用 `git diff` 看改动。非 git 项目看不到。TodoPro 的 touched-files 功能这里没有(需要 hook)。

5. **skill-align 扫描可能噪音大**:项目 skill 很多时,推荐列表可能过长。目前靠 agent 判断相关性,没有更智能的过滤。

---

## 八、维护红线速查

| 想做 | 能不能 | 为什么 |
|------|--------|--------|
| 把增强做成需要 agent 主动调用的独立 skill | ❌ | 违背原则 1(patch 优先,自然遇到) |
| 让主 agent 读 review-guide.md 内容 | ❌ | 违背原则 2(路径传递,主 agent 不读) |
| 在 review-guide.md 里写命令式语气 | ❌ | 违背原则 3(findings 不强制) |
| 去掉 review 2 轮上限 | ❌ | 违背原则 4(熔断兜底) |
| 引入 npm 依赖 | ❌ | 违背原则 5(零依赖) |
| 让 backup 被多增强覆盖 | ❌ | 违背原则 6(非侵入,可恢复) |
| 在 cycle counting 里跳过未完成的 Review N | ❌ | 决策 4(防竞态) |
| 加新增强 | ✅ | 新建 `enhancements/<name>/`,在 init.js 注册一行 |
| 调注入文本措辞 | ✅ | 只改对应 `enhancements/<id>/index.js` |
| 加新的 patch 注入点 | ✅ | 在增强的 patches 对象里加新 key |
| 改 patch 正则匹配 | ✅(谨慎) | OpenSpec 更新文本时需要同步调整 |

---

## 九、相关文档

- `README.md` — 面向用户的安装/使用说明
- OpenSpec 源码 — `openspec init` 的实现(`@fission-ai/openspec/dist/core/init.js`),理解 OpenSpec 如何生成 skill 文件
- TodoPro 的 `skills/todopro/review-subagent-prompt.md` — review-guide.md 的内容来源(审查方法论复用)

改设计时,同步更新本文件。不要让它和代码脱节。
