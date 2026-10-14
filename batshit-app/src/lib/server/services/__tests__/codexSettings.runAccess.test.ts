import { describe, expect, it } from 'vitest'

import { buildCodexRuntimeSettings, resolveCodexRunAccess } from '../codexSettings'

/**
 * BL-941: the agent's record is the upper bound of a Codex run's access. A mode that a send
 * carries (the chat bar's `metadata.codexPermissionMode`) can make a run tighter than the record,
 * never looser. Order: `chat` < `agent` < `agent_full`; `read-only` < `workspace-write` <
 * `danger-full-access`.
 *
 * 1. The mode is the tighter of the sent mode and the record's mode (no sent mode: the record's).
 * 2. The saved level is the record's sandbox, or the record mode's own level when it has none.
 * 3. With a sent mode the sandbox is the tighter of the mode's own level and the saved level;
 *    with no sent mode it is the saved level (a Worker, a wake-up, Compact, the profile file).
 * 4. The run starts as `agent_full` only with `danger-full-access`; otherwise as `agent`.
 * When the record's mode is tighter than the sent mode, the settings name both (the reply's note).
 */

type Row = {
  name: string
  sent?: unknown
  record: Record<string, unknown> | null
  start: 'chat' | 'agent' | 'agent_full'
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  limited?: { sentMode: string; ranMode: string }
}

/** A whole `codex_settings` block, as Agent Settings and the chat bar write it. */
function block(permissionMode: string, sandbox?: string) {
  return {
    permissionMode,
    model: 'gpt-6-astra',
    ...(sandbox ? { sandbox } : {}),
    approval: 'never',
    streamingEffect: true,
    search: true,
    addDirs: [],
    enableFeatures: [],
    disableFeatures: [],
    configOverrides: [],
    workingDirectoryMode: 'project'
  }
}

const rows: Row[] = [
  // A send whose mode equals the record's mode.
  { name: 'condition A: Agent with a saved Read-only runs read-only', sent: 'agent', record: block('agent', 'read-only'), start: 'agent', sandbox: 'read-only' },
  { name: 'Agent with its own level', sent: 'agent', record: block('agent', 'workspace-write'), start: 'agent', sandbox: 'workspace-write' },
  { name: 'a saved level looser than the mode is not used by a send', sent: 'agent', record: block('agent', 'danger-full-access'), start: 'agent', sandbox: 'workspace-write' },
  { name: 'Agent with no saved level takes the mode level', sent: 'agent', record: block('agent'), start: 'agent', sandbox: 'workspace-write' },
  { name: 'Agent (full access) with a full level', sent: 'agent_full', record: block('agent_full', 'danger-full-access'), start: 'agent_full', sandbox: 'danger-full-access' },
  { name: 'Agent (full access) with no saved level', sent: 'agent_full', record: block('agent_full'), start: 'agent_full', sandbox: 'danger-full-access' },
  { name: 'rule 4: Agent (full access) with a saved Workspace write starts as Agent', sent: 'agent_full', record: block('agent_full', 'workspace-write'), start: 'agent', sandbox: 'workspace-write' },
  { name: 'rule 4: Agent (full access) with a saved Read-only starts as Agent', sent: 'agent_full', record: block('agent_full', 'read-only'), start: 'agent', sandbox: 'read-only' },
  { name: 'Chat with a saved Workspace write stays read-only for a send', sent: 'chat', record: block('chat', 'workspace-write'), start: 'chat', sandbox: 'read-only' },
  // A send looser than the record (condition B: a group member; condition C: an older window).
  { name: 'condition B: a member whose record holds Chat', sent: 'agent_full', record: block('chat', 'read-only'), start: 'chat', sandbox: 'read-only', limited: { sentMode: 'agent_full', ranMode: 'chat' } },
  { name: 'a member whose record holds Agent with Read-only', sent: 'agent_full', record: block('agent', 'read-only'), start: 'agent', sandbox: 'read-only', limited: { sentMode: 'agent_full', ranMode: 'agent' } },
  { name: 'a member whose record holds Agent', sent: 'agent_full', record: block('agent', 'workspace-write'), start: 'agent', sandbox: 'workspace-write', limited: { sentMode: 'agent_full', ranMode: 'agent' } },
  { name: 'condition C: an older window sends Agent to a record that holds Chat', sent: 'agent', record: block('chat', 'read-only'), start: 'chat', sandbox: 'read-only', limited: { sentMode: 'agent', ranMode: 'chat' } },
  { name: 'condition C with a saved Workspace write under Chat', sent: 'agent', record: block('chat', 'workspace-write'), start: 'chat', sandbox: 'read-only', limited: { sentMode: 'agent', ranMode: 'chat' } },
  // A send tighter than the record: the sent mode runs, as today, with no note.
  { name: 'isolated test driver: a sent Chat to a record with Agent (full access)', sent: 'chat', record: block('agent_full', 'danger-full-access'), start: 'chat', sandbox: 'read-only' },
  { name: 'a sent Chat to a record with Agent', sent: 'chat', record: block('agent', 'workspace-write'), start: 'chat', sandbox: 'read-only' },
  { name: 'a sent Agent to a record with Agent (full access)', sent: 'agent', record: block('agent_full', 'danger-full-access'), start: 'agent', sandbox: 'workspace-write' },
  { name: 'a sent Agent to a record with Agent (full access) and Read-only', sent: 'agent', record: block('agent_full', 'read-only'), start: 'agent', sandbox: 'read-only' },
  // No sent mode: the record decides, with its saved level as it is (rule 4 still holds).
  { name: 'no sent mode: Agent with Read-only', record: block('agent', 'read-only'), start: 'agent', sandbox: 'read-only' },
  { name: 'no sent mode: Chat with a saved Workspace write keeps it', record: block('chat', 'workspace-write'), start: 'chat', sandbox: 'workspace-write' },
  { name: 'no sent mode: Agent with a saved Danger full access keeps it', record: block('agent', 'danger-full-access'), start: 'agent', sandbox: 'danger-full-access' },
  { name: 'no sent mode, rule 4: Agent (full access) with Read-only starts as Agent', record: block('agent_full', 'read-only'), start: 'agent', sandbox: 'read-only' },
  { name: 'no sent mode: Agent (full access) with a full level', record: block('agent_full', 'danger-full-access'), start: 'agent_full', sandbox: 'danger-full-access' },
  { name: 'no sent mode: Agent (full access) with no saved level', record: block('agent_full'), start: 'agent_full', sandbox: 'danger-full-access' },
  { name: 'a sent null is no sent mode', sent: null, record: block('agent', 'workspace-write'), start: 'agent', sandbox: 'workspace-write' },
  // Odd records.
  { name: 'no record: Chat', record: null, start: 'chat', sandbox: 'read-only' },
  { name: 'no record, a sent Agent: Chat, with the note', sent: 'agent', record: null, start: 'chat', sandbox: 'read-only', limited: { sentMode: 'agent', ranMode: 'chat' } },
  { name: 'an unknown sent mode counts as Chat', sent: 'everything', record: block('agent', 'workspace-write'), start: 'chat', sandbox: 'read-only' },
  { name: 'the older record: Agent with Read-only, a sent Agent', sent: 'agent', record: { codex_permission_mode: 'agent', codex_sandbox: 'read-only' }, start: 'agent', sandbox: 'read-only' },
  { name: 'the older record: Chat, a sent Agent (full access)', sent: 'agent_full', record: { codex_permission_mode: 'chat' }, start: 'chat', sandbox: 'read-only', limited: { sentMode: 'agent_full', ranMode: 'chat' } },
  { name: 'the older record, no sent mode: Agent with Read-only', record: { codex_permission_mode: 'agent', codex_sandbox: 'read-only' }, start: 'agent', sandbox: 'read-only' }
]

describe('BL-941: the record is the upper bound of a Codex run', () => {
  it.each(rows)('$name', (row) => {
    const settings = buildCodexRuntimeSettings(
      row.record as any,
      row.sent === undefined ? undefined : { permissionMode: row.sent as any }
    )
    expect(settings.permissionMode).toBe(row.start)
    expect(settings.sandbox).toBe(row.sandbox)
    expect(settings.modeLimitedByAgentSettings ?? null).toEqual(row.limited ?? null)
  })

  it('a send follows the mode it starts with for the approval word; no sent mode keeps the saved word', () => {
    expect(buildCodexRuntimeSettings(block('agent', 'read-only'), { permissionMode: 'agent' }).approval).toBe('on-request')
    expect(buildCodexRuntimeSettings(block('chat'), { permissionMode: 'agent_full' }).approval).toBe('never')
    expect(buildCodexRuntimeSettings({ ...block('agent', 'read-only'), approval: 'never' }).approval).toBe('never')
    // rule 4 with no sent mode leaves the saved word, so the managed profile file does not move.
    expect(buildCodexRuntimeSettings({ ...block('agent_full', 'read-only'), approval: 'never' }).approval).toBe('never')
  })

  it('a sent mode still marks the settings as sent (the exec lane passes its sandbox)', () => {
    expect(buildCodexRuntimeSettings(block('agent'), { permissionMode: 'agent' }).permissionOverridden).toBe(true)
    expect(buildCodexRuntimeSettings(block('agent')).permissionOverridden).toBe(false)
    // A sent null is no sent mode, so nothing is marked as sent.
    expect(buildCodexRuntimeSettings(block('agent'), { permissionMode: null as any }).permissionOverridden).toBe(false)
  })
})

describe('BL-941: an invalid stored sandbox counts as read-only', () => {
  it('on each lane: a whole block and the older record, with and with no sent mode', () => {
    for (const sent of [undefined, 'agent', 'agent_full']) {
      const options = sent === undefined ? undefined : { permissionMode: sent as any }
      expect(buildCodexRuntimeSettings(block('agent', 'everything'), options).sandbox, `block, sent ${sent}`).toBe('read-only')
      expect(buildCodexRuntimeSettings({ ...block('agent'), sandbox: 7 } as any, options).sandbox, `number, sent ${sent}`).toBe('read-only')
      expect(
        buildCodexRuntimeSettings({ codex_permission_mode: 'agent', codex_sandbox: 'everything' }, options).sandbox,
        `older record, sent ${sent}`
      ).toBe('read-only')
    }
    // rule 4 then starts an Agent (full access) record as Agent.
    expect(buildCodexRuntimeSettings(block('agent_full', 'everything')).permissionMode).toBe('agent')
  })
})

describe('BL-941: resolveCodexRunAccess reads its own inputs', () => {
  it('an unknown value never wins: a mode counts as Chat, a sandbox as read-only', () => {
    expect(resolveCodexRunAccess({ recordMode: 'root', recordSandbox: 'everything', sentMode: 'root' })).toEqual({
      permissionMode: 'chat', sandbox: 'read-only', modeLimitedByAgentSettings: null
    })
    expect(resolveCodexRunAccess({ recordMode: 'agent_full', recordSandbox: 'danger-full-access', sentMode: 'root' })).toEqual({
      permissionMode: 'chat', sandbox: 'read-only', modeLimitedByAgentSettings: null
    })
    expect(resolveCodexRunAccess({ recordMode: 'root', sentMode: 'agent_full' })).toEqual({
      permissionMode: 'chat', sandbox: 'read-only', modeLimitedByAgentSettings: { sentMode: 'agent_full', ranMode: 'chat' }
    })
    expect(resolveCodexRunAccess({ recordMode: 'agent', recordSandbox: null, sentMode: null })).toEqual({
      permissionMode: 'agent', sandbox: 'workspace-write', modeLimitedByAgentSettings: null
    })
  })
})

describe('BL-941 rule 4 at the bridge: an Agent (full access) record with a tighter level starts with that level', () => {
  function execOptions(permissionMode: string, sandboxMode: string) {
    return {
      model: 'gpt-6-astra', permissionMode, sandboxMode, workingDirectory: process.cwd(), allowFileEdits: sandboxMode !== 'read-only',
      allowNetwork: sandboxMode === 'danger-full-access', approvalPolicy: 'never', webSearchEnabled: true, addDirectories: [],
      enableFeatures: [], disableFeatures: [], configOverrides: [], defaultGateways: null, profileName: 'batshit_agent_test',
      configScope: 'managed', managedConfigHome: '/tmp/codex-home', dockerAuthToken: null, n8nInstanceMcpToken: null,
      historyPersistence: 'none', serviceTier: 'standard', permissionOverridden: true, unifiedExec: true, imagePaths: []
    } as any
  }

  it('the thread parameters and the exec lane flags carry the saved level; a full level still runs full', async () => {
    const { buildCodexAppServerThreadParams, buildCodexCliArgs } = await import('../codexBridge')
    const limited = buildCodexRuntimeSettings(block('agent_full', 'read-only'), { permissionMode: 'agent_full' })
    expect(buildCodexAppServerThreadParams(execOptions(limited.permissionMode, limited.sandbox)).sandbox).toBe('read-only')
    const limitedArgs = buildCodexCliArgs(execOptions(limited.permissionMode, limited.sandbox), { useProfileDefaults: false, shouldSkipGitCheck: true })
    expect(limitedArgs).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(limitedArgs.join(' ')).toContain('--sandbox read-only')

    const full = buildCodexRuntimeSettings(block('agent_full', 'danger-full-access'), { permissionMode: 'agent_full' })
    expect(buildCodexAppServerThreadParams(execOptions(full.permissionMode, full.sandbox)).sandbox).toBe('danger-full-access')
    expect(buildCodexCliArgs(execOptions(full.permissionMode, full.sandbox), { useProfileDefaults: false, shouldSkipGitCheck: true })).toContain(
      '--dangerously-bypass-approvals-and-sandbox'
    )
  }, 60_000)
})

describe('BL-941 R1: which settings are the agent block (the old gate)', () => {
  it('a settings bag with a model key (a preset merged with the older keys) keeps its older keys', () => {
    // send-routed hands over the preset's settings merged with the agent's own keys when the
    // agent has no block; a preset can hold `model`.
    const settings = buildCodexRuntimeSettings(
      { model: 'gpt-6-astra', codex_permission_mode: 'agent', codex_sandbox: 'read-only', codex_search: false },
      { permissionMode: 'agent' }
    )
    expect(settings.permissionMode).toBe('agent')
    expect(settings.sandbox).toBe('read-only')
    expect(settings.search).toBe(false)
  })

  it('a block with its mode and model but no lists runs with empty lists', () => {
    const settings = buildCodexRuntimeSettings({ permissionMode: 'agent', model: 'gpt-6-astra', sandbox: 'read-only' } as any)
    expect(settings.permissionMode).toBe('agent')
    expect(settings.sandbox).toBe('read-only')
    expect(settings.addDirs).toEqual([])
    expect(settings.enableFeatures).toEqual([])
    expect(settings.disableFeatures).toEqual([])
  })
})
