import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as agentStore from '$lib/stores/agents.svelte'
import { confirmUserSettings, resetUserSettings } from '$lib/stores/userSettings.svelte'

/** Component-only proof: real ChatInput + VoiceService browser recognition handling, with
 * the existing MockSpeechRecognition seam and controlled LOCAL page callbacks. No microphone,
 * provider, HTTP send/queue, Redis, or feature enablement is exercised or claimed here. */
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
}
const AGENT = { id: 'synthetic_voice_agent', user_id: 'synthetic_voice_user', displayName: 'Voice fixture',
  agentType: 'api', primary_model_provider: 'openai', primary_model_name: 'synthetic-unused' }
const voiceSettings = { schemaVersion: 2, voiceSessionRuntime: 'direct', stt: { providerId: 'browser' },
  realtimeStt: { providerId: 'browser' }, tts: { providerId: 'browser' },
  voiceMode: { inputMode: 'speech', autoSubmitDelayMs: 250, jevJuiceQuickActions: false } }
let ChatInput: typeof import('./ChatInput.svelte').default
let voice: typeof import('$lib/services/voice')
let calls: { text: string; completion: Completion; settle: (value: boolean) => void }[]
let requests: { path: string; method: string }[]

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
  confirmUserSettings({ voice_settings: voiceSettings as any })
  agentStore.setAgents([AGENT as any])
  agentStore.setCurrentAgentId(AGENT.id)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://synthetic.invalid').pathname
    const method = init?.method ?? 'GET'
    requests.push({ path, method })
    const bodies: Record<string, unknown> = {
      '/api/user/saved-models': { models: [] }, '/api/models': { data: { connections: [] } },
      '/api/mcp/gateways': { gateways: [] }, '/api/agents': { agents: [AGENT] }, '/api/groups': { groups: [] },
      '/api/projects': { projects: [] }, '/api/projects/preferences': { preferences: null },
      '/api/cli-tools': { tools: [] }, '/api/slash-commands': { commands: [] },
      '/api/voice/providers': { providers: [] }, '/api/user/settings': { settings: { voice_settings: voiceSettings } },
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
  resetUserSettings()
  vi.restoreAllMocks()
})
afterAll(() => vi.unstubAllGlobals())

async function openVoice() {
  const mounted = render(ChatInput, { props: { data: { user: { id: AGENT.user_id } }, sessionId: 'synthetic_chat',
    onSend: (text: string, _metadata: unknown, completion: Completion = {}) => new Promise<boolean>(settle => {
      calls.push({ text, completion, settle })
    }) } })
  await fireEvent.click(screen.getByRole('button', { name: 'Start Voice Mode' }))
  await screen.findByRole('button', { name: 'End Voice Mode' })
  return mounted.component
}
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
  it('holds an unrelated end during initially idle preparation, then completes the captured no-stream send', async () => {
    const component = await openVoice()
    finalTranscript('captured first transcript')
    await waitFor(() => expect(calls).toHaveLength(1))
    component.aiResponseReceived() // Another tab's reply ends before this page admits our send.
    await waitFor(expectWaiting)
    finalTranscript('must not supersede the pending transcript')
    expect(calls[0].text).toBe('captured first transcript')
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('captured first transcript')
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
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: '' } })
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
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: '' } })
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
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: '' } })
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
