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

### 命令行（推荐）

```sh
dsh plugin --profile <profile> add /绝对路径/dsh-session-continuity
dsh --profile <profile> --dump-config    # 应能看到本组合包贡献的那一层
dsh --profile <profile>
```

移除：

```sh
dsh plugin --profile <profile> remove dsh-session-continuity
```

### Desktop / Web 界面

侧边栏的**插件**页 → 安装组合包 → 目标指向本目录；或让 Agent 调用 `plugin_manager` 的 `install_bundle`，`target` 填本目录的绝对路径。装完打开一个**新会话**，第一个步骤就会带上指针。

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

- 逻辑级：`node test/run.mjs`，12 项通过——覆盖同工作目录优先、全局回退、有无交接文档、中英两种文本、只注入一次、下游拒绝透传、查询失败降级、`enabled: false`、标题缺失回退、超长标题截断。
- 未做：装进真实 profile 后的端到端注入验证。本仓库未在你的 DSH 里安装过，README 不声称已验证到那一步。

## 开发

```sh
node test/run.mjs      # 逻辑测试；会自动准备两个最小桩包，无需 pnpm install
node test/sample.mjs   # 打印真实注入样本与体积
```

`test/stubs.mjs` 会在 `node_modules/` 下写两个桩包（`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`），只为了让 `index.js` 的 `import` 在没有 DSH 的机器上能解析。真实运行时用的是 DSH 自带的同名包，`node_modules/` 不需要提交。

## 许可

MIT
