/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * 9.0D D4: the legacy `slash -> __` backup directory is ambiguous. Paths whose
 * encoded name could collide must use a distinct v2 directory, while the legacy
 * directory remains readable for existing backups.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const MODULE = path.resolve(import.meta.dirname, '../../prototypes/phase2/dsh-bundle/lib/backup-path.mjs')
const { backupDirName, legacyBackupDirName, backupDirsFor } = await import(pathToFileURL(MODULE).href)

test('D4: colliding legacy paths receive distinct v2 backup directories', () => {
  const left = 'docs/a__b/c.mdx'
  const right = 'docs/a/b__c.mdx'
  assert.equal(legacyBackupDirName(left), legacyBackupDirName(right), 'fixture must actually collide')
  assert.notEqual(backupDirName(left), backupDirName(right))
  assert.match(backupDirName(left), /^v2-[0-9a-f]{64}$/)
  assert.match(backupDirName(right), /^v2-[0-9a-f]{64}$/)
})

test('D4: ordinary paths keep their legacy directory and old backups stay discoverable', () => {
  const rel = 'docs/01-intro.mdx'
  assert.equal(backupDirName(rel), legacyBackupDirName(rel))
  const root = '/tmp/backups'
  assert.deepEqual(backupDirsFor(rel, root), [path.join(root, legacyBackupDirName(rel))])

  const collision = 'docs/a__b/c.mdx'
  const dirs = backupDirsFor(collision, root)
  assert.equal(dirs.length, 2)
  assert.ok(dirs.includes(path.join(root, legacyBackupDirName(collision))))
  assert.ok(dirs.includes(path.join(root, backupDirName(collision))))
})
