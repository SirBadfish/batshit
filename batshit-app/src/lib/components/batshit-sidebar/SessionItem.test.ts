import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SessionService } from '$lib/services/sessions'
import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
import * as sessionStore from '$lib/stores/session.svelte'
import SessionItem from './SessionItem.svelte'

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  loading: vi.fn(() => 'loading-toast'),
  dismiss: vi.fn()
}))
vi.mock('svelte-sonner', () => ({ toast }))

describe('SessionItem accessibility labels', () => {
  afterEach(() => {
    chatRunRegistry.clearRunRegistryForTest()
  })

  it('labels the session settings trigger with the session name', () => {
    render(SessionItem, {
      props: {
        session: {
          id: 'session-123',
          name: 'Mar 8, 4:25 AM',
          archived: false,
          locked: false,
          metadata: {}
        },
        isSelected: false,
        sessionService: null
      }
    })

    expect(
      screen.getByRole('button', { name: 'Mar 8, 4:25 AM chat session settings' })
    ).toBeInTheDocument()
  })

  it('shows a run status when the session is active', () => {
    chatRunRegistry.startRun({
      sessionId: 'session-123',
      transport: 'api',
      activeMessageId: 'message-123'
    })
    chatRunRegistry.markStreaming('session-123', 'message-123')

    render(SessionItem, {
      props: {
        session: {
          id: 'session-123',
          name: 'Background Chat',
          archived: false,
          locked: false,
          metadata: {}
        },
        isSelected: false,
        sessionService: null
      }
    })

    const status = screen.getByTestId('session-run-status-session-123')
    expect(status).toHaveAccessibleName('Background Chat is running')
    expect(status).toHaveAttribute('title', 'Running')
    expect(status).not.toHaveTextContent('Running')
  })

  // SA-113 P1 (DL-113-08): the origin pill. An ordinary chat renders exactly as before.
  it('shows no origin pill for a chat the user started', () => {
    render(SessionItem, {
      props: {
        session: {
          id: 'session-plain',
          name: 'Mar 8, 4:25 AM',
          archived: false,
          locked: false,
          metadata: {}
        },
        isSelected: false,
        sessionService: null
      }
    })

    expect(screen.queryByTestId('session-origin-dm-session-plain')).toBeNull()
    expect(screen.queryByTestId('session-origin-webhook-session-plain')).toBeNull()
  })

  it('shows a DM origin pill naming the sender', () => {
    render(SessionItem, {
      props: {
        session: {
          id: 'session-woken',
          name: 'DM from Cooper: Verify the package',
          archived: false,
          locked: false,
          metadata: {
            origin: {
              version: 1,
              kind: 'dm',
              label: 'Cooper',
              agentId: 'agent-cooper',
              at: '2026-09-07T12:00:00.000Z',
              chainDepth: 1
            }
          }
        },
        isSelected: false,
        sessionService: null
      }
    })

    const pill = screen.getByTestId('session-origin-dm-session-woken')
    expect(pill).toBeInTheDocument()
    expect(pill.getAttribute('title')).toBe('Started by a DM from Cooper')
  })

  it('shows a webhook origin pill naming the hook', () => {
    render(SessionItem, {
      props: {
        session: {
          id: 'session-hook',
          name: 'Webhook: Nightly build',
          archived: false,
          locked: false,
          metadata: {
            origin: {
              version: 1,
              kind: 'webhook',
              label: 'Nightly build',
              hookId: 'hook_1',
              at: '2026-09-07T12:00:00.000Z',
              chainDepth: 0
            }
          }
        },
        isSelected: false,
        sessionService: null
      }
    })

    const pill = screen.getByTestId('session-origin-webhook-session-hook')
    expect(pill.getAttribute('title')).toBe('Started by webhook "Nightly build"')
  })
})

/**
 * Bug sweep #3 (2026-09-18): the delete toast printed the server's raw JSON
 * (`Failed to delete session: API error: {"error":…,"code":…}`), for example when a reply would
 * not stop within 30 s. Driven through the real menu, dialog, `SessionService`, and `apiCall`;
 * only the network answer is made up.
 */
describe('SessionItem delete refusals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    toast.success.mockClear()
    toast.error.mockClear()
    toast.loading.mockClear()
    toast.dismiss.mockClear()
  })

  async function deleteWhenTheServerAnswers(deleteAnswer: { status: number; body: unknown }) {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'DELETE' && String(input).endsWith('/sessions/session-refused')) {
          return new Response(JSON.stringify(deleteAnswer.body), { status: deleteAnswer.status })
        }
        // Opening the menu asks whether the chat has messages.
        return new Response('[]', { status: 200 })
      })
    )

    render(SessionItem, {
      props: {
        session: {
          id: 'session-refused',
          name: 'Refused Chat',
          archived: false,
          locked: false,
          metadata: {}
        },
        isSelected: false,
        sessionService: new SessionService()
      }
    })

    const trigger = screen.getByRole('button', { name: 'Refused Chat chat session settings' })
    await fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    await fireEvent.click(await screen.findByRole('menuitem', { name: /Delete Session/ }))
    const dialog = await screen.findByRole('alertdialog')
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Session' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    return String(toast.error.mock.calls[0][0])
  }

  it('shows the server’s own sentence, never its JSON', async () => {
    const sentence =
      'This chat’s reply is still stopping, so nothing was deleted. Try again in a moment.'

    const shown = await deleteWhenTheServerAnswers({
      status: 409,
      body: { error: sentence, code: 'session_turn_still_stopping' }
    })

    expect(shown).toBe(`Failed to delete session: ${sentence}`)
  })

  it('does not say "Failed to delete session" twice when that is the server’s sentence', async () => {
    const shown = await deleteWhenTheServerAnswers({
      status: 500,
      body: { error: 'Failed to delete session' }
    })

    expect(shown).toBe('Failed to delete session')
  })
})

/**
 * BL-605: renaming a chat to an id with a glob character (`*`, `?`, `[`, `]`, `\`) is refused by
 * the create route (BL-541), but the rename toast showed a vague generic message instead of the
 * route's own reason. Driven through the real menu, the ID field, `SessionService`, and
 * `apiCall`; only the network answers are made up.
 */
describe('SessionItem rename refusals', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    sessionStore.setSessions([])
    toast.success.mockClear()
    toast.error.mockClear()
    toast.loading.mockClear()
    toast.dismiss.mockClear()
  })

  async function renameWhenTheServerAnswers(createAnswer: { status: number; body: unknown }) {
    // SessionService.updateSessionId looks the session up in the shared store, not from props.
    sessionStore.setSessions([
      {
        id: 'session-rename-me',
        name: 'Rename Me',
        archived: false,
        locked: false,
        metadata: {},
        user_id: 'test-user'
      } as unknown as sessionStore.ChatSession
    ])

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = decodeURIComponent(String(input))
        if (init?.method === 'POST' && url.endsWith('/sessions')) {
          return new Response(JSON.stringify(createAnswer.body), { status: createAnswer.status })
        }
        if (url.includes('/sessions/session-rename-me*')) {
          // The new id does not already exist.
          return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        }
        // Messages checks (menu open, and updateSessionId's own check): no messages yet.
        return new Response('[]', { status: 200 })
      })
    )

    render(SessionItem, {
      props: {
        session: {
          id: 'session-rename-me',
          name: 'Rename Me',
          archived: false,
          locked: false,
          metadata: {}
        },
        isSelected: false,
        sessionService: new SessionService()
      }
    })

    const trigger = screen.getByRole('button', { name: 'Rename Me chat session settings' })
    await fireEvent.pointerDown(trigger, { button: 0, pointerType: 'mouse' })
    await waitFor(() => screen.getByPlaceholderText('Edit Session ID'))

    const idInput = screen.getByPlaceholderText('Edit Session ID')
    await fireEvent.input(idInput, { target: { value: 'session-rename-me*' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save session ID for Rename Me' }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1))
    return String(toast.error.mock.calls[0][0])
  }

  it('shows the create route’s own refusal reason, not a vague generic message', async () => {
    const sentence = 'Session ID must be a non-empty string without ":", or the characters * ? [ ] \\.'

    const shown = await renameWhenTheServerAnswers({
      status: 400,
      body: { error: sentence }
    })

    expect(shown).toBe(sentence)
  })
})
