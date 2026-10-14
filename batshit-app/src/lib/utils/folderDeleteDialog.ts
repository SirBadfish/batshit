/**
 * The words of the "Delete Folder + Sessions" dialog (BL-388, 2026-09-28).
 *
 * The chats come from the server's list of what the delete sweeps (`GET /api/folders/[id]/sessions`),
 * archived chats included, so the count is the number that goes. Archived chats are named,
 * because the sidebar does not show them in the folder and the user may not remember them.
 * A folder with a locked chat gets no delete at all: the dialog names the locked chats instead
 * (`describeFolderDeleteLocked`), since the server refuses the delete while one is locked.
 */
export interface FolderDeleteDialogChat {
  name: string
  archived: boolean
}

/** How many chats the dialog names before "and N more". */
export const FOLDER_DELETE_NAMES_SHOWN = 5

function chatsWord(count: number) {
  return count === 1 ? 'chat' : 'chats'
}

export function describeFolderDeleteWithChats(
  folderName: string,
  chats: ReadonlyArray<FolderDeleteDialogChat>
): { title: string; description: string[] } {
  const count = chats.length
  const title = `Delete "${folderName}" and ${count} ${chatsWord(count)}?`
  if (count === 0) {
    return {
      title,
      description: ['This folder has no chats. The folder will be permanently deleted.']
    }
  }

  const description = [
    'This permanently deletes every chat in this folder, archived chats included. This action cannot be undone.'
  ]
  const archived = chats.filter((chat) => chat.archived)
  if (archived.length > 0) {
    const shown = archived
      .slice(0, FOLDER_DELETE_NAMES_SHOWN)
      .map((chat) => `"${chat.name}"`)
    const more = archived.length - shown.length
    const names = more > 0 ? `${shown.join(', ')}, and ${more} more` : shown.join(', ')
    description.push(
      `${archived.length} of them ${archived.length === 1 ? 'is' : 'are'} archived: ${names}.`
    )
  }
  return { title, description }
}

/** "A", "A" and "B", "A", "B", and "C", or the first five and "and N more". */
function listNames(names: string[]) {
  const quoted = names.slice(0, FOLDER_DELETE_NAMES_SHOWN).map((name) => `"${name}"`)
  const more = names.length - quoted.length
  if (more > 0) return `${quoted.join(', ')}, and ${more} more`
  if (quoted.length <= 2) return quoted.join(' and ')
  return `${quoted.slice(0, -1).join(', ')}, and ${quoted[quoted.length - 1]}`
}

/**
 * The dialog for a folder that holds a locked chat: it names them and offers no delete.
 * `null` when no chat is locked.
 */
export function describeFolderDeleteLocked(
  folderName: string,
  chats: ReadonlyArray<{ name: string; locked: boolean }>
): { title: string; description: string[] } | null {
  const locked = chats.filter((chat) => chat.locked).map((chat) => chat.name)
  if (locked.length === 0) return null
  return {
    title:
      locked.length === 1
        ? `"${folderName}" has a locked chat`
        : `"${folderName}" has ${locked.length} locked chats`,
    description: [`Unlock ${listNames(locked)} to delete this folder.`]
  }
}
