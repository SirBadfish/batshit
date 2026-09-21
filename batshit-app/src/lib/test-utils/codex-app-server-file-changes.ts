/**
 * Codex native patches as the app server really reports them: `fileChange` items captured from a
 * standalone `codex app-server` turn (codex-cli 0.139.0, gpt-5.5, 2026-09-18), with the workspace
 * path anonymized. Each change's `kind` is an object and each carries Codex's own `diff`: unified
 * hunks for an update, the whole text for an add or a delete, and `\n\nMoved to: <path>` after
 * any hunks for a rename. An earlier fixture that used a plain word for `kind` hid the adapter's
 * crash on every native patch; keep these faithful.
 */
import { mapAppServerItem } from '$lib/server/services/codexAppServerLane'

export const CODEX_PROJECT = '/Users/example/project'

/** One patch: `notes.md` edited, `old-name.txt` renamed. */
export const CAPTURED_UPDATE_AND_RENAME = {
  type: 'fileChange',
  id: 'call_9DRwgIctLrDDPWNu9cUZxe8D',
  changes: [
    {
      path: `${CODEX_PROJECT}/notes.md`,
      kind: { type: 'update', move_path: null },
      diff: '@@ -2,3 +2,3 @@\n \n-First line.\n+Last line.\n Second line.\n'
    },
    {
      path: `${CODEX_PROJECT}/old-name.txt`,
      kind: { type: 'update', move_path: `${CODEX_PROJECT}/new-name.txt` },
      diff: `\n\nMoved to: ${CODEX_PROJECT}/new-name.txt`
    }
  ],
  status: 'completed'
}

/** One patch: `added.md` added, `doomed.txt` deleted, `notes.md` edited and renamed. */
export const CAPTURED_ADD_DELETE_MOVE_EDIT = {
  type: 'fileChange',
  id: 'call_anSX3AREloN1yK6Os7BmxWnB',
  changes: [
    { path: `${CODEX_PROJECT}/added.md`, kind: { type: 'add' }, diff: 'hello\nworld\n' },
    { path: `${CODEX_PROJECT}/doomed.txt`, kind: { type: 'delete' }, diff: 'delete me\n' },
    {
      path: `${CODEX_PROJECT}/notes.md`,
      kind: { type: 'update', move_path: `${CODEX_PROJECT}/moved-notes.md` },
      diff: `@@ -3,2 +3,2 @@\n Last line.\n-Second line.\n+Final line.\n\n\nMoved to: ${CODEX_PROJECT}/moved-notes.md`
    }
  ],
  status: 'completed'
}

/**
 * `item.started` and `item.completed` for a raw app-server `fileChange` item, through the lane's
 * own `mapAppServerItem`, as the Codex event adapter receives them. The app server sends the same
 * changes on both, `inProgress` first.
 */
export function appServerFileChangeEvents(
  item: { id: string; changes: unknown[]; status: string },
  finalStatus = item.status
): any[] {
  return [
    { type: 'item.started', item: mapAppServerItem({ ...item, type: 'fileChange', status: 'inProgress' }) },
    { type: 'item.completed', item: mapAppServerItem({ ...item, type: 'fileChange', status: finalStatus }) }
  ]
}
