/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Decide whether the preview has picked up a saved structural change.
 *
 * The preview page republishes `previewSignature`, a content hash of the
 * staged docs (title/slug/frontmatter/sidebar). A wall-clock `generatedAt`
 * changes even when the real docs reload leaves the staged content old, so it
 * must not be used here. A changed signature means a fresh preview page is
 * carrying the new structure; the same signature means the preview restarted
 * too early, so retry a bounded number of times instead of waiting blindly.
 */
export function decideStructuralSync ({ pendingSignature, observedSignature, attempts, maxAttempts = 3 }) {
  if (typeof pendingSignature !== 'string' || pendingSignature.length === 0) return 'none'
  if (typeof observedSignature === 'string' && observedSignature.length > 0
    && observedSignature !== pendingSignature) return 'synced'
  if (!Number.isInteger(attempts) || attempts < 0 || attempts >= maxAttempts) return 'gave-up'
  return 'retry'
}
