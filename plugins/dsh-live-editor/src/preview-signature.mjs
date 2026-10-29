/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Content signature of the preview docs instance.
 *
 * `generatedAt` changes on every docs reload, including reloads of the real
 * docs instance that leave the staged content untouched. The structural
 * preview sync must key on the staged content itself: title/slug/frontmatter
 * and the staged sidebar tree. The timestamp is deliberately excluded.
 */
import { createHash } from 'node:crypto'

export function previewContentSignature ({ docs = [], sidebars = null } = {}) {
  const compactDocs = (Array.isArray(docs) ? docs : []).map((doc) => ({
    id: doc?.id ?? null,
    title: doc?.title ?? null,
    permalink: doc?.permalink ?? null,
    frontMatter: doc?.frontMatter ?? null,
  }))
  const { generatedAt: _ignored, ...stableSidebars } = sidebars ?? {}
  return createHash('sha256')
    .update(JSON.stringify({ docs: compactDocs, sidebars: stableSidebars }))
    .digest('hex')
    .slice(0, 16)
}
