import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { installUserSettingsRoutes, loadUserSettingsRoute, jsonResponse } from '$lib/test-utils/userSettingsRoute'
import { confirmDialog, confirmDialogWithCheckbox } from '$lib/stores/confirmDialog'
import { toast } from '$lib/components/ui/sonner/settings-toast'
import type { BackupUploadCheck } from '$lib/types/backupUploadCheck'
import { encodeMissingUploadsSummary, type BackupMissingUploadsSummary } from '$lib/utils/backupPartialSummary'
import AdminSettingsPanel from './AdminSettingsPanel.svelte'

/**
 * BL-1381: the REAL Admin panel with the REAL Backup card. The panel's `handleBackupExport`
 * answers how the export ended, and the card starts its read-only upload check from that answer
 * alone: after a failed export, never after a cancel. Before the fix the card read the error
 * prop and a shown list instead, so cancelling the With Secrets confirmation under an old error,
 * or cancelling a save chooser while a list was shown, started one more check.
 *
 * Only the platform edges are stand-ins: the confirmation dialog, the Mac export bridge and the
 * download's save chooser (`window.zero`), the export route's answer and the check route's
 * answer. `$app/environment` says "browser" so the panel's real download code runs.
 */

vi.mock('$app/environment', () => ({ browser: true, building: false, dev: false, version: 'test' }))
vi.mock('$lib/stores/confirmDialog', () => ({
  confirmDialog: vi.fn(async () => false),
  confirmDialogWithCheckbox: vi.fn(async () => ({ confirmed: false, checked: false }))
}))
useRedisTestServer()

const USER = 'bl1381_user'
const STOPPED = 'Backup stopped: 1 uploaded file cannot be backed up (1 missing; 0 of 1 found in /tmp/uploads): images/1700_cat.png.'
/** BL-1390: what the panel says when the download body breaks off after the route's 200. */
const DOWNLOAD_STOPPED =
  'The backup stopped while it was downloading. Check Upload Files only looks for each file and cannot show that it can be read, so it may find nothing wrong. The app log may say why the backup stopped.'

type ZeroStub = {
  downloads?: { exportBackup?: (options: { includeSecrets: boolean; partial?: unknown }) => Promise<unknown> }
  dialogs?: { saveFile?: (options?: unknown) => Promise<string | null> }
}

function audit(): BackupUploadCheck {
  return {
    checkedAt: '2026-10-11T18:00:00.000Z',
    uploadRoot: '/tmp/uploads',
    fileBackedCount: 1,
    foundCount: 0,
    legacyCopyCount: 0,
    legacyCopyFileCount: 0,
    problemCount: 1,
    problemFileCount: 1,
    counts: { missing: 1, unreadable: 0, notAFile: 0, unsupportedRecord: 0 },
    problems: [
      {
        key: 'upload:images:1700_cat.png',
        relativePath: 'images/1700_cat.png',
        kind: 'missing',
        code: null,
        size: 3,
        uploadedAt: null,
        originalName: 'cat.png',
        sha256: null,
        fingerprint: 'c'.repeat(64),
        owner: { kind: 'clip', state: 'found', label: 'Clip "cat.png".', repair: 'Delete this Clip in the Clip Vault.', urgent: false }
      }
    ],
    truncated: false,
    listLimit: 10_000,
    rootProblem: null,
    uploadFolderFoundNothing: true,
    exportBlockedMessage: STOPPED
  }
}

/** Lets a check that would start after the export's answer start, so "no check" is real. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

async function openBackupCard(exportAnswer: () => Response) {
  const exportPosts: Array<Record<string, unknown>> = []
  let checks = 0
  installUserSettingsRoutes({
    userId: USER,
    route: await loadUserSettingsRoute(),
    extra: (path, method, init) => {
      if (path === '/api/admin/backup/export' && method === 'POST') {
        exportPosts.push(JSON.parse(String(init.body)))
        return exportAnswer()
      }
      if (path === '/api/admin/backup/missing-uploads' && method === 'GET') {
        checks += 1
        return jsonResponse({ audit: audit() })
      }
      // The download's native save (the browser path inside the Mac shell), for a finished download.
      if (path === '/api/native-downloads/save' && method === 'POST') return jsonResponse({ saved: true })
      return undefined
    }
  })
  render(AdminSettingsPanel, { data: { user: { id: USER, is_admin: true }, userSettings: null } as any })
  const card = screen.getByText('Backup and Restore').closest('details') as HTMLDetailsElement
  return {
    card,
    button: (name: string) => within(card).getByRole('button', { name }),
    exportPosts,
    checks: () => checks
  }
}

afterEach(() => {
  Reflect.deleteProperty(window, 'zero')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
beforeEach(() => {
  Reflect.deleteProperty(window, 'zero')
  vi.mocked(confirmDialog).mockReset().mockResolvedValue(false)
  vi.mocked(confirmDialogWithCheckbox).mockReset().mockResolvedValue({ confirmed: false, checked: false })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('Admin Backup export outcome reaches the card (BL-1381)', () => {
  it('a cancelled With Secrets confirmation under an old export error starts no check; a confirmed one still asks and checks', async () => {
    const view = await openBackupCard(() => jsonResponse({ error: STOPPED }, 409))

    // A real failed export: the error shows, and the card checks once by itself.
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(view.checks()).toBe(1))
    expect(view.exportPosts).toEqual([{ includeSecrets: false, confirmIncludeSecrets: false }])
    expect(await within(view.card).findByText('images/1700_cat.png')).toBeTruthy()
    expect(within(view.card).getAllByText(STOPPED).length).toBeGreaterThan(0)

    // Cancel the With Secrets confirmation while that error still shows.
    await fireEvent.click(view.button('With Secrets'))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    await settle()
    expect(view.checks()).toBe(1)
    expect(view.exportPosts).toHaveLength(1)
    expect(within(view.card).getAllByText(STOPPED).length).toBeGreaterThan(0)

    // Confirmed consent still goes to the route, and a failure still checks.
    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    await fireEvent.click(view.button('With Secrets'))
    await waitFor(() => expect(view.checks()).toBe(2))
    expect(confirmDialog).toHaveBeenCalledTimes(2)
    expect(vi.mocked(confirmDialog).mock.calls[1][0]).toMatchObject({ title: 'Export Backup With Secrets?' })
    expect(view.exportPosts[1]).toEqual({ includeSecrets: true, confirmIncludeSecrets: true })
  }, 60_000)

  it('a cancelled Mac save chooser or download save chooser starts no check while a list shows; a finished export refreshes it', async () => {
    const zipAnswer = () =>
      new Response(new Uint8Array([80, 75, 5, 6]), {
        status: 200,
        headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="batshit-backup-x.zip"' }
      })
    const view = await openBackupCard(zipAnswer)
    await fireEvent.click(view.button('Check Upload Files'))
    expect(await within(view.card).findByText('images/1700_cat.png')).toBeTruthy()
    expect(view.checks()).toBe(1)

    // The packaged Mac export: the user cancels its save chooser.
    const exportBackup = vi.fn(async () => ({ completed: false, native: true, canceled: true }))
    ;(window as Window & { zero?: ZeroStub }).zero = { downloads: { exportBackup } }
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(exportBackup).toHaveBeenCalledOnce())
    await settle()
    expect(view.checks()).toBe(1)
    expect(view.exportPosts).toEqual([])

    // The packaged Mac export finishes: the shown list is refreshed.
    exportBackup.mockResolvedValueOnce({ completed: true, native: true, canceled: false })
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(view.checks()).toBe(2))
    expect(exportBackup).toHaveBeenCalledTimes(2)
    // The refresh has finished (its button reads "Check Upload Files" again, not "Checking"), so
    // a wrong outcome below could not hide behind a check still running.
    await waitFor(() => expect(view.button('Check Upload Files')).toBeTruthy())

    // The download path: the route answers a zip, and the user cancels the save chooser.
    const saveFile = vi.fn(async () => null)
    ;(window as Window & { zero?: ZeroStub }).zero = { dialogs: { saveFile } }
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(saveFile).toHaveBeenCalledOnce())
    await settle()
    expect(view.exportPosts).toEqual([{ includeSecrets: false, confirmIncludeSecrets: false }])
    expect(view.checks()).toBe(2)
    expect(within(view.card).getByText('images/1700_cat.png')).toBeTruthy()
  }, 60_000)

  it('a download that breaks off after the route began the zip fails with the truthful hint; an error before the response keeps its own words (BL-1390)', async () => {
    const SERVER_SAID = 'Backup cannot continue because the upload folder is not available.'
    let answer = () => jsonResponse({ error: SERVER_SAID }, 500)
    const view = await openBackupCard(() => answer())

    // The route refuses before any zip byte: its own sentence shows, never the hint.
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(view.checks()).toBe(1))
    expect(within(view.card).getByText(SERVER_SAID)).toBeTruthy()
    expect(within(view.card).queryByText(DOWNLOAD_STOPPED)).toBeNull()

    // The route answers 200 and begins the zip, then the body breaks off, as when the export
    // fails mid-stream. The card checks again (the list from step 1 shows, so a finished export
    // would refresh it too); the hint proves 'failed', since only the catch that returns
    // 'failed' sets it.
    answer = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([80, 75, 3, 4]))
            controller.error(new TypeError('network error'))
          }
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="batshit-backup-x.zip"' }
        }
      )
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(view.checks()).toBe(2))
    expect(await within(view.card).findByText(DOWNLOAD_STOPPED)).toBeTruthy()
    expect(within(view.card).queryByText(SERVER_SAID)).toBeNull()
    expect(within(view.card).queryByText('network error')).toBeNull()
    expect(view.exportPosts).toEqual([
      { includeSecrets: false, confirmIncludeSecrets: false },
      { includeSecrets: false, confirmIncludeSecrets: false }
    ])
  }, 60_000)
})

/**
 * BL-378 Phase 1b: Make a Partial Backup through the REAL panel and card. The panel sends the
 * card's exact rows as `partial`, and its toast reads only the strict summary (the header for a
 * download, the result's `missingUploads` on the packaged Mac export). A missing or malformed
 * summary is "unavailable": the backup is still exported, nothing is invented.
 */
describe('Admin Backup partial export (BL-378 Phase 1b)', () => {
  const PARTIAL_SUMMARY: BackupMissingUploadsSummary = {
    completeness: 'partial',
    missingFiles: 1,
    missingRecords: 1,
    foundAgainFiles: 0,
    goneRecords: 0,
    otherRecords: 0
  }
  const ACKNOWLEDGED = [{ key: 'upload:images:1700_cat.png', relativePath: 'images/1700_cat.png', fingerprint: 'c'.repeat(64) }]
  const UNAVAILABLE =
    'Backup exported, but Batshit could not read its missing-upload summary, so it cannot say which upload files are in it. Run Check Upload Files to see which are missing now.'
  const zipAnswer = (summary: string | null) => () =>
    new Response(new Uint8Array([80, 75, 5, 6]), {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="batshit-backup-PARTIAL-x.zip"',
        ...(summary === null ? {} : { 'X-Batshit-Backup-Missing-Uploads': summary })
      }
    })

  async function makePartial(view: Awaited<ReturnType<typeof openBackupCard>>, expectedChecks: number) {
    vi.mocked(confirmDialogWithCheckbox).mockResolvedValueOnce({ confirmed: true, checked: true })
    await fireEvent.click(view.button('Make a Partial Backup'))
    // A finished export refreshes the list shown; its button reads "Check Upload Files" again.
    await waitFor(() => expect(view.checks()).toBe(expectedChecks))
    await waitFor(() => expect(view.button('Check Upload Files')).toBeTruthy())
  }

  it('a download: the exact rows go out, the summary decides the words, and an unavailable one still counts as exported', async () => {
    let answer = zipAnswer(encodeMissingUploadsSummary(PARTIAL_SUMMARY))
    const view = await openBackupCard(() => answer())
    ;(window as Window & { zero?: ZeroStub }).zero = { dialogs: { saveFile: vi.fn(async () => '/tmp/batshit-backup-PARTIAL-x.zip') } }
    const warning = vi.spyOn(toast, 'warning')
    const success = vi.spyOn(toast, 'success')
    const failure = vi.spyOn(toast, 'error')
    await fireEvent.click(view.button('Check Upload Files'))
    expect(await within(view.card).findByText('images/1700_cat.png')).toBeTruthy()

    await makePartial(view, 2)
    expect(view.exportPosts).toEqual([
      { includeSecrets: false, confirmIncludeSecrets: false, partial: { acknowledged: ACKNOWLEDGED, confirmAllMissing: true } }
    ])
    expect(warning).toHaveBeenLastCalledWith('Partial backup exported: 1 upload file Batshit did not find is not in it.')

    // Nothing missing any more: an ordinary backup, said as such.
    answer = zipAnswer(encodeMissingUploadsSummary({ ...PARTIAL_SUMMARY, completeness: 'complete', missingFiles: 0, missingRecords: 0, foundAgainFiles: 1 }))
    await makePartial(view, 3)
    expect(success).toHaveBeenLastCalledWith(
      'Backup exported. The 1 upload file marked as missing was found again, so no upload files remain missing.'
    )

    // No header, a header that is not the exact shape, or not JSON: unavailable, and still exported.
    let checks = 3
    for (const summary of [null, '{"completeness":"partial"}', 'not json']) {
      answer = zipAnswer(summary)
      checks += 1
      await makePartial(view, checks)
      expect(warning).toHaveBeenLastCalledWith(UNAVAILABLE)
    }
    // (The panel also loads unrelated cards whose routes this test does not answer; only backup errors count.)
    expect(failure.mock.calls.filter(([message]) => /backup/i.test(String(message)))).toEqual([])
    expect(success).toHaveBeenCalledTimes(1)
  }, 60_000)

  it('the packaged Mac export: a plain export sends only includeSecrets; a partial one sends the rows and reads missingUploads', async () => {
    const view = await openBackupCard(() => {
      throw new Error('the Mac export never fetches from the page')
    })
    const exportBackup = vi.fn(async (_options: { includeSecrets: boolean; partial?: unknown }): Promise<unknown> => ({
      completed: true,
      native: true,
      canceled: false,
      missingUploads: encodeMissingUploadsSummary(PARTIAL_SUMMARY)
    }))
    ;(window as Window & { zero?: ZeroStub }).zero = { downloads: { exportBackup } }
    const warning = vi.spyOn(toast, 'warning')
    const failure = vi.spyOn(toast, 'error')

    await fireEvent.click(view.button('Check Upload Files'))
    expect(await within(view.card).findByText('images/1700_cat.png')).toBeTruthy()
    await makePartial(view, 2)
    expect(exportBackup).toHaveBeenLastCalledWith({ includeSecrets: false, partial: { acknowledged: ACKNOWLEDGED, confirmAllMissing: true } })
    expect(warning).toHaveBeenLastCalledWith('Partial backup exported: 1 upload file Batshit did not find is not in it.')

    // A result whose summary is not text: the written backup stays exported, the summary unavailable.
    exportBackup.mockResolvedValueOnce({ completed: true, native: true, canceled: false, missingUploads: 7 })
    await makePartial(view, 3)
    expect(warning).toHaveBeenLastCalledWith(UNAVAILABLE)
    // (The panel also loads unrelated cards whose routes this test does not answer; only backup errors count.)
    expect(failure.mock.calls.filter(([message]) => /backup/i.test(String(message)))).toEqual([])

    // A plain export still sends exactly what it did.
    exportBackup.mockResolvedValueOnce({ completed: true, native: true, canceled: false })
    await fireEvent.click(view.button('Export'))
    await waitFor(() => expect(exportBackup).toHaveBeenCalledTimes(3))
    expect(exportBackup).toHaveBeenLastCalledWith({ includeSecrets: false })
    await waitFor(() => expect(view.checks()).toBe(4))
    expect(view.exportPosts).toEqual([])
  }, 60_000)
})
