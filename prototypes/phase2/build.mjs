/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client.cjs'],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  write: false,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
})
const code = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({\n  id: "dsh-live-editor-phase2",\n  factory: (require) => {\n    var module = { exports: {} };\n    var exports = module.exports;\n${code}\n    return module.exports;\n  }\n});\n`
await writeFile('dsh-bundle/lib/client.js', wrapped)
console.log('built dsh-bundle/lib/client.js', wrapped.length, 'bytes')
