/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
const { Decoration, ViewPlugin } = require('@codemirror/view')

const lineDeco = (className) => Decoration.line({ class: className })
const mathInlineDeco = Decoration.mark({ class: 'cm-le-math-inline' })
const mathSourceDeco = Decoration.mark({ class: 'cm-le-math-source' })
const mathDelimiterDeco = Decoration.mark({ class: 'cm-le-math-delimiter' })
const commentDeco = Decoration.mark({ class: 'cm-le-comment' })
const mdCodeDeco = Decoration.mark({ class: 'cm-le-md-code' })
const mdLinkDeco = Decoration.mark({ class: 'cm-le-md-link' })
const mdStrongDeco = Decoration.mark({ class: 'cm-le-md-strong' })
const mdEmDeco = Decoration.mark({ class: 'cm-le-md-emphasis' })

const STRUCTURAL = new Set(['frac', 'dfrac', 'tfrac', 'sqrt', 'int', 'sum', 'prod', 'boxed', 'leq', 'geq', 'equiv', 'approx', 'll', 'gg', 'neq', 'sim', 'simeq', 'propto'])
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'exp', 'lim', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd', 'Pr'])
const ENVIRONMENT = new Set(['begin', 'end'])
const DELIMITER = new Set(['left', 'right'])
const OPERATOR = new Set(['quad', 'qquad', 'dots', 'cdot', 'times', 'pm', 'mp'])
const SPECIAL = new Set(['mathcal', 'mathbf', 'hat', 'tilde', 'bar', 'vec', 'dot', 'ddot'])
const SYMBOL = new Set(['partial', 'delta', 'phi', 'mu', 'eta', 'varepsilon', 'mathrm', 'text'])

function commandClass (name) {
  if (FUNCTIONS.has(name)) return 'cm-le-latex-function'
  if (STRUCTURAL.has(name)) return 'cm-le-latex-structure'
  if (ENVIRONMENT.has(name)) return 'cm-le-latex-env'
  if (DELIMITER.has(name)) return 'cm-le-latex-delimiter'
  if (SPECIAL.has(name)) return 'cm-le-latex-special'
  if (OPERATOR.has(name)) return 'cm-le-latex-operator'
  if (SYMBOL.has(name)) return 'cm-le-latex-symbol'
  return 'cm-le-latex-symbol'
}

function addCommands (ranges, text, base) {
  const command = /\\[a-zA-Z]+/g
  let cmd
  while ((cmd = command.exec(text)) !== null) {
    const name = cmd[0].slice(1)
    ranges.push(Decoration.mark({ class: commandClass(name) }).range(base + cmd.index, base + cmd.index + cmd[0].length))
  }
}

function overlaps (rangesToCheck, from, to) {
  return rangesToCheck.some((range) => from < range.to && to > range.from)
}

function addMarkdownInline (ranges, text, base, excluded) {
  const code = /`([^`\n]+)`/g
  let match
  while ((match = code.exec(text)) !== null) {
    const from = base + match.index
    const to = from + match[0].length
    if (!overlaps(excluded, from, to)) {
      ranges.push(mdCodeDeco.range(from, to))
      excluded.push({ from, to })
    }
  }

  const link = /\[([^\]\n]+)\]\(([^)\n]+)\)/g
  while ((match = link.exec(text)) !== null) {
    const from = base + match.index
    const to = from + match[0].length
    if (!overlaps(excluded, from, to)) ranges.push(mdLinkDeco.range(from, to))
  }

  const strong = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g
  while ((match = strong.exec(text)) !== null) {
    const from = base + match.index
    const to = from + match[0].length
    if (!overlaps(excluded, from, to)) ranges.push(mdStrongDeco.range(from, to))
  }

  const emphasis = /(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g
  while ((match = emphasis.exec(text)) !== null) {
    const from = base + match.index
    const to = from + match[0].length
    if (!overlaps(excluded, from, to)) ranges.push(mdEmDeco.range(from, to))
  }
}

// Line-level blocks (frontmatter/fenced code/display math/admonitions) plus
// inline math, LaTeX commands and MDX comments. The math marks also neutralize
// Markdown emphasis/link styling inside math ranges.
function buildDecorations (view) {
  const doc = view.state.doc
  const ranges = []
  let frontmatter = false
  let fence = false
  let math = false
  let admonition = false

  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number)
    const text = line.text
    const trimmed = text.trim()
    const classes = []

    if (number === 1 && trimmed === '---') frontmatter = true
    if (frontmatter) {
      classes.push('cm-le-frontmatter')
      if (number > 1 && trimmed === '---') frontmatter = false
    } else if (/^(```|~~~)/.test(trimmed)) {
      classes.push('cm-le-codeblock')
      fence = !fence
    } else if (fence) {
      classes.push('cm-le-codeblock')
    } else {
      // Admonition and display math are independent: a $$ block inside a
      // :::note must keep both its admonition and math decoration.
      if (trimmed.startsWith(':::')) {
        classes.push('cm-le-admonition')
        admonition = !admonition
      } else if (admonition) {
        classes.push('cm-le-admonition')
      }

      if (trimmed === '$$') {
        classes.push('cm-le-mathblock')
        math = !math
      } else if (math) {
        classes.push('cm-le-mathblock')
      }
    }

    const className = classes.join(' ')
    if (className) ranges.push(lineDeco(className).range(line.from))
    const isMathLine = classes.includes('cm-le-mathblock')
    if (isMathLine) {
      if (text.length > 0) ranges.push(mathSourceDeco.range(line.from, line.to))
      if (trimmed === '$$') ranges.push(mathDelimiterDeco.range(line.from, line.to))
    }

    if (frontmatter || fence) continue

    const comments = /\{\/\*.*?\*\/\}/g
    let comment
    while ((comment = comments.exec(text)) !== null) {
      const from = line.from + comment.index
      ranges.push(commentDeco.range(from, from + comment[0].length))
    }

    if (isMathLine && trimmed !== '$$') {
      addCommands(ranges, text, line.from)
    }

    const inline = /\$(?!\$)([^$\n]+?)\$(?!\$)/g
    const excluded = []
    let match
    while ((match = inline.exec(text)) !== null) {
      const from = line.from + match.index
      const to = from + match[0].length
      excluded.push({ from, to })
      ranges.push(mathInlineDeco.range(from, to))
      ranges.push(mathDelimiterDeco.range(from, from + 1))
      ranges.push(mathDelimiterDeco.range(to - 1, to))
      addCommands(ranges, match[1], from + 1)
    }

    if (!isMathLine && !frontmatter && !fence) {
      addMarkdownInline(ranges, text, line.from, excluded)
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(ranges, true)
}

const mdxBlockDecorations = ViewPlugin.fromClass(class {
  constructor (view) {
    this.decorations = buildDecorations(view)
  }

  update (update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view)
    }
  }
}, {
  decorations: (value) => value.decorations,
})

module.exports = { mdxBlockDecorations }
