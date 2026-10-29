/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * D4: legacy backup directories replace `/` with `__`, so `docs/a__b/c.mdx`
 * and `docs/a/b__c.mdx` address the same directory. Paths that contain `__`
 * therefore use a stable hash directory; paths that cannot be ambiguous keep
 * the legacy layout so existing backup locations remain stable.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'

export function legacyBackupDirName (rel) {
  return rel.replaceAll('/', '__')
}

export function backupDirName (rel) {
  if (!rel.includes('__')) return legacyBackupDirName(rel)
  return `v2-${createHash('sha256').update(rel, 'utf8').digest('hex')}`
}

/** New directory first, then the legacy one when it differs (old backups readable). */
export function backupDirsFor (rel, root) {
  const names = [backupDirName(rel)]
  const legacy = legacyBackupDirName(rel)
  if (!names.includes(legacy)) names.push(legacy)
  return names.map((name) => path.join(root, name))
}
