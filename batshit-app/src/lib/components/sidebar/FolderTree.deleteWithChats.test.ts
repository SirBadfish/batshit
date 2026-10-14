import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-388: "Delete Folder + Sessions" deletes every chat in the folder, archived ones included,
 * but its dialog counted only the page's active chats. A folder holding only archived chats
 * said "0 chats" and then deleted them all. The dialog now counts and names what the server
 * says the delete sweeps, and offers no delete when that list cannot be read.
 */

const confirmDialogMock = vi.hoisted(() => vi.fn(async () => false))
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))

vi.mock('$lib/stores/confirmDialog', () => ({ confirmDialog: confirmDialogMock }))
vi.mock('svelte-sonner', () => ({ toast: toastMock }))
vi.mock('./FolderItem.svelte', async () => ({
  default: (await import('./FolderItemStub.test.svelte')).default
}))

import FolderTree from './FolderTree.svelte'

const folder = {
  id: 'folder-probe',
  user_id: 'josh',
  name: 'Probe',
  is_default: false,
  is_expanded: true,
  sort_order: 1,
  created_at: '2026-09-28T08:00:00.000Z'
}

// What the page holds: the sidebar's sessions, where both chats of the folder are archived.
const pageSessions = [
  {
    id: 'chat-a',
    user_id: 'josh',
    name: 'Old plan',
    folder_id: folder.id,
    archived: true,
    created_at: '2026-09-01T08:00:00.000Z',
    last_modified_at: '2026-09-01T08:00:00.000Z'
  },
  {
    id: 'chat-b',
    user_id: 'josh',
    name: 'Older plan',
    folder_id: folder.id,
    archived: true,
    created_at: '2026-09-02T08:00:00.000Z',
    last_modified_at: '2026-09-02T08:00:00.000Z'
  }
]

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function mockServer(
  folderChats: () => Response,
  deleteAnswer: () => Response = () => jsonResponse({ success: true, deleted_sessions: 2 })
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/folders') return jsonResponse([folder])
    if (url === `/api/folders/${folder.id}/sessions`) return folderChats()
    if (url === `/api/folders/${folder.id}?deleteSessions=true` && init?.method === 'DELETE') {
      return deleteAnswer()
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function clickDeleteWithChats(sessionService?: unknown) {
  render(FolderTree, {
    props: {
      sessions: pageSessions as any,
      sessionService,
      onSessionSelect: vi.fn(),
      onCreateSession: vi.fn()
    }
  })
  await fireEvent.click(await screen.findByRole('button', { name: 'Delete Probe with its chats' }))
}

describe('FolderTree: Delete Folder + Sessions counts the chats the delete sweeps (BL-388)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
  })

  it('counts and names archived chats a folder holds, from the server list', async () => {
    mockServer(() =>
      jsonResponse({
        folder: { id: folder.id, name: folder.name, is_default: false },
        chats: [
          { id: 'chat-a', name: 'Old plan', archived: true, locked: false },
          { id: 'chat-b', name: 'Older plan', archived: true, locked: false }
        ]
      })
    )

    await clickDeleteWithChats()

    await waitFor(() => expect(confirmDialogMock).toHaveBeenCalledTimes(1))
    const options = confirmDialogMock.mock.calls[0]![0] as any
    expect(options.title).toBe('Delete "Probe" and 2 chats?')
    const description = ([] as string[]).concat(options.description).join('\n')
    expect(description).toContain('archived chats included')
    expect(description).toContain('2 of them are archived: "Old plan", "Older plan".')
    expect(description).not.toContain('no chats')
    expect(description).not.toContain('ocked')
  })

  it('sends the ids of the chats it showed with the delete', async () => {
    confirmDialogMock.mockResolvedValueOnce(true)
    const fetchMock = mockServer(() =>
      jsonResponse({
        folder: { id: folder.id, name: folder.name, is_default: false },
        chats: [
          { id: 'chat-a', name: 'Old plan', archived: true, locked: false },
          { id: 'chat-b', name: 'Older plan', archived: true, locked: false }
        ]
      })
    )

    await clickDeleteWithChats()

    await waitFor(() => expect(toastMock.success).toHaveBeenCalledTimes(1))
    const deleteCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(deleteCall).toBeDefined()
    expect(JSON.parse(String(deleteCall![1]!.body))).toEqual({
      expectedChatIds: ['chat-a', 'chat-b']
    })
  })

  it('shows the server’s words and reloads folders and chats after a partial delete', async () => {
    confirmDialogMock.mockResolvedValueOnce(true)
    const words =
      'Deleted 1 of 2 chats. "Older plan" is still stopping, so it and the folder remain. Try again.'
    const fetchMock = mockServer(
      () =>
        jsonResponse({
          folder: { id: folder.id, name: folder.name, is_default: false },
          chats: [
            { id: 'chat-a', name: 'Old plan', archived: true, locked: false },
            { id: 'chat-b', name: 'Older plan', archived: true, locked: false }
          ]
        }),
      () => jsonResponse({ error: words, code: 'session_turn_still_stopping', deleted_sessions: 1 }, 409)
    )
    const sessionService = { loadSessions: vi.fn(async () => undefined) }

    await clickDeleteWithChats(sessionService)

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(words))
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/folders')).toHaveLength(2)
    )
    expect(sessionService.loadSessions).toHaveBeenCalledTimes(1)
  })

  it('names the locked chats and offers no delete when one is locked', async () => {
    // Even the dialog's own button (answered "yes" here) deletes nothing.
    confirmDialogMock.mockResolvedValueOnce(true)
    const fetchMock = mockServer(() =>
      jsonResponse({
        folder: { id: folder.id, name: folder.name, is_default: false },
        chats: [
          { id: 'chat-a', name: 'Old plan', archived: true, locked: true },
          { id: 'chat-b', name: 'Older plan', archived: true, locked: false }
        ]
      })
    )

    await clickDeleteWithChats()

    await waitFor(() => expect(confirmDialogMock).toHaveBeenCalledTimes(1))
    const options = confirmDialogMock.mock.calls[0]![0] as any
    expect(options.title).toBe('"Probe" has a locked chat')
    expect(([] as string[]).concat(options.description)).toEqual([
      'Unlock "Old plan" to delete this folder.'
    ])
    expect(options.confirmLabel).not.toContain('Delete')
    expect(options.tone).not.toBe('destructive')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
  })

  it('offers no delete and says why when the list of chats cannot be read', async () => {
    mockServer(() => jsonResponse({ error: 'Failed to read the chats in this folder' }, 500))

    await clickDeleteWithChats()

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1))
    expect(String(toastMock.error.mock.calls[0]![0])).toContain('nothing was deleted')
    expect(String(toastMock.error.mock.calls[0]![0])).toContain(
      'Failed to read the chats in this folder'
    )
    expect(confirmDialogMock).not.toHaveBeenCalled()
  })
})
