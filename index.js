/**
 * dsh-session-continuity — 新会话开始时的「极小接续指针」。
 *
 * 目的只有一个：省 token。新会话的第一个模型步骤里，本插件只注入一条极短的
 * 用户角色消息，告诉模型「上一个会话是哪个、工作区里有没有交接文档」。
 * 它绝不搬运会话原文、也不生成摘要——需要背景时由模型自己去读那份文件。
 *
 * 注入缝：`agent/pre-step`（瀑布式事件），与 DSH 自带的 dsh-time-context、
 * dsh-tmux-context、dsh-agent-instructions 用的是同一处。
 * 注入内容：一条带来源的 user 消息（`createUserMessage`），来源 kind 为本插件名，
 * 因此在会话记录里可以被识别、被回放，也不会被当成用户手打的输入。
 */

import { statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/** Cordis 插件名，同时用作注入消息的来源 kind。 */
export const name = 'session-continuity'

/** 没有会话查询服务时插件不激活：找不到上一个会话就没什么可指。 */
export const inject = ['sessionQuery']

/** 按顺序查找的第一个存在的交接文档就算数。 */
const DEFAULT_HANDOFF_PATHS = [
  '.dsh/handoff.md',
  '.dsh/HANDOFF.md',
  'HANDOFF.md',
  'docs/agents/handoff.md',
]

const MAX_TITLE_CHARS = 48

export const Config = z.object({
  /** 关掉它即可完全停止注入，不必卸载插件。 */
  enabled: z.boolean(),
  /** 注入文本的语言：`en` 或 `zh`。 */
  language: z.string(),
  /** 相对工作目录的交接文档候选路径，取第一个存在的。 */
  handoffPaths: z.array(z.string()),
  /** 会话标题在指针里的最大字符数，超出即截断。 */
  maxTitleChars: z.number(),
})

/**
 * 注册前置的 pre-step 监听器。
 * @param ctx - 插件上下文，监听器随它释放。
 * @param config - 见 {@link Config}；缺字段时使用默认值。
 */
export function apply(ctx, config) {
  if ((config?.enabled ?? true) === false) return
  const options = {
    language: config?.language === 'zh' ? 'zh' : 'en',
    handoffPaths: Array.isArray(config?.handoffPaths) && config.handoffPaths.length > 0
      ? config.handoffPaths
      : DEFAULT_HANDOFF_PATHS,
    maxTitleChars: Number.isSafeInteger(config?.maxTitleChars) && config.maxTitleChars > 0
      ? config.maxTitleChars
      : MAX_TITLE_CHARS,
  }

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    // 不拥有这个决定：下游拒绝或已取消时原样返回。
    if (decision.kind === 'reject' || signal?.aborted === true) return decision
    // 只在本会话的第一个模型步骤注入一次；重试不会重跑 pre-step。
    if (turn !== 1 || step !== 1) return decision

    let text
    try {
      text = await buildPointer(ctx, agent, options, signal)
    } catch (error) {
      ctx.logger?.warn?.(`session-continuity: ${error instanceof Error ? error.message : String(error)}`)
      return decision
    }
    if (text === undefined) return decision

    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
      })],
    }
  }, { prepend: true })
}

/**
 * 找到应当被指向上一个会话，并渲染一行极小的指针。
 * @returns 注入文本；没有可指的会话时返回 `undefined`。
 */
async function buildPointer(ctx, agent, options, signal) {
  const sessionQuery = ctx.sessionQuery
  if (sessionQuery === undefined) return undefined

  const header = agent?.session?.header
  const selfId = agent?.id ?? header?.id
  const cwd = typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : undefined

  // listSessions 的顺序是「创建时间新到旧」：同工作目录里第一条就是上一个会话。
  const records = await sessionQuery.listSessions(signal)
  const others = records.filter((record) => record?.header?.id !== undefined && record.header.id !== selfId)
  if (others.length === 0) return undefined

  const sameWorkspace = cwd === undefined
    ? []
    : others.filter((record) => record.header.cwd === cwd)
  const previous = sameWorkspace[0] ?? others[0]

  const title = await readTitle(ctx, previous, signal)
  const handoff = findHandoff(cwd, options.handoffPaths)
  return renderPointer({
    previousId: String(previous.header.id),
    createdAt: previous.header.createdAt,
    title,
    handoff,
    language: options.language,
    maxTitleChars: options.maxTitleChars,
  })
}

/**
 * 读一个会话的最新标题。先问投影缓存（不读日志），拿不到再折叠日志。
 * @returns 去掉首尾空白的标题；都没有时返回 `undefined`。
 */
async function readTitle(ctx, record, signal) {
  const cached = cachedTitle(ctx, record)
  if (cached !== undefined) return cached
  try {
    const snapshot = await ctx.sessionQuery.readTitleSnapshot(record.header.id, signal)
    const title = snapshot?.title
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  } catch {
    return undefined
  }
}

/** 从投影缓存里读标题；缓存不可用或形状不符时返回 `undefined`。 */
function cachedTitle(ctx, record) {
  try {
    const cache = ctx.get('sessionProjectionCache')
    if (cache === undefined) return undefined
    const snapshot = cache.cachedSnapshot(record.header, ['title'])
    const title = snapshot?.values?.title
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  } catch {
    return undefined
  }
}

/** 返回第一个存在的工作区交接文档；一个都没有时返回 `undefined`。 */
function findHandoff(cwd, handoffPaths) {
  if (cwd === undefined) return undefined
  for (const candidate of handoffPaths) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const absolute = isAbsolute(candidate) ? candidate : join(cwd, candidate)
    try {
      const stats = statSync(absolute)
      if (stats.isFile()) {
        return {
          display: relative(cwd, absolute) || candidate,
          mtimeMs: stats.mtimeMs,
        }
      }
    } catch {
      // 不存在或不可读都当没找到。
    }
  }
  return undefined
}

/** 渲染指针文本。只有标题、时间、id 和一个文件路径——没有会话内容。 */
function renderPointer({ previousId, createdAt, title, handoff, language, maxTitleChars }) {
  const label = clip(title ?? previousId, maxTitleChars)
  const shortId = shortSessionId(previousId)
  const created = formatDate(createdAt)
  const head = language === 'zh'
    ? `会话接续：上个会话「${label}」（${created}，id ${shortId}）`
    : `Continuity: previous session "${label}" (${created}, id ${shortId})`

  if (handoff !== undefined) {
    const updated = formatDate(handoff.mtimeMs)
    return language === 'zh'
      ? `${head}。动手前先读 ${handoff.display}（${updated}）。`
      : `${head}. Read ${handoff.display} (${updated}) before planning.`
  }
  return language === 'zh'
    ? `${head}。它没留下交接文档；需要完整历史时请让用户用 @ 引用它。`
    : `${head}. No handoff file; ask the user to @-reference it if you need its history.`
}

/** 取会话 id 里真正有区分度的那一段：`session-` 前缀不携带信息。 */
function shortSessionId(id) {
  const raw = String(id ?? '')
  const stripped = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return stripped.slice(0, 8)
}

/** 压平空白并截断，避免一个超长标题撑大指针。 */
function clip(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return 'untitled'
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(1, maxChars - 1))}…`
}

/** 只保留本地年月日：精确到秒的时间对「上个会话」没有价值。 */
function formatDate(value) {
  const time = typeof value === 'number' && Number.isFinite(value) ? value : undefined
  if (time === undefined) return 'unknown'
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
