import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import { jsonResponse } from '$lib/test-utils/userSettingsRoute'
import LocalAISettingsPanel from './LocalAISettingsPanel.svelte'

const LOCAL_AI_USER = 'local_ai_availability_user'
const SAVED_SERVERS = LOCAL_AI_SERVER_DEFINITIONS.map((definition) => ({
  ...definition,
  baseUrl: definition.defaultBaseUrl,
  openaiPath: definition.openaiPath,
  enabled: definition.id === 'llama-cpp' ? true : definition.enabledByDefault,
  imageTransport: definition.defaultImageTransport,
  imageBaseUrl: definition.defaultImageBaseUrl,
  source: 'stored' as const
}))

type AvailabilityAnswer = {
  success: true
  availability: 'reachable' | 'unreachable' | 'access-required'
  baseUrl: string
  openaiPath: string
  message?: string
  models?: { data: Array<{ id: string }> }
}

let availabilityAnswer: (programId: string) => Promise<Response> | Response
let availabilityRequests: string[] = []
let browserProgramRequests: string[] = []

function ensureWebAnimationsStub() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({ cancel: () => {}, finish: () => {}, play: () => {}, pause: () => {}, onfinish: null })
    })
  }
}

function installFetch() {
  availabilityRequests = []
  browserProgramRequests = []
  availabilityAnswer = (programId) => {
    const server = SAVED_SERVERS.find((candidate) => candidate.id === programId)!
    return jsonResponse({
      success: true,
      availability: 'reachable',
      baseUrl: server.baseUrl,
      openaiPath: server.openaiPath,
      models: { data: [] }
    } satisfies AvailabilityAnswer)
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init: RequestInit = {}) => {
      const rawUrl =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request.url
      const url = new URL(rawUrl, 'http://localhost')
      const method = (init.method ?? 'GET').toUpperCase()

      if (url.pathname === '/api/settings/local-ai' && method === 'GET') {
        return jsonResponse({ servers: SAVED_SERVERS })
      }

      if (url.pathname === '/api/settings/local-ai/models' && method === 'GET') {
        const programId = url.searchParams.get('program') ?? ''
        if (url.searchParams.get('mode') === 'availability') {
          availabilityRequests.push(rawUrl)
          return await availabilityAnswer(programId)
        }
        return jsonResponse({
          success: true,
          state: {
            programId,
            connectionKey: 'a'.repeat(64),
            label: programId,
            manageable: false,
            reason: 'This test does not exercise model management.',
            canLoad: false,
            canUnload: false,
            canDownload: false,
            restartsOnSwitch: false,
            models: []
          }
        })
      }

      const directOpenAiModelsTarget = SAVED_SERVERS.some((server) => {
        const serverUrl = new URL(server.baseUrl)
        const openAiPath = server.openaiPath.replace(/\/+$/, '')
        return url.origin === serverUrl.origin && url.pathname === `${openAiPath}/models`
      })
      if (directOpenAiModelsTarget) browserProgramRequests.push(rawUrl)
      return jsonResponse({ models: [], data: [] })
    })
  )
}

const serverHeader = (label: string) => {
  const header = Array.from(document.querySelectorAll('button.batshit-settings-l1-card-header')).find(
    (button) => button.querySelector('.batshit-settings-form-label')?.textContent?.trim() === label
  )
  return header as HTMLElement | undefined
}

const serverCard = (label: string) =>
  serverHeader(label)?.closest('.batshit-settings-l1-card') as HTMLElement | null

async function openServer(label: string) {
  const header = serverHeader(label)
  if (!header) throw new Error(`Could not find the ${label} card header.`)
  await fireEvent.click(header)
}

function baseUrlInput(label: string) {
  const row = within(serverCard(label) as HTMLElement)
    .getByText('Base URL')
    .closest('.batshit-settings-form-row') as HTMLElement
  return row.querySelector('input') as HTMLInputElement
}

const renderPanel = () =>
  render(LocalAISettingsPanel, {
    props: { data: { user: { id: LOCAL_AI_USER }, userSettings: null } }
  })

describe('Local AI authenticated availability in Settings', () => {
  beforeEach(() => {
    ensureWebAnimationsStub()
    installFetch()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses Batshit’s authenticated availability route and a reachable empty list replaces earlier failures', async () => {
    renderPanel()
    await waitFor(() => expect(serverHeader('llama.cpp')).toBeTruthy())
    await openServer('llama.cpp')
    const card = serverCard('llama.cpp') as HTMLElement
    expect(within(card).getByText('Detected Models')).toBeTruthy()
    // The generic manager refreshes availability after its own initial state read.
    // Let that real integration settle, then drive three manual results in order.
    await within(card).findByText('Online')
    const automaticRefreshes = availabilityRequests.length

    let manualStatusStep = 0
    availabilityAnswer = (programId) => {
      const server = SAVED_SERVERS.find((candidate) => candidate.id === programId)!
      const step = manualStatusStep++
      const body: AvailabilityAnswer =
        step === 0
          ? {
              success: true,
              availability: 'access-required',
              baseUrl: server.baseUrl,
              openaiPath: server.openaiPath,
              message: 'The program requires a valid key.'
            }
          : step === 1
            ? {
                success: true,
                availability: 'unreachable',
                baseUrl: server.baseUrl,
                openaiPath: server.openaiPath,
                message: 'Start the program and check its address.'
              }
            : {
                success: true,
                availability: 'reachable',
                baseUrl: server.baseUrl,
                openaiPath: server.openaiPath,
                models: { data: [] }
              }
      return jsonResponse(body)
    }

    const check = within(card).getByRole('button', { name: 'Check Status' })

    await fireEvent.click(check)
    await screen.findByText('Access Required')
    await fireEvent.click(within(card).getByRole('button', { name: 'Check Status' }))
    await screen.findByText('Unreachable')
    await fireEvent.click(within(card).getByRole('button', { name: 'Check Status' }))

    await screen.findByText('Online')
    expect(within(card).queryByText('Access Required')).toBeNull()
    expect(within(card).queryByText('Unreachable')).toBeNull()
    expect(manualStatusStep).toBe(3)
    expect(availabilityRequests.length).toBeGreaterThanOrEqual(automaticRefreshes + 3)
    expect(availabilityRequests.every((request) => request.includes('mode=availability'))).toBe(true)
    expect(browserProgramRequests).toEqual([])
    expect(availabilityRequests.some((request) => request.includes('localhost:8080'))).toBe(false)
  }, 30_000)

  it('does not let a delayed response restore status after the endpoint changes away and back', async () => {
    let release: (response: Response) => void = () => {}
    const oldResponse = new Promise<Response>((resolve) => {
      release = resolve
    })
    let releaseFresh: (response: Response) => void = () => {}
    const freshResponse = new Promise<Response>((resolve) => {
      releaseFresh = resolve
    })
    renderPanel()
    await waitFor(() => expect(serverHeader('llama.cpp')).toBeTruthy())
    await openServer('llama.cpp')
    const card = serverCard('llama.cpp') as HTMLElement
    // Opening the management card causes one real availability refresh. Wait for it
    // before deferring the explicit check whose response this test holds back.
    await within(card).findByText('Online')
    let deferNext = true
    availabilityAnswer = (programId) => {
      if (deferNext) {
        deferNext = false
        return oldResponse
      }
      return freshResponse
    }
    await fireEvent.click(within(card).getByRole('button', { name: 'Check Status' }))
    await screen.findByText('Checking')

    const input = baseUrlInput('llama.cpp')
    const savedUrl = input.value
    const requestsBeforeEdit = availabilityRequests.length
    await fireEvent.input(input, { target: { value: 'http://changed.example:1234' } })
    await fireEvent.input(input, { target: { value: savedUrl } })

    // A legitimate refresh may start after the endpoint edit. Keep it pending so
    // the stale manual response is evaluated on its own, before any newer result.
    await waitFor(() => expect(availabilityRequests.length).toBeGreaterThan(requestsBeforeEdit))
    release(
      jsonResponse({
        success: true,
        availability: 'reachable',
        baseUrl: savedUrl,
        openaiPath: '/v1',
        models: { data: [{ id: 'stale-model' }] }
      } satisfies AvailabilityAnswer)
    )
    await waitFor(() => expect(within(card).queryByText('Checking')).toBeTruthy())
    expect(within(card).queryByText('Online')).toBeNull()
    expect(within(card).queryByText('stale-model')).toBeNull()
    const server = SAVED_SERVERS.find((candidate) => candidate.id === 'llama-cpp')!
    releaseFresh(
      jsonResponse({
        success: true,
        availability: 'unreachable',
        baseUrl: server.baseUrl,
        openaiPath: server.openaiPath,
        message: 'Fresh check after the endpoint edit.'
      } satisfies AvailabilityAnswer)
    )
    await within(card).findByText('Unreachable')
    const requestsBeforeRelease = availabilityRequests.length
    await waitFor(() => expect(within(card).queryByText('Checking')).toBeNull())

    availabilityAnswer = (programId) => {
      const server = SAVED_SERVERS.find((candidate) => candidate.id === programId)!
      return jsonResponse({
        success: true,
        availability: 'reachable',
        baseUrl: server.baseUrl,
        openaiPath: server.openaiPath,
        models: { data: [{ id: 'current-model' }] }
      } satisfies AvailabilityAnswer)
    }
    await fireEvent.click(within(card).getByRole('button', { name: 'Check Status' }))
    await screen.findByText('Online')
    expect(availabilityRequests.length).toBeGreaterThan(requestsBeforeRelease)
  }, 30_000)

  it('shows a save-first hint when the saved endpoint differs from the current draft', async () => {
    availabilityAnswer = (programId) =>
      jsonResponse({
        success: true,
        availability: 'reachable',
        baseUrl: 'http://other-saved-host:1234',
        openaiPath: '/v1',
        models: { data: [] }
      } satisfies AvailabilityAnswer)

    renderPanel()
    await waitFor(() => expect(serverHeader('llama.cpp')).toBeTruthy())
    await openServer('llama.cpp')
    const card = serverCard('llama.cpp') as HTMLElement
    await fireEvent.click(within(card).getByRole('button', { name: 'Check Status' }))

    expect((await within(card).findAllByText('Save the connection before checking its availability.')).length).toBeGreaterThan(0)
    expect(within(serverHeader('llama.cpp') as HTMLElement).queryByText('Online')).toBeNull()
    expect(within(card).queryByText('stale-model')).toBeNull()
  }, 30_000)

  it('marks Enabled green while keeping Disabled neutral', async () => {
    renderPanel()
    await waitFor(() => expect(serverHeader('LM Studio')).toBeTruthy())

    const enabled = within(serverHeader('Ollama') as HTMLElement).getByText('Enabled')
    const disabled = within(serverHeader('LM Studio') as HTMLElement).getByText('Disabled')
    expect(enabled.classList.contains('is-enabled')).toBe(true)
    expect(enabled.classList.contains('batshit-settings-status-badge')).toBe(true)
    expect(disabled.classList.contains('is-enabled')).toBe(false)
  }, 30_000)
})
