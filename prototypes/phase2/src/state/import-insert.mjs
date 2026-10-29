/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * True when the document ends inside an unclosed fenced code block. Appending
 * a draft that starts with (or contains) a closing fence would otherwise close
 * the user's fence and turn later draft text into executable MDX. The tree must
 * cover `length`; a missing/partial tree is treated as unsafe (fail closed).
 *
 * Lezer marks both the opening and closing fence with `CodeMark`. An open fence
 * has exactly one such direct child; a closed fence has two. Checking the node
 * itself is not enough: an open fence still contains the caret at EOF.
 */
export function endsInOpenFence (tree, length) {
  if (!tree || typeof length !== 'number' || length < 0) return true
  if (tree.length < length) return true
  if (length === 0) return false
  let fenced = null
  for (let node = tree.resolveInner(length - 1, -1); node; node = node.parent) {
    if (node.name === 'FencedCode') { fenced = node; break }
  }
  if (fenced === null) return false
  let marks = 0
  for (let child = fenced.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeMark') marks += 1
  }
  return marks < 2
}

/**
 * Phase 7-B insertion: append an imported draft as a separate block at the end
 * of the current document. A cursor-relative insert can merge the draft into a
 * list item or heading (observed with 01-intro), so B deliberately appends.
 */
export function buildImportInsertion (current, draft) {
  if (typeof current !== 'string' || typeof draft !== 'string') return null
  const body = draft.replace(/\s+$/u, '')
  if (body.length === 0) return null
  const prefix = current.length === 0
    ? ''
    : current.endsWith('\n\n')
      ? ''
      : current.endsWith('\n')
        ? '\n'
        : '\n\n'
  const suffix = body.endsWith('\n') ? '' : '\n'
  const insertion = `${prefix}${body}${suffix}`
  return { at: current.length, insertion, anchor: current.length + insertion.length }
}
