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
