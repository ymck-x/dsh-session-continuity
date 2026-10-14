/**
 * 逻辑级验证：用假的 ctx / agent 驱动 apply() 注册的 pre-step 监听器。
 *
 * 覆盖的是这个插件自己的决策：选哪个会话、什么时候注入、注入什么文本、
 * 什么情况下不注入。真正的 DSH 加载与端到端注入需要装进 profile 后另测。
 *
 * 运行：node test/run.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureStubs, cleanupStubs } from './stubs.mjs'

ensureStubs()

const { apply, inject, name } = await import('../index.js')

const workspace = mkdtempSync(join(tmpdir(), 'dsh-continuity-'))
writeFileSync(join(workspace, 'HANDOFF.md'), '# handoff\n')
const bareWorkspace = mkdtempSync(join(tmpdir(), 'dsh-continuity-bare-'))
// 带子目录的交接文档：用来验证注入文本里的路径写法。
const nestedWorkspace = mkdtempSync(join(tmpdir(), 'dsh-continuity-nested-'))
mkdirSync(join(nestedWorkspace, '.dsh'), { recursive: true })
writeFileSync(join(nestedWorkspace, '.dsh', 'handoff.md'), '# handoff\n')
const otherWorkspace = join(tmpdir(), 'dsh-continuity-elsewhere')

const selfRecord = { header: { id: 'session-self', cwd: workspace, createdAt: Date.UTC(2026, 9, 13) } }
const previousRecord = { header: { id: 'session-abcdef12-3456', cwd: workspace, createdAt: Date.UTC(2026, 9, 10) } }
const otherRecord = { header: { id: 'session-other-9999', cwd: otherWorkspace, createdAt: Date.UTC(2026, 9, 11) } }

/** 建一个只实现插件用到的那些面的假上下文。 */
function makeContext(records, titles = {}, surfaceEvents = []) {
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
        async readSurface(id) {
          return { session: { id }, capturedThroughSeq: null, events: surfaceEvents }
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

test('显式指定 zh 时用中文', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], { 'session-abcdef12-3456': '重构插件索引' })
  apply(ctx, { language: 'zh' })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /你上一个会话是/)
  assert.match(text, /HANDOFF\.md/)
})

/** 造一条这一轮用户自己写的消息。 */
function humanMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('默认跟随用户消息的语言（中文提问得到中文指针）', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [humanMessage('帮我把导出功能改成能选 CSV')] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /你上一个会话是/)
  assert.doesNotMatch(text, /previous session/)
})

test('默认跟随用户消息的语言（英文提问得到英文指针）', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [humanMessage('make the export support CSV')] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /previous session/)
})

test('显式 en 不会被中文消息改掉', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, { language: 'en' })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [humanMessage('帮我把导出功能改成能选 CSV')] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /previous session/)
})

test('指针带上「无关就忽略」的提示', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, { language: 'zh' })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /与当前请求无关就忽略/)
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

/** 造一条表层的 user 消息事件。 */
function userEvent(text, kind = 'user') {
  return {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind } },
  }
}

/** 造一条表层的 assistant 消息事件。 */
function assistantEvent(text) {
  return {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

test('没有交接文档时带上个会话的最后两句', async () => {
  const surface = [
    userEvent('把导出改成 CSV'),
    assistantEvent('已改完，测试通过。'),
    userEvent('再顺手把表头换成中文'),
    assistantEvent('表头已换成中文，另外加了单位。'),
  ]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /再顺手把表头换成中文/)
  assert.match(text, /表头已换成中文/)
  assert.doesNotMatch(text, /把导出改成 CSV/, '只带最后两句，不带更早的内容')
})

test('只认真实用户的话，跳过插件注入的上下文', async () => {
  const surface = [
    userEvent('真正的用户消息'),
    assistantEvent('好'),
    userEvent('Time sampled while preparing turn 1', 'time-context'),
  ]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /真正的用户消息/)
  assert.doesNotMatch(text, /Time sampled/)
})

test('tailBytes 为 0 时只给指针', async () => {
  const surface = [userEvent('不该出现的内容'), assistantEvent('也不该出现')]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, { tailBytes: 0 })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.doesNotMatch(text, /不该出现/)
  assert.match(text, /no handoff file/i)
})

test('结尾片段受字节预算约束', async () => {
  const long = '啊'.repeat(2000)
  const surface = [userEvent(long), assistantEvent(long)]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, { tailBytes: 500 })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  const bytes = Buffer.byteLength(text, 'utf8')
  assert.ok(bytes < 900, `整条注入必须很小，实际 ${bytes} 字节`)
})

test('有交接文档时不带结尾片段', async () => {
  const surface = [userEvent('不该出现'), assistantEvent('也不该出现')]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /HANDOFF\.md/)
  assert.doesNotMatch(text, /不该出现/)
})

test('交接文档路径统一用正斜杠', async () => {
  const { ctx, handlers } = makeContext([selfRecord, previousRecord])
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: nestedWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /\.dsh\/handoff\.md/)
  assert.doesNotMatch(text, /\\/, '注入文本里不该出现平台相关的反斜杠')
})

test('引用文本里的代码围栏被压平', async () => {
  const surface = [
    userEvent('看看这段'),
    assistantEvent('结果是这样：\n```js\nconst a = 1\n```\n就这些'),
  ]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, {})
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.doesNotMatch(text, /```/, '代码围栏不能原样进注入文本')
  assert.match(text, /'''/)
})

/** 造一条 DSH 自动生成的压缩检查点事件。 */
function checkpointEvent(summary) {
  return {
    type: 'user/message',
    data: {
      role: 'user',
      content: [{
        type: 'text',
        text: `This is an automatically generated checkpoint condensing an earlier span.\n<compacted-summary>\n${summary}\n</compacted-summary>`,
      }],
      source: { kind: 'compact-checkpoint', compactionId: 'cp-1' },
    },
  }
}

const SAMPLE_SUMMARY = [
  '## Primary Request and Intent',
  '- 用户想要一个插件索引站',
  '',
  '## Key Technical Concepts',
  '- DSH 的插件体系',
  '',
  '## Current Work',
  '- 正在写导入器',
  '',
  '## Next Step',
  '- 补上分页',
  '',
  '## Pending Jobs',
  '- 还没测大仓库',
].join('\n')

test('优先复用上一个会话的压缩摘要（零模型调用）', async () => {
  const surface = [checkpointEvent(SAMPLE_SUMMARY), userEvent('收工'), assistantEvent('好')]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, { language: 'zh' })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /正在写导入器/, '应带上 Current Work')
  assert.match(text, /补上分页/, '应带上 Next Step')
  assert.match(text, /还没测大仓库/, '应带上 Pending Jobs')
  assert.match(text, /插件索引站/, '应带上原始意图')
  assert.doesNotMatch(text, /compacted-summary/, '不该把内部标签带进去')
  assert.doesNotMatch(text, /收工/, '有摘要时不用退回最后两句')
})

test('摘要也受字节预算约束', async () => {
  const surface = [checkpointEvent(SAMPLE_SUMMARY)]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, { language: 'zh', summaryBytes: 120 })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.ok(Buffer.byteLength(text, 'utf8') < 500, `实际 ${Buffer.byteLength(text, 'utf8')} 字节`)
  assert.match(text, /正在写导入器/, '预算再小也该保住最要紧的那节')
})

test('summaryBytes 为 0 时退回最后两句', async () => {
  const surface = [checkpointEvent(SAMPLE_SUMMARY), userEvent('收工'), assistantEvent('好')]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, { language: 'zh', summaryBytes: 0 })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: { ...selfRecord.header, cwd: bareWorkspace } } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.doesNotMatch(text, /正在写导入器/)
  assert.match(text, /收工/)
})

test('有交接文档时既不用摘要也不带结尾', async () => {
  const surface = [checkpointEvent(SAMPLE_SUMMARY), userEvent('不该出现'), assistantEvent('也不该出现')]
  const { ctx, handlers } = makeContext([selfRecord, previousRecord], {}, surface)
  apply(ctx, { language: 'zh' })
  const decision = await preStep(handlers.get('agent/pre-step'), {
    agent: { id: 'session-self', session: { header: selfRecord.header } },
    decision: { kind: 'enter', messages: [] },
  })
  const text = injected(decision).content[0].text
  assert.match(text, /HANDOFF\.md/)
  assert.doesNotMatch(text, /正在写导入器/)
  assert.doesNotMatch(text, /不该出现/)
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
