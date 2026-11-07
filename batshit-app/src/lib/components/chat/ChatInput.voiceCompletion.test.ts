import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'
import { confirmUserSettings, resetUserSettings } from '$lib/stores/userSettings.svelte'
import * as savedModelsStore from '$lib/stores/savedModels.svelte'
import type { SavedModel } from '$lib/types/savedModels'
import * as sessionStore from '$lib/stores/session.svelte'
import { DatabaseService } from '$lib/services/databaseRedis.client'
import { toast } from 'svelte-sonner'

/** Component-only proof: real ChatInput + VoiceService browser recognition handling, with
 * the existing MockSpeechRecognition seam and controlled LOCAL page callbacks. No microphone,
 * provider, HTTP send/queue, Redis, or production feature enablement is exercised or claimed here. Synthetic action verdicts below never invoke a judge. */
class MockSpeechRecognition {
  static instances: MockSpeechRecognition[] = []
  continuous = false
  interimResults = true
  lang = ''
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: any) => void) | null = null
  onresult: ((event: any) => void) | null = null
  onspeechstart: (() => void) | null = null
  start = vi.fn(() => this.onstart?.())
  stop = vi.fn(() => this.onend?.())
  constructor() { MockSpeechRecognition.instances.push(this) }
}

type Completion = {
  onNoReplyCompleted?: () => void
  onReplyAdmitted?: (kind: 'direct' | 'steer' | 'queued') => void
  onSteerPrepared?: (identity: { sessionId: string; steerId: string; targetMessageId?: string }) => void
  onComposerSessionCreated?: (identity: { sessionId: string; agentId: string }) => boolean
}
const AGENT = { id: 'synthetic_voice_agent', user_id: 'synthetic_voice_user', displayName: 'Voice fixture',
  created_at: '2026-10-27T12:00:00.000Z', agentType: 'api', primary_model_provider: 'openai', primary_model_name: 'synthetic-unused' }
const voiceSettings = { schemaVersion: 2, voiceSessionRuntime: 'direct', stt: { providerId: 'browser' },
  realtimeStt: { providerId: 'browser' }, tts: { providerId: 'browser' },
  voiceMode: { inputMode: 'speech', autoSubmitDelayMs: 250, jevJuiceQuickActions: false } }
let ChatInput: typeof import('./ChatInput.svelte').default
let voice: typeof import('$lib/services/voice')
let calls: { text: string; metadata: { onAccepted?: () => Promise<void> }; completion: Completion; settle: (value: boolean) => void }[]
let requests: { path: string; method: string; url: string }[]
let savedPresetRows: SavedModel[]
let fixtureVoiceSettings: any
let quickActionVerdict: Record<string, unknown> | null

beforeAll(async () => {
  // Install before the real service constructs its recognizer, as in voiceRealtimePlayback.
  vi.stubGlobal('SpeechRecognition', MockSpeechRecognition)
  vi.stubGlobal('webkitSpeechRecognition', MockSpeechRecognition)
  voice = await import('$lib/services/voice')
  ChatInput = (await import('./ChatInput.svelte')).default
}, 60_000)

beforeEach(() => {
  calls = []
  requests = []
  savedPresetRows = []
  quickActionVerdict = null
  sessionStore.setSessions([])
  sessionStore.setCurrentSessionId('synthetic_chat')
  fixtureVoiceSettings = structuredClone(voiceSettings)
  confirmUserSettings({ voice_settings: fixtureVoiceSettings })
  agentStore.setAgents([AGENT as any])
  agentStore.setCurrentAgentId(AGENT.id)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = new URL(String(input), 'http://synthetic.invalid'), path = parsed.pathname
    const method = init?.method ?? 'GET'
    requests.push({ path, method, url: parsed.pathname + parsed.search })
    if (path === '/api/jev-juice/quick-action' && method === 'POST' && quickActionVerdict) return Response.json(quickActionVerdict)
    if (path === '/api/user/saved-models' && parsed.searchParams.get('projection') === 'stored') return Response.json({ projection: 'stored', models: savedPresetRows, total: savedPresetRows.length, offset: 0, nextOffset: null })
    const bodies: Record<string, unknown> = {
      '/api/user/saved-models': { models: savedPresetRows }, '/api/models': { data: { connections: [] } },
      '/api/mcp/gateways': { gateways: [] }, '/api/agents': { agents: [AGENT] }, '/api/groups': { groups: [] },
      '/api/folders': [], '/api/projects': { projects: [] }, '/api/projects/preferences': { preferences: null },
      '/api/cli-tools': { tools: [] }, '/api/slash-commands': { commands: [] },
      '/api/voice/providers': { providers: [] }, '/api/user/settings': { settings: { voice_settings: fixtureVoiceSettings } },
      [`/api/agents/${AGENT.id}`]: AGENT
    }
    // No request escapes this fixture; unexpected reads fail rather than reaching a real server.
    return new Response(JSON.stringify(bodies[path] ?? { error: 'No synthetic route' }),
      { status: path in bodies && method === 'GET' ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }))
})

afterEach(() => {
  cleanup() // Real unmount invalidation and owned Voice teardown.
  voice.voiceService.stopAll()
  voice.voiceService.stopListening()
  calls.forEach(call => call.settle(false))
  agentStore.setAgents([])
  savedModelsStore.setSavedModels([])
  resetUserSettings()
  sessionStore.setCurrentSessionId(null)
  sessionStore.setSessions([])
  vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

function renderInput(extra: Record<string, any> = {}) {
  return render(ChatInput, { props: { data: { user: { id: AGENT.user_id } }, sessionId: 'synthetic_chat',
    onSend: (text: string, metadata: { onAccepted?: () => Promise<void> }, completion: Completion = {}) => new Promise<boolean>(settle => {
      calls.push({ text, metadata, completion, settle })
    }), ...extra } })
}
async function startVoice() {
  await fireEvent.click(screen.getByRole('button', { name: 'Start Voice Mode' }))
  await screen.findByRole('button', { name: 'End Voice Mode' })
}
async function openVoice() {
  const mounted = renderInput()
  await startVoice()
  return mounted.component
}
const composer = () => screen.getByRole('textbox', { name: 'Message composer' }) as HTMLTextAreaElement
function finalTranscript(text: string) {
  const recognition = MockSpeechRecognition.instances.at(-1)!
  recognition.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text }, isFinal: true }] })
}
function expectWaiting() {
  expect((screen.getByRole('button', { name: 'Voice input unavailable while waiting for AI response' }) as HTMLButtonElement).disabled).toBe(true)
}
async function expectReady() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Voice input one message' })).toBeTruthy())
}

describe('spoken completion ownership at the mounted phone/End seam', () => {
  it('clears the accepted spoken draft after the normal same-agent refresh, before its reply completes', async () => {
    await openVoice()
    finalTranscript('accepted spoken words')
    await waitFor(() => expect(calls).toHaveLength(1))
    // handleSendMessage refreshes this same record before storing the user message
    // and invoking its normal acceptance callback. No model/provider call is needed.
    agentStore.updateAgent(AGENT.id, { ...AGENT } as any)
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message composer' }) as HTMLTextAreaElement).value).toBe('accepted spoken words'))
    await calls[0].metadata.onAccepted?.()
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message composer' }) as HTMLTextAreaElement).value).toBe(''))
    expectWaiting()
    expect(calls).toHaveLength(1) // onSend is still pending; this is acceptance, not completion.
  })

  it.each(['a newer typed draft', 'same spoken words'])('preserves a newer edit even when it returns to %s before acceptance', async next => {
    await openVoice()
    finalTranscript('same spoken words')
    await waitFor(() => expect(calls).toHaveLength(1))
    await fireEvent.input(composer(), { target: { value: 'edited away' } })
    await fireEvent.input(composer(), { target: { value: next } })
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe(next)
    calls[0].settle(true)
    await waitFor(() => expect(composer().value).toBe(next))
  })

  it('keeps refusal and rejected-before-acceptance words, and completion alone never clears them', async () => {
    const component = await openVoice()
    finalTranscript('not accepted words')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onNoReplyCompleted?.()
    calls[0].settle(false)
    await expectReady()
    component.aiResponseReceived()
    expect(composer().value).toBe('not accepted words')
  })

  it('keeps a draft when send preparation throws before acceptance', async () => {
    const send = vi.fn(async () => { throw new Error('Synthetic preparation refusal') })
    renderInput({ onSend: send })
    await startVoice()
    finalTranscript('recoverable words')
    await waitFor(() => expect(send).toHaveBeenCalledOnce())
    await expectReady()
    expect(composer().value).toBe('recoverable words')
  })

  it('never clears later input on reply completion after its own acceptance', async () => {
    const component = await openVoice()
    finalTranscript('accepted first')
    await waitFor(() => expect(calls).toHaveLength(1))
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('')
    await fireEvent.input(composer(), { target: { value: 'next unsent draft' } })
    calls[0].completion.onNoReplyCompleted?.()
    calls[0].settle(true)
    component.aiResponseReceived()
    await waitFor(() => expect(composer().value).toBe('next unsent draft'))
  })

  it('keeps a distinct same-text utterance while an older accepted send is delayed', async () => {
    await openVoice()
    finalTranscript('same utterance')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onReplyAdmitted?.('direct')
    calls[0].completion.onNoReplyCompleted?.()
    await expectReady()
    finalTranscript('same utterance')
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('same utterance')
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].text).toBe('same utterance')
    await calls[1].metadata.onAccepted?.()
    expect(composer().value).toBe('')
    calls[0].settle(true)
    expect(calls).toHaveLength(2)
  })

  it('fences old capture callbacks and acceptance after End and restart', async () => {
    await openVoice()
    const oldResult = MockSpeechRecognition.instances.at(-1)!.onresult!
    finalTranscript('old spoken words')
    await waitFor(() => expect(calls).toHaveLength(1))
    await fireEvent.click(screen.getByRole('button', { name: 'End Voice Mode' }))
    await fireEvent.input(composer(), { target: { value: 'new unsent draft' } })
    await startVoice()
    oldResult({ resultIndex: 0, results: [{ 0: { transcript: 'late old transcript' }, isFinal: true }] })
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('new unsent draft')
    expect(calls).toHaveLength(1)
  })

  it('keeps a new chat draft and rejects old callbacks even after returning to the original chat', async () => {
    const mounted = renderInput()
    await startVoice()
    const oldResult = MockSpeechRecognition.instances.at(-1)!.onresult!
    finalTranscript('original words')
    await waitFor(() => expect(calls).toHaveLength(1))
    await mounted.rerender({ sessionId: 'other_chat' })
    await mounted.rerender({ sessionId: 'synthetic_chat' })
    await fireEvent.input(composer(), { target: { value: 'original words' } })
    oldResult({ resultIndex: 0, results: [{ 0: { transcript: 'late words' }, isFinal: true }] })
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('original words')
  })

  it('retires a changed agent incarnation while preserving same-text unsent words', async () => {
    await openVoice()
    finalTranscript('owned words')
    await waitFor(() => expect(calls).toHaveLength(1))
    agentStore.updateAgent(AGENT.id, { ...AGENT, created_at: '2026-10-27T13:00:00.000Z' } as any)
    await fireEvent.input(composer(), { target: { value: 'owned words' } })
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('owned words')
  })

  it('retires old pending configuration without restarting or muting the started continuous capture', async () => {
    const start = vi.spyOn(voice.voiceService, 'startVoiceMode')
    await openVoice()
    finalTranscript('old config words')
    await waitFor(() => expect(calls).toHaveLength(1))
    agentStore.updateAgent(AGENT.id, { ...AGENT, voice_profile: { realtimeStt: { providerId: 'openai', modelId: 'synthetic-recorded' } } } as any)
    await fireEvent.input(composer(), { target: { value: 'preserved draft' } })
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('preserved draft')
    finalTranscript('new words from existing capture')
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].text).toBe('new words from existing capture')
    expect(start).toHaveBeenCalledOnce()
  })

  it('leaves Transcribe text unsent until the normal Send action is accepted', async () => {
    renderInput()
    await fireEvent.input(composer(), { target: { value: 'typed prefix' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Voice input one message' }))
    finalTranscript('dictated draft')
    await fireEvent.click(screen.getByRole('button', { name: 'Stop dictation' }))
    expect(composer().value).toBe('typed prefix dictated draft')
    expect(calls).toHaveLength(0)
    await fireEvent.keyDown(composer(), { key: 'Enter' })
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(composer().value).toBe('typed prefix dictated draft')
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('')
  })

  it('keeps Manual Turn draft until the user stops/sends the recorded turn and it is accepted', async () => {
    fixtureVoiceSettings = { ...voiceSettings, realtimeStt: { providerId: 'openai', modelId: 'synthetic-recorded' }, voiceMode: { ...voiceSettings.voiceMode, submitMode: 'manual' } }
    confirmUserSettings({ voice_settings: fixtureVoiceSettings })
    let captured: { result: (text: string) => void; resolve: () => void } | undefined
    vi.spyOn(voice.voiceService, 'startVoiceMode').mockImplementation((result) => new Promise<void>(resolve => { captured = { result, resolve } }))
    vi.spyOn(voice.voiceService, 'stopListening').mockImplementation(() => { captured?.result('manual words'); captured?.resolve(); captured = undefined })
    renderInput()
    await fireEvent.input(composer(), { target: { value: 'unsent prefix' } })
    await startVoice()
    await screen.findByRole('button', { name: 'Stop and send voice turn' })
    expect(calls).toHaveLength(0)
    expect(composer().value).toBe('unsent prefix')
    await fireEvent.click(screen.getByRole('button', { name: 'Stop and send voice turn' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].text).toBe('unsent prefix manual words')
    expect(composer().value).toBe('unsent prefix manual words')
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('')
  })

  it('transfers only its own null-chat first send and keeps capture callbacks alive in that created chat', async () => {
    sessionStore.setCurrentSessionId(null)
    const mounted = renderInput({ sessionId: null })
    await startVoice()
    finalTranscript('first chat words')
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].completion.onComposerSessionCreated?.({ sessionId: 'created_chat', agentId: AGENT.id })).toBe(true)
    await mounted.rerender({ sessionId: 'created_chat' })
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('')
    calls[0].completion.onReplyAdmitted?.('direct')
    calls[0].completion.onNoReplyCompleted?.()
    await expectReady()
    finalTranscript('next created-chat words')
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].text).toBe('next created-chat words')
  })

  it('a first-send handoff cannot adopt another selected chat or erase its newer same-text draft', async () => {
    sessionStore.setCurrentSessionId(null)
    const mounted = renderInput({ sessionId: null })
    await startVoice()
    finalTranscript('same first words')
    await waitFor(() => expect(calls).toHaveLength(1))
    await mounted.rerender({ sessionId: 'user_selected_chat' })
    await fireEvent.input(composer(), { target: { value: 'same first words' } })
    expect(calls[0].completion.onComposerSessionCreated?.({ sessionId: 'old_created_chat', agentId: AGENT.id })).toBe(false)
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('same first words')
  })

  it('hands a first spoken slash-preparation creation to its exact token before selection', async () => {
    sessionStore.setCurrentSessionId(null)
    const created = { id: 'slash_created_chat', user_id: AGENT.user_id, name: 'Created', created_at: AGENT.created_at, last_modified_at: AGENT.created_at }
    vi.spyOn(DatabaseService.prototype, 'createSession').mockResolvedValue(created as any)
    const mounted = renderInput({ sessionId: null })
    const select = sessionStore.setCurrentSessionId
    vi.spyOn(sessionStore, 'setCurrentSessionId').mockImplementation(id => { select(id); void mounted.rerender({ sessionId: id }) })
    await startVoice()
    finalTranscript('/literal spoken words')
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(sessionStore.getCurrentSessionId()).toBe(created.id)
    expect(calls[0].text).toBe('/literal spoken words')
    await calls[0].metadata.onAccepted?.()
    expect(composer().value).toBe('')
  })

  it('refuses stale spoken slash preparation when the user selects another chat during creation', async () => {
    sessionStore.setCurrentSessionId(null)
    let finish!: (value: any) => void
    const create = vi.spyOn(DatabaseService.prototype, 'createSession').mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const mounted = renderInput({ sessionId: null })
    await startVoice()
    finalTranscript('/literal old words')
    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    sessionStore.setCurrentSessionId('user_selected_chat')
    await mounted.rerender({ sessionId: 'user_selected_chat' })
    await fireEvent.input(composer(), { target: { value: 'new selected draft' } })
    finish({ id: 'old_created_chat', user_id: AGENT.user_id, name: 'Old creation', created_at: AGENT.created_at, last_modified_at: AGENT.created_at })
    await waitFor(() => expect(sessionStore.getSessions().some(row => row.id === 'old_created_chat')).toBe(true))
    expect(sessionStore.getCurrentSessionId()).toBe('user_selected_chat')
    expect(composer().value).toBe('new selected draft')
    expect(calls).toHaveLength(0)
    expect(requests.some(request => request.path.endsWith('/invoke'))).toBe(false)
  })

  it('keeps words and reports the already-applied action when there is no message-save owner', async () => {
    fixtureVoiceSettings.voiceMode = { ...fixtureVoiceSettings.voiceMode, jevJuiceQuickActions: true, jevJuiceQuickActionsWakeWordRequired: false }
    confirmUserSettings({ voice_settings: fixtureVoiceSettings })
    quickActionVerdict = { action: 'stop', onlyThis: true, confidence: 1, snapshotId: 'synthetic' }
    const stopWork = vi.fn(), error = vi.spyOn(toast, 'error')
    renderInput({ workBusy: true, onStopWork: stopWork })
    await startVoice()
    const oldResult = MockSpeechRecognition.instances.at(-1)!.onresult!
    finalTranscript('stop this work')
    await waitFor(() => expect(stopWork).toHaveBeenCalledOnce())
    await screen.findByRole('button', { name: 'Start Voice Mode', exact: true })
    expect(composer().value).toBe('stop this work')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('The voice action ran, but its words were not confirmed saved. Voice Mode is paused'))
    oldResult({ resultIndex: 0, results: [{ 0: { transcript: 'late old action' }, isFinal: true }] })
    expect(stopWork).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })

  it('an old failed action save cannot pause or clear a newer restarted Voice owner', async () => {
    fixtureVoiceSettings.voiceMode = { ...fixtureVoiceSettings.voiceMode, jevJuiceQuickActions: true, jevJuiceQuickActionsWakeWordRequired: false }
    confirmUserSettings({ voice_settings: fixtureVoiceSettings })
    quickActionVerdict = { action: 'stop', onlyThis: true, confidence: 1, snapshotId: 'synthetic' }
    let reject!: (error: Error) => void
    const save = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const error = vi.spyOn(toast, 'error')
    renderInput({ onQuickActionMessage: save })
    await startVoice()
    finalTranscript('old action words')
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await fireEvent.click(screen.getByRole('button', { name: 'End Voice Mode' }))
    await startVoice()
    await fireEvent.input(composer(), { target: { value: 'newer owner draft' } })
    reject(new Error('Synthetic unknown save'))
    await waitFor(() => expect(error).toHaveBeenCalledWith('The voice action ran, but its words were not confirmed saved. Your composer was not cleared.'))
    expect(screen.getByRole('button', { name: 'End Voice Mode' })).toBeTruthy()
    expect(composer().value).toBe('newer owner draft')
    expect(calls).toHaveLength(0)
  })

  it('does not rearm recorded Auto Listen while an action-only save is pending, then pauses the exact failed turn', async () => {
    fixtureVoiceSettings = { ...voiceSettings, realtimeStt: { providerId: 'openai', modelId: 'synthetic-recorded' },
      voiceMode: { ...voiceSettings.voiceMode, submitMode: 'auto', jevJuiceQuickActions: true, jevJuiceQuickActionsWakeWordRequired: false } }
    confirmUserSettings({ voice_settings: fixtureVoiceSettings })
    quickActionVerdict = { action: 'stop', onlyThis: true, confidence: 1, snapshotId: 'synthetic' }
    let capture!: { result: (text: string) => void; finish: () => void }, reject!: (error: Error) => void
    const start = vi.spyOn(voice.voiceService, 'startVoiceMode').mockImplementation(result => new Promise<void>(finish => { capture = { result, finish } }))
    const save = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail })), stop = vi.fn()
    renderInput({ workBusy: true, onStopWork: stop, onQuickActionMessage: save })
    await startVoice()
    await screen.findByRole('button', { name: 'Stop and send voice turn' })
    capture.result('stop the work'); capture.finish()
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    // The existing automatic capture timer is300ms. It must remain held by storage.
    await new Promise(resolve => setTimeout(resolve, 450))
    expect(start).toHaveBeenCalledOnce()
    reject(new Error('Synthetic unconfirmed persistence'))
    await screen.findByRole('button', { name: 'Start Voice Mode', exact: true })
    expect(start).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(composer().value).toBe('stop the work')
    expect(calls).toHaveLength(0)
  })

  it('a later same-text typed draft prevents an old failed action save from pausing its newer input', async () => {
    fixtureVoiceSettings.voiceMode = { ...fixtureVoiceSettings.voiceMode, jevJuiceQuickActions: true, jevJuiceQuickActionsWakeWordRequired: false }
    confirmUserSettings({ voice_settings: fixtureVoiceSettings })
    quickActionVerdict = { action: 'stop', onlyThis: true, confidence: 1, snapshotId: 'synthetic' }
    let reject!: (error: Error) => void
    const save = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail })), error = vi.spyOn(toast, 'error')
    renderInput({ onQuickActionMessage: save })
    await startVoice()
    finalTranscript('same action words')
    await waitFor(() => expect(save).toHaveBeenCalledOnce())
    await fireEvent.input(composer(), { target: { value: 'edited away' } })
    await fireEvent.input(composer(), { target: { value: 'same action words' } })
    reject(new Error('Synthetic unconfirmed persistence'))
    await waitFor(() => expect(error).toHaveBeenCalledWith('The voice action ran, but its words were not confirmed saved. Your composer was not cleared.'))
    expect(screen.getByRole('button', { name: 'End Voice Mode' })).toBeTruthy()
    expect(composer().value).toBe('same action words')
    expect(calls).toHaveLength(0)
  })

  it('fences the selected agent switch and late callbacks without clearing the replacement draft', async () => {
    await openVoice()
    const oldResult = MockSpeechRecognition.instances.at(-1)!.onresult!
    finalTranscript('old agent words')
    await waitFor(() => expect(calls).toHaveLength(1))
    const other = { ...AGENT, id: 'other_voice_agent', displayName: 'Other fixture' }
    agentStore.setAgents([AGENT as any, other as any]); agentStore.setCurrentAgentId(other.id)
    await fireEvent.input(composer(), { target: { value: 'other agent draft' } })
    oldResult({ resultIndex: 0, results: [{ 0: { transcript: 'late old agent words' }, isFinal: true }] })
    await calls[0].metadata.onAccepted?.()
    expect(agentStore.getCurrentAgent()?.id).toBe(other.id)
    expect(composer().value).toBe('other agent draft')
  })

  it('a pure saved-model/current-agent refresh updates the next Connect label without connecting, sending or losing composer text', async () => {
    const send = vi.fn()
    render(ChatInput, { props: { data: { user: { id: AGENT.user_id } }, sessionId: 'synthetic_chat', onSend: send } })
    await screen.findByRole('button', { name: 'Start Voice Mode', exact: true })
    await waitFor(() => expect(requests.some(request => request.path === '/api/user/saved-models')).toBe(true))
    await waitFor(() => expect(savedModelsStore.getIsLoading()).toBe(false))
    await fireEvent.input(screen.getByRole('textbox', { name: 'Message composer' }), { target: { value: 'Keep this unsent draft' } })
    const preset: SavedModel = { id: 'synthetic_voice_preset', modelName: 'Configured speech', modelId: 'gpt-realtime-2', provider: 'openai', purpose: 'chat',
      connection: { id: 'direct:openai', type: 'direct', service: 'openai' }, settings: {}, pricing: {}, createdAt: '2026-10-18', updatedAt: '2026-10-18',
      voiceSession: { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', supportStatus: 'supported', locksVoiceModeSettings: true } }
    savedPresetRows = [preset]
    const before = requests.length
    expect(await savedModelsStore.refreshStoredSavedModels()).toBe(true)
    agentStore.setAgents([{ ...AGENT, primary_model_preset_id: preset.id, primary_model_provider: preset.provider, primary_model_name: preset.modelId, primary_model_connection: preset.connection } as any])
    await screen.findByRole('button', { name: 'Connect OpenAI Realtime voice', exact: true })
    expect((screen.getByRole('textbox', { name: 'Message composer' }) as HTMLTextAreaElement).value).toBe('Keep this unsent draft')
    expect(requests.slice(before).map(request => request.url)).toEqual(['/api/user/saved-models?projection=stored&offset=0'])
    expect(requests.every(request => request.method === 'GET')).toBe(true)
    expect(requests.slice(before).some(request => request.path.startsWith('/api/voice/'))).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  it('holds an unrelated end during initially idle preparation, then completes the captured no-stream send', async () => {
    const component = await openVoice()
    finalTranscript('captured first transcript')
    await waitFor(() => expect(calls).toHaveLength(1))
    component.aiResponseReceived() // Another tab's reply ends before this page admits our send.
    await waitFor(expectWaiting)
    finalTranscript('must not supersede the pending transcript')
    expect(calls[0].text).toBe('captured first transcript')
    expect((screen.getByRole('textbox', { name: 'Message composer' }) as HTMLTextAreaElement).value).toBe('captured first transcript')
    calls[0].completion.onReplyAdmitted?.('direct')
    expectWaiting() // The unrelated preparation-time end never becomes this reply's completion.
    calls[0].completion.onNoReplyCompleted?.() // Accepted terminal no-stream completion.
    await expectReady()
    calls[0].settle(true)
    expect(requests.every(request => request.path !== '/api/jev-juice/quick-action')).toBe(true)
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
  })

  it('End releases its accepted no-stream wait, while an old completion cannot release a restarted queued wait', async () => {
    const component = await openVoice()
    finalTranscript('old skipped spoken turn')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onReplyAdmitted?.('direct')
    await fireEvent.click(screen.getByRole('button', { name: 'End Voice Mode' }))
    await expectReady()
    // End preserves unsent composer text. The user clears that old draft before restarting.
    await fireEvent.input(screen.getByRole('textbox', { name: 'Message composer' }), { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Start Voice Mode' }))
    finalTranscript('new queued spoken turn')
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1].completion.onReplyAdmitted?.('queued')
    calls[0].completion.onNoReplyCompleted?.()
    calls[0].settle(true)
    component.aiResponseReceived() // The prior reply's end owns neither this queued wait nor its terminal.
    await waitFor(expectWaiting)
    expect(calls[1].text).toBe('new queued spoken turn')
    calls[1].settle(true) // Controlled local onSend represents its own awaited terminal, not a 202.
    await expectReady()
    expect(requests.every(request => request.path !== '/api/jev-juice/quick-action')).toBe(true)
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
  })
  it('a spoken inbox receipt waits past predecessor end and promoted user until its exact answer', async () => {
    const component = await openVoice()
    finalTranscript('spoken inbox words')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'spoken' })
    // Actual page seam registers before POST; these server events can race the 202.
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'user_message', role: 'user',
      metadata: { steerPromoted: { steerIds: ['spoken'] } } })
    component.aiResponseReceived()
    await waitFor(expectWaiting)
    calls[0].completion.onReplyAdmitted?.('steer')
    calls[0].settle(true)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'start', messageId: 'promoted-answer',
      metadata: { steerPromoted: { steerIds: ['spoken'] } } })
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'predecessor' })
    await waitFor(expectWaiting)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'promoted-answer' })
    await expectReady()
  })

  it('End and restart keep an old inbox answer from releasing a new exact wait; reload can finish the new one', async () => {
    const component = await openVoice()
    finalTranscript('old inbox words')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'old' })
    calls[0].completion.onReplyAdmitted?.('steer')
    calls[0].settle(true)
    await fireEvent.click(screen.getByRole('button', { name: 'End Voice Mode' }))
    await expectReady()
    await fireEvent.input(screen.getByRole('textbox', { name: 'Message composer' }), { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Start Voice Mode' }))
    finalTranscript('new inbox words')
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'new' })
    calls[1].completion.onReplyAdmitted?.('steer')
    calls[1].settle(true)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'old-answer',
      metadata: { steerPromoted: { steerIds: ['old'] } } })
    component.aiResponseReceived()
    await waitFor(expectWaiting)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'record', role: 'assistant', status: 'complete', messageId: 'new-answer',
      metadata: { steerPromoted: { steerIds: ['new'] } } })
    await expectReady()
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
  })

  it('holds the real approval end→complete and answered reload before the owning resumed answer', async () => {
    const component = await openVoice()
    finalTranscript('spoken approval words')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'spoken', targetMessageId: 'card' })
    calls[0].completion.onReplyAdmitted?.('steer')
    calls[0].settle(true)
    const relation = { steerPromoted: { steerIds: ['spoken'] } }
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'card',
      metadata: { ...relation, toolApprovals: { approvals: [{ status: 'pending' }] } } })
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'complete', messageId: 'card', metadata: relation })
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'record', messageId: 'card', role: 'assistant', status: 'complete',
      metadata: { ...relation, answeredApprovalIds: ['ap'] } })
    component.aiResponseReceived()
    await waitFor(expectWaiting)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'card',
      metadata: { ...relation, approvalResumeVersion: 20 } })
    await expectReady()
  })

  it('held speech stays busy after the API card resume ends, then releases at the exact held answer', async () => {
    const component = await openVoice()
    finalTranscript('held spoken words')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'spoken', targetMessageId: 'card' })
    calls[0].completion.onReplyAdmitted?.('steer')
    calls[0].settle(true)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'user_message', role: 'user', messageId: 'spoken', metadata: {
      steerPromoted: { steerIds: ['spoken'], disposition: 'awaiting_approval', approvalResumeVersion: 10 },
      waitsForApproval: { messageId: 'card' } } })
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'start', messageId: 'card', metadata: { approvalResumeVersion: 20 } })
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'card', metadata: { approvalResumeVersion: 20 } })
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'complete', messageId: 'card', metadata: { approvalResumeVersion: 20 } })
    component.aiResponseReceived()
    await waitFor(expectWaiting)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'start', messageId: 'held-answer',
      metadata: { steerPromoted: { steerIds: ['spoken'] } } })
    await waitFor(expectWaiting)
    component.observeVoiceReply({ sessionId: 'synthetic_chat', type: 'end', messageId: 'held-answer',
      metadata: { steerPromoted: { steerIds: ['spoken'] } } })
    await expectReady()
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
  })

  it('the exact local Stop owns a lost-forward inbox wait; End/restart fences its stale target', async () => {
    const component = await openVoice()
    finalTranscript('spoken stopped words')
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'spoken', targetMessageId: 'target' })
    calls[0].completion.onReplyAdmitted?.('steer')
    calls[0].settle(true)
    component.voiceSteerTargetStopped('synthetic_chat', 'other')
    await waitFor(expectWaiting)
    component.voiceSteerTargetStopped('synthetic_chat', 'target')
    await expectReady()
    await fireEvent.click(screen.getByRole('button', { name: 'End Voice Mode' }))
    await fireEvent.input(screen.getByRole('textbox', { name: 'Message composer' }), { target: { value: '' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Start Voice Mode' }))
    finalTranscript('new spoken words')
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1].completion.onSteerPrepared?.({ sessionId: 'synthetic_chat', steerId: 'new', targetMessageId: 'new-target' })
    calls[1].completion.onReplyAdmitted?.('steer')
    calls[1].settle(true)
    component.voiceSteerTargetStopped('synthetic_chat', 'target')
    await waitFor(expectWaiting)
    component.voiceSteerTargetStopped('synthetic_chat', 'new-target')
    await expectReady()
  })

})
