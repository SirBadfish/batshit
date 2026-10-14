import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  json: new Map<string, any>(),
  sets: new Map<string, Set<string>>(),
  lists: new Map<string, string[]>(),
  // BL-552: a one-shot hook keyed by record key, fired just before a `json.set` on that key
  // applies its mutation. Tests use this to land a concurrent rotate/revoke/update exactly in
  // the window a real race would land in, deterministically, instead of guessing at
  // microtask ordering.
  setHooks: new Map<string, () => Promise<void> | void>(),
  // BL-552 review: a one-shot forced failure on the NEXT `json.set` call, regardless of key or
  // path -- simulates a genuine Redis failure (a dropped connection, a real server error) that
  // has nothing to do with the record being gone, so the record still exists when it throws.
  forceNextSetFailure: null as Error | null
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    execute: async (operation: any) =>
      operation({
        json: {
          get: async (key: string) => store.json.get(key) ?? null,
          // Real RedisJSON semantics, not a blind overwrite: `$` replaces the whole document;
          // any other path merges (or adds) exactly one field into the CURRENT document, read
          // fresh at call time, and refuses (throws) when the document does not exist yet --
          // a non-root `JSON.SET` cannot create or resurrect a key. The previous version of
          // this fake ignored `path` entirely and always replaced the whole value, which would
          // have hidden the BL-552 regression (a path-scoped write looking like a full
          // overwrite in the test double, even after the real bug was fixed).
          set: async (key: string, path: string, value: any) => {
            if (store.forceNextSetFailure) {
              const error = store.forceNextSetFailure
              store.forceNextSetFailure = null
              throw error
            }
            const hook = store.setHooks.get(key)
            if (hook) {
              store.setHooks.delete(key)
              await hook()
            }
            if (path === '$') {
              store.json.set(key, value)
              return 'OK'
            }
            const existing = store.json.get(key)
            if (!existing || typeof existing !== 'object') {
              throw new Error(`ERR could not perform this operation on a key that doesn't exist: ${key}`)
            }
            const match = /^\$\.([a-zA-Z0-9_]+)$/.exec(path)
            if (!match) {
              throw new Error(`unsupported JSON path in test fake: ${path}`)
            }
            store.json.set(key, { ...existing, [match[1]]: value })
            return 'OK'
          }
        },
        sAdd: async (key: string, value: string) => {
          const set = store.sets.get(key) ?? new Set<string>()
          set.add(value)
          store.sets.set(key, set)
          return 1
        },
        sMembers: async (key: string) => Array.from(store.sets.get(key) ?? []),
        sRem: async (key: string, value: string) => {
          const set = store.sets.get(key)
          if (!set) return 0
          const deleted = set.delete(value) ? 1 : 0
          if (set.size === 0) {
            store.sets.delete(key)
          } else {
            store.sets.set(key, set)
          }
          return deleted
        },
        del: async (key: string) => {
          const deletedJson = store.json.delete(key) ? 1 : 0
          const deletedSet = store.sets.delete(key) ? 1 : 0
          const deletedList = store.lists.delete(key) ? 1 : 0
          return deletedJson + deletedSet + deletedList
        },
        // BL-552 review: real `EXISTS` returns a count, not a boolean.
        exists: async (key: string) => (store.json.has(key) ? 1 : 0),
        lPush: async (key: string, value: string) => {
          const list = store.lists.get(key) ?? []
          list.unshift(value)
          store.lists.set(key, list)
          return list.length
        },
        lTrim: async (key: string, start: number, stop: number) => {
          const list = store.lists.get(key) ?? []
          store.lists.set(key, list.slice(start, stop + 1))
          return 'OK'
        },
        // BL-787: the JS twin of the three atomic Lua scripts in portableSkillTokens.ts. Each
        // re-reads the record from the CURRENT store state (never a value the test captured
        // earlier) and refuses on a missing/revoked record, exactly like the real script. The
        // one-shot race hook fires first, keyed by the record key (KEYS[0]), modeling another
        // admin action's own atomic script completing in the gap just before this one runs --
        // real Lua scripts cannot interleave mid-script, so "before" is the only order that
        // matters.
        eval: async (script: string, options: { keys?: string[]; arguments?: string[] } = {}) => {
          const keys = options.keys ?? []
          const args = options.arguments ?? []
          const recordKey = keys[0]

          const hook = recordKey ? store.setHooks.get(recordKey) : undefined
          if (hook) {
            store.setHooks.delete(recordKey)
            await hook()
          }
          if (store.forceNextSetFailure) {
            const error = store.forceNextSetFailure
            store.forceNextSetFailure = null
            throw error
          }

          // Review round 2: as strict as the Lua. `JSON.TYPE $.revokedAt` on a MISSING path
          // returns nil, and `nil ~= 'null'` is true in Lua, so a record with no revokedAt
          // field at all fails closed (REVOKED) exactly like an actually-revoked one -- only a
          // JSON `null` value reads as "not revoked". A tokenHash that is not a string answers
          // MALFORMED before any write, never deleting a `${prefix}undefined` nonsense key.
          const isRevoked = (record: any) => record.revokedAt !== null

          if (script.includes('BATSHIT_PORTABLE_SKILL_TOKEN_UPDATE_V1')) {
            const [updatedAt, hasLabelFlag, labelJson, hasFamiliesFlag, familiesJson] = args
            const existing = store.json.get(recordKey)
            if (!existing) return 'MISSING'
            if (isRevoked(existing)) return 'REVOKED'
            const next = { ...existing }
            if (hasFamiliesFlag === '1') {
              const families = JSON.parse(familiesJson)
              if (families.length === 0) return 'EMPTY_FAMILIES'
              next.families = families
            }
            if (hasLabelFlag === '1') {
              next.label = JSON.parse(labelJson)
            }
            next.updatedAt = updatedAt
            store.json.set(recordKey, next)
            return 'OK'
          }

          if (script.includes('BATSHIT_PORTABLE_SKILL_TOKEN_ROTATE_V1')) {
            const [newTokenHash, tokenPrefix, tokenSuffix, updatedAt, userId, tokenId, hashPrefix] = args
            const newHashIndexKey = keys[1]
            const existing = store.json.get(recordKey)
            if (!existing) return 'MISSING'
            if (isRevoked(existing)) return 'REVOKED'
            if (typeof existing.tokenHash !== 'string') return 'MALFORMED'
            const oldHash = existing.tokenHash
            store.json.set(recordKey, { ...existing, tokenHash: newTokenHash, tokenPrefix, tokenSuffix, updatedAt })
            store.json.delete(`${hashPrefix}${oldHash}`)
            store.json.set(newHashIndexKey, { userId, tokenId })
            return 'OK'
          }

          if (script.includes('BATSHIT_PORTABLE_SKILL_TOKEN_REVOKE_V1')) {
            const [revokedAt, tokenId, hashPrefix] = args
            const setKey = keys[1]
            const existing = store.json.get(recordKey)
            if (!existing) return 'MISSING'
            if (isRevoked(existing)) return 'ALREADY_REVOKED'
            if (typeof existing.tokenHash !== 'string') return 'MALFORMED'
            const hash = existing.tokenHash
            store.json.set(recordKey, { ...existing, revokedAt, updatedAt: revokedAt })
            store.json.delete(`${hashPrefix}${hash}`)
            const set = store.sets.get(setKey)
            if (set) {
              set.delete(tokenId)
              if (set.size === 0) store.sets.delete(setKey)
            }
            return 'OK'
          }

          throw new Error(`This Redis fake does not implement that Lua script: ${script.slice(0, 80)}`)
        }
      })
  }
}))

import {
  createPortableSkillToken,
  ensurePortableSkillEnvTemplates,
  getPortableSkillAllowedControlIds,
  getPortableSkillRequiredFamiliesForControl,
  isPortableSkillControlAllowed,
  listPortableSkillTokens,
  recordPortableSkillTokenControlExecution,
  revokePortableSkillToken,
  rotatePortableSkillToken,
  updatePortableSkillToken,
  validatePortableSkillToken
} from '../portableSkillTokens'

describe('portableSkillTokens', () => {
  beforeEach(() => {
    store.json.clear()
    store.sets.clear()
    store.lists.clear()
    store.setHooks.clear()
    store.forceNextSetFailure = null
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('mints show-once secrets while storing only token hashes in summaries', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Claude Code voice setup',
      families: ['voice-engines']
    })

    expect(minted.token).toMatch(/^bspt_/)
    expect(minted.record.label).toBe('Claude Code voice setup')
    expect(minted.record.families).toEqual(['voice-engines'])
    expect('tokenHash' in minted.record).toBe(false)

    const listed = await listPortableSkillTokens('user-1')
    expect(listed).toHaveLength(1)
    expect('tokenHash' in listed[0]).toBe(false)
  })

  it('validates a token and derives the scoped control allow-list', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Voice token',
      families: ['voice-engines']
    })

    const validation = await validatePortableSkillToken(minted.token)
    expect(validation.valid).toBe(true)
    if (!validation.valid) return
    expect(validation.userId).toBe('user-1')
    expect(validation.allowedControlIds).toContain('sys.voice.engine.complete_local_setup')
    expect(validation.allowedControlIds).toContain('sys.runtime_addon.status')
    expect(validation.allowedControlIds).not.toContain('sys.artifact.create')
  })

  it('rotates and revokes token secrets without changing the token record id', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Portable artifact token',
      families: ['artifacts']
    })

    const rotated = await rotatePortableSkillToken({
      userId: 'user-1',
      tokenId: minted.record.id
    })
    expect(rotated.record.id).toBe(minted.record.id)
    await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
      valid: false,
      reason: 'invalid'
    })
    await expect(validatePortableSkillToken(rotated.token)).resolves.toMatchObject({
      valid: true,
      userId: 'user-1'
    })

    await revokePortableSkillToken({
      userId: 'user-1',
      tokenId: minted.record.id
    })
    await expect(validatePortableSkillToken(rotated.token)).resolves.toMatchObject({
      valid: false,
      reason: 'invalid'
    })
    await expect(listPortableSkillTokens('user-1')).resolves.toHaveLength(0)
    expect(store.sets.get('portable_skill_tokens:user-1')).toBeUndefined()
  })

  it('updates family scopes and records last-used execution metadata', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Narrow token',
      families: ['skills']
    })

    const updated = await updatePortableSkillToken({
      userId: 'user-1',
      tokenId: minted.record.id,
      families: ['skills', 'cli-tools']
    })
    expect(updated.families).toEqual(['skills', 'cli-tools'])

    await recordPortableSkillTokenControlExecution({
      userId: 'user-1',
      tokenId: minted.record.id,
      tokenLabel: 'Narrow token',
      controlId: 'sys.cli_tool.test',
      success: true
    })

    const listed = await listPortableSkillTokens('user-1')
    expect(listed[0].lastUsedAt).toEqual(expect.any(String))
    expect(store.lists.get('portable_skill_token_executions:user-1')).toHaveLength(1)
  })

  it('BL-552: a rotate landing during the use-stamp must not be undone by the stamp', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Race token',
      families: ['skills']
    })
    const recordKey = `portable_skill_token:user-1:${minted.record.id}`

    // One-shot: fires just before the stamp's FIRST write to this record lands, landing a
    // rotate in exactly the window the old code's read-then-write-whole raced against.
    let rotated: Awaited<ReturnType<typeof rotatePortableSkillToken>> | undefined
    store.setHooks.set(recordKey, async () => {
      rotated = await rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
    })

    await recordPortableSkillTokenControlExecution({
      userId: 'user-1',
      tokenId: minted.record.id,
      tokenLabel: 'Race token',
      controlId: 'sys.skill.save',
      success: true
    })

    expect(rotated).toBeDefined()
    // The rotate's new secret must still validate: the stamp must not have written the old
    // tokenHash back over it.
    await expect(validatePortableSkillToken(rotated!.token)).resolves.toMatchObject({
      valid: true,
      userId: 'user-1'
    })
    // And the pre-rotate secret must stay dead. The old bug resurrected it: the stamp read the
    // record BEFORE the rotate, then wrote that whole stale object back (including the old
    // tokenHash) AFTER the rotate had already replaced it, undoing the rotate.
    await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
      valid: false,
      reason: 'invalid'
    })
  })

  it('BL-552: a revoke landing during the use-stamp must not be undone by the stamp', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Race token',
      families: ['skills']
    })
    const recordKey = `portable_skill_token:user-1:${minted.record.id}`

    store.setHooks.set(recordKey, async () => {
      await revokePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
    })

    await recordPortableSkillTokenControlExecution({
      userId: 'user-1',
      tokenId: minted.record.id,
      tokenLabel: 'Race token',
      controlId: 'sys.skill.save',
      success: true
    })

    // The hash index and set membership the revoke deletes/removes are separate keys the old
    // bug's stale write never touched, so validate/list read as revoked either way -- that is
    // NOT where this race shows up. It shows up in the record's OWN `revokedAt` field: the old
    // bug's stale write had no `revokedAt` yet, so it silently reset the stored record back to
    // "not revoked" even though the hash index was already gone. A later call that reads the
    // raw record directly (rotate, update) trusts that field, so it would wrongly succeed on an
    // id that was just revoked instead of 404ing.
    await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
      valid: false,
      reason: 'invalid'
    })
    await expect(listPortableSkillTokens('user-1')).resolves.toHaveLength(0)
    await expect(
      rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
    ).rejects.toThrow(/not found/i)
  })

  it('BL-552: a narrowed scope landing during the use-stamp must not be widened back', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Race token',
      families: ['skills', 'cli-tools']
    })
    const recordKey = `portable_skill_token:user-1:${minted.record.id}`

    store.setHooks.set(recordKey, async () => {
      await updatePortableSkillToken({
        userId: 'user-1',
        tokenId: minted.record.id,
        families: ['skills']
      })
    })

    await recordPortableSkillTokenControlExecution({
      userId: 'user-1',
      tokenId: minted.record.id,
      tokenLabel: 'Race token',
      controlId: 'sys.skill.save',
      success: true
    })

    // The old bug's stale write carried the wider pre-edit `families` list, silently widening
    // the scope edit back open.
    const listed = await listPortableSkillTokens('user-1')
    expect(listed[0].families).toEqual(['skills'])
  })

  it('BL-552: the use-stamp never recreates a record that is gone by the time it runs', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Deleted mid-flight',
      families: ['skills']
    })
    const recordKey = `portable_skill_token:user-1:${minted.record.id}`

    // Simulate the record being gone entirely (not just revoked) by the time the stamp's first
    // write reaches Redis: a non-root JSON.SET against a missing key must not resurrect it.
    store.setHooks.set(recordKey, () => {
      store.json.delete(recordKey)
    })

    await expect(
      recordPortableSkillTokenControlExecution({
        userId: 'user-1',
        tokenId: minted.record.id,
        tokenLabel: 'Deleted mid-flight',
        controlId: 'sys.skill.save',
        success: true
      })
    ).resolves.toBeUndefined()

    expect(store.json.has(recordKey)).toBe(false)
  })

  it('BL-552 review: a genuine Redis failure while the record still exists must propagate, not be swallowed', async () => {
    const minted = await createPortableSkillToken({
      userId: 'user-1',
      label: 'Still here',
      families: ['skills']
    })
    const recordKey = `portable_skill_token:user-1:${minted.record.id}`

    // Not the "record is gone" case: the record stays in the store the whole time. This forces
    // the FIRST json.set call to throw for an unrelated reason (a dropped connection, a real
    // server error), exactly the kind of failure the old read-then-write code would have
    // surfaced (its `client.json.get` would have thrown the same way).
    store.forceNextSetFailure = new Error('ECONNRESET (simulated)')

    await expect(
      recordPortableSkillTokenControlExecution({
        userId: 'user-1',
        tokenId: minted.record.id,
        tokenLabel: 'Still here',
        controlId: 'sys.skill.save',
        success: true
      })
    ).rejects.toThrow('ECONNRESET (simulated)')

    // The record was never actually gone -- a bare catch would have swallowed this and left
    // the execution log written as if nothing had failed.
    expect(store.json.has(recordKey)).toBe(true)
    expect(store.lists.get('portable_skill_token_executions:user-1')).toBeUndefined()
  })

  describe('BL-787: update/rotate/revoke are one atomic step each, never undo each other', () => {
    it('a rotate landing during an update must not be undone by the update', async () => {
      const minted = await createPortableSkillToken({
        userId: 'user-1',
        label: 'Race token',
        families: ['skills']
      })
      const recordKey = `portable_skill_token:user-1:${minted.record.id}`

      let rotated: Awaited<ReturnType<typeof rotatePortableSkillToken>> | undefined
      store.setHooks.set(recordKey, async () => {
        rotated = await rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      })

      const updated = await updatePortableSkillToken({
        userId: 'user-1',
        tokenId: minted.record.id,
        label: 'Renamed while rotating'
      })

      expect(rotated).toBeDefined()
      expect(updated.label).toBe('Renamed while rotating')
      // The update never touches tokenHash, so the rotate's new secret must still validate.
      await expect(validatePortableSkillToken(rotated!.token)).resolves.toMatchObject({
        valid: true,
        userId: 'user-1'
      })
      await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
        valid: false,
        reason: 'invalid'
      })
    })

    it('a revoke landing during a rotate must refuse the rotate, not resurrect the token', async () => {
      const minted = await createPortableSkillToken({
        userId: 'user-1',
        label: 'Race token',
        families: ['skills']
      })
      const recordKey = `portable_skill_token:user-1:${minted.record.id}`

      store.setHooks.set(recordKey, async () => {
        await revokePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      })

      await expect(
        rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      ).rejects.toThrow(/not found/i)

      // The old bug wrote `revokedAt: null` back and created a live hash index for the new
      // secret, so the "failed" rotate's token validated anyway. Here nothing should validate,
      // and the record must not be listed (still revoked, still gone from the index).
      await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
        valid: false,
        reason: 'invalid'
      })
      await expect(listPortableSkillTokens('user-1')).resolves.toHaveLength(0)
      const record = store.json.get(recordKey)
      expect(record.revokedAt).not.toBeNull()
    })

    it('a revoke landing during an update must refuse the update, not reset revokedAt', async () => {
      const minted = await createPortableSkillToken({
        userId: 'user-1',
        label: 'Race token',
        families: ['skills']
      })
      const recordKey = `portable_skill_token:user-1:${minted.record.id}`

      store.setHooks.set(recordKey, async () => {
        await revokePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      })

      await expect(
        updatePortableSkillToken({
          userId: 'user-1',
          tokenId: minted.record.id,
          label: 'Should never land'
        })
      ).rejects.toThrow(/not found/i)

      const record = store.json.get(recordKey)
      expect(record.revokedAt).not.toBeNull()
      expect(record.label).toBe('Race token')
    })

    it('two rotates close together each delete the hash index that is actually live, never a stale one', async () => {
      const minted = await createPortableSkillToken({
        userId: 'user-1',
        label: 'Race token',
        families: ['skills']
      })
      const recordKey = `portable_skill_token:user-1:${minted.record.id}`

      let rotatedFirst: Awaited<ReturnType<typeof rotatePortableSkillToken>> | undefined
      store.setHooks.set(recordKey, async () => {
        rotatedFirst = await rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      })

      const rotatedSecond = await rotatePortableSkillToken({
        userId: 'user-1',
        tokenId: minted.record.id
      })

      expect(rotatedFirst).toBeDefined()
      // Both tokens already read as valid/invalid the same way under the old bug (the record's
      // OWN tokenHash field ends up matching whichever rotate wrote last, so validate/invalid
      // reads correctly either way). The actual defect is a LEAKED hash index: the old code
      // computed which old index to delete from a stale pre-read, so the first rotate's own
      // index -- pointing at a secret that no longer matches the record -- was never cleaned
      // up. Assert directly that it is gone, not just that its secret fails to validate.
      const firstHash = createHash('sha256').update(rotatedFirst!.token, 'utf8').digest('hex')
      expect(store.json.has(`portable_skill_token_hash:${firstHash}`)).toBe(false)

      await expect(validatePortableSkillToken(rotatedSecond.token)).resolves.toMatchObject({
        valid: true,
        userId: 'user-1'
      })
      await expect(validatePortableSkillToken(rotatedFirst!.token)).resolves.toMatchObject({
        valid: false,
        reason: 'invalid'
      })
      await expect(validatePortableSkillToken(minted.token)).resolves.toMatchObject({
        valid: false,
        reason: 'invalid'
      })
    })

    // BL-787 review round 2: as strict as the real Lua's JSON.TYPE checks.
    it('a record with no revokedAt field at all fails closed, like an actually-revoked one', async () => {
      const minted = await createPortableSkillToken({
        userId: 'user-1',
        label: 'No revokedAt field',
        families: ['skills']
      })
      const recordKey = `portable_skill_token:user-1:${minted.record.id}`
      const record = store.json.get(recordKey)
      delete record.revokedAt
      store.json.set(recordKey, record)

      await expect(
        rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      ).rejects.toThrow(/not found/i)
      await expect(
        revokePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      ).rejects.toThrow(/not found/i)
      await expect(
        updatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id, label: 'x' })
      ).rejects.toThrow(/not found/i)
    })

    it('a record with a malformed tokenHash is refused before any write, never deleting a nonsense key', async () => {
      const minted = await createPortableSkillToken({
        userId: 'user-1',
        label: 'Malformed hash',
        families: ['skills']
      })
      const recordKey = `portable_skill_token:user-1:${minted.record.id}`
      const record = store.json.get(recordKey)
      delete record.tokenHash
      store.json.set(recordKey, record)
      const keysBefore = new Set(store.json.keys())

      await expect(
        rotatePortableSkillToken({ userId: 'user-1', tokenId: minted.record.id })
      ).rejects.toThrow(/unexpected/i)

      // No half-write: the record itself is untouched, and no `${prefix}undefined` key exists.
      expect(store.json.get(recordKey)).toEqual(record)
      expect(store.json.has('portable_skill_token_hash:undefined')).toBe(false)
      expect(new Set(store.json.keys())).toEqual(keysBefore)
    })
  })

  it('exposes deterministic family scope helpers', () => {
    expect(getPortableSkillAllowedControlIds(['artifacts'])).toContain('sys.model_catalog.search')
    expect(getPortableSkillAllowedControlIds(['goon-scenes'])).toEqual(['sys.goon_scene.creator_info'])
    expect(isPortableSkillControlAllowed('sys.cli_tool.test', ['cli-tools'])).toBe(true)
    expect(isPortableSkillControlAllowed('sys.cli_tool.test', ['skills'])).toBe(false)
    expect(isPortableSkillControlAllowed('sys.goon_scene.creator_info', ['goon-scenes'])).toBe(true)
    expect(getPortableSkillRequiredFamiliesForControl('sys.artifact.create')).toEqual(['artifacts'])
    expect(getPortableSkillRequiredFamiliesForControl('sys.goon_scene.creator_info')).toEqual([
      'goon-scenes'
    ])
    expect(getPortableSkillRequiredFamiliesForControl('sys.zip.fetch')).toEqual([])
  })

  it('reports host-side env template guidance without writing in containerized runtimes', async () => {
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')

    const templates = await ensurePortableSkillEnvTemplates('http://localhost:5621')

    expect(templates).toHaveLength(1)
    expect(templates[0]).toMatchObject({
      id: 'portable-skills',
      kind: 'shared',
      skillId: null,
      family: null,
      path: '~/.batshit/portable-skills/portable-skills.env',
      writable: false,
      exists: false,
      created: false
    })
    expect(templates[0].placeholder).toContain('BATSHIT_PORTABLE_TOKEN=paste-your-portable-skill-token-here')
    // BL-341: the address is the app's own origin as the request reached it, never 5620.
    expect(templates[0].placeholder).toContain('BATSHIT_BASE_URL=http://127.0.0.1:5621\n')
    expect(templates[0].placeholder).not.toContain('5620')
  })

  it('SA-113 P2 (DL-113-03): no Portable Skill family may reach sys.dm.*', async () => {
    // A Portable Skill Token is an OUTSIDE caller. Agent DMs are addressed messages
    // between this instance's own agents, and a portable token additionally forces
    // `allowRisky`, so letting one DM on an agent's behalf would be a real impersonation
    // door. The wake-up webhook (P3) is the only inbound way in, and it authenticates on
    // its own route. This exists so a future family addition cannot open it by accident.
    const { PORTABLE_SKILL_FAMILIES, getPortableSkillAllowedControlIds } = await import(
      '$lib/server/services/portableSkillTokens'
    )
    const everyControlId = getPortableSkillAllowedControlIds(
      PORTABLE_SKILL_FAMILIES.map((family) => family.id)
    )
    expect(everyControlId.some((controlId) => controlId.startsWith('sys.dm.'))).toBe(false)
    // SA-115 P2 (DL-115-10): the schedule family is scoped the same way, and for a sharper
    // reason — a Portable Skill token reaching `sys.schedule.create` could leave a clock
    // behind that keeps waking an agent after the token itself is long gone.
    expect(everyControlId.some((controlId) => controlId.startsWith('sys.schedule.'))).toBe(false)
    // And no family may use a wildcard that could later swallow one.
    expect(everyControlId.some((controlId) => controlId.includes('*'))).toBe(false)
  })
})
