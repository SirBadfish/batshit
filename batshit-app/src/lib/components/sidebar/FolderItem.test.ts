import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import FolderItem from './FolderItem.svelte'

vi.mock('svelte-dnd-action', () => ({
  dndzone: () => ({
    destroy() {}
  }),
  TRIGGERS: {}
}))

function ensureAnimateStub() {
  if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      value: () => ({
        cancel: () => {},
        finish: () => {},
        play: () => {},
        pause: () => {},
        onfinish: null
      })
    })
  }
}

describe('FolderItem accessibility labels', () => {
  it('labels the folder new-chat trigger with the folder name', () => {
    ensureAnimateStub()
    render(FolderItem, {
      props: {
        folder: {
          id: 'folder-default',
          user_id: 'josh',
          name: 'My Chats',
          is_default: true,
          is_expanded: true,
          sort_order: 0,
          created_at: '2026-03-08T08:00:00.000Z',
          updated_at: '2026-03-08T08:00:00.000Z'
        },
        sessions: [],
        onSessionSelect: vi.fn(),
        onCreateSession: vi.fn()
      }
    })

    expect(
      screen.getByRole('button', { name: 'Create new chat in My Chats' })
    ).toBeInTheDocument()
  })

  it('excludes Infinite Sessions from the folder list (SA-104 P5 — they render in the pinned section, never in a dndzone)', () => {
    ensureAnimateStub()
    render(FolderItem, {
      props: {
        folder: {
          id: 'folder-default',
          user_id: 'josh',
          name: 'My Chats',
          is_default: true,
          is_expanded: true,
          sort_order: 0,
          created_at: '2026-03-08T08:00:00.000Z',
          updated_at: '2026-03-08T08:00:00.000Z'
        },
        sessions: [
          {
            id: 'sess-regular',
            user_id: 'josh',
            folder_id: 'folder-default',
            created_at: '2026-08-25T08:00:00.000Z',
            last_modified_at: '2026-08-25T08:00:00.000Z',
            metadata: {}
          },
          {
            id: 'sess-fixed',
            user_id: 'josh',
            folder_id: 'folder-default',
            created_at: '2026-08-25T09:00:00.000Z',
            last_modified_at: '2026-08-25T09:00:00.000Z',
            locked: true,
            metadata: {
              fixedSession: { version: 1, enabled: true, created_at: '2026-08-25T09:00:00.000Z' }
            }
          }
        ] as never,
        sessionService: null,
        onSessionSelect: vi.fn(),
        onCreateSession: vi.fn()
      }
    })

    expect(screen.getByTestId('session-row-sess-regular')).toBeInTheDocument()
    expect(screen.queryByTestId('session-row-sess-fixed')).not.toBeInTheDocument()
  })

  it('labels the default folder settings trigger with the folder name', () => {
    ensureAnimateStub()
    render(FolderItem, {
      props: {
        folder: {
          id: 'folder-default',
          user_id: 'josh',
          name: 'My Chats',
          is_default: true,
          is_expanded: true,
          sort_order: 0,
          created_at: '2026-03-08T08:00:00.000Z',
          updated_at: '2026-03-08T08:00:00.000Z'
        },
        sessions: [],
        onSessionSelect: vi.fn(),
        onCreateSession: vi.fn()
      }
    })

    expect(
      screen.getByRole('button', { name: 'My Chats default chat folder settings' })
    ).toBeInTheDocument()
  })
})
