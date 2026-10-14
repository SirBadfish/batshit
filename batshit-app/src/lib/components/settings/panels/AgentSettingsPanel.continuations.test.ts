import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { untrack } from 'svelte'
import { resolveAgentDeleteChatCountOutcome } from '$lib/utils/agentDeleteChatCount'
import { uploadAvatarFile } from '$lib/appActions/imports/avatars'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Execute the actual callback bodies with a mutable view context across their awaited boundary.
// Upload responses use the real route's {url} shape; no filesystem or normal runtime is touched.
function callback(name: string, scope: Record<string, any>) {
  const source = readFileSync('src/lib/components/settings/panels/AgentSettingsPanel.svelte', 'utf8').split('<script lang="ts">')[1].split('</script>')[0]
  const file = ts.createSourceFile('panel.ts', source, ts.ScriptTarget.Latest, true)
  const fn = file.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!fn) throw new Error(`Missing callback ${name}`)
  const code = ts.transpileModule(fn.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('scope', `with (scope) { ${code}; return ${name} }`)(scope) as (...args: any[]) => Promise<void>
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) }

function uploadContext(kind: 'agent' | 'subagent') {
  const gate = deferred<Response>()
  const scope: Record<string, any> = {
    selectedEntity: { kind, id: 'A' }, selectedAgentId: 'A', selectedEditableSubagentId: 'A',
    settingsPanelAlive: true, primaryOwnedSaveInFlightUi: false, subagentOwnedSaveInFlightUi: false,
    agentAvatarUploadRequestId: 0, subagentAvatarUploadRequestId: 0,
    isUploadingAgentAvatar: false, subagentAvatarUploading: false,
    agentAvatarError: null, subagentAvatarError: null,
    basicForm: { displayName: 'A', avatar_url: 'saved-A.png' },
    subagentForm: { displayName: 'A', avatar: 'saved-A.png' },
    fetch: vi.fn(() => gate.promise), toast: { info: vi.fn() },
    extractError: vi.fn(async () => 'upload failed'),
    // BL-1304: SA-122 (dc029d93d) guards both uploads with `avatarAppActionBusy` and sends them through
    // the shared `uploadAvatarFile` helper. The real helper runs here, with this test's fetch.
    avatarAppActionBusy: false,
    uploadAvatarFile
  }
  vi.stubGlobal('fetch', scope.fetch)
  const input = { files: [new File(['probe'], 'probe.png', { type: 'image/png' })], value: 'probe.png' }
  return { scope, gate, input }
}

describe('Agent Settings awaited continuations (BL-1026, BL-1027)', () => {
  it.each(['agent', 'subagent'] as const)('%s upload cannot land on a different selected owner', async kind => {
    const { scope, gate, input } = uploadContext(kind)
    const result = callback(kind === 'agent' ? 'handleAgentAvatarUpload' : 'handleSubagentAvatarUpload', scope)({ currentTarget: input })
    const body = scope.fetch.mock.calls[0][1].body as FormData
    expect(body.get('entityId')).toBe('A')
    scope.selectedEntity = { kind, id: 'B' }
    scope.selectedAgentId = 'B'; scope.selectedEditableSubagentId = 'B'
    scope.basicForm = { displayName: 'B', avatar_url: 'saved-B.png' }
    scope.subagentForm = { displayName: 'B', avatar: 'saved-B.png' }
    gate.resolve(json({ url: '/uploads/avatars/agent_A_123.jpg' }))
    await result
    expect(scope.basicForm.avatar_url).toBe('saved-B.png')
    expect(scope.subagentForm.avatar).toBe('saved-B.png')
    expect(scope.fetch).toHaveBeenCalledOnce() // No save or speculative tidy of another upload.
    expect(scope.toast.info).toHaveBeenCalledOnce()
  })

  it.each(['agent', 'subagent'] as const)('%s upload rejects a stale request even after A to B to A', async kind => {
    const { scope, gate, input } = uploadContext(kind)
    const result = callback(kind === 'agent' ? 'handleAgentAvatarUpload' : 'handleSubagentAvatarUpload', scope)({ currentTarget: input })
    scope.agentAvatarUploadRequestId += 1; scope.subagentAvatarUploadRequestId += 1
    gate.resolve(json({ url: '/uploads/avatars/agent_A_old.jpg' }))
    await result
    expect(scope.basicForm.avatar_url).toBe('saved-A.png')
    expect(scope.subagentForm.avatar).toBe('saved-A.png')
  })

  it.each(['agent', 'subagent'] as const)('%s upload does not apply while its own save is in flight', async kind => {
    const { scope, gate, input } = uploadContext(kind)
    const result = callback(kind === 'agent' ? 'handleAgentAvatarUpload' : 'handleSubagentAvatarUpload', scope)({ currentTarget: input })
    scope.primaryOwnedSaveInFlightUi = true; scope.subagentOwnedSaveInFlightUi = true
    gate.resolve(json({ url: '/uploads/avatars/agent_A_new.jpg' }))
    await result
    expect(scope.basicForm.avatar_url).toBe('saved-A.png')
    expect(scope.subagentForm.avatar).toBe('saved-A.png')
    expect(scope.fetch).toHaveBeenCalledOnce()
  })

  it.each(['agent', 'subagent'] as const)('%s current upload still applies its own successful answer', async kind => {
    const { scope, gate, input } = uploadContext(kind)
    const result = callback(kind === 'agent' ? 'handleAgentAvatarUpload' : 'handleSubagentAvatarUpload', scope)({ currentTarget: input })
    gate.resolve(json({ url: '/uploads/avatars/A_new.jpg' }))
    await result
    expect(kind === 'agent' ? scope.basicForm.avatar_url : scope.subagentForm.avatar).toBe('/uploads/avatars/A_new.jpg')
    expect(kind === 'agent' ? scope.isUploadingAgentAvatar : scope.subagentAvatarUploading).toBe(false)
    expect(input.value).toBe('')
  })

  function deleteContext(kind: 'agent' | 'subagent') {
    const confirmation = deferred<boolean>()
    const scope: Record<string, any> = {
      selectedEntity: { kind, id: 'A' }, selectedAgentId: 'A', selectedEditableSubagentId: 'A',
      primaryCaptureBlocked: false, subagentCaptureBlocked: false,
      createEntityMode: false, selectedSubagentIds: [], assignmentPersistedSignature: null, subagents: [],
      agents: [{ id: 'A', displayName: 'Agent A' }, { id: 'B', displayName: 'Agent B' }],
      subagentForm: { displayName: 'Subagent A' },
      confirmDialog: vi.fn(() => confirmation.promise), confirmDialogWithCheckbox: vi.fn(),
      resolveAgentDeleteChatCountOutcome,
      fetch: vi.fn(async () => json({ deletable: 0, infinite: 0, keptLocked: 0, archived: 0 })),
      subagentStore: { delete: vi.fn() }, toast: { error: vi.fn(), success: vi.fn() },
      untrack, loadAgents: vi.fn(async () => { scope.agents = [] }), hydrateAgent: vi.fn(async () => {}),
      makeSubagentSignature: vi.fn(() => '[]'), updateAgentCollections: vi.fn(), selectSubagent: vi.fn(),
      agentDeleteState: 'idle', agentDeleteError: null, subagentDeleteState: 'idle', subagentDeleteError: null
    }
    return { scope, confirmation }
  }

  it('a failed Primary chat-count read refuses before opening any deletion dialog', async () => {
    const { scope } = deleteContext('agent')
    scope.fetch.mockImplementation(async () => new Response('count refused', { status: 503 }))
    await callback('handleDeletePrimaryAgent', scope)()
    expect(scope.fetch).toHaveBeenCalledOnce()
    expect(scope.fetch.mock.calls[0][0]).toBe('/api/agents/A/chats')
    expect(scope.confirmDialog).not.toHaveBeenCalled()
    expect(scope.confirmDialogWithCheckbox).not.toHaveBeenCalled()
    expect(scope.toast.error).toHaveBeenCalledOnce()
  })

  it.each(['agent', 'subagent'] as const)('%s delete confirmation cannot select another target after awaiting', async kind => {
    const { scope, confirmation } = deleteContext(kind)
    const result = callback(kind === 'agent' ? 'handleDeletePrimaryAgent' : 'handleDeleteSubagent', scope)()
    for (let turn = 0; turn < 12 && scope.confirmDialog.mock.calls.length === 0; turn++) await Promise.resolve()
    expect(scope.confirmDialog).toHaveBeenCalledOnce()
    scope.selectedEntity = { kind, id: 'B' }; scope.selectedAgentId = 'B'; scope.selectedEditableSubagentId = 'B'
    confirmation.resolve(true)
    await result
    expect(scope.fetch.mock.calls.some(([, init]: any) => init?.method === 'DELETE')).toBe(false)
    expect(scope.subagentStore.delete).not.toHaveBeenCalled()
    if (kind === 'agent') expect(scope.fetch.mock.calls[0][0]).toBe('/api/agents/A/chats')
  })

  it.each(['agent', 'subagent'] as const)('%s delete continuation refuses new unresolved work after the dialog opens', async kind => {
    const { scope, confirmation } = deleteContext(kind)
    const result = callback(kind === 'agent' ? 'handleDeletePrimaryAgent' : 'handleDeleteSubagent', scope)()
    for (let turn = 0; turn < 12 && scope.confirmDialog.mock.calls.length === 0; turn++) await Promise.resolve()
    scope.primaryCaptureBlocked = true; scope.subagentCaptureBlocked = true
    confirmation.resolve(true)
    await result
    expect(scope.fetch.mock.calls.some(([, init]: any) => init?.method === 'DELETE')).toBe(false)
    expect(scope.subagentStore.delete).not.toHaveBeenCalled()
  })
})
