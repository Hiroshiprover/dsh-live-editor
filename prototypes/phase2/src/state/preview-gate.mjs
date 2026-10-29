/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Pure decision for a draft-preview write.
 *
 * Regression guard: a document can become `ready` before the preview handshake
 * completes (`previewReady === false`). The old inline effect returned early and
 * never re-ran once readiness flipped, so the pane kept the previous staging
 * frame. Keeping the decision pure makes that sequence testable without a DOM.
 */
export function decidePreviewWrite ({ previewReady, schedulerEnabled, loadPhase, text, currentSession, currentText, capability = null }) {
  if (capability === false) return 'disabled'
  if (!previewReady) return 'wait'
  if (loadPhase !== 'ready' || typeof text !== 'string') return 'no-doc'
  if (!schedulerEnabled && typeof currentSession === 'string' && currentText === text) return 'current'
  return 'write'
}
