/**
 * BL-142 / BL-145 (2026-09-25): tidying an owner's avatar pictures from Settings: an agent's or
 * Subagent's, and a Group's or the user's since BL-281 (2026-09-27).
 *
 * Every upload stores a new picture named after its owner. The panels used to delete the old
 * one at upload time (`oldAvatarUrl`), before the save: a save the form then refused kept
 * pointing at the deleted picture (BL-145), and clearing a picture or choosing an icon deleted
 * nothing at all (BL-142). Now nothing is deleted at upload; after a save that CHANGED the
 * picture, the panel asks the server to delete every picture of that owner except the one the
 * SAVED record shows (`DELETE /api/uploads/avatar`). It asks only while nothing newer is on its
 * way, since a picture uploaded but not saved yet is not in the saved record either; and
 * batshit-server leaves any picture newer than the saved one, for a newer upload from another
 * tab (BL-288).
 */

const AVATAR_PATH = '/uploads/avatars/'

/** The stored picture's file name an avatar URL points at (any host), or null. */
export function avatarPictureName(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const path = value.split(/[?#]/)[0]
  const index = path.indexOf(AVATAR_PATH)
  if (index === -1) return null
  const name = path.slice(index + AVATAR_PATH.length)
  return name && !name.includes('/') ? name : null
}

export function shouldTidyAvatarPictures(input: {
  /** The picture the owner's record showed before this save. */
  previous: unknown
  /** The picture this save stored. */
  saved: unknown
  /** The picture the form shows now, when the save answered. */
  current: unknown
  /** An upload for this owner is still running. */
  uploading: boolean
}): boolean {
  const saved = avatarPictureName(input.saved)
  if (avatarPictureName(input.previous) === saved) return false
  return !input.uploading && avatarPictureName(input.current) === saved
}

/**
 * Ask the server to tidy. The save already succeeded, so a failure is only reported: the old
 * pictures stay until the next tidy or the owner's delete, which sweeps every one of them.
 * `replaced` is the picture the saved record showed before this save (BL-288): when the save
 * cleared the picture, it and older ones go at once, and a newer upload stays.
 */
export async function requestAvatarPictureTidy(
  entityType: 'agent' | 'subagent' | 'group' | 'user',
  entityId: string,
  replaced?: unknown
): Promise<void> {
  const replacedName = avatarPictureName(replaced)
  try {
    const response = await fetch('/api/uploads/avatar', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType, entityId, ...(replacedName ? { replaced: replacedName } : {}) })
    })
    if (!response.ok) {
      console.warn(
        `Could not delete the ${entityType}'s old avatar pictures (they stay until the next change or its delete):`,
        await response.text()
      )
    }
  } catch (error) {
    console.warn(
      `Could not delete the ${entityType}'s old avatar pictures (they stay until the next change or its delete):`,
      error instanceof Error ? error.message : String(error)
    )
  }
}
