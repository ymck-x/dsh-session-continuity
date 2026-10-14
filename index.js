/**
 * dsh-session-continuity — 新会话开始时的「极小接续指针」。
 *
 * 目的只有一个：省 token。新会话的第一个模型步骤里，本插件注入一条很短的用户角色
 * 消息，告诉模型「上一个会话是哪个、工作区里有没有交接文档」。
 *
 * 工作区里**没有**交接文档时，它会额外补上那个会话的最后两句（用户最后说的、助手
 * 最后回的），并受字节预算硬约束——这是唯一会带上会话内容的情形。其余情况一律
 * 只给指针：需要背景时由模型自己去读那份文件。
 *
 * 注入缝：`agent/pre-step`（瀑布式事件），与 DSH 自带的 dsh-time-context、
 * dsh-tmux-context、dsh-agent-instructions 用的是同一处。
 * 注入内容：一条带来源的 user 消息（`createUserMessage`），来源 kind 为本插件名，
 * 因此在会话记录里可以被识别、被回放，也不会被当成用户手打的输入。
 */

import { statSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
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

/** 没有交接文档时，从上一个会话末尾带过来的字节预算。 */
const DEFAULT_TAIL_BYTES = 500

/** 优先复用上一个会话的压缩摘要时，最多带多少字节（摘要由 DSH 生成，不额外花钱）。 */
const DEFAULT_SUMMARY_BYTES = 1500

export const Config = z.object({
  /** 关掉它即可完全停止注入，不必卸载插件。 */
  enabled: z.boolean(),
  /** 注入文本的语言：`auto`（跟随这一轮用户消息）、`en` 或 `zh`。 */
  language: z.string(),
  /** 相对工作目录的交接文档候选路径，取第一个存在的。 */
  handoffPaths: z.array(z.string()),
  /** 会话标题在指针里的最大字符数，超出即截断。 */
  maxTitleChars: z.number(),
  /** 没有交接文档时，从上一个会话末尾带过来的字节预算；`0` 表示只给指针。 */
  tailBytes: z.number(),
  /** 复用上一个会话的压缩摘要时最多带多少字节；`0` 表示不用摘要。 */
  summaryBytes: z.number(),
})

/**
 * 注入文本用哪种语言。
 *
 * 默认 `auto`：看这一轮用户自己写的话里有没有中日韩文字。用户用中文提问，
 * 却收到一段英文的会话背景，是发布后收到的第一个真实差评——所以这个默认值是本意。
 *
 * @param configured - 配置里的 `language`；显式给 `en`/`zh` 时直接采纳。
 * @param messages - 这一步拟进入的消息批次。
 * @returns `'en'` 或 `'zh'`。
 */
function resolveLanguage(configured, messages) {
  if (configured === 'zh' || configured === 'en') return configured
  for (const message of messages) {
    if (message?.role !== 'user') continue
    if (message?.source?.kind !== 'user') continue
    const text = blockText(message.content)
    if (text === undefined) continue
    if (/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text)) return 'zh'
    return 'en'
  }
  return 'en'
}

/**
 * 注册前置的 pre-step 监听器。
 * @param ctx - 插件上下文，监听器随它释放。
 * @param config - 见 {@link Config}；缺字段时使用默认值。
 */
export function apply(ctx, config) {
  if ((config?.enabled ?? true) === false) return
  const options = {
    language: config?.language === 'zh' || config?.language === 'en' ? config.language : 'auto',
    handoffPaths: Array.isArray(config?.handoffPaths) && config.handoffPaths.length > 0
      ? config.handoffPaths
      : DEFAULT_HANDOFF_PATHS,
    maxTitleChars: Number.isSafeInteger(config?.maxTitleChars) && config.maxTitleChars > 0
      ? config.maxTitleChars
      : MAX_TITLE_CHARS,
    tailBytes: Number.isSafeInteger(config?.tailBytes) && config.tailBytes >= 0
      ? config.tailBytes
      : DEFAULT_TAIL_BYTES,
    summaryBytes: Number.isSafeInteger(config?.summaryBytes) && config.summaryBytes >= 0
      ? config.summaryBytes
      : DEFAULT_SUMMARY_BYTES,
  }

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next()
    // 不拥有这个决定：下游拒绝或已取消时原样返回。
    if (decision.kind === 'reject' || signal?.aborted === true) return decision
    // 只在本会话的第一个模型步骤注入一次；重试不会重跑 pre-step。
    if (turn !== 1 || step !== 1) return decision

    let text
    try {
      // 语言跟随这一轮用户自己写的话，而不是配置里的固定值。
      const language = resolveLanguage(options.language, decision.messages)
      text = await buildPointer(ctx, agent, { ...options, language }, signal)
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

  // 子代理会话（带 parentSession）不是用户要接续的那场对话——它们在时间上总是更新，
  // 会让指针指向一次工具调用而不是上一场真实对话。只有工作区里找不到主会话时才退回它们。
  const primary = others.filter((record) => record.header.parentSession == null)
  const pool = primary.length > 0 ? primary : others

  const sameWorkspace = cwd === undefined
    ? []
    : pool.filter((record) => record.header.cwd === cwd)
  const previous = sameWorkspace[0] ?? pool[0]

  const title = await readTitle(ctx, previous, signal)
  const handoff = findHandoff(cwd, options.handoffPaths)
  // 工作区里有交接文档时，指针指向文档就够，不再带内容。
  const continuity = handoff === undefined
    ? await readContinuity(ctx, previous.header.id, options, signal)
    : undefined
  return renderPointer({
    previousId: String(previous.header.id),
    createdAt: previous.header.createdAt,
    title,
    handoff,
    continuity,
    language: options.language,
    maxTitleChars: options.maxTitleChars,
  })
}

/**
 * 读上一个会话能交给新窗口的「接续材料」。
 *
 * 优先用它自己的压缩摘要：会话长到要换窗口时，DSH 通常已经把它压缩过，
 * 那条检查点就是一份现成的交接文档（意图、进展、下一步、踩过的坑），
 * 搬过来不花一次模型调用——这是所有方案里最划算的。
 *
 * 没有摘要（会话还短）时退回最后两句。读取失败一律当作没有——
 * 绝不因为要带点背景而拖住这一轮。
 *
 * @returns `{ kind: 'summary', text }` 或 `{ kind: 'tail', user, assistant }`。
 */
async function readContinuity(ctx, sessionId, options, signal) {
  const query = ctx.sessionQuery
  if (typeof query?.readSurface !== 'function') return undefined

  let surface
  try {
    surface = await query.readSurface(sessionId)
  } catch {
    return undefined
  }
  if (signal?.aborted === true) return undefined
  const events = Array.isArray(surface?.events) ? surface.events : []

  if (Number.isSafeInteger(options.summaryBytes) && options.summaryBytes > 0) {
    const checkpoint = lastCheckpointText(events)
    if (checkpoint !== undefined) {
      const digest = digestCheckpoint(checkpoint, options.summaryBytes)
      if (digest !== undefined) return { kind: 'summary', text: sanitizeQuoted(digest) }
    }
  }

  if (!Number.isSafeInteger(options.tailBytes) || options.tailBytes <= 0) return undefined
  const lastUser = lastMessageText(events, 'user/message', true)
  const lastAssistant = lastMessageText(events, 'assistant/message', false)
  if (lastUser === undefined && lastAssistant === undefined) return undefined

  const perMessage = Math.max(80, Math.floor(options.tailBytes / 2))
  return {
    kind: 'tail',
    user: lastUser === undefined ? undefined : clipBytes(sanitizeQuoted(lastUser), perMessage),
    assistant: lastAssistant === undefined ? undefined : clipBytes(sanitizeQuoted(lastAssistant), perMessage),
  }
}

/** 找表层里最后一条压缩检查点（DSH 自动摘要）。 */
function lastCheckpointText(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const message = event.data?.message ?? event.data
    if (message?.source?.kind !== 'compact-checkpoint') continue
    const text = blockText(message?.content)
    if (text !== undefined) return text
  }
  return undefined
}

/** 摘要里最值得带回新窗口的小节，按重要性排序。 */
const SUMMARY_SECTIONS = [
  '## Current Work',
  '## Next Step',
  '## Pending Jobs',
  '## Primary Request and Intent',
  '## Critical Context',
]

/**
 * 把一份压缩摘要压进字节预算：先挑关键小节，不够再按原顺序补，
 * 每段内部的代码围栏也会被压平（摘要里常带代码）。
 */
function digestCheckpoint(text, budgetBytes) {
  const inside = /<compacted-summary>([\s\S]*?)<\/compacted-summary>/.exec(text)
  const body = (inside === null ? text : inside[1]).trim()
  if (body === '') return undefined

  const sections = []
  let current = { title: '', lines: [] }
  for (const line of body.split('\n')) {
    if (/^##\s/.test(line)) {
      if (current.title !== '' || current.lines.length > 0) sections.push(current)
      current = { title: line.trim(), lines: [] }
      continue
    }
    current.lines.push(line)
  }
  if (current.title !== '' || current.lines.length > 0) sections.push(current)

  const preferred = []
  for (const wanted of SUMMARY_SECTIONS) {
    const found = sections.find((section) => section.title.toLowerCase() === wanted.toLowerCase())
    if (found !== undefined) preferred.push(found)
  }
  const rest = sections.filter((section) => !preferred.includes(section))
  const ordered = [...preferred, ...rest]

  let out = ''
  let used = 0
  const encoder = new TextEncoder()
  for (const section of ordered) {
    const piece = `${section.title}\n${section.lines.join('\n')}`.trim()
    if (piece === '') continue
    const size = encoder.encode(piece).length
    if (used + size <= budgetBytes) {
      out += (out === '' ? '' : '\n') + piece
      used += size
      continue
    }
    const room = budgetBytes - used
    if (room > 120) {
      const clipped = clipBytes(piece, room)
      if (clipped !== undefined) out += (out === '' ? '' : '\n') + clipped
    }
    break
  }
  return out === '' ? undefined : out
}

/**
 * 引用一段别人的文本前先压掉会撑破结构的连续反引号围栏。
 *
 * 注入的内容是 Markdown 里的普通引用；原文里的 ``` 会让后面的内容被读成代码块，
 * 甚至把本条消息的其余部分一起吞掉。
 */
function sanitizeQuoted(text) {
  return text.replace(/`{2,}/g, "'''")
}

/**
 * 从表层事件里倒着找某类消息的文本。
 * @param events - `sessionQuery.readSurface()` 返回的表层事件。
 * @param type - 事件类型，例如 `user/message`。
 * @param humanOnly - 为真时只接受真实用户输入（排除插件注入的上下文）。
 */
function lastMessageText(events, type, humanOnly) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== type) continue
    const message = event.data?.message ?? event.data
    if (humanOnly && message?.source?.kind !== 'user') continue
    const text = blockText(message?.content)
    if (text !== undefined) return text
  }
  return undefined
}

/** 把一条消息的内容块拼成纯文本；没有文本块时返回 `undefined`。 */
function blockText(content) {
  if (!Array.isArray(content)) return undefined
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** 按 UTF-8 字节数截断，不切断多字节字符。 */
function clipBytes(value, maxBytes) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= maxBytes) return text
  let clipped = ''
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).length
    if (used + size > maxBytes) break
    clipped += char
    used += size
  }
  return clipped === '' ? undefined : `${clipped}…`
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
          // 注入文本里统一用正斜杠：模型读到的路径不该随宿主平台变形。
          display: (relative(cwd, absolute) || candidate).split(sep).join('/'),
          mtimeMs: stats.mtimeMs,
        }
      }
    } catch {
      // 不存在或不可读都当没找到。
    }
  }
  return undefined
}

/** 渲染指针文本：标题、时间、id，加一个文件路径或那个会话的最后两句。 */
function renderPointer({ previousId, createdAt, title, handoff, continuity, language, maxTitleChars }) {
  const label = clip(title ?? previousId, maxTitleChars)
  const shortId = shortSessionId(previousId)
  const created = formatDate(createdAt)
  const head = language === 'zh'
    ? `（背景，与当前请求无关就忽略）这个工作区里，你上一个会话是「${label}」（${created}，id ${shortId}）`
    : `[background — ignore if unrelated] Your previous session in this workspace was "${label}" (${created}, id ${shortId})`

  if (handoff !== undefined) {
    const updated = formatDate(handoff.mtimeMs)
    return language === 'zh'
      ? `${head}。如果确实接着它做，动手前先读 ${handoff.display}（${updated}）。`
      : `${head}. If this really continues it, read ${handoff.display} (${updated}) before planning.`
  }

  if (continuity?.kind === 'summary') {
    return language === 'zh'
      ? `${head}。它没留下交接文档，但它被自动压缩过，这是那份摘要里最要紧的几节：\n${continuity.text}`
      : `${head}. No handoff file, but that session was auto-compacted; these are the parts of its digest that matter:\n${continuity.text}`
  }

  const tail = continuity?.kind === 'tail' ? continuity : undefined
  const parts = []
  if (tail?.user !== undefined) {
    // 用「用户／助手」而不是「你／它」：中文里的「你」会让模型分不清是谁说的话。
    parts.push(language === 'zh' ? `用户最后说：「${tail.user}」` : `user: "${tail.user}"`)
  }
  if (tail?.assistant !== undefined) {
    parts.push(language === 'zh' ? `助手最后回：「${tail.assistant}」` : `assistant: "${tail.assistant}"`)
  }
  if (parts.length === 0) {
    return language === 'zh'
      ? `${head}。它没留下交接文档；需要完整历史时请让用户用 @ 引用它。`
      : `${head}. No handoff file; ask the user to @-reference it if you need its history.`
  }
  return language === 'zh'
    ? `${head}。它没留下交接文档；需要完整历史请让用户用 @ 引用它。\n那个会话的结尾 —— ${parts.join('；')}`
    : `${head}. No handoff file; ask the user to @-reference it for the full history.\nTail of it — ${parts.join(' | ')}`
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
