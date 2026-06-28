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

review **档位化**熔断:tier 在 propose 时由用户选(`AskUserQuestion` low/high/max,默认 low),写进 Review 1 task 文字的 `[tier=XXX]`,apply 时解析。`maxCycle` = low→2 / high、max→3。Review `maxCycle` 修完直接 archive,不管还有没有问题。cycle counting 通过扫描 tasks.md 的 `Review N Fix` 标记实现,只有 Review N 的所有 task 都 `[x]` 才进入 N+1。档位还调每轮严格度(low 全程"属实且值得修";high/max 第 1 轮严格多修、第 2+ 轮回归正确性为主);max 档第 1 轮起两个独立 review 子 agent 交叉。

**为什么**:复杂项目可能永远有可改的地方。不熔断会无限循环,用户体验灾难。

**红线**:不要去掉熔断上限(档位化的 maxCycle:low=2,high/max=3)。不要让 cycle counting 在 Review N task 未完成时就进入 N+1。不要把档位默认改成 high/max(默认 low 符合多数任务)。不要把档位逻辑做成命令式语气(强制修)——档位只调"修的倾向",仍守原则 3。

### 原则 5:零依赖、纯 Node

和 OpenSpec、TodoPro 一样,只用 Node.js 内置模块。不引入 npm 依赖。

**红线**:有测试守着(虽然 os-stronger 目前测试较少,但这是约束)。

### 原则 6:非侵入、可恢复

patch 前自动 backup(`.os-stronger.bak`),`--restore` 完全恢复原样。多增强 patch 同一文件时,backup 只在第一次做(保留原始版本)。

**restore 安全机制**:`restore()` 在恢复前检查当前文件是否包含 os-stronger marker(`OS-STRONGER`)。如果不包含,说明 OpenSpec update 覆盖了 skill 文件——此时从旧 backup 恢复会导致降级。restore 会跳过恢复并删除过期 backup,返回 `'skipped-no-marker'`。

**红线**:不要让 backup 被覆盖。`patcher.backup()` 已实现"只在不存在时 backup"。不要去掉 restore 的 marker 检查——它防止 OpenSpec 更新后的降级事故。

---

## 三、架构总览

```
os-stronger/
├── bin/os-stronger                    ← CLI 入口(转发参数到 init.js / goal 子命令到 goal/scripts/cli.js)
├── src/
│   ├── init.js                        ← 主流程:多选增强 → 扫描 → 分发 patch → 创建文件
│   ├── patcher.js                     ← 通用工具:findOpenSpecSkills / backup / restore
│   └── enhancements/
│       ├── review/
│       │   ├── index.js               ← review 增强(patch 逻辑 + 注入文本)
│       │   ├── review-guide.md        ← 子 agent 审查规则(模板,init 时拷贝到 .os-stronger/)
│       │   └── skill.md               ← os-stronger-review skill 说明(模板)
│       └── skill-align/
│           └── index.js               ← skill-align 增强(patch 逻辑 + 注入文本)
├── goal/                              ← goal 增强(独立目录,不 patch,有自己的 CLI 子命令)
│   ├── README.md                      ← 使用说明
│   ├── AGENTS.md                      ← 设计遗嘱(动机/决策/规范/红线)
│   ├── skill.md                       ← SKILL.md 模板
│   ├── scripts/                       ← state.js / instructions.js / cli.js / index.js
│   └── reference/                     ← 额外提示词(如有)
└── tests/
    ├── patch.test.js                  ← patch 单元测试
    ├── integration.test.js            ← 集成测试
    └── goal.test.js                   ← goal 单元测试
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

### goal 增强的特殊性

goal 与 review / skill-align 有本质区别:
- review / skill-align 通过 **patch** OpenSpec skill 文件注入增强步骤(原则 1)
- goal 是**独立 skill**,不 patch 任何文件,有自己的 CLI 子命令(`os-stronger goal *`)
- goal 的代码在 `goal/` 目录(不在 `src/enhancements/`),有自己的状态机、重注入引擎、CLI 入口
- goal 有独立的设计文档:[goal/AGENTS.md](goal/AGENTS.md)——记录了动机、10 个设计决策、状态机、红线规范

**红线**:不要把 goal 的逻辑混入 src/enhancements/。goal 是编排层,不是流程增强层。

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

### 决策 7:patch 注入用分层降级策略

**选择**:每个 patch 函数尝试 3 个锚点,从精确到宽松(L1→L2→L3),任一命中即注入。

**为什么**:OpenSpec 可能改措辞(`congratulate`→`celebrate`)、改步骤号/标题(`Create artifacts`→`Generate artifacts`)、甚至大改结构。单一精确匹配太脆弱。分层降级保证:只要关键词还在(如 `all_done` / `**Steps**`),就能找到注入点。

**降级表**:
- review → apply-change: L1 `**Handle states:**` 整块之前(不劈开状态列表) → L2 含 `state: "all_done"` 的行之前 → L3 含 state+all_done 的行之前
- review → propose: 末尾追加(天然通用,无降级需要)
- skill-align → propose: L1 步骤5 `Show final status` 之前 → L2 步骤4之后 → L3 `**Steps**` 之后 → L4 第一个数字步骤之前
- skill-align → apply-change: L1 `Read context files` 之后 → L2 `**Steps**` 之后 → L3 末尾

**红线**:不要去掉降级链。L1 失败必须尝试 L2,以此类推。只有最宽松级别也失败(关键词完全不存在)才返回 `pattern-not-found`。L3/L4 的语义要正确——不能匹配到纯解释性文字(如 L3 要求同时含 `state` 和 `all_done`)。L1 注入要在整块之前,不劈开 OpenSpec 的列表结构。

---

## 五、两个增强详解

### review 增强

**触发方式**(两层):
1. **主触发**:propose patch 要求 propose 子 agent **先用 `AskUserQuestion` 问 review 档位**(low/high/max,默认 low),把 `[tier=XXX]` 写进 tasks.md 末尾的 `- [ ] Review [tier=XXX]: 按 apply skill 指导启动 Review 1`。agent 走到这个 task 时 CLI 直接推到面前,不依赖长上下文记忆。
2. **兜底**:all_done 分支保留,但仅在"本轮从未做过 review"(tasks.md 无 `[x]` 的 Review task)时触发。做过就跳过,不重复。兜底无 tier 标识 → 默认 low。

**档位**(纯提示词,无 CLI/state;tier 只写在 Review task 文字里,apply 解析):
- **low**(默认,maxCycle=2):全程"属实且值得修"才修。第 2 轮熔断:修完 archive。
- **high**(maxCycle=3):第 1 轮严格——属实的尽量修(不值得也**可**不修)。第 2+ 轮回归正确性为主,小问题可不修。第 3 轮熔断。
- **max**(maxCycle=3):同 high 的严格度曲线,**且第 1 轮起两个独立 review 子 agent**(并行优先否则串行),主 agent 融合两份 findings、交叉确认、属实的能修尽量修。第 2+ 轮单子 agent。第 3 轮熔断。

**patch 位置**(分层降级):
- `openspec-apply-change`: L1 `**Handle states:**` 整块之前(不劈开列表) → L2 含 `state: "all_done"` 的行之前 → L3 含 state+all_done 的行之前,在 all_done 行**之前插入**(保留原行作兜底)
- `openspec-propose`: 末尾追加,要求先 AskUserQuestion 问档位、再 tasks.md 末尾加带 `[tier=...]` 的 Review task

**注入的 review workflow**(STEP -1 嵌套自检 → STEP 0 tier 解析+熔断 → 0a-f):
- **STEP -1 — 嵌套子 agent 自检**:识别自己是子 agent(goal 模式等)就静默跳过 review,标 `[x]` 不起子 agent。防 goal+review 嵌套崩。
- **STEP 0 — tier 解析 + 熔断(最高优先级)**:从当前 Review task 文字解析 `[tier=XXX]` → `maxCycle = (low?2:3)`。扫 tasks.md 找 `lastCompleted`。`lastCompleted >= maxCycle` → STOP,标 `[x]`,**询问用户**是否 archive。硬上限,无例外。无 tier 标识 → 默认 low(向后兼容)。
- 0a. 检查 `.os-stronger/review-guide.md` 存在性(不读内容)
- a. 写需求总结到 `.os-stronger/requirement-summary.md`
- b. 确定当前 cycle(此时已知 < maxCycle)
- c. 起 review 子 agent(先跑 `openspec status --change <name> --json` 拿 `changeRoot`/`artifactPaths`,不写死路径;甩路径:review-guide + requirement-summary + tasks.md + design.md + proposal.md + git diff HEAD)。**max 档 cycle 1 特例**:起**两个**独立子 agent(并行优先否则串行),主 agent 融合 findings 去重交叉
- d. 子 agent 按 CRITICAL/ISSUE/SUGGEST 分档输出
- e. 主 agent 评估(按 tier 严格度):low 全程"属实且值得修";high/max cycle 1 严格倾向修、cycle 2+ 正确性为主
- f. `currentCycle < maxCycle` 有 fix → 加 `Review [tier=...] N+1` task(同 tier 贯穿);`currentCycle === maxCycle` 有 fix → 熔断,不加 N+1,问用户;无 fix → 问用户是否 archive

**archive 规则**:agent 不能自动 archive,只能**询问用户**。所有场景(各档熔断/review 通过/兜底)都是 ask user。

**支撑文件**:
- `.os-stronger/review-guide.md` — 子 agent 审查规则(模板,init 时拷贝;档位不影响其中的 CRITICAL/ISSUE/SUGGEST 格式)
- `.os-stronger/requirement-summary.md` — 主 agent review 时写

**支撑文件**:
- `.os-stronger/review-guide.md` — 子 agent 审查规则(模板,init 时拷贝)
- `.os-stronger/requirement-summary.md` — 主 agent review 时写

**skill 文件**:每个工具目录创建 `os-stronger-review/SKILL.md`

### skill-align 增强

**patch 位置**(分层降级):
- `openspec-propose`: L1 步骤5 `Show final status` 之前 → L2 步骤4之后 → L3 `**Steps**` 之后 → L4 第一个数字步骤之前,插入 skill 对齐步骤(此时 design.md 已存在)
- `openspec-apply-change`: L1 `Read context files` 之后 → L2 `**Steps**` 之后 → L3 末尾,插入 skill 约定提醒

**时序设计**:skill 对齐在步骤4(生成 artifacts)之后、步骤5(show status)之前执行。此时 design.md 已由步骤4生成,追加 `## Skill Alignment` 章节不会冲突。

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
2. 导出 `{ id, label, patches, files, skillTemplate }`
3. 在 `src/init.js` 的 `enhancements` 对象里加一行: `'<name>': require('./enhancements/<name>')`
4. 如有模板文件,放同目录
5. 完成

**红线**:不要为了加新增强去改 patcher.js 或 init.js 的核心逻辑。

### patch 函数规范(分层降级)

```js
patches: {
  'openspec-apply-change': (content) => {
    // 1. 检查已 patch(用 marker)
    if (content.includes(MARKER)) return { patched: false, reason: 'already-patched', content };
    // 2. 分层降级匹配注入点(L1 精确 → L2 宽松 → L3 兜底)
    const l1 = /精确匹配整句/;
    const l2 = /宽松匹配关键词所在行/;
    const l3 = /最宽松只认关键词/;
    let matched = null;
    for (const p of [l1, l2, l3]) { if (p.test(content)) { matched = p; break; } }
    if (!matched) return { patched: false, reason: 'pattern-not-found', content };
    // 3. 替换或插入
    return { patched: true, content: content.replace(matched, INJECT_BLOCK.trim()) };
  },
}
```

**红线**:
- 必须检查已 patch(幂等)
- 找不到 pattern 时返回 `pattern-not-found`,不要静默失败
- 注入文本用 HTML 注释 marker 包裹(便于检测和未来的移除)

---

## 七、兼容性策略

os-stronger 通过 patch OpenSpec 的 skill 文件 + 调用 OpenSpec 的 CLI 工作，对 OpenSpec 版本有依赖。两个层面的耦合：

1. **patch 锚点文本匹配**——在 `openspec-apply-change/SKILL.md` 等文件里找 `**Handle states:**`、`all_done`、`**Steps**` 等锚点注入。靠分层降级(决策 7)兜：只要关键词在就能 patch，关键词全消失才 `pattern-not-found`。
2. **goal 用的 CLI/JSON 字段**——`openspec status --change --json` 的 `artifactPaths.*.resolvedOutputPath`、skill 名 `openspec-archive-change` 等。这些是 OpenSpec 对外接口，版本间可能变。

**适配而非集成**(设计选择)：os-stronger 不把某个 OpenSpec 版本打包进来、不替用户 `openspec init`。原因：
- 用户可能已装好自己偏好的 OpenSpec 版本，集成会冲突且堵住升级
- 替用户初始化 OpenSpec = 越界吃 OpenSpec 的职责(skill 生成/目录结构/配置)，重复劳动且必然滞后
- 违背原则 5(零依赖)。OpenSpec 1.4.1 unpacked 1.3MB + 10 依赖，集成进来 os-stronger 不再轻量
- 定位：os-stronger 是增强层，面向**已有 OpenSpec 的项目**，不是从零分发 OpenSpec

**验证清单**(维护者定期更新)：在 README 的"## 兼容性"节列出已验证版本。当前已验证 1.4.1(2026-06)。验证步骤：
1. 装该版本 OpenSpec，跑一遍 `os-stronger init`——确认 patch 全部命中(不报 `pattern-not-found`)
2. 跑一遍 goal 流程——确认 `openspec status --change --json` 字段、skill 名(`openspec-archive-change`)对得上
3. 通过则更新 README 清单；失败则修 patch 锚点 / CLI 字段引用，再更新

**红线**：
- 不要集成 OpenSpec 进来(违背定位 + 原则 5)。
- 不要让 README 的兼容性清单和实际验证脱节——验证成功就更新，失败就修 + 标注。
- OpenSpec 大改导致 patch 全断时，优先补分层降级的新锚点(决策 7)，而非退回精确匹配。

## 八、已知限制

1. **纯提示词约束**:没有 hook,agent 可能跳过增强步骤。但 OpenSpec 自身就是靠 agent 遵循 SKILL.md 跑起来的,同样的机制,同样的可靠性。review 的主触发靠 tasks.md 里的显式 Review task(CLI 直接推到 agent 面前),all_done 分支仅作兜底。

2. **patch 依赖文本匹配**:OpenSpec 大幅改写 skill 文本时 patch 可能失败。但分层降级策略(决策 7)保证:只要关键词还在(`**Handle states:**` / `all_done` / `**Steps**`),就能找到注入点。只有关键词完全消失才返回 `pattern-not-found`。

3. **OpenSpec 更新覆盖 patch**:`openspec update` 会重新生成 skill 文件,覆盖我们的 patch。用户需重跑 `os-stronger init`。文档已说明。

4. **非 git 项目 review 覆盖有限**:review 子 agent 用 `git diff HEAD` 看改动。非 git 项目或改动已 commit 时 diff 可能为空,子 agent 需直接读 tasks.md 涉及的文件。注入文本已包含此兜底指导。

5. **skill-align 扫描可能噪音大**:项目 skill 很多时,推荐列表可能过长。目前靠 agent 判断相关性,没有更智能的过滤。

6. **workspace 模式路径**:OpenSpec 1.4+ 的 workspace 模式 changes 目录不在 `openspec/changes/`。注入文本已改为先跑 `openspec status --change <name> --json` 拿 `artifactPaths.*.resolvedOutputPath`,不写死路径。

7. **restore 降级防护**:如果 OpenSpec update 覆盖了 skill 文件（文件不含 os-stronger marker），restore 会跳过恢复并删除过期 backup，避免把新版本降级回旧版本。但用户可能困惑为什么 restore "没生效"——实际是正确行为。

8. **嵌套子 agent**:goal + review 同时启用时,apply 子 agent 遇到 Review task 需要起 review 子 agent(嵌套),部分平台 max_depth=1 不支持。**已加双层兜底,可同时启用**:(a) goal 侧——propose 子 agent 提示词明确"不加 Review task",apply 子 agent 提示词明确"遇到 Review task 直接标 `[x]` 跳过,不起子 agent";(b) review patch 侧——`REVIEW_WORKFLOW_BLOCK` 顶部加 STEP -1 子 agent 自检,识别自己是子 agent(被显式标记为 sub-agent,或无 spawn-subagent 能力)就静默跳过 review。两层防御保证:即使 propose 子 agent 没听话加了 Review task,apply 子 agent 也会跳过;即使 review patch 被单独嵌套调用(非 goal 场景),STEP -1 也会兜住。goal 模式下 review 静默失效,不报错不阻塞——goal 的 fix→test→熔断循环本身就是质量门,不依赖 review。

9. **uninstall 顺序**:`--uninstall` 会先卸载全局 CLI，用户之后无法跑 `--restore`。正确顺序是先在各项目 restore 再卸载。CLI 提示已说明但无法强制。

10. **goal.md 章节填不全**:goal.md 现在是设计意图 + 资料中心(目标/架构/设计规范/测试维度/资料/验收标准六段,见 goal/AGENTS.md 决策 13)。模板有 HTML 注释引导每段不填的代价,但不强制填。章节填不全会让 fresh-context 子 agent 缺视角或拿不到用户给过的资料,导致目标偏移。靠主 agent 在 Phase 0 主动收集资料 + 提示子 agent 读 goal.md 全文缓解。

---

## 九、维护红线速查

| 想做 | 能不能 | 为什么 |
|------|--------|--------|
| 把增强做成需要 agent 主动调用的独立 skill | ❌ | 违背原则 1(patch 优先,自然遇到) |
| 让主 agent 读 review-guide.md 内容 | ❌ | 违背原则 2(路径传递,主 agent 不读) |
| 在 review-guide.md 里写命令式语气 | ❌ | 违背原则 3(findings 不强制) |
| 去掉 review 熔断上限(档位化的 maxCycle) | ❌ | 违背原则 4(熔断兜底)。low=2 / high=max=3,仍是硬上限 |
| 把档位改成命令式语气(强制修) | ❌ | 违背原则 3(findings 不强制)。档位只调"修的倾向",不可强制 |
| 把档位默认改成 high/max | ❌ | 默认 low 符合多数任务。high/max 主动选,避免意外高成本 |
| 引入 npm 依赖 | ❌ | 违背原则 5(零依赖) |
| 让 backup 被多增强覆盖 | ❌ | 违背原则 6(非侵入,可恢复) |
| 去掉 restore 的 marker 检查 | ❌ | 违背原则 6。marker 检查防 OpenSpec 更新后降级 |
| 让 restore 从过期 backup 降级 | ❌ | 违背原则 6。文件无 marker 时应跳过恢复 |
| 在 cycle counting 里跳过未完成的 Review N | ❌ | 决策 4(防竞态) |
| 加新增强 | ✅ | 新建 `enhancements/<name>/`,在 init.js 注册一行 |
| 调注入文本措辞 | ✅ | 只改对应 `enhancements/<id>/index.js` |
| 加新的 patch 注入点 | ✅ | 在增强的 patches 对象里加新 key |
| 改 patch 正则匹配 | ✅(谨慎) | OpenSpec 更新文本时需要同步调整。遵循分层降级(决策 7) |
| 去掉降级链只留精确匹配 | ❌ | 违背决策 7。OpenSpec 改措辞就断 |
| 让 agent 自动 archive | ❌ | archive 决定权在用户。agent 只能询问,不能自动做 |
| 去掉 STEP 0 熔断优先级 | ❌ | 熔断必须在任何其他逻辑之前,防无限循环 |
| 去掉 Review task 主触发,只靠 all_done | ❌ | all_done 依赖长上下文记忆,不可靠。Review task 是主触发 |

---

## 十、相关文档

- `README.md` — 面向用户的安装/使用说明
- OpenSpec 源码 — `openspec init` 的实现(`@fission-ai/openspec/dist/core/init.js`),理解 OpenSpec 如何生成 skill 文件
- TodoPro 的 `skills/todopro/review-subagent-prompt.md` — review-guide.md 的内容来源(审查方法论复用)

改设计时,同步更新本文件。不要让它和代码脱节。
