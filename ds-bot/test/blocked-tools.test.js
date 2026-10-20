import assert from 'node:assert/strict'
import { test } from 'node:test'
import { blockedToolMatches } from '../src/host/blocked-tools.js'

test('a declared name matches as written and with the connector prefix', () => {
  const list = ['delete_repository', 'manage_webhook']
  assert.equal(blockedToolMatches(list, 'github', 'delete_repository'), true)
  assert.equal(blockedToolMatches(list, 'github', 'github_delete_repository'), true)
  assert.equal(blockedToolMatches(list, 'github', 'manage_webhook'), true)
  assert.equal(blockedToolMatches(list, 'github', 'github_manage_webhook'), true)
  // A different connector's prefix is a different call.
  assert.equal(blockedToolMatches(list, 'github', 'gitlab_delete_repository'), false)
  assert.equal(blockedToolMatches(list, 'github', 'delete_repository_extra'), false)
})

test('a RegExp entry matches a family of call names', () => {
  const list = [/^create_.*_secret$/, /_webhook$/]
  assert.equal(blockedToolMatches(list, 'github', 'create_repo_secret'), true)
  assert.equal(blockedToolMatches(list, 'github', 'github_create_repo_secret'), true)
  assert.equal(blockedToolMatches(list, 'github', 'manage_webhook'), true)
  assert.equal(blockedToolMatches(list, 'github', 'delete_repository'), false)
})

test('an absent, empty or malformed list never blocks anything', () => {
  assert.equal(blockedToolMatches(undefined, 'github', 'delete_repository'), false)
  assert.equal(blockedToolMatches([], 'github', 'delete_repository'), false)
  assert.equal(blockedToolMatches([null, 42, ''], 'github', 'delete_repository'), false)
  assert.equal(blockedToolMatches(['delete_repository'], 'github', ''), false)
  assert.equal(blockedToolMatches(['delete_repository'], 'github', undefined), false)
})
