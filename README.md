# dsh-session-continuity

新会话开始时，只注入一条极小的**接续指针**：上一个会话是谁、工作区里有没有交接文档。

它不搬运任何会话原文，也不调用模型生成摘要——需要背景时由模型自己去读那份文件。

## 注入什么

工作区里有交接文档时（英文，默认）：

```
Continuity: previous session "给 DSH 写一个会话接续插件" (2026-10-13, id 1f759b89). Read HANDOFF.md (2026-10-13) before planning.
```

中文（`language: zh`）：

```
会话接续：上个会话「给 DSH 写一个会话接续插件」（2026-10-13，id 1f759b89）。动手前先读 HANDOFF.md（2026-10-13）。
```

没有交接文档时退化为：

```
Continuity: previous session "给 DSH 写一个会话接续插件" (2026-10-13, id 1f759b89). No handoff file; ask the user to @-reference it if you need its history.
```

工作区里没有其他会话时**什么都不注入**。

实测体积（`node test/sample.mjs` 的输出）：英文 119 字符 / 139 字节，中文 80 字符 / 146 字节，只注入一次。

## 为什么不是「引用上一个会话」

| 做法 | 新会话一次性吃进 |
|---|---|
| `@` 引用上一个会话（DSH 内建的会话引用快照） | 每源上限 `max(65536, 上下文窗口 × 4 × 0.2)` 字节；在 100 万 token 窗口下上限约 80 万字节 ≈ **20 万 token** |
| 注入上一会话的压缩摘要 | 约 1k ~ 3k token |
| **本插件的指针** | **约 30 ~ 90 token，一次** |

指针注入一次后留在会话历史里，后续每轮重发时命中前缀缓存；模型真要细节时自己去 `read` 那份交接文档，全文只活在那一个会话里。省 token 的杠杆不是「少带点原文」，而是**把随身携带换成按需拉取**。

## 安装

装完都执行一次 `dsh --profile <profile> --dump-config`，确认能看到本组合包贡献的那一层，再启动。

### 从 GitHub 安装（别人拿到这个仓库时用这条）

固定版本，推荐：

```sh
dsh plugin --profile <profile> add https://github.com/ymck-x/dsh-session-continuity/archive/refs/tags/v0.1.0.tar.gz
```

跟随 `main` 最新快照（版本会漂）：

```sh
dsh plugin --profile <profile> add https://github.com/ymck-x/dsh-session-continuity/archive/refs/heads/main.tar.gz
```

也可以直接给 git 地址，`dsh plugin` 会把它转发给 pnpm：

```sh
dsh plugin --profile <profile> add git+https://github.com/ymck-x/dsh-session-continuity.git#v0.1.0
```

**为什么要打 tag**：`archive/refs/tags/<tag>.tar.gz` 是唯一能把「装的到底是哪一版」固定下来的地址——`heads/main` 会随每次提交变化，pnpm 锁文件也就锁不住；git 地址不带 `#<tag>` 同样会漂。升级就是打新 tag、换 tag 重新 `add`。另外 git 与 tarball 这两种 spec 需要先抓取，peer 兼容性是在下载之后才判定的。

### 从本地目录安装

```sh
dsh plugin --profile <profile> add /绝对路径/dsh-session-continuity
```

本地目录走 `link:`，装的是这个 checkout 本身，改了代码不用重装（但要重新构建/重启才加载新代码）。

### 移除

```sh
dsh plugin --profile <profile> remove dsh-session-continuity
```

### Desktop / Web 界面

侧边栏的**插件**页 → 安装组合包 → 目标指向本目录；或让 Agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填本目录的绝对路径。装完打开一个**新会话**，第一个步骤就会带上指针。

已经装过组合包、但 DSH 是装之前启动的：运行中的进程不会重新发布运行时组合，**重启一次 DSH** 才会真正加载本插件。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖这一行的 `config`：

```yaml
- id: session-continuity
  name: dsh-session-continuity
  config:
    enabled: true
    language: zh
    handoffPaths: ['.dsh/handoff.md', 'HANDOFF.md']
    maxTitleChars: 48
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 即完全停止注入，不必卸载 |
| `language` | `en` | 指针文本语言：`en` 或 `zh` |
| `handoffPaths` | `.dsh/handoff.md`、`.dsh/HANDOFF.md`、`HANDOFF.md`、`docs/agents/handoff.md` | 相对工作目录，取第一个存在的 |
| `maxTitleChars` | `48` | 标题超过就截断，避免超长标题撑大指针 |

## 配套：让指针有东西可指

指针指向的是**工作区里的一份交接文档**，这份文档得有人写。推荐两种做法：

1. **用 `/handoff` 技能**，但把落点改到工作区。注意 DSH 自带的 `handoff` 技能默认把交接文档写进系统临时目录（刻意的：不让半成品文档混进仓库），本插件默认找不到它。要么复制一份技能改成写 `.dsh/handoff.md`，要么用下面的做法。
2. **在项目的 `AGENTS.md` 里写一条约定**：会话收尾时把「下一步、当前进度、没解决的、踩过的坑」写进 `.dsh/handoff.md`。这样每次收尾都留下指针的落点，不需要额外技能。

不想把交接文档提交进仓库，就把它写进 `.gitignore`。

## 行为细节

- 只在本会话的**第一个模型步骤**（turn 1 / step 1）注入一次。重试不会重跑 pre-step，所以不会重复注入；用 `--continue` 恢复的会话不会注入。
- 「上一个会话」取 `sessionQuery.listSessions()` 里排在最前、且工作目录相同的那一个；没有同目录的就退到全局最新一个。
- 标题优先从投影缓存读（不读会话日志），缓存给不出时才折叠那个会话的日志。两者都是本地 IO，不花 token。
- 任何失败（会话查询服务不可用、文件读不到、标题读不出）都只是**不注入**，原样放行这一轮，不影响正常对话。
- 注入的消息带来源 `kind: 'session-continuity'`，在会话记录里可识别、可回放，不会被当作用户手打的输入。

## 已知限制

- 模型自己不能 `@` 引用会话（那是输入框给用户的能力），所以没有交接文档时，指针只能提醒用户去引用。
- 排序键是**会话创建时间**，不是最后活动时间：一个昨天创建、今天还在用的长会话，会排在一个今天新建的短会话后面。
- 没有交接文档时，指针只剩标题和时间，价值有限。
- 未覆盖的场景：多 profile 并行、跨重启后的首次注入、受限沙箱下工作区文件的可见性。

## 验证状态

**逻辑级**：`node test/run.mjs`，12 项通过——覆盖同工作目录优先、全局回退、有无交接文档、中英两种文本、只注入一次、下游拒绝透传、查询失败降级、`enabled: false`、标题缺失回退、超长标题截断。

**真实 DSH 进程里确认到的**（0.2.0-rc.2）：

- **依赖解析正确**：在插件目录下没有 `node_modules` 时，`@deepseek-ai/dsh-llm` 解析到 `…/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`，`@deepseek-ai/schemastery` 同样落在 `app.asar` 内——即 DSH 自带的真包，不是别处的副本。
- `apply(ctx, config)` 会被调用，`inject: ['sessionQuery']` 得到满足，`Config` 能通过**真** schemastery 的校验，config 会连默认补齐一起传进来。实测传入 `{"language":"en","enabled":true}` 时，`apply` 收到的是 `{"enabled":true,"language":"en","handoffPaths":[]}`——没提供的数组字段被补成了**空数组**，所以 `apply` 里对空数组做了兜底。
- 真实 `agent/pre-step` 上的形状：新会话的第一次请求是 `turn=1, step=1`；`agent.session.header.cwd` 是工作区绝对路径；`ctx.sessionQuery.listSessions()` 一次返回 154 条会话记录。

**踩到的两个坑（都已修，值得记住）**：

1. `Config` 里用 schemastery 的链式 `.default(...)` 会让配置校验失败，插件**静默不激活**——`apply` 根本不被调用，日志里什么都不写。改成纯类型声明、默认值放到 `apply` 里用 `??` 兜底就好了。这个坑只有装进真实 profile 才暴露得出来。
2. 本地测试会在仓库根建 `node_modules` 桩包。**如果这时 DSH 以 `link:` 方式装了这个目录，插件会解析到桩而不是真包**——桩的 `createUserMessage` 和 schemastery 与真实现不同，验证结论全部作废。现在 `test/run.mjs` 与 `test/sample.mjs` 结束时都会自动删掉桩（要保留就设 `DSH_CONTINUITY_KEEP_STUBS=1`）；装进 profile 之前也请确认这个目录不存在。

**没有验证到最后一步**：没能观测到「注入的消息真的进入那一步的消息批次」。原因是本机 Desktop 的运行进程在安装组合包后不会重新发布运行时组合（要重启 DSH 才生效），而重启会打断正在进行的会话；改用一次性 CLI 会话时它能加载并激活插件，却卡在模型调用阶段、走不到 `pre-step`。要彻底闭环：重启一次 DSH，开个新会话，看那一轮里有没有 `Continuity: ...` 的注入行。

## 开发

```sh
node test/run.mjs      # 逻辑测试；会自动准备两个最小桩包，结束时删掉
node test/sample.mjs   # 打印真实注入样本与体积
```

`test/stubs.mjs` 会在仓库根的 `node_modules/` 下临时写两个桩包（`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`），只为了让 `index.js` 的 `import` 在没有 DSH 的机器上能解析；测试跑完会删掉它们（要保留便于反复调试：`DSH_CONTINUITY_KEEP_STUBS=1`）。

**这一步不能省**：本仓库被 `dsh plugin add` 以 `link:` 方式装进 profile 时，插件从这个目录开始做祖先查找，残留的桩会顶掉 DSH 自带的真包。装之前确认 `node_modules/` 不存在。

## 许可

MIT
