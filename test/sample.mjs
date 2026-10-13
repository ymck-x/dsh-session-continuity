/**
 * 打印真实的注入样本与体积，用来核对「省 token」这个目标。
 *
 * 运行：node test/sample.mjs
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStubs } from './stubs.mjs'

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

function makeContext(cwd, records) {
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
        async readTitleSnapshot(id) {
          return titles[id] === undefined ? { session: { id } } : { session: { id }, title: titles[id] }
        },
      },
    },
  }
}

async function sample({ language, cwd, records, label }) {
  const { ctx, handlers } = makeContext(cwd, records)
  apply(ctx, { language })
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
await sample({ language: 'en', cwd: bare, records: [selfRecord, previousRecord], label: '英文 · 无交接文档' })
await sample({ language: 'en', cwd: bare, records: [selfRecord], label: '工作区里没有上一个会话' })
