/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * E3: model-generated MDX is data, not code. The draft may contain Markdown,
 * math and MDX comments; executable ESM/JSX/expressions are rejected. A user
 * who edits the draft afterwards takes responsibility for the full document.
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMdx from 'remark-mdx'
import remarkMathExtended from 'remark-math-extended'

// The site uses the same native parser, so E3 validates the grammar that
// Docusaurus will actually render, including \(...\) / \[...\] math.
const parser = unified().use(remarkParse).use(remarkMdx).use(remarkMathExtended, {
  backslashDelimiters: true,
  singleDollarTextMath: true,
})

const ALLOWED = new Set([
  'root', 'paragraph', 'text', 'emphasis', 'strong', 'delete',
  'inlineCode', 'code', 'heading', 'blockquote', 'list', 'listItem',
  'thematicBreak', 'break', 'link', 'linkReference', 'definition',
  'inlineMath', 'math', 'mdxFlowExpression', 'mdxTextExpression',
])

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

// Docusaurus resolves local Markdown links. A link whose target exists on disk
// and looks like an asset is rewritten to a file-loader require() by
// @docusaurus/mdx-loader (verified against the installed 3.10.1 transformer).
// The @site/ alias is joined to siteDir, and parent-relative paths are joined
// to the document directory; both can escape the docs root. E3 has no target
// document path, so it cannot prove containment and must reject those shapes.
function decodedLocalPath (url) {
  let local = url
  const hashIndex = local.indexOf('#')
  if (hashIndex >= 0) local = local.slice(0, hashIndex)
  const searchIndex = local.indexOf('?')
  if (searchIndex >= 0) local = local.slice(0, searchIndex)
  try {
    return decodeURIComponent(local)
  } catch {
    return null
  }
}

function linkProblem (url) {
  if (typeof url !== 'string' || url.length === 0) return '链接为空'
  // A scheme must be explicitly safe; bare relative paths are handled below.
  if (SCHEME.test(url)) {
    return /^(?:https?|mailto):/i.test(url) ? null : `链接协议不允许：${url}`
  }
  if (url.startsWith('//')) return `不允许协议相对链接：${url}`
  const local = decodedLocalPath(url)
  if (local === null) return `链接路径无法解码：${url}`
  if (local.includes('\0') || local.includes('\\')) return `链接路径包含不允许的字符：${url}`
  if (local.startsWith('@')) return `不允许 Docusaurus 文件别名链接（请改用 / 开头的站点路径）：${url}`
  if (local.split('/').some((segment) => segment === '..')) return `不允许父级相对链接（..）：${url}`
  return null
}

const DOCUSAURUS_MDX_FENCE = /^mdx-code-block$/i
// Docusaurus's preprocessor unwraps these text patterns before MDX parsing,
// including when they are nested inside a normal outer code fence. AST-only
// language checks cannot see that transformation, so reject the raw pattern.
const DOCUSAURUS_UNWRAP = /(?:^|\r?\n)\x20*(?:```\x20*mdx-code-block|````\x20*mdx-code-block)\r?\n/
// A pure block comment only: the first `*/` must be the final terminator.
const COMMENT = /^\s*\/\*(?:(?!\*\/)[\s\S])*\*\/\s*$/

function issue (node, message) {
  const line = node?.position?.start?.line
  return { node: node?.type ?? 'unknown', line: line ?? null, message }
}

function visit (node, errors) {
  if (node === null || typeof node !== 'object') return
  const type = node.type
  if (type === 'mdxFlowExpression' || type === 'mdxTextExpression') {
    if (typeof node.value !== 'string' || !COMMENT.test(node.value)) {
      errors.push(issue(node, '只允许 MDX 注释表达式 {/* ... */}'))
    }
  } else if (type === 'link' || type === 'definition') {
    const problem = linkProblem(node.url)
    if (problem !== null) {
      errors.push(issue(node, `${problem}`))
    }
  } else if (type === 'code') {
    // Docusaurus unwraps `mdx-code-block` fences before MDX compilation, so
    // their contents become executable expressions even though our AST sees a
    // harmless code node. Reject Docusaurus's reserved fence language.
    if (DOCUSAURUS_MDX_FENCE.test(node.lang ?? '')) {
      errors.push(issue(node, '不允许 Docusaurus mdx-code-block 围栏'))
    }
  } else if (!ALLOWED.has(type)) {
    errors.push(issue(node, `不允许的 MDX 节点：${type}`))
  }
  for (const child of Array.isArray(node.children) ? node.children : []) {
    visit(child, errors)
  }
}

/** @returns {{ok: boolean, errors: Array<{node: string, line: number|null, message: string}>}} */
export function validateGeneratedMdx (mdx) {
  if (typeof mdx !== 'string') return { ok: false, errors: [{ node: 'root', line: null, message: '草稿不是字符串' }] }
  const unwrap = DOCUSAURUS_UNWRAP.exec(mdx)
  if (unwrap !== null) {
    const line = mdx.slice(0, unwrap.index).split('\n').length
    return {
      ok: false,
      errors: [{ node: 'docusaurus-mdx-code-block', line, message: '不允许会被 Docusaurus 展开的 mdx-code-block 围栏' }],
    }
  }
  let tree
  try {
    tree = parser.parse(mdx)
  } catch (error) {
    return { ok: false, errors: [{ node: 'parse', line: null, message: `MDX 解析失败：${String(error?.message ?? error)}` }] }
  }
  const errors = []
  visit(tree, errors)
  return { ok: errors.length === 0, errors: errors.slice(0, 20) }
}
