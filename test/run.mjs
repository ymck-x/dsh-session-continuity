/**
 * 逻辑级验证：用假的 ctx / agent 驱动 apply() 注册的 pre-step 监听器。
 *
 * 覆盖的是这个插件自己的决策：选哪个会话、什么时候注入、注入什么文本、
 * 什么情况下不注入。真正的 DSH 加载与端到端注入需要装进 profile 后另测。
 *
 * 运行：node test/run.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStubs, cleanupStubs } from './stubs.mjs'

ensureStubs()

const { apply, inject, name } = await import('../index.js')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-continuity-'))
writeFileSync(join(workspace, 'HANDOFF.md'), '# handoff\n')
const bareWorkspace = mkdtempSync(join(tmpdir(), 'dsh-continuity-bare-'))
const otherWorkspace = join(tmpdir(), 'dsh-continuity-elsewhere')

const selfRecord = { header: { id: 'session-self', cwd: workspace, createdAt: Date.UTC(2026, 9, 13) } }
const previousRecord = { header: { id: 'session-abcdef12-3456', cwd: workspace, createdAt: Date.UTC(2026, 9, 10) } }
const otherRecord = { header: { id: 'session-other-9999', cwd: otherWorkspace, createdAt: Date.UTC(2026, 9, 11) } }

/** 建一个只实现插件用到的那些面的假上下文。 */
function makeContext(records, titles = {}) {
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

/** 跑一次 pre-step。 */
async function preStep(handler, { agent, turn = 1, step = 1, decision }) {
  return handler({ agent, turn, step, signal: undefined }, async () => decision)
}

/** 取出本插件注入的那条消息，没有则返回 undefined。 */
function injected(decision) {
  return decision.messages.find((message) => message?.source?.kind === name)
}

const cases = []
const test = (title, fn) => cases.push([title, fn])

test('清单导出齐全', () => {
  assert.equal(name, 'session-continuity')
  assert.deepEqual(inject, ['sessionQuery'])
})

test('同工作目录优先，并给出标题与交接文档', async () => {
  const { ctx, handlers } = makeContext([selfRecord, otherRecord, previousRecord], {
    'session-abcdef12-3456': '重构插件索引',
  })
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const message = injected(decision)
  assert.ok(message, '应该注入一条消息')
  const text = message.content[0].text
  assert.match(text, /重构插件索引/)
  assert.match(text, /HANDOFF\.md/)
  assert.match(text, /abcdef12/)
  assert.match(text, /2026-1[01]-\d\d/)
  assert.doesNotMatch(text, /id session-/)
  assert.ok(text.length <= 400, `指针应该很短，实际 ${text.length} 字符`)
  assert.equal(decision.messages.length, 1)
  assert.equal(message.role, 'user')
  assert.deepEqual(message.source, {
    kind: name,
    form: 'snapshot',
    sections: [{ name, text }],
  })
})

test('没有同工作目录的会话时退到全局最新一个', async () => {
  const { ctx, handlers } = makeContext([selfRecord, otherRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /session-othe/)
})

test('工作区没有交接文档时明确说明，而不是编造', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /no handoff file/i)
  assert.doesNotMatch(text, /HANDOFF\.md/)
})

test('中文模式', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], { 'session-abcdef12-3456': '重构插件索引' })
  apply(ctx, { language: 'zh' })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /会话接续/)
  assert.match(text, /HANDOFF\.md/)
})

test('没有其他会话就不注入', async () => {
  const { ctx, handlers } = makeContext([selfRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  assert.equal(injected(decision), undefined)
})

test('只在第一个步骤注入', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const agent = { id: 'session-self', session: { header: selfRecord.header } }
  for (const point of [{ turn: 2, step: 1 }, { turn: 1, step: 2 }, { turn: 3, step: 4 }]) {
    const decision = await preStep(handlers.get('agent/pre-step'), {
      agent,
      ...point,
      decision: { kind: 'enter', messages: [] },
    })
    assert.equal(injected(decision), undefined, `${point.turn}/${point.step} 不该注入`)
  }
})

test('下游拒绝时原样返回', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const reject = { kind: 'reject', reason: 'archived' }
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: reject,
  })
  assert.equal(decision, reject)
})

test('会话查询失败时不影响这一轮', async () => {
  const { ctx, handlers } = makeContext([])
  ctx.sessionQuery.listSessions = async () => {
    throw new Error('backend down')
  }
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [{ role: 'user' }] },
  })
  assert.equal(injected(decision), undefined)
  assert.equal(decision.messages.length, 1)
})

test('enabled: false 完全不注册', () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, { enabled: false })
  assert.equal(handlers.size, 0)
})

test('子代理会话不会被当成上一个会话', async () => {
  const subagentRecord = {
    header: { id: 'subagent-2222', cwd: workspace, createdAt: Date.UTC(2026, 9, 12), parentSession: 'session-abcdef12-3456' },
  }
  const { ctx, handlers } = makeContext([selfRecord, subagentRecord, previousRecord], {
    'session-abcdef12-3456': '重构插件索引',
  })
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /重构插件索引/)
  assert.doesNotMatch(text, /subagent-2222/)
})

test('工作区里只有子代理会话时退回到它', async () => {
  const subagentRecord = {
    header: { id: 'subagent-2222', cwd: workspace, createdAt: Date.UTC(2026, 9, 12), parentSession: 'session-abcdef12-3456' },
  }
  const { ctx, handlers } = makeContext([selfRecord, subagentRecord], { 'subagent-2222': '一次工具调用' })
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /一次工具调用/)
})

test('标题缺失时退回会话 id', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /session-abcdef12-3456/)
})

test('超长标题被截断', async () => {
  const long = '标题'.repeat(80)
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], { 'session-abcdef12-3456': long })
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.ok(text.length <= 400, `实际 ${text.length}`)
  assert.ok(!text.includes(long))
})

let failed = 0
try {
  for (const [title, fn] of cases) {
    try {
      await fn()
      console.log(`ok   ${title}`)
    } catch (error) {
      failed += 1
      console.log(`FAIL ${title}`)
      console.log(`     ${error instanceof Error ? error.message : String(error)}`)
    }
  }
} finally {
  cleanupStubs()
}

console.log(failed === 0 ? `\n全部 ${cases.length} 项通过` : `\n${failed}/${cases.length} 项失败`)
process.exitCode = failed === 0 ? 0 : 1
