/**
 * 测试用的最小桩包：让 index.js 的 import 在没有 DSH 的机器上也能解析。
 *
 * 这些桩写在仓库的 `node_modules/` 下，会被 Node 的祖先查找优先命中——
 * 所以它们**必须**在测试结束时删掉：本仓库被 `dsh plugin add` 以 `link:`
 * 方式装进 profile 时，插件加载会从这个目录开始解析，残留的桩会顶掉 DSH 自带的真包。
 * 设置 DSH_CONTINUITY_KEEP_STUBS=1 可以保留它们，便于反复调试。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const STUBS = [
  {
    name: '@deepseek-ai/dsh-llm',
    source: `export function createUserMessage(input) {
  return { role: 'user', id: \`stub-\${Math.random().toString(16).slice(2)}\`, ...input }
}
`,
  },
  {
    name: '@deepseek-ai/schemastery',
    source: `const chain = () => {
  const api = {}
  for (const method of ['default', 'required', 'min', 'max', 'step', 'description', 'role']) api[method] = () => api
  return api
}
export default {
  object: (shape) => shape,
  array: () => chain(),
  string: () => chain(),
  number: () => chain(),
  boolean: () => chain(),
}
`,
  },
]

/** 仓库根目录（test/ 的上一级）。 */
export const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

const nodeModules = join(packageRoot, 'node_modules')

/** 幂等地写入两个桩包；已存在就不动。 */
export function ensureStubs() {
  for (const stub of STUBS) {
    const directory = join(nodeModules, ...stub.name.split('/'))
    if (existsSync(join(directory, 'index.js'))) continue
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'index.js'), stub.source)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: stub.name, version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2)}\n`,
    )
  }
}

/** 删掉桩目录，让插件在真实 DSH 里解析到它自带的包。 */
export function cleanupStubs() {
  if (process.env.DSH_CONTINUITY_KEEP_STUBS === '1') {
    console.log('（按 DSH_CONTINUITY_KEEP_STUBS=1 保留了桩包）')
    return
  }
  rmSync(nodeModules, { recursive: true, force: true })
}
