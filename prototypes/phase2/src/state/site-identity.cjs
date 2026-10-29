/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Pure keys for per-site editor state. The site id comes from the Host and is
 * stable for a given site root; tab/session ids stay orthogonal so two sites
 * with the same document path never share a draft or an import review.
 */
function importTaskKey ({ siteId, sessionId = null, tabId = null, path = null }) {
  if (typeof siteId !== 'string' || siteId.length === 0) throw new TypeError('siteId is required')
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('path is required')
  return `live-editor:import-task:v2:${siteId}:${sessionId ?? 'nosession'}:${tabId ?? 'notab'}:${path}`
}

module.exports = { importTaskKey }
