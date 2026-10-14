# dsh-session-continuity

新会话开始时，注入一条很小的**接续指针**：上一个会话是谁、工作区里有没有交接文档。

两件事值得先说清楚：

- **语言默认跟随你**（`language: auto`）。你用中文提问，指针就是中文；用英文提问就是英文。发布后收到的第一个真实差评就是「默认英文，中文用户看不懂」——所以这个默认值是这么来的。
- 指针开头写着「**与当前请求无关就忽略**」。它在语义上是背景，不是任务；你开新对话做一件全新的事时，模型应该把它放一边。

它不搬运会话原文，也不调用模型生成摘要。唯一的例外：工作区里**没有**交接文档时，它会补上那个会话的最后两句，并受字节预算硬约束——这样你不用养成写文档的习惯也能接上话。

## 注入什么

工作区里有交接文档时（英文）：

```
[background — ignore if unrelated] Your previous session in this workspace was "给 DSH 写一个会话接续插件" (2026-10-13, id 1f759b89). If this really continues it, read HANDOFF.md (2026-10-14) before planning.
```

中文（中文提问时的实际输出）：

```
（背景，与当前请求无关就忽略）这个工作区里，你上一个会话是「给 DSH 写一个会话接续插件」（2026-10-13，id 1f759b89）。如果确实接着它做，动手前先读 HANDOFF.md（2026-10-14）。
```

没有交接文档时，补上那个会话的最后两句：

```
（背景，与当前请求无关就忽略）这个工作区里，你上一个会话是「给 DSH 写一个会话接续插件」（2026-10-13，id 1f759b89）。它没留下交接文档；需要完整历史请让用户用 @ 引用它。
那个会话的结尾 —— 用户最后说：「把导出按钮改成能选 CSV 和 XLSX」；助手最后回：「CSV 已经好了，XLSX 还差一个表头映射，卡在合并单元格上。」
```

最后两句也没有（空会话等）就退回纯提醒；想彻底回到「只给指针」，把 `tailBytes` 设成 `0`。

工作区里没有其他会话时**什么都不注入**。

实测体积（`node test/sample.mjs` 的输出，只注入一次）：

| 情形 | 英文 | 中文 |
|---|---|---|
| 有交接文档 | 198 字符 / 220 字节 | 109 字符 / 233 字节 |
| 没交接文档，带最后两句 | 283 字符 / 373 字节 | 179 字符 / 435 字节 |
| 没交接文档，`tailBytes: 0` | 196 字符 / 218 字节 | — |

## 为什么不是「引用上一个会话」

| 做法 | 新会话一次性吃进 |
|---|---|
| `@` 引用上一个会话（DSH 内建的会话引用快照） | 每源上限 `max(65536, 上下文窗口 × 4 × 0.2)` 字节；在 100 万 token 窗口下上限约 80 万字节 ≈ **20 万 token** |
| 注入上一会话的压缩摘要 | 约 1k ~ 3k token |
| **本插件：有交接文档时只给指针** | **约 55 token（220 字节），一次** |
| **本插件：没交接文档时补最后两句** | **约 95 ~ 110 token（373 ~ 435 字节），一次** |

指针注入一次后留在会话历史里，后续每轮重发时命中前缀缓存；模型真要细节时自己去 `read` 那份交接文档，全文只活在那一个会话里。省 token 的杠杆不是「少带点原文」，而是**把随身携带换成按需拉取**。

## 安装

三种方式，推荐顺序如下。装完都执行一次 `dsh --profile <profile> --dump-config`，确认能看到本组合包贡献的那一层，再启动。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile <profile> add dsh-session-continuity
```

锁死版本就写 `dsh-session-continuity@0.2.3`。刚发布的版本可能被 pnpm 的 `minimumReleaseAge` 供应链策略挡一下——`dsh plugin` 会自动把它记进 profile 的 `minimumReleaseAgeExclude`，只提示、不报错。

### 从 GitHub 安装（不想走 npm，或要离线分发时）

固定版本：

```sh
dsh plugin --profile <profile> add https://github.com/ymck-x/dsh-session-continuity/archive/refs/tags/v0.2.3.tar.gz
```

跟随 `main` 最新快照（版本会漂）：

```sh
dsh plugin --profile <profile> add https://github.com/ymck-x/dsh-session-continuity/archive/refs/heads/main.tar.gz
```

也可以直接给 git 地址，`dsh plugin` 会把它转发给 pnpm：

```sh
dsh plugin --profile <profile> add git+https://github.com/ymck-x/dsh-session-continuity.git#v0.2.3
```

**为什么要打 tag**：`archive/refs/tags/<tag>.tar.gz` 是唯一能把「装的到底是哪一版」固定下来的地址——`heads/main` 会随每次提交变化，pnpm 锁文件也就锁不住；git 地址不带 `#<tag>` 同样会漂。升级就是打新 tag、换 tag 重新 `add`。另外 git 与 tarball 这两种 spec 需要先抓取，peer 兼容性是在下载之后才判定的。

### 版本

| tag | 说明 |
|---|---|
| `v0.2.3` | 语言默认改为跟随用户（`auto`）；指针开头加「与当前请求无关就忽略」；中文角色称呼改为「用户／助手」 |
| `v0.2.2` | 仅文档：安装章节补上「从 npm 安装」 |
| `v0.2.1` | 修复：引用文本里的代码围栏压平、交接文档路径统一正斜杠（真机验证时发现） |
| `v0.2.0` | 没交接文档时补上「上个会话的最后两句」（受 `tailBytes` 约束） |
| `v0.1.3` | 修复：子代理会话不再被当成「上一个会话」（端到端验证时发现） |
| `v0.1.2` | 仅文档：补上端到端验证结论（重启后注入成功，附会话日志证据） |
| `v0.1.1` | 补 `peerDependenciesMeta.optional`（消除 pnpm 的 peer 警告）与仓库元数据 |
| `v0.1.0` | 首个可安装版本 |

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
| `language` | `auto` | `auto` 跟随这一轮用户消息的语言（有中日韩文字就用中文）；也可以写死 `en` 或 `zh` |
| `handoffPaths` | `.dsh/handoff.md`、`.dsh/HANDOFF.md`、`HANDOFF.md`、`docs/agents/handoff.md` | 相对工作目录，取第一个存在的 |
| `maxTitleChars` | `48` | 标题超过就截断，避免超长标题撑大指针 |
| `tailBytes` | `500` | 没有交接文档时，从上一个会话末尾带过来的字节预算（用户与助手各一半）；`0` 表示只给指针 |

## 配套：让指针有东西可指

指针指向的是**工作区里的一份交接文档**，这份文档得有人写。推荐两种做法：

1. **用 `/handoff` 技能**，但把落点改到工作区。注意 DSH 自带的 `handoff` 技能默认把交接文档写进系统临时目录（刻意的：不让半成品文档混进仓库），本插件默认找不到它。要么复制一份技能改成写 `.dsh/handoff.md`，要么用下面的做法。
2. **在项目的 `AGENTS.md` 里写一条约定**：会话收尾时把「下一步、当前进度、没解决的、踩过的坑」写进 `.dsh/handoff.md`。这样每次收尾都留下指针的落点，不需要额外技能。

不想把交接文档提交进仓库，就把它写进 `.gitignore`。

## 行为细节

- 只在本会话的**第一个模型步骤**（turn 1 / step 1）注入一次。重试不会重跑 pre-step，所以不会重复注入；用 `--continue` 恢复的会话不会注入。
- 「上一个会话」取 `sessionQuery.listSessions()` 里排在最前、且工作目录相同的那一个；没有同目录的就退到全局最新一个。
- **子代理会话不算「上一个会话」**（会话 header 带 `parentSession` 的那些）。子代理在时间上永远比真实对话更新，不排除的话指针会指向一次工具调用——这个行为是端到端验证时从真实注入里发现的。只有工作区里找不到主会话时才退回它们。
- 标题优先从投影缓存读（不读会话日志），缓存给不出时才折叠那个会话的日志。两者都是本地 IO，不花 token。
- 任何失败（会话查询服务不可用、文件读不到、标题读不出）都只是**不注入**，原样放行这一轮，不影响正常对话。
- 注入的消息带来源 `kind: 'session-continuity'`，在会话记录里可识别、可回放，不会被当作用户手打的输入。
- 补最后两句时，只认来源为真实用户的 `user/message`（`source.kind === 'user'`）：既不会把别的插件注入的上下文（时间读数、技能目录、上一次的接续指针）当成用户的话，也不会让本插件递归引用自己。读取失败一律当作没有——绝不因为要补一段结尾而拖住这一轮。
- 原文进注入文本前会压平连续反引号（` ``` ` → `'''`），否则一段带代码块的回复会把后面的内容读成代码；交接文档的路径统一写成正斜杠，不随宿主平台变形。这两条都是真机验证时从实际注入里发现的。

## 已知限制

- 模型自己不能 `@` 引用会话（那是输入框给用户的能力），所以没有交接文档时，指针只能提醒用户去引用。
- 排序键是**会话创建时间**，不是最后活动时间：一个昨天创建、今天还在用的长会话，会排在一个今天新建的短会话后面。
- 没有交接文档时，指针只剩标题和时间，价值有限。
- 未覆盖的场景：多 profile 并行、受限沙箱下工作区文件的可见性。（跨重启后的首次注入已验证：重启 DSH 后新开一个子会话，注入当次生效。）

## 验证状态

**逻辑级**：`node test/run.mjs`，25 项通过——覆盖同工作目录优先、全局回退、有无交接文档、补最后两句、只认真实用户输入、字节预算截断、语言跟随（auto/显式 en/显式 zh）、只注入一次、下游拒绝透传、查询失败降级、`enabled: false`、标题缺失回退、超长标题截断、子代理会话的排除与回退、交接文档路径写法、代码围栏压平。

**发布后收到的第一个真实差评，以及它改了什么**：用户开新对话时看到的是英文指针（`Continuity: previous session … Tail — user: …`）——默认 `language: en`，而他用中文，直接看不懂；紧接着模型又把这段注入当成回答素材，回了一串会话编号式的话。两处都改了：语言默认改为 `auto` 跟随用户，指针开头写明「与当前请求无关就忽略」，中文里的角色称呼也从「你／它」改成「用户／助手」（原来的写法会让模型分不清是谁说的）。

**真实 DSH 进程里确认到的**（0.2.0-rc.2）：

- **依赖解析正确**：在插件目录下没有 `node_modules` 时，`@deepseek-ai/dsh-llm` 解析到 `…/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`，`@deepseek-ai/schemastery` 同样落在 `app.asar` 内——即 DSH 自带的真包，不是别处的副本。
- `apply(ctx, config)` 会被调用，`inject: ['sessionQuery']` 得到满足，`Config` 能通过**真** schemastery 的校验，config 会连默认补齐一起传进来。实测传入 `{"language":"en","enabled":true}` 时，`apply` 收到的是 `{"enabled":true,"language":"en","handoffPaths":[]}`——没提供的数组字段被补成了**空数组**，所以 `apply` 里对空数组做了兜底。
- 真实 `agent/pre-step` 上的形状：新会话的第一次请求是 `turn=1, step=1`；`agent.session.header.cwd` 是工作区绝对路径；`ctx.sessionQuery.listSessions()` 一次返回 154 条会话记录。
- **四条分支都在真机上跑过**（重启 DSH 后用全新子会话触发，原文从会话日志里读）：英文 + 有交接文档 147 字节；英文 + 无交接文档（带结尾两句）394 字节；中文 + 有交接文档 154 字节；中文 + 无交接文档 559 字节。中文那两次顺带证明了「用户在 `cordis.patch.yml` 里覆盖 `config`」确实生效——home 级补丁的改动会被热加载，不用再重启。

**踩到的两个坑（都已修，值得记住）**：

1. `Config` 里用 schemastery 的链式 `.default(...)` 会让配置校验失败，插件**静默不激活**——`apply` 根本不被调用，日志里什么都不写。改成纯类型声明、默认值放到 `apply` 里用 `??` 兜底就好了。这个坑只有装进真实 profile 才暴露得出来。
2. 本地测试会在仓库根建 `node_modules` 桩包。**如果这时 DSH 以 `link:` 方式装了这个目录，插件会解析到桩而不是真包**——桩的 `createUserMessage` 和 schemastery 与真实现不同，验证结论全部作废。现在 `test/run.mjs` 与 `test/sample.mjs` 结束时都会自动删掉桩（要保留就设 `DSH_CONTINUITY_KEEP_STUBS=1`）；装进 profile 之前也请确认这个目录不存在。

**注入真的发生了（端到端闭环）**：重启 DSH 之后，一个全新子会话的日志里留下了这条记录——会话文件 `session.v4.jsonl.zstd` 里的 `user/message` 事件，来源 `kind: session-continuity`：

```json
{"type":"user/message","seq":13,"data":{"content":[{"type":"text","text":"Continuity: previous session \"…\" (2026-10-13, id e5545680). No handoff file; ask the user to @-reference it if you need its history."}],"source":{"kind":"session-continuity","form":"snapshot","sections":[{"name":"session-continuity","text":"…"}]},"role":"user","id":"987a9f60-…"}}
```

也就是说：它选对了同工作目录的上一个会话、把 `session-` 前缀剥掉只留 8 位 id、标题按 48 字符截断、没有交接文档时正确降级，并且那个会话里**只注入这一条**（139 字节）。

**一个反直觉的观察**：同一轮里直接问模型「你上下文里有没有以 `Continuity:` 开头的 user 消息」，它会答「没有」——DSH 把这类消息作为**上下文注入**与用户输入区分开，模型不把它当用户消息。所以判断插件是否生效，**看会话日志，不要问模型**。

## 开发

```sh
node test/run.mjs      # 逻辑测试；会自动准备两个最小桩包，结束时删掉
node test/sample.mjs   # 打印真实注入样本与体积
```

`test/stubs.mjs` 会在仓库根的 `node_modules/` 下临时写两个桩包（`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`），只为了让 `index.js` 的 `import` 在没有 DSH 的机器上能解析；测试跑完会删掉它们（要保留便于反复调试：`DSH_CONTINUITY_KEEP_STUBS=1`）。

**这一步不能省**：本仓库被 `dsh plugin add` 以 `link:` 方式装进 profile 时，插件从这个目录开始做祖先查找，残留的桩会顶掉 DSH 自带的真包。装之前确认 `node_modules/` 不存在。

## 许可

MIT
