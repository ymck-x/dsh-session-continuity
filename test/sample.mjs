/**
 * 打印真实的注入样本与体积，用来核对「省 token」这个目标。
 *
 * 运行：node test/sample.mjs
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanupStubs, ensureStubs } from './stubs.mjs'

ensureStubs()

const { apply, name } = await import('../index.js')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-continuity-sample-'))
writeFileSync(join(workspace, 'HANDOFF.md'), '# handoff\n')
const bare = mkdtempSync(join(tmpdir(), 'dsh-continuity-sample-bare-'))

const selfRecord = { header: { id: 'session-self', cwd: workspace, createdAt: Date.UTC(2026, 9, 13, 9, 15) } }
const previousRecord = {
  header: { id: 'session-1f759b89-3603-4ed4-905d-0a6ed4402618', cwd: workspace, createdAt: Date.UTC(2026, 9, 12, 16, 40) },
}
const titles = { 'session-1f759b89-3603-4ed4-905d-0a6ed4402618': '给 DSH 写一个会话接续插件' }

function makeContext(cwd, records, surfaceEvents = tailSurface) {
  const handlers = new Map()
  return {
    handlers,
    ctx: {
      on(event, handler) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      get() {
        return undefined
      },
      logger: { warn() {} },
      sessionQuery: {
        async listSessions() {
          return records
        },
        async readTitle(id) {
          return titles[id] === undefined ? undefined : { title: titles[id] }
        },
        async readSurface(id) {
          return { session: { id }, capturedThroughSeq: null, events: surfaceEvents }
        },
      },
    },
  }
}

/** 上一个会话结尾的样子。 */
const tailSurface = [
  {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text: '把导出按钮改成能选 CSV 和 XLSX' }], source: { kind: 'user' } },
  },
  {
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'CSV 已经好了，XLSX 还差一个表头映射，卡在合并单元格上。' }],
      },
    },
  },
]

/** 上一个会话被 DSH 自动压缩后留下的摘要。 */
const summarySurface = [
  {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'compact-checkpoint', compactionId: 'cp-1' },
      content: [{
        type: 'text',
        text: [
          'This is an automatically generated checkpoint condensing an earlier span of the conversation.',
          '<compacted-summary>',
          '## Primary Request and Intent',
          '- 做一个插件索引站，把 GITHUB 上零散的 DSH 插件汇总起来给用户浏览',
          '## Key Technical Concepts',
          '- DSH 插件体系、bundle patch、pnpm 供应链策略',
          '## Files and Code',
          '- build_index.py：抓取与去重；out/index.json：产物',
          '## Errors and Fixes',
          '- 分页参数在第二页会丢排序，已改成显式游标',
          '## Current Work',
          '- 正在写导入器，已能跑通单仓库',
          '## Next Step',
          '- 补上分页，然后测一个大仓库',
          '## Pending Jobs',
          '- 还没测过超过 500 个插件的仓库',
          '## Critical Context',
          '- 用户要求索引必须可核对，不许出现未经核实的版本号',
          '</compacted-summary>',
        ].join('\n'),
      }],
    },
  },
]

async function sample({ language, cwd, records, label, tailBytes, surfaceEvents = tailSurface }) {
  const { ctx, handlers } = makeContext(cwd, records, surfaceEvents)
  apply(ctx, { language, tailBytes })
  const decision = await handlers.get('agent/pre-step')(
    { agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd } } }, turn: 1, step: 1, signal: undefined },
    async () => ({ kind: 'enter', messages: [] }),
  )
  const message = decision.messages.find((candidate) => candidate?.source?.kind === name)
  const text = message === undefined ? '(不注入)' : message.content[0].text
  console.log(`--- ${label} ---`)
  console.log(text)
  console.log(`字符数 ${[...text].length}，UTF-8 字节 ${Buffer.byteLength(text, 'utf8')}`)
  console.log()
}

await sample({ language: 'en', cwd: workspace, records: [selfRecord, previousRecord], label: '英文 · 有交接文档' })
await sample({ language: 'zh', cwd: workspace, records: [selfRecord, previousRecord], label: '中文 · 有交接文档' })
await sample({ language: 'en', cwd: bare, records: [selfRecord, previousRecord], label: '英文 · 没交接文档（带结尾两句）' })
await sample({ language: 'zh', cwd: bare, records: [selfRecord, previousRecord], label: '中文 · 没交接文档（带结尾两句）' })
await sample({ language: 'zh', cwd: bare, records: [selfRecord, previousRecord], surfaceEvents: summarySurface, label: '中文 · 没交接文档但有 DSH 压缩摘要' })
await sample({ language: 'en', cwd: bare, records: [selfRecord, previousRecord], surfaceEvents: summarySurface, label: '英文 · 没交接文档但有 DSH 压缩摘要' })
await sample({ language: 'en', cwd: bare, records: [selfRecord, previousRecord], tailBytes: 0, label: '英文 · 没交接文档且 tailBytes=0' })
await sample({ language: 'en', cwd: bare, records: [selfRecord], label: '工作区里没有上一个会话' })

cleanupStubs()
