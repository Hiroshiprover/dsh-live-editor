/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Document-wide read-only viewer ownership.
 *
 * The viewer itself (its source text and load state) stays per Live Editor
 * body; this token only shares the isolation fact across bodies in the same
 * document, so a second tab cannot save, navigate or open QuickOpen behind an
 * open viewer. The token is synchronous: acquire before rendering the viewer,
 * release on close/unmount; every guard re-checks it after awaits.
 */
let owner = null

export function acquireViewer (ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) return null
  if (owner !== null) return null
  owner = ownerId
  return owner
}

export function releaseViewer (ownerId) {
  if (owner === ownerId) owner = null
}

export function isViewerActive () {
  return owner !== null
}

export function currentViewerOwner () {
  return owner
}
