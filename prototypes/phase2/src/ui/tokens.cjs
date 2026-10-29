/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Central UI tokens. Every color/font/size is overrideable through a
// --live-editor-* variable; defaults map to DSH theme tokens. This keeps the
// prototype themeable for future settings and the open-source release.
const T = {
  bg: 'var(--live-editor-bg, var(--dsw-alias-bg-layer-1, #fff))',
  bgMuted: 'var(--live-editor-bg-muted, var(--dsw-alias-bg-layer-2, #f6f7f9))',
  bgHover: 'var(--live-editor-bg-hover, var(--dsw-alias-interactive-bg-hover, #f1f3f5))',
  text: 'var(--live-editor-text, var(--dsw-alias-label-primary, #1f2328))',
  textSecondary: 'var(--live-editor-text-secondary, var(--dsw-alias-label-secondary, #57606a))',
  textTertiary: 'var(--live-editor-text-tertiary, var(--dsw-alias-label-tertiary, #8b949e))',
  border: 'var(--live-editor-border, var(--dsw-alias-border-l2, #e5e7eb))',
  borderStrong: 'var(--live-editor-border-strong, var(--dsw-alias-border-l3, #d0d7de))',
  success: 'var(--live-editor-success, #2e7d4f)',
  error: 'var(--live-editor-error, #a8322a)',
  warning: 'var(--live-editor-warning, #8a5a12)',
  accent: 'var(--live-editor-accent, var(--dsw-alias-state-business-primary, #3a6b8a))',
  heading: 'var(--live-editor-heading, #2f5d7a)',
  math: 'var(--live-editor-math, #2f5d7a)',
  special: 'var(--live-editor-special, #9a5a3a)',
  fn: 'var(--live-editor-function, #6b5b95)',
  mathBg: 'var(--live-editor-math-bg, color-mix(in srgb, var(--live-editor-accent, #3a6b8a) 6%, transparent))',
  selection: 'var(--live-editor-selection, color-mix(in srgb, var(--live-editor-accent, #3a6b8a) 14%, transparent))',
  font: 'var(--live-editor-font, var(--dsh-font-family-text, system-ui, -apple-system, sans-serif))',
  mono: 'var(--live-editor-mono, var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace))',
  codeSize: 'var(--live-editor-code-size, 13px)',
  codeLineHeight: 'var(--live-editor-code-line-height, 1.6)',
  uiSize: 'var(--live-editor-ui-size, 12px)',
  uiSmallSize: 'var(--live-editor-ui-small-size, 11px)',
  radius: 'var(--live-editor-radius, 5px)',
}

module.exports = { T }
