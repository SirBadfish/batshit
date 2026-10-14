import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { confirmDialog, confirmDialogWithCheckbox } from '$lib/stores/confirmDialog'
import type { BackupUploadCheck } from '$lib/types/backupUploadCheck'
import AdminBackupRestoreCard from './AdminBackupRestoreCard.svelte'
import type { BackupExportOutcome, BackupPreflightSummary } from './adminSettingsTypes'

// BL-378 Phase 1b: the partial backup's confirmations are stand-ins; nothing else is.
vi.mock('$lib/stores/confirmDialog', () => ({
  confirmDialog: vi.fn(async () => false),
  confirmDialogWithCheckbox: vi.fn(async () => ({ confirmed: false, checked: false }))
}))

// BL-378: the Backup card's read-only "Check Upload Files" list.

/** Lets a check that would start after the export's answer start, so "no check" is real. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    exportBusy: false,
    preflightBusy: false,
    stageProgress: null,
    restoreBusy: false,
    selectedFile: null,
    preflight: null,
    error: null,
    confirmReplace: false,
    onConfirmReplaceChange: vi.fn(),
    onExport: vi.fn(),
    onFileSelected: vi.fn(),
    onPreflight: vi.fn(),
    onRestore: vi.fn(),
    ...overrides
  }
}

function check(overrides: Partial<BackupUploadCheck> = {}): BackupUploadCheck {
  return {
    checkedAt: '2026-10-11T16:00:00.000Z',
    uploadRoot: '/tmp/uploads',
    fileBackedCount: 3,
    foundCount: 1,
    legacyCopyCount: 0,
    legacyCopyFileCount: 0,
    problemCount: 2,
    problemFileCount: 2,
    counts: { missing: 1, unreadable: 1, notAFile: 0, unsupportedRecord: 0 },
    problems: [
      {
        key: 'upload:memory-media:agent_a/mem_b/media_c.png',
        relativePath: 'memory-media/agent_a/mem_b/media_c.png',
        kind: 'missing',
        code: null,
        size: 3,
        uploadedAt: null,
        originalName: null,
        sha256: null,
        fingerprint: 'a'.repeat(64),
        owner: {
          kind: 'memory-media',
          state: 'found',
          label: 'Image of memory mem_b of Ada.',
          repair: 'Settings → Memory → Ada: open memory mem_b, then remove or replace this image.',
          urgent: true
        }
      },
      {
        key: 'upload:images:1700_cat.png',
        relativePath: 'images/1700_cat.png',
        kind: 'unreadable',
        code: 'EACCES',
        size: 3,
        uploadedAt: null,
        originalName: 'cat.png',
        sha256: null,
        fingerprint: 'b'.repeat(64),
        owner: {
          kind: 'clip',
          state: 'found',
          label: 'Clip "cat.png".',
          repair: 'Delete this Clip in the Clip Vault.',
          urgent: false
        }
      }
    ],
    truncated: false,
    listLimit: 10_000,
    rootProblem: null,
    uploadFolderFoundNothing: false,
    exportBlockedMessage: 'Backup stopped: 2 uploaded files cannot be backed up.',
    ...overrides
  }
}

function stubCheck(answer: BackupUploadCheck | { status: number; error: string }) {
  const fetchMock = vi.fn(async () =>
    'status' in answer
      ? new Response(JSON.stringify({ error: answer.error }), { status: answer.status })
      : Response.json({ audit: answer })
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Backup card upload check (BL-378)', () => {
  it('reads only: one GET with no body, then each file with its owner and fix', async () => {
    const fetchMock = stubCheck(check())
    const props = baseProps()
    render(AdminBackupRestoreCard, props)

    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))

    expect(await screen.findByText('memory-media/agent_a/mem_b/media_c.png')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/backup/missing-uploads', { method: 'GET' })
    expect(props.onExport).not.toHaveBeenCalled()
    expect(screen.getByText('Image of memory mem_b of Ada.')).toBeTruthy()
    expect(screen.getByText('Unreadable (EACCES)')).toBeTruthy()
    expect(screen.getByText('2 files cannot be backed up')).toBeTruthy()
    expect(screen.getByText('1 of 3 found')).toBeTruthy()
    const urgent = screen.getByText(/open memory mem_b, then remove or replace this image/)
    expect(urgent.className).toContain('is-danger')
    expect(screen.getByText(/Batshit does not delete these records for you/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /delete|remove|clean/i })).toBeNull()
  })

  it('checks at once after a failed export, and not after a good one', async () => {
    const fetchMock = stubCheck(check())
    let rerenderCard: ((props: Record<string, unknown>) => Promise<void>) | null = null
    const failingExport = vi.fn(async (): Promise<BackupExportOutcome> => {
      await rerenderCard?.({ error: 'Backup stopped: 2 uploaded files cannot be backed up.' })
      return 'failed'
    })
    const view = render(AdminBackupRestoreCard, baseProps({ onExport: failingExport }))
    rerenderCard = view.rerender as (props: Record<string, unknown>) => Promise<void>

    await fireEvent.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(failingExport).toHaveBeenCalledWith(false)
    expect(await screen.findByText('images/1700_cat.png')).toBeTruthy()
    view.unmount()

    const quietFetch = stubCheck(check())
    const goodExport = vi.fn(async (): Promise<BackupExportOutcome> => 'exported')
    const quiet = render(AdminBackupRestoreCard, baseProps({ onExport: goodExport }))
    await fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    await waitFor(() => expect(goodExport).toHaveBeenCalledTimes(1))
    await settle()
    expect(quietFetch).not.toHaveBeenCalled()
    quiet.unmount()
  })

  // BL-1381: the outcome the panel returns decides, never the error prop or a shown list.
  it('a failed export checks even before the parent has shown its error', async () => {
    const fetchMock = stubCheck(check())
    const failedExport = vi.fn(async (): Promise<BackupExportOutcome> => 'failed')
    render(AdminBackupRestoreCard, baseProps({ onExport: failedExport }))

    await fireEvent.click(screen.getByRole('button', { name: 'With Secrets' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(failedExport).toHaveBeenCalledWith(true)
    expect(await screen.findByText('images/1700_cat.png')).toBeTruthy()
  })

  it('a cancelled or busy export starts no check, with an old error showing or a list shown', async () => {
    for (const outcome of ['canceled', 'busy'] as const) {
      const fetchMock = stubCheck(check())
      const endedEarly = vi.fn(async (): Promise<BackupExportOutcome> => outcome)
      const withOldError = render(
        AdminBackupRestoreCard,
        baseProps({ onExport: endedEarly, error: 'Backup stopped: 2 uploaded files cannot be backed up.' })
      )
      await fireEvent.click(screen.getByRole('button', { name: 'With Secrets' }))
      await fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(endedEarly).toHaveBeenCalledTimes(2))
      await settle()
      expect(fetchMock).not.toHaveBeenCalled()
      // The old error stays where it was: the card hides nothing the parent shows.
      expect(screen.getByText('Backup stopped: 2 uploaded files cannot be backed up.')).toBeTruthy()
      withOldError.unmount()

      const listFetch = stubCheck(check())
      const listShown = render(AdminBackupRestoreCard, baseProps({ onExport: endedEarly }))
      await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
      expect(await screen.findByText('images/1700_cat.png')).toBeTruthy()
      expect(listFetch).toHaveBeenCalledTimes(1)
      await fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      await waitFor(() => expect(endedEarly).toHaveBeenCalledTimes(3))
      await settle()
      expect(listFetch).toHaveBeenCalledTimes(1)
      expect(screen.getByText('images/1700_cat.png')).toBeTruthy()
      listShown.unmount()
    }
  })

  it('refreshes a list already shown after a good export, so it never goes stale', async () => {
    stubCheck(check())
    const goodExport = vi.fn(async (): Promise<BackupExportOutcome> => 'exported')
    render(AdminBackupRestoreCard, baseProps({ onExport: goodExport }))
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText('images/1700_cat.png')).toBeTruthy()

    const refreshed = stubCheck(check({ problemCount: 0, problemFileCount: 0, problems: [], foundCount: 3, counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 0 }, exportBlockedMessage: null }))
    await fireEvent.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/3 uploaded files were found as regular files in the upload folder/)).toBeTruthy()
    expect(screen.queryByText('images/1700_cat.png')).toBeNull()
  })

  // BL-1388: the server's shared predicate decides the folder hint; legacy copies only add words.
  it('shows the folder hint when the server says the folder had none of the files, even beside a legacy copy', async () => {
    const missing = check().problems[0]
    stubCheck(check({
      fileBackedCount: 3,
      foundCount: 0,
      legacyCopyCount: 1,
      problemCount: 2,
      problemFileCount: 1,
      counts: { missing: 2, unreadable: 0, notAFile: 0, unsupportedRecord: 0 },
      problems: [
        { ...missing, key: 'upload:avatars:agent:agent_a_1.jpg', relativePath: 'avatars/agent_a_1.jpg' },
        { ...missing, key: 'upload:avatars:agent_a_1.jpg', relativePath: 'avatars/agent_a_1.jpg' }
      ],
      uploadFolderFoundNothing: true
    }))
    const withLegacy = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(
      await screen.findByText(
        'The uploaded file (2 upload records) was not found in /tmp/uploads. 1 older upload is saved inside its record and does not need the folder. If the upload folder moved, or a drive or Docker volume is not connected, fix that first.'
      )
    ).toBeTruthy()
    withLegacy.unmount()
  })

  it('never works the folder hint out again from its own counts', async () => {
    stubCheck(check({
      foundCount: 0,
      counts: { missing: 2, unreadable: 0, notAFile: 0, unsupportedRecord: 0 },
      problemCount: 2,
      uploadFolderFoundNothing: false
    }))
    render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText('images/1700_cat.png')).toBeTruthy()
    expect(screen.queryByText(/found in \/tmp\/uploads/)).toBeNull()
  })

  // BL-1380: a record a backup cannot carry is its own kind, never shown as missing or found.
  it('names an unsupported record as such, and claims no found count when no file was looked for', async () => {
    const unsupported = check().problems[0]
    stubCheck(check({
      fileBackedCount: 0,
      foundCount: 0,
      problemCount: 1,
      problemFileCount: 1,
      counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 1 },
      problems: [{
        ...unsupported,
        key: 'upload:avatars:string_avatar.png',
        relativePath: 'avatars/string_avatar.png',
        kind: 'unsupported-record',
        owner: { kind: 'avatar', state: 'found', label: 'Your profile picture.', repair: 'Choose a new picture.', urgent: false }
      }]
    }))
    render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))

    expect(await screen.findByText('avatars/string_avatar.png')).toBeTruthy()
    expect(screen.getByText('Unsupported record')).toBeTruthy()
    expect(screen.getByText('1 unsupported record')).toBeTruthy()
    expect(screen.queryByText(/of 0 found/)).toBeNull()
    expect(screen.queryByText('Missing')).toBeNull()
    expect(screen.queryByText(/found in \/tmp\/uploads/)).toBeNull()
  })

  it('shows the folder problem, a clean result, a cut list and a failed check honestly', async () => {
    stubCheck(check({
      problemCount: 0,
      problemFileCount: 0,
      problems: [],
      counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 0 },
      rootProblem: { kind: 'root-missing', code: 'ENOENT' },
      exportBlockedMessage: "Backup stopped: Batshit's upload folder /tmp/uploads was not found."
    }))
    const first = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText(/upload folder \/tmp\/uploads was not found/)).toBeTruthy()
    first.unmount()

    stubCheck(check({ problemCount: 0, problemFileCount: 0, problems: [], foundCount: 1, legacyCopyCount: 2, counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 0 }, exportBlockedMessage: null }))
    const second = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(
      await screen.findByText(
        '1 uploaded file was found as a regular file in the upload folder, and 2 older uploads will use the copies saved in their records. This check only looks for each file; a backup still reads every file as it copies it, and stops if one cannot be read.'
      )
    ).toBeTruthy()
    second.unmount()

    stubCheck(check({ fileBackedCount: 0, problemCount: 0, problemFileCount: 0, problems: [], foundCount: 0, counts: { missing: 0, unreadable: 0, notAFile: 0, unsupportedRecord: 0 }, exportBlockedMessage: null }))
    const empty = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText('This instance has no uploaded files for a backup to check.')).toBeTruthy()
    empty.unmount()

    // Nothing found but one path unreadable (its file may be there): no "not found" hint.
    stubCheck(check({ foundCount: 0 }))
    const unreadable = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText('images/1700_cat.png')).toBeTruthy()
    expect(screen.queryByText(/found in \/tmp\/uploads/)).toBeNull()
    unreadable.unmount()

    const [missingProblem, unreadableProblem] = check().problems
    stubCheck(check({
      foundCount: 0,
      counts: { missing: 2, unreadable: 0, notAFile: 0, unsupportedRecord: 0 },
      problems: [missingProblem, { ...unreadableProblem, kind: 'missing', code: null }],
      uploadFolderFoundNothing: true
    }))
    const none = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(
      await screen.findByText(
        'None of the 2 uploaded files were found in /tmp/uploads. If the upload folder moved, or a drive or Docker volume is not connected, fix that first.'
      )
    ).toBeTruthy()
    none.unmount()

    stubCheck(check({ problemCount: 12_000, problemFileCount: 11_000, truncated: true }))
    const third = render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText('Showing the first 10000 of 12000.')).toBeTruthy()
    expect(screen.getByText('12000 upload records')).toBeTruthy()
    third.unmount()

    stubCheck({ status: 500, error: 'Upload check lost track of upload:images:x.png.' })
    render(AdminBackupRestoreCard, baseProps())
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText('Upload check lost track of upload:images:x.png.')).toBeTruthy()
  })
})

// BL-378 Phase 1b: Make a Partial Backup, beside a full list where every row is a missing file.
describe('Backup card partial backup (BL-378 Phase 1b)', () => {
  const ALL_MISSING_ROWS = (() => {
    const [missingProblem] = check().problems
    return [
      missingProblem,
      { ...missingProblem, key: 'upload:avatars:agent:a.jpg', relativePath: 'avatars/a.jpg', fingerprint: 'c'.repeat(64) },
      { ...missingProblem, key: 'upload:avatars:a.jpg', relativePath: 'avatars/a.jpg', fingerprint: 'd'.repeat(64) }
    ]
  })()
  const allMissing = (overrides: Partial<BackupUploadCheck> = {}) =>
    check({
      foundCount: 1,
      problemCount: 3,
      problemFileCount: 2,
      counts: { missing: 3, unreadable: 0, notAFile: 0, unsupportedRecord: 0 },
      problems: ALL_MISSING_ROWS,
      ...overrides
    })
  const acknowledged = ALL_MISSING_ROWS.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint }))
  const BODY =
    'Batshit did not find 2 upload files (3 upload records) where it expects them in /tmp/uploads. ' +
    'A partial backup contains the upload files and records that are available and names each missing file; it cannot contain the missing files. ' +
    'Skill and voice folders it cannot carry are still listed, as in any backup.'

  beforeEach(() => {
    vi.mocked(confirmDialog).mockReset().mockResolvedValue(false)
    vi.mocked(confirmDialogWithCheckbox).mockReset().mockResolvedValue({ confirmed: false, checked: false })
  })

  async function showList(answer: BackupUploadCheck, props: Record<string, unknown> = {}) {
    const fetchMock = stubCheck(answer)
    const view = render(AdminBackupRestoreCard, baseProps(props))
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    expect(await screen.findByText(answer.problems[0]?.relativePath ?? 'never')).toBeTruthy()
    return { view, fetchMock }
  }

  it('is offered only when every row is missing and the list is whole', async () => {
    const mixed = await showList(check())
    expect(screen.queryByRole('button', { name: 'Make a Partial Backup' })).toBeNull()
    mixed.view.unmount()

    const cut = await showList(allMissing({ truncated: true, problemCount: 12_000 }))
    expect(screen.queryByRole('button', { name: 'Make a Partial Backup' })).toBeNull()
    cut.view.unmount()

    const whole = await showList(allMissing())
    expect(screen.getByRole('button', { name: 'Make a Partial Backup' })).toBeTruthy()
    whole.view.unmount()
  })

  it('Cancel sends nothing; a confirmation sends exactly the rows shown, then refreshes the list', async () => {
    const exportPartial = vi.fn(async (): Promise<BackupExportOutcome> => 'exported')
    const { fetchMock } = await showList(allMissing(), { onExport: exportPartial })

    await fireEvent.click(screen.getByRole('button', { name: 'Make a Partial Backup' }))
    await waitFor(() => expect(confirmDialog).toHaveBeenCalledOnce())
    await settle()
    expect(exportPartial).not.toHaveBeenCalled()
    expect(confirmDialogWithCheckbox).not.toHaveBeenCalled()
    expect(vi.mocked(confirmDialog).mock.calls[0][0]).toEqual({
      title: 'Make a Partial Backup?',
      description: [BODY],
      confirmLabel: 'Make a Partial Backup',
      cancelLabel: 'Cancel'
    })

    vi.mocked(confirmDialog).mockResolvedValueOnce(true)
    await fireEvent.click(screen.getByRole('button', { name: 'Make a Partial Backup' }))
    await waitFor(() => expect(exportPartial).toHaveBeenCalledOnce())
    expect(exportPartial).toHaveBeenCalledWith(false, { acknowledged })
    // As after any finished export, the list shown is checked again.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('when the folder held none of the files, asks a second box; only a ticked box sends confirmAllMissing', async () => {
    const exportPartial = vi.fn(async (): Promise<BackupExportOutcome> => 'failed')
    await showList(allMissing({ foundCount: 0, uploadFolderFoundNothing: true }), { onExport: exportPartial })

    vi.mocked(confirmDialogWithCheckbox).mockResolvedValueOnce({ confirmed: true, checked: true })
    await fireEvent.click(screen.getByRole('button', { name: 'Make a Partial Backup' }))
    await waitFor(() => expect(exportPartial).toHaveBeenCalledTimes(1))
    expect(exportPartial).toHaveBeenLastCalledWith(false, { acknowledged, confirmAllMissing: true })
    expect(confirmDialog).not.toHaveBeenCalled()
    expect(vi.mocked(confirmDialogWithCheckbox).mock.calls[0][0]).toEqual({
      title: 'Make a Partial Backup?',
      description: [
        BODY,
        'None of the 2 upload files Batshit expects are in /tmp/uploads. If your upload folder moved, or a drive or Docker volume is not connected, cancel and fix that first: this partial backup would contain no upload files at all.'
      ],
      confirmLabel: 'Make a Partial Backup',
      cancelLabel: 'Cancel',
      checkbox: { label: 'The upload folder is the right one. Make the partial backup anyway.' }
    })

    // Confirmed without the box: the server would refuse it, so nothing is sent, and the card says why.
    vi.mocked(confirmDialogWithCheckbox).mockResolvedValueOnce({ confirmed: true, checked: false })
    await fireEvent.click(screen.getByRole('button', { name: 'Make a Partial Backup' }))
    await waitFor(() => expect(confirmDialogWithCheckbox).toHaveBeenCalledTimes(2))
    const note =
      'Nothing was exported. When none of the files are in the upload folder, a partial backup needs the box "The upload folder is the right one" ticked; check the upload folder first.'
    expect(await screen.findByText(note)).toBeTruthy()
    await settle()
    expect(exportPartial).toHaveBeenCalledTimes(1)

    // A new check is a new list: the line goes with the old one.
    await fireEvent.click(screen.getByRole('button', { name: 'Check Upload Files' }))
    await waitFor(() => expect(screen.queryByText(note)).toBeNull())
  })

  it('older uploads saved inside their records change only the words, counted as files', async () => {
    await showList(allMissing({ foundCount: 0, uploadFolderFoundNothing: true, legacyCopyCount: 2, legacyCopyFileCount: 1 }))
    await fireEvent.click(screen.getByRole('button', { name: 'Make a Partial Backup' }))
    await waitFor(() => expect(confirmDialogWithCheckbox).toHaveBeenCalledOnce())
    expect((vi.mocked(confirmDialogWithCheckbox).mock.calls[0][0].description as string[])[1]).toBe(
      'None of the 2 upload files Batshit expects are in /tmp/uploads. If your upload folder moved, or a drive or Docker volume is not connected, cancel and fix that first: ' +
        'this partial backup would contain only the 1 older upload file saved inside its record, and none from the folder.'
    )
  })

  function preflight(completeness?: 'partial'): BackupPreflightSummary {
    return {
      ok: true,
      manifest: {
        ...(completeness ? { completeness } : {}),
        app: { name: 'Batshit', version: '0.0.1' },
        createdAt: '2026-10-11T20:00:00.000Z',
        options: { includeSecrets: false },
        contents: { redisRecordCount: 4, fileAssetCount: 1, fileAssetBytes: 3, groups: [] },
        secrets: { included: false, excludedRecordCount: 0, redactedFieldCount: 0, warning: '' },
        externalReferences: []
      },
      redisRecordCount: 4,
      fileAssetCount: 1,
      fileAssetBytes: 3,
      hostFileCount: 0,
      hostFileBytes: 0,
      requiresDestructiveConfirmation: true,
      currentRecordCount: 3,
      sourceUserId: 'u',
      targetUserId: 'u',
      userRemapRequired: false,
      warnings: completeness ? ['Partial backup: 1 upload file is not in this backup.'] : [],
      stage: { id: 's', filename: 'b.zip', archiveBytes: 10, sha256: 'e'.repeat(64), expiresAt: '2026-10-12T00:00:00.000Z' },
      disk: { requiredBytes: 1, availableBytes: 2, sufficient: true, restoredFileBytes: 3, rollbackBytes: 0, restorePlanBytes: 0 }
    }
  }

  it('Inspect says "Partial backup" and the replace confirmation repeats it; a complete backup says neither', () => {
    const partial = render(AdminBackupRestoreCard, baseProps({ preflight: preflight('partial') }))
    expect(screen.getByText('Partial backup')).toBeTruthy()
    expect(screen.getByText('Partial backup: 1 upload file is not in this backup.')).toBeTruthy()
    expect(screen.getByText('Replace current Batshit data with this partial backup. I understand this is not a merge.')).toBeTruthy()
    partial.unmount()

    render(AdminBackupRestoreCard, baseProps({ preflight: preflight() }))
    expect(screen.queryByText('Partial backup')).toBeNull()
    expect(screen.getByText('Replace current Batshit data with this backup. I understand this is not a merge.')).toBeTruthy()
  })
})
