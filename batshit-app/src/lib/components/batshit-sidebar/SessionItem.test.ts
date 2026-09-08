import { render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it } from 'vitest'

import * as chatRunRegistry from '$lib/stores/chatRunRegistry.svelte'
import SessionItem from './SessionItem.svelte'

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
