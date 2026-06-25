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
})
