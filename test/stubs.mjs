/** 测试用的最小桩包准备：让 index.js 的 import 在没有 DSH 的机器上也能解析。 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

/** 幂等地写入两个桩包；已存在就不动。 */
export function ensureStubs() {
  for (const stub of STUBS) {
    const directory = join(packageRoot, 'node_modules', ...stub.name.split('/'))
    if (existsSync(join(directory, 'index.js'))) continue
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'index.js'), stub.source)
    writeFileSync(
      join(directory, 'package.json'),
      `${JSON.stringify({ name: stub.name, version: '0.0.0-stub', type: 'module', main: 'index.js' }, null, 2)}\n`,
    )
  }
}
