/**
 * Which chats "Delete Folder + Sessions" deletes (BL-388, 2026-09-28). ONE rule, used by both
 * the delete dialog's read (`GET /api/folders/[id]/sessions`) and the delete itself
 * (`redis.deleteFolder` with `deleteSessions: true`), so the chats the dialog names are the
 * chats that go.
 *
 * The rule: every member of `folder:{userId}:{folderId}:sessions` whose record exists and is not
 * another user's, archived chats included. Archiving only sets `archived` on the record and
 * leaves the chat in that set; the dialog used to count the page's ACTIVE chats, so a folder
 * holding only archived chats said "0 chats" and then deleted them all.
 *
 * The delete also takes the ids the dialog showed and deletes nothing when this selection no
 * longer matches them (`sameFolderChatIds`), so a chat that arrived after the dialog opened is
 * never deleted unseen.
 *
 * This module is a leaf on purpose: `redis.ts` imports it, so it must not import the facade.
 * It works on the raw client a `redis.execute` callback receives, and a failed read throws.
 */

/** The two raw-client commands the selection needs (the node-redis client has both). */
export interface FolderChatSelectionClient {
  json: { get(key: string): Promise<unknown> }
  sMembers(key: string): Promise<string[]>
}

export interface FolderChatForDelete {
  id: string
  name: string
  archived: boolean
  locked: boolean
}

export interface FolderChatSelection {
  folder: { id: string; name: string; is_default: boolean }
  chats: FolderChatForDelete[]
}

export const FOLDER_CHANGED_CODE = 'folder_changed'
export const FOLDER_CHANGED_MESSAGE = 'This folder changed since you opened the dialog. Look again.'

/** `null` when the user has no folder with this id (folder keys are per user). */
export async function selectFolderChats(
  client: FolderChatSelectionClient,
  userId: string,
  folderId: string
): Promise<FolderChatSelection | null> {
  const folder = (await client.json.get(`folder:${userId}:${folderId}`)) as Record<
    string,
    unknown
  > | null
  if (!folder) return null

  const sessionIds = await client.sMembers(`folder:${userId}:${folderId}:sessions`)
  const chats: FolderChatForDelete[] = []
  for (const sessionId of sessionIds) {
    const session = (await client.json.get(`session:${sessionId}`)) as Record<
      string,
      unknown
    > | null
    // A missing record is skipped, and so is another user's chat.
    if (!session) continue
    if (session.user_id && session.user_id !== userId) continue
    chats.push({
      id: sessionId,
      name: typeof session.name === 'string' && session.name.trim() ? session.name : sessionId,
      archived: session.archived === true,
      locked: session.locked === true
    })
  }
  chats.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

  return {
    folder: {
      id: typeof folder.id === 'string' ? folder.id : folderId,
      name: typeof folder.name === 'string' ? folder.name : folderId,
      is_default: folder.is_default === true
    },
    chats
  }
}

/** The same chats, compared by id (order and repeats do not matter). */
export function sameFolderChatIds(
  chats: ReadonlyArray<{ id: string }>,
  expectedIds: ReadonlyArray<string>
): boolean {
  const selected = new Set(chats.map((chat) => chat.id))
  const expected = new Set(expectedIds)
  if (selected.size !== expected.size) return false
  for (const id of selected) if (!expected.has(id)) return false
  return true
}
