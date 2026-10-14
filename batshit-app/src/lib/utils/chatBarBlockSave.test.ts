import { afterEach, describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { planAgentRecordUpdate } from '$lib/server/agentRecordUpdate'
import { chatBarBlockSave } from './chatBarBlockSave'

/**
 * BL-848: `chatBarBlockSave` is the one rule the chat bar's Codex and Claude controls share: the
 * keys where the block the control shows (`viewed`) and the block it builds (`next`) differ, and
 * the whole `next` when the store copy has no block (a create). The round trip runs a chat-bar
 * body through `planAgentRecordUpdate` and the record's by-path write (real Redis under
 * `npm run test:redis`, the fake's twin under `npm test`) beside a change another window made.
 */

useRedisTestServer()

const VIEWED = { permissionMode: 'chat', model: 'gpt-6-astra', sandbox: 'read-only', addDirs: [] as string[] }

describe('chatBarBlockSave (BL-848)', () => {
  it('names only the keys that differ from what the control shows', () => {
    const next = { ...VIEWED, permissionMode: 'agent', sandbox: 'workspace-write' }
    expect(chatBarBlockSave('codex_settings', VIEWED, VIEWED, next)).toEqual({
      codex_settings: { permissionMode: 'agent', sandbox: 'workspace-write' }
    })
  })

  it('names a key the change removes as null', () => {
    const viewed = { ...VIEWED, maxThinkingTokens: 2048 }
    const next = { ...VIEWED, maxThinkingTokens: undefined }
    expect(chatBarBlockSave('claude_settings', viewed, viewed, next)).toEqual({
      claude_settings: { maxThinkingTokens: null }
    })
  })

  it('answers no block when nothing differs', () => {
    expect(chatBarBlockSave('codex_settings', VIEWED, VIEWED, { ...VIEWED })).toEqual({})
  })

  it('compares against what the control shows, not the raw copy: a default the copy never held is not sent', () => {
    const stored = { model: 'gpt-6-astra' }
    expect(chatBarBlockSave('codex_settings', stored, VIEWED, { ...VIEWED, model: 'gpt-6-sol' })).toEqual({
      codex_settings: { model: 'gpt-6-sol' }
    })
  })

  it('a group of keys the control sets is always sent, even where it equals what the control shows', () => {
    const next = { ...VIEWED, permissionMode: 'chat', sandbox: 'read-only', model: 'gpt-6-sol' }
    expect(
      chatBarBlockSave('codex_settings', VIEWED, VIEWED, next, { group: ['permissionMode', 'sandbox'] })
    ).toEqual({
      // The group (equal to the copy) and the one other key that differs; addDirs is unchanged and stays out.
      codex_settings: { permissionMode: 'chat', sandbox: 'read-only', model: 'gpt-6-sol' }
    })
  })

  it('a group is sent even when nothing else differs', () => {
    expect(chatBarBlockSave('codex_settings', VIEWED, VIEWED, { ...VIEWED }, { group: ['permissionMode'] })).toEqual({
      codex_settings: { permissionMode: 'chat' }
    })
  })

  it('a group key the change leaves out is sent as null (a removal)', () => {
    const viewed = { ...VIEWED, maxThinkingTokens: 2048 }
    const next = { ...VIEWED, maxThinkingTokens: undefined }
    expect(chatBarBlockSave('claude_settings', viewed, viewed, next, { group: ['maxThinkingTokens'] })).toEqual({
      claude_settings: { maxThinkingTokens: null }
    })
  })

  it('a group does not widen a create: the whole next block goes out once', () => {
    expect(chatBarBlockSave('codex_settings', null, VIEWED, { ...VIEWED }, { group: ['permissionMode'] })).toEqual({
      codex_settings: { permissionMode: 'chat', model: 'gpt-6-astra', sandbox: 'read-only', addDirs: [] }
    })
  })

  it('a store copy with no block is a create: the whole next block goes out', () => {
    const next = { ...VIEWED, model: 'gpt-6-sol', historyPersistence: undefined }
    for (const stored of [null, undefined]) {
      expect(chatBarBlockSave('codex_settings', stored, VIEWED, next)).toEqual({
        codex_settings: { permissionMode: 'chat', model: 'gpt-6-sol', sandbox: 'read-only', addDirs: [] }
      })
    }
  })
})

const USER = 'cbbs_unit_user'
const AGENT = 'cbbs_unit_agent'
const KEY = `agent:${AGENT}`

afterEach(async () => {
  await redis.del(KEY)
})

describe('a chat-bar body and another window\'s change to a different key both survive (BL-848 round trip)', () => {
  it('a mode pick from an older copy leaves the model another window chose', async () => {
    const stale = {
      permissionMode: 'chat',
      model: 'gpt-6-astra',
      sandbox: 'read-only',
      approval: 'never',
      reasoningEffort: 'default',
      addDirs: [] as string[]
    }
    // The record: another window chose a model, a reasoning effort and a folder since the copy.
    await redis.json.set(KEY, '$', {
      id: AGENT,
      user_id: USER,
      displayName: 'Round trip probe',
      agentType: 'cli',
      created_at: '2026-09-28T09:00:00.000Z',
      updated_at: '2026-09-28T09:00:00.000Z',
      codex_settings: { ...stale, model: 'gpt-5.5', reasoningEffort: 'high', addDirs: ['/elsewhere'] }
    } as never)

    // The chat bar's Codex mode pick (Agent, full access), built from the older copy.
    const next = { ...stale, permissionMode: 'agent_full', sandbox: 'danger-full-access' }
    const body = chatBarBlockSave('codex_settings', stale, stale, next)
    expect(body).toEqual({ codex_settings: { permissionMode: 'agent_full', sandbox: 'danger-full-access' } })

    // The plan writes those two keys and no other.
    const plan = planAgentRecordUpdate({ updates: body, now: '2026-09-28T10:00:00.000Z' })
    const written = plan.ops
      .filter((op) => op.field === 'codex_settings' && op.op === 'set')
      .map((op) => ('key' in op ? op.key : undefined))
    expect(written).toEqual(['permissionMode', 'sandbox'])

    await redis.updateAgent(AGENT, body as never)

    const record = (await redis.json.get(KEY)) as any
    expect(record.codex_settings).toEqual({
      permissionMode: 'agent_full',
      model: 'gpt-5.5',
      sandbox: 'danger-full-access',
      approval: 'never',
      reasoningEffort: 'high',
      addDirs: ['/elsewhere']
    })
  })
})
