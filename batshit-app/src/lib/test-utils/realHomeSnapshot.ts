import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The sentinel of a suite that could write under the real home folder (skills, voice profiles):
 * which of the suite's OWN names exist directly under `root`. It never looks at any other entry, so
 * another process's unrelated write there (a dev server's skill sync rewriting a `metadata.json`
 * during a full lane, BL-808) cannot fail the suite; a real leak of a name the suite uses does.
 * List every name the suite seeds or writes; a name not in the list is not watched. A missing root
 * is empty. Read-only; follows no link.
 */
export async function ownNamesUnder(root: string, names: readonly string[]): Promise<string[]> {
  const present: string[] = []
  for (const name of names) {
    try {
      await fs.lstat(path.join(root, name))
      present.push(name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return present
}

/**
 * A safety net for tests that could write under the real home folder (skills, voice profiles):
 * every entry below `root` with its type, size, and modification time, so a changed file shows up,
 * not only a new name. A missing root is an empty list. Read-only; follows no link. It watches the
 * WHOLE tree, so any other process's write there changes it: prefer `ownNamesUnder` for a sentinel
 * that runs beside dev servers (BL-773, BL-808).
 */
export async function snapshotRealHomeTree(root: string): Promise<string[]> {
  const lines: string[] = []
  async function walk(relative: string) {
    let entries: string[]
    try {
      entries = await fs.readdir(path.join(root, relative))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && relative === '') return
      throw error
    }
    for (const name of entries.sort()) {
      const entryPath = relative ? `${relative}/${name}` : name
      const stat = await fs.lstat(path.join(root, entryPath))
      const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file'
      lines.push(`${entryPath}\t${kind}\t${kind === 'file' ? stat.size : ''}\t${stat.mtimeMs}`)
      if (kind === 'dir') await walk(entryPath)
    }
  }
  await walk('')
  return lines
}
