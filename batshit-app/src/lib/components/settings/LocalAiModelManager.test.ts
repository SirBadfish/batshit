/**
 * BL-134: a switch on the KoboldCpp, LM Studio, or oMLX model card changes what
 * `/api/models` lists (KoboldCpp's served model and its size, LM Studio's loaded
 * context), so a successful Load, Unload, or Restore Startup Model sends the
 * shared model-connection invalidation that open Models tabs and model pickers
 * refresh on. A refused switch changes nothing and sends nothing.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LocalAiModelManager from './LocalAiModelManager.svelte'
import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'

const originalFetch = globalThis.fetch

const STATE = {
  programId: 'koboldcpp',
  connectionKey: 'a'.repeat(64),
  label: 'KoboldCpp',
  manageable: true,
  canLoad: true,
  canUnload: true,
  canDownload: false,
  restartsOnSwitch: false,
  canRestoreStartup: true,
  models: [
    { id: 'Qwen3.5-9B-Q4_K_M.gguf', label: 'Qwen3.5-9B-Q4_K_M.gguf', loaded: false, format: 'gguf' },
    { id: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', label: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', loaded: true, format: 'gguf' }
  ],
  settingsFiles: []
}

const LLAMA_STATE = {
  ...STATE,
  programId: 'llama-cpp',
  label: 'llama.cpp',
  restartsOnSwitch: false,
  canRestoreStartup: false,
  models: [{ id: 'router-model', label: 'Router model', loaded: false, format: null }]
}
const LLAMA_SLEEPING_STATE = {
  ...LLAMA_STATE,
  models: [{ id: 'router-model', label: 'Router model', loaded: false, sleeping: true, unloaded: false, busy: false }]
}

let switchAnswer: Record<string, unknown> = { success: true, message: 'Switched' }
let posts: any[] = []
let postResponse: Promise<Response> | null = null
let events: Array<{ source?: string }> = []
let queuedStates: Array<{ success: true; state: unknown }> = []
let queuedResponses: Array<Response | Promise<Response>> = []
let stateReads = 0
let defaultState: any = STATE
const onEvent = (event: Event) => events.push((event as CustomEvent).detail ?? {})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function stateResponse(state: unknown) {
  return new Response(JSON.stringify({ success: true, state }), { status: 200 })
}

beforeEach(() => {
  switchAnswer = { success: true, message: 'Switched' }
  posts = []
  postResponse = null
  events = []
  queuedStates = []
  queuedResponses = []
  stateReads = 0
  defaultState = STATE
  window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, onEvent)
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.startsWith('/api/settings/local-ai/models') && (init?.method ?? 'GET') === 'POST') {
      posts.push(JSON.parse(String(init?.body ?? '{}')))
      if (postResponse) return postResponse
      return new Response(JSON.stringify(switchAnswer), { status: 200 })
    }
    if (url.startsWith('/api/settings/local-ai/models')) {
      stateReads += 1
      const queuedResponse = queuedResponses.shift()
      if (queuedResponse) return queuedResponse
      return new Response(JSON.stringify(queuedStates.shift() ?? { success: true, state: defaultState }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, onEvent)
  globalThis.fetch = originalFetch
})

describe('BL-134 the Local AI model card announces a model switch', () => {
  it('sends the model-connection change after a successful Load', async () => {
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Load/ }))

    await waitFor(() => expect(events).toEqual([{ source: 'local-ai' }]))
    expect(posts[0]).toMatchObject({
      program: 'koboldcpp', action: 'load', modelId: 'Qwen3.5-9B-Q4_K_M.gguf',
      expectedConnectionKey: STATE.connectionKey
    })
  })

  it('sends it after Unload and after Restore Startup Model', async () => {
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fireEvent.click(await screen.findByTitle('Unload'))
    await waitFor(() => expect(events).toHaveLength(1))

    await fireEvent.click(await screen.findByRole('button', { name: /Restore Startup Model/ }))
    await waitFor(() => expect(events).toHaveLength(2))
    expect(posts.map((post) => post.action)).toEqual(['unload', 'load'])
    expect(posts[1].modelId).toBe('initial_model')
    expect(posts.every((post) => post.expectedConnectionKey === STATE.connectionKey)).toBe(true)
  })

  it('sends nothing when the program refuses the switch', async () => {
    switchAnswer = { success: false, message: 'KoboldCpp would not switch to that file.' }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Load/ }))

    await waitFor(() => expect(posts).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(events).toEqual([])
  })

  it('keeps model actions unavailable until the connection has been saved', async () => {
    const { container } = render(LocalAiModelManager, {
      props: { programId: 'koboldcpp', connectionReady: false }
    })
    await waitFor(() => expect(container.textContent).toContain('Save the connection before using model controls.'))
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
    expect(posts).toEqual([])
    expect(events).toEqual([])
  })

  it('does not accept an unavailable read as confirmation that a pending unload finished', async () => {
    switchAnswer = { success: true, pending: true, message: 'Unloading' }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    const unloadButton = await screen.findByTitle('Unload')
    queuedStates = [
      { success: true, state: { ...STATE, manageable: false, canLoad: false, canUnload: false, models: [] } },
      { success: true, state: { ...STATE, models: [
        { id: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', label: 'Llama', loaded: false, format: 'gguf' }
      ] } }
    ]
    await fireEvent.click(unloadButton)

    await waitFor(() => expect(events).toEqual([{ source: 'local-ai' }]), { timeout: 5000 })
    expect(stateReads).toBeGreaterThanOrEqual(3) // initial, pending confirmation, and the post-action refresh
    expect(posts[0]).toMatchObject({ action: 'unload', expectedConnectionKey: STATE.connectionKey })
  })

  it('refuses to accept pending residency from a different saved connection', async () => {
    switchAnswer = { success: true, pending: true, message: 'Unloading' }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    const unloadButton = await screen.findByTitle('Unload')
    queuedStates = [{
      success: true,
      state: { ...STATE, connectionKey: 'b'.repeat(64), models: [
        { id: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', label: 'Llama', loaded: false, format: 'gguf' }
      ] }
    }]
    await fireEvent.click(unloadButton)

    await waitFor(() => expect(stateReads).toBe(2))
    expect(posts).toHaveLength(1)
    expect(events).toEqual([])
  })

  it('discards an old endpoint read and refreshes the saved endpoint after readiness returns', async () => {
    const initialA = deferred<Response>()
    const savedB = deferred<Response>()
    queuedResponses = [initialA.promise, savedB.promise]
    const view = render(LocalAiModelManager, {
      props: { programId: 'koboldcpp', connectionReady: true }
    })
    await waitFor(() => expect(stateReads).toBe(1))

    await view.rerender({ programId: 'koboldcpp', connectionReady: false })
    await view.rerender({ programId: 'koboldcpp', connectionReady: true })
    window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, onEvent)
    window.dispatchEvent(new Event(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated))
    expect(stateReads).toBe(1) // the in-flight read must be settled before the queued refresh starts

    const stateA = {
      ...STATE, connectionKey: 'b'.repeat(64),
      models: [{ id: 'A-only-model.gguf', label: 'A-only model', loaded: false, format: 'gguf' }]
    }
    const stateB = {
      ...STATE, connectionKey: 'c'.repeat(64),
      models: [{ id: 'B-only-model.gguf', label: 'B endpoint model', loaded: false, format: 'gguf' }]
    }
    initialA.resolve(stateResponse(stateA))
    await waitFor(() => expect(stateReads).toBe(2))
    expect(screen.queryByText('A-only model')).toBeNull()
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()

    savedB.resolve(stateResponse(stateB))
    await screen.findByText('B endpoint model')
    expect(screen.queryByText('A-only model')).toBeNull()
    const loadB = await screen.findByRole('button', { name: /Load/ })

    defaultState = stateB
    await fireEvent.click(loadB)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toMatchObject({
      action: 'load', modelId: 'B-only-model.gguf', expectedConnectionKey: stateB.connectionKey
    })
  })

  it('keeps an initial read failure visible with Retry and clears it after a successful read', async () => {
    queuedResponses = [
      new Response(JSON.stringify({ success: false, error: 'Saved connection read failed.' }), { status: 500 }),
      stateResponse(STATE)
    ]
    const { container } = render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })

    await waitFor(() => expect(container.textContent).toContain('Saved connection read failed.'))
    const retry = await screen.findByRole('button', { name: /Retry/ })
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
    await fireEvent.click(retry)

    await screen.findByRole('button', { name: /Load/ })
    expect(container.textContent).not.toContain('Saved connection read failed.')
    expect(stateReads).toBe(2)
  })

  it('waits through llama.cpp loading status before announcing a confirmed load', async () => {
    switchAnswer = { success: true, pending: true, message: 'Loading model' }
    defaultState = LLAMA_STATE
    queuedStates = [
      { success: true, state: LLAMA_STATE },
      { success: true, state: { ...LLAMA_STATE, models: [
        { id: 'router-model', label: 'Router model', loaded: false, busy: true }
      ] } },
      { success: true, state: { ...LLAMA_STATE, models: [
        { id: 'router-model', label: 'Router model', loaded: true }
      ] } },
      { success: true, state: { ...LLAMA_STATE, models: [
        { id: 'router-model', label: 'Router model', loaded: true }
      ] } }
    ]
    render(LocalAiModelManager, { props: { programId: 'llama-cpp' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Load/ }))

    await waitFor(() => expect(events).toEqual([{ source: 'local-ai' }]), { timeout: 6000 })
    expect(posts[0]).toMatchObject({ program: 'llama-cpp', action: 'load', modelId: 'router-model' })
    expect(stateReads).toBeGreaterThanOrEqual(3)
    expect(await screen.findByText('Loaded')).toBeTruthy()
  })

  it('keeps a failed llama.cpp startup visible and does not announce a successful switch', async () => {
    switchAnswer = { success: true, pending: true, message: 'Loading model' }
    queuedStates = [
      { success: true, state: LLAMA_STATE },
      { success: true, state: { ...LLAMA_STATE, models: [
        { id: 'router-model', label: 'Router model', loaded: false, unloaded: true, failure: 'llama.cpp exited (exit 42).' }
      ] } }
    ]
    const { container } = render(LocalAiModelManager, { props: { programId: 'llama-cpp' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Load/ }))

    await waitFor(() => expect(container.textContent).toContain('llama.cpp exited (exit 42).'))
    expect(screen.getByRole('alert').textContent).toContain('exit 42')
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(events).toEqual([])
    expect(posts[0]).toMatchObject({ program: 'llama-cpp', action: 'load', modelId: 'router-model' })
  })

  it('shows sleeping llama.cpp residency, hides Load, and waits past sleep during Unload', async () => {
    switchAnswer = { success: true, pending: true, message: 'Unloading model' }
    const unloaded = {
      ...LLAMA_STATE,
      models: [{ id: 'router-model', label: 'Router model', loaded: false, sleeping: false, unloaded: true, busy: false }]
    }
    defaultState = unloaded
    const afterSleep = deferred<Response>()
    const unknownStatus = {
      ...LLAMA_STATE,
      models: [{ id: 'router-model', label: 'Router model', loaded: false, sleeping: false, busy: false }]
    }
    queuedResponses = [
      stateResponse(LLAMA_SLEEPING_STATE),
      stateResponse(LLAMA_SLEEPING_STATE),
      stateResponse(unknownStatus),
      afterSleep.promise
    ]
    render(LocalAiModelManager, { props: { programId: 'llama-cpp' } })

    expect(await screen.findByText('Sleeping · chat wakes it')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Load/ })).toBeNull()
    const unload = await screen.findByTitle('Unload')
    await fireEvent.click(unload)
    await waitFor(() => expect(stateReads).toBe(2))
    expect(screen.getByText('Sleeping · chat wakes it')).toBeTruthy()
    expect(events).toEqual([]) // sleeping still owns a live child; unload is not confirmed yet

    await waitFor(() => expect(stateReads).toBe(3), { timeout: 5000 })
    expect(events).toEqual([]) // an unknown status also cannot confirm that the child exited

    afterSleep.resolve(stateResponse(unloaded))
    await waitFor(() => expect(events).toEqual([{ source: 'local-ai' }]), { timeout: 5000 })
    expect(posts[0]).toMatchObject({
      program: 'llama-cpp', action: 'unload', modelId: 'router-model', expectedConnectionKey: LLAMA_STATE.connectionKey
    })
    await waitFor(() => expect(screen.queryByText('Sleeping · chat wakes it')).toBeNull())
  })

  it('does not count llama.cpp sleeping status as a successful pending Load', async () => {
    switchAnswer = { success: true, pending: true, message: 'Loading model' }
    queuedResponses = [stateResponse(LLAMA_STATE), stateResponse(LLAMA_SLEEPING_STATE)]
    const { container } = render(LocalAiModelManager, { props: { programId: 'llama-cpp' } })
    await fireEvent.click(await screen.findByRole('button', { name: /Load/ }))

    await waitFor(() => expect(container.textContent).toContain('The model is sleeping with its memory released.'))
    expect(screen.getByRole('button', { name: /Retry/ })).toBeTruthy()
    expect(events).toEqual([])
    expect(posts[0]).toMatchObject({ action: 'load', modelId: 'router-model' })
  })
})


const PROFILE_STATE = { ...STATE, canApplyProfile: true, requiresVerifiedProfile: true, hasModelFiles: false,
  running: { model: 'Qwen3.5-9B-Q4_K_M', contextLength: 16384, chatTemplates: true, guidance: false },
  settingsFiles: ['large.kcpps'], models: [{ id: 'large.kcpps', label: 'large', loaded: false, format: 'config' }] }
async function chooseProfile() {
  const selector = await screen.findByLabelText('Saved KoboldCpp Settings')
  await fireEvent.keyDown(selector, { key: 'ArrowDown' })
  await fireEvent.pointerUp(await screen.findByRole('option', { name: 'large.kcpps' }), { pointerType: 'mouse' })
}
async function fillProfile() {
  await chooseProfile()
  await fireEvent.input(screen.getByLabelText('Expected Real Context (tokens)'), { target: { value: '65536' } })
  await fireEvent.click(screen.getByRole('checkbox', { name: 'No chats in any app using this KoboldCpp server are generating or waiting for a response.' }))
}
describe('native saved-profile controls', () => {
  it('keeps protected profiles out of legacy Load when current context is unavailable', async () => {
    defaultState = { ...PROFILE_STATE, canApplyProfile: false, running: { ...PROFILE_STATE.running, contextLength: null } }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await screen.findByText('large')
    expect(screen.queryByRole('button', { name: /^Load$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Apply saved settings and restart model' })).toBeNull()
    expect(posts).toEqual([])
  })
  it('requires explicit context and client quiescence, and sends model/context as verification only', async () => {
    defaultState = PROFILE_STATE
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    const apply = await screen.findByRole('button', { name: 'Apply saved settings and restart model' })
    expect(apply.hasAttribute('disabled')).toBe(true)
    await chooseProfile()
    expect((screen.getByLabelText('Expected Real Context (tokens)') as HTMLInputElement).value).toBe('')
    expect(apply.hasAttribute('disabled')).toBe(true)
    await fireEvent.input(screen.getByLabelText('Expected Real Context (tokens)'), { target: { value: '65536' } })
    expect(apply.hasAttribute('disabled')).toBe(true)
    await fireEvent.click(screen.getByRole('checkbox', { name: 'No chats in any app using this KoboldCpp server are generating or waiting for a response.' }))
    await fireEvent.click(apply)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ program: 'koboldcpp', action: 'apply-profile', modelId: 'large.kcpps', expectation: {
      expectedConnectionKey: STATE.connectionKey, observedModel: PROFILE_STATE.running.model, observedContext: 16384,
      expectedModel: PROFILE_STATE.running.model, expectedContext: 65536, quiescenceConfirmed: true
    } })
    await waitFor(() => expect(events).toHaveLength(1))
    expect(screen.queryByRole('button', { name: /^Load$/ })).toBeNull()
  })
  it('keeps uncertain native effects visible after refreshing, with no repeat mutation', async () => {
    defaultState = PROFILE_STATE
    switchAnswer = { success: false, outcomeUnknown: true, message: 'Native result uncertain. Check before another action.' }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fillProfile()
    await fireEvent.click(screen.getByRole('button', { name: 'Apply saved settings and restart model' }))
    await waitFor(() => expect(stateReads).toBeGreaterThan(1))
    expect(screen.getByRole('status').textContent).toContain('Native result uncertain.')
    expect(posts).toHaveLength(1)
    expect((await screen.findByRole('button', { name: 'Apply saved settings and restart model' })).hasAttribute('disabled')).toBe(true)
  })
  it('discards a late success for an edited connection and keeps its possible native effects visible', async () => {
    defaultState = PROFILE_STATE
    const answer = deferred<Response>()
    postResponse = answer.promise
    const view = render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fillProfile()
    await fireEvent.click(screen.getByRole('button', { name: 'Apply saved settings and restart model' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    await view.rerender({ programId: 'koboldcpp', connectionReady: false })
    answer.resolve(new Response(JSON.stringify({ success: true, restarted: true, message: 'Obsolete success' })))
    await view.rerender({ programId: 'koboldcpp', connectionReady: true })
    await waitFor(() => expect(stateReads).toBeGreaterThan(1))
    expect(screen.getByRole('status').textContent).toContain('previous connection changed')
    expect(screen.getByRole('status').textContent).not.toContain('Obsolete success')
    await waitFor(() => expect(events).toHaveLength(1))
    expect(posts).toHaveLength(1)
  })
  it('clears the draft expectations when the connection is edited', async () => {
    defaultState = PROFILE_STATE
    const view = render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fillProfile()
    await view.rerender({ programId: 'koboldcpp', connectionReady: false })
    await view.rerender({ programId: 'koboldcpp', connectionReady: true })
    await screen.findByLabelText('Expected Real Context (tokens)')
    expect((screen.getByLabelText('Expected Real Context (tokens)') as HTMLInputElement).value).toBe('')
    expect(screen.getByRole('button', { name: 'Apply saved settings and restart model' }).hasAttribute('disabled')).toBe(true)
    expect(posts).toEqual([])
  })
})

const REG_ID = '11111111-1111-4111-8111-111111111111'
const MODEL_ID = '22222222-2222-4222-8222-222222222222'
const REGISTERED_STATE = { ...PROFILE_STATE, managedContextActive: true,
  registeredSetup: { registrationId: REG_ID, models: [{ id: MODEL_ID, nativeRef: 'Qwen.gguf', servedName: 'Qwen', baseConfig: 'batshit-managed/base.kcpps' }] },
  models: [{ id: 'Qwen.gguf', label: 'Qwen.gguf', loaded: true, format: 'gguf' }], settingsFiles: ['batshit-managed/base.kcpps'] }
describe('BL-1213 actual model/context form', () => {
  it('offers scoped current-server unload for a vanity name without a false loaded-file claim', async () => {
    defaultState = { ...REGISTERED_STATE, canUnloadCurrent: true, running: { ...PROFILE_STATE.running, model: 'debug-custom' },
      registeredSetup: { ...REGISTERED_STATE.registeredSetup, models: [{ ...REGISTERED_STATE.registeredSetup.models[0], servedName: 'debug-custom' }] },
      models: [{ id: 'Qwen.gguf', label: 'Qwen.gguf', loaded: false, format: 'gguf' }] }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    const unload = await screen.findByRole('button', { name: 'Unload Current Model' })
    expect(screen.queryByText('Loaded')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Unload' })).toBeNull()
    await fireEvent.click(unload)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ program: 'koboldcpp', action: 'unload', modelId: 'unload_model', expectedConnectionKey: STATE.connectionKey })
  })
  it('hides direct loads and default-settings selection for an active registered setup', async () => {
    defaultState = { ...REGISTERED_STATE, models: [...REGISTERED_STATE.models, { id: 'Other.gguf', label: 'Other.gguf', loaded: false, format: 'gguf' }] }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await screen.findByLabelText('Context Tokens')
    expect(screen.queryByText('Settings for Model Files')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Load$/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Unload' })).toBeTruthy()
  })
  it('selects a genuine installed model and posts 60000 as configuration intent', async () => {
    defaultState = REGISTERED_STATE
    const { container } = render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    const selector = await screen.findByLabelText('Model')
    expect(screen.queryByLabelText('Expected Real Context (tokens)')).toBeNull()
    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    await fireEvent.pointerUp(await screen.findByRole('option', { name: 'Qwen.gguf' }), { pointerType: 'mouse' })
    await fireEvent.input(screen.getByLabelText('Context Tokens'), { target: { value: '60000' } })
    const apply = screen.getByRole('button', { name: 'Apply and Restart' })
    expect(apply.hasAttribute('disabled')).toBe(true)
    expect(container.textContent).toContain('Leave KoboldCpp and its Terminal window running.')
    await fireEvent.click(screen.getByRole('checkbox', { name: 'No chats in any app using this KoboldCpp server are generating or waiting for a response.' }))
    await fireEvent.click(apply)
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual({ program: 'koboldcpp', action: 'apply-context', intent: {
      expectedConnectionKey: STATE.connectionKey, observedModel: PROFILE_STATE.running.model,
      observedContext: 16384, quiescenceConfirmed: true, registrationId: REG_ID, modelId: MODEL_ID, contextTokens: 60000
    } })
    await waitFor(() => expect(events).toEqual([{ source: 'local-ai' }]))
  })
  it('does not invent a model from an enrolled base whose GGUF is no longer listed', async () => {
    defaultState = { ...REGISTERED_STATE, models: [] }
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    const selector = await screen.findByLabelText('Model')
    await fireEvent.keyDown(selector, { key: 'ArrowDown' })
    expect(screen.queryByRole('option', { name: 'Qwen.gguf' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Apply and Restart' }).hasAttribute('disabled')).toBe(true)
  })
  it('clears model/context drafts when the saved connection is invalidated', async () => {
    defaultState = REGISTERED_STATE
    render(LocalAiModelManager, { props: { programId: 'koboldcpp' } })
    await fireEvent.input(await screen.findByLabelText('Context Tokens'), { target: { value: '60000' } })
    window.dispatchEvent(new CustomEvent(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated))
    await waitFor(() => expect((screen.getByLabelText('Context Tokens') as HTMLInputElement).value).toBe(''))
    expect(posts).toEqual([])
  })
})
