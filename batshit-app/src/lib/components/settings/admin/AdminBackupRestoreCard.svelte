<script lang="ts">
  import { AlertCircle, Download, FileArchive, FileSearch, KeyRound, Loader2, RefreshCw, Upload } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { confirmDialog, confirmDialogWithCheckbox } from '$lib/stores/confirmDialog'
  import type { BackupUploadCheck } from '$lib/types/backupUploadCheck'
  import type { BackupPartialRequest } from '$lib/utils/backupPartialSummary'
  import {
    formatBackupBytes,
    formatBackupDate,
    type BackupExportOutcome,
    type BackupPreflightSummary
  } from './adminSettingsTypes'
  import {
    canMakePartialBackup,
    describePartialBackupConfirmation,
    describeUploadFolderHint,
    describeUploadProblemKind,
    fetchBackupUploadCheck
  } from './backupUploadCheck'

  interface Props {
    exportBusy: boolean
    preflightBusy: boolean
    stageProgress: number | null
    restoreBusy: boolean
    selectedFile: File | null
    preflight: BackupPreflightSummary | null
    error: string | null
    confirmReplace: boolean
    onConfirmReplaceChange: (checked: boolean) => void
    /** `partial` only from Make a Partial Backup (BL-378 Phase 1b); a plain export passes one argument. */
    onExport: (includeSecrets: boolean, partial?: BackupPartialRequest) => Promise<BackupExportOutcome>
    onFileSelected: (event: Event) => void
    onPreflight: () => void
    onRestore: () => void
  }

  let {
    exportBusy,
    preflightBusy,
    stageProgress,
    restoreBusy,
    selectedFile,
    preflight,
    error,
    confirmReplace,
    onConfirmReplaceChange,
    onExport,
    onFileSelected,
    onPreflight,
    onRestore
  }: Props = $props()

  let fileInputRef = $state<HTMLInputElement | null>(null)

  // BL-378: the read-only upload check. It only reads; fixing happens where each file is used.
  let uploadCheck = $state<BackupUploadCheck | null>(null)
  let uploadCheckBusy = $state(false)
  let uploadCheckError = $state<string | null>(null)
  // BL-378 Phase 1b: why Make a Partial Backup sent nothing (the second box was not ticked).
  let partialBackupNote = $state<string | null>(null)
  const PARTIAL_BACKUP_NEEDS_THE_BOX =
    'Nothing was exported. When none of the files are in the upload folder, a partial backup needs the box "The upload folder is the right one" ticked; check the upload folder first.'

  async function runUploadCheck() {
    if (uploadCheckBusy) return
    uploadCheckBusy = true
    uploadCheckError = null
    // A new check is a new list: an earlier "nothing was exported" line no longer applies to it.
    partialBackupNote = null
    try {
      uploadCheck = await fetchBackupUploadCheck()
    } catch (checkError) {
      uploadCheck = null
      uploadCheckError = checkError instanceof Error ? checkError.message : 'Checking upload files failed.'
    } finally {
      uploadCheckBusy = false
    }
  }

  /**
   * After a failed export, check the upload files at once, so the list is there with the error;
   * after a finished export, refresh a list already shown so it never goes stale. A cancel (the
   * With Secrets confirmation or a save chooser) or a busy return starts nothing. The panel's
   * answer decides (BL-1381): an error still showing from an earlier export says nothing about
   * this one.
   */
  async function exportThenCheck(includeSecrets: boolean) {
    const outcome = await onExport(includeSecrets)
    if (outcome === 'failed' || (outcome === 'exported' && uploadCheck)) await runUploadCheck()
  }

  /**
   * BL-378 Phase 1b: the partial backup acknowledges exactly the rows shown (each record's key,
   * path and fingerprint), after a confirmation; the server re-checks them at action time and
   * refuses anything that changed. The second box is asked only when the server's predicate says
   * the folder held none of the files; only a ticked box sends the request (with
   * `confirmAllMissing`), and an unticked one sends nothing and says why. Cancel sends nothing.
   * The list shown is refreshed afterwards, as after any export.
   */
  async function makePartialBackup() {
    const check = uploadCheck
    if (!canMakePartialBackup(check) || exportBusy) return
    partialBackupNote = null
    const confirmation = describePartialBackupConfirmation(check)
    const dialog = {
      title: confirmation.title,
      description: confirmation.description,
      confirmLabel: 'Make a Partial Backup',
      cancelLabel: 'Cancel'
    }
    let confirmAllMissing = false
    if (confirmation.checkbox) {
      const answer = await confirmDialogWithCheckbox({ ...dialog, checkbox: confirmation.checkbox })
      if (!answer.confirmed) return
      // The server refuses this case without the box, so the card does not send it at all.
      if (!answer.checked) {
        partialBackupNote = PARTIAL_BACKUP_NEEDS_THE_BOX
        return
      }
      confirmAllMissing = true
    } else if (!(await confirmDialog(dialog))) {
      return
    }
    const partial: BackupPartialRequest = {
      acknowledged: check.problems.map(({ key, relativePath, fingerprint }) => ({ key, relativePath, fingerprint })),
      ...(confirmAllMissing ? { confirmAllMissing: true as const } : {})
    }
    const outcome = await onExport(false, partial)
    if (outcome === 'failed' || outcome === 'exported') await runUploadCheck()
  }
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Backup and Restore"
  icon={FileArchive}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Backup and Restore" contentClass="w-80">
      <p>
        Export a Batshit-owned data bundle or restore one into this instance. Restore replaces
        current Batshit data after confirmation.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="space-y-4">
    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Export Backup</Label.Root>
            <SettingsInfoMenu ariaLabel="About Export Backup" contentClass="w-80">
              <p>
                Exports can take a few minutes when your instance has large uploads, especially Goon
                files. Default backups exclude saved API keys, secret keys, tokens, webhook auth, and
                other secrets. With Secrets includes those private credentials in the backup zip; only
                use it for an intentional private transfer because the file is not encrypted. Upload
                files stored by Batshit are included. Chats, agents, settings, clips, zips, artifacts,
                Goons, icons, projects, tool records, your own skills with their files, and clone voice
                recordings are bundled into one zip. A backup stops when an uploaded file it needs is
                missing or cannot be read. Check Upload Files looks for each file without opening it,
                and lists any that are missing, are not a file, or cannot be checked, with where to
                fix it. It also lists any upload record saved in a form a backup cannot carry (an
                unsupported record). When every file it lists is missing, Make a Partial Backup
                exports everything else and names each missing file; it cannot contain those
                files, and a restore of it leaves them missing.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="batshit-backup-action-row">
            <Button
              type="button"
              size="sm"
              onclick={() => exportThenCheck(false)}
              disabled={exportBusy}
            >
              {#if exportBusy}
                <Loader2 class="animate-spin" aria-hidden="true" />
              {:else}
                <Download aria-hidden="true" />
              {/if}
              Export
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onclick={() => exportThenCheck(true)}
              disabled={exportBusy}
            >
              <KeyRound aria-hidden="true" />
              With Secrets
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onclick={runUploadCheck}
              disabled={uploadCheckBusy}
            >
              {#if uploadCheckBusy}
                <Loader2 class="animate-spin" aria-hidden="true" />
                Checking
              {:else}
                <FileSearch aria-hidden="true" />
                Check Upload Files
              {/if}
            </Button>
          </div>
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label" for="backup-restore-file">
              Restore Backup
            </Label.Root>
            <SettingsInfoMenu ariaLabel="About Restore Backup" contentClass="w-80">
              <p>
                Restore validates the bundle first. It does not add to or merge with your current
                instance; it replaces current Batshit data after confirmation. Export a fresh backup
                first if you want a safety copy. External n8n workflows, local engine installs, and
                model weights are not silently copied.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="batshit-settings-form-control-group">
            <input
              id="backup-restore-file"
              bind:this={fileInputRef}
              class="sr-only"
              type="file"
              accept=".zip,application/zip"
              onchange={onFileSelected}
              disabled={preflightBusy || restoreBusy}
            />
            <div class="batshit-backup-file-picker">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onclick={() => fileInputRef?.click()}
                disabled={preflightBusy || restoreBusy}
              >
                <FileArchive aria-hidden="true" />
                Choose File
              </Button>
              <span
                class={`batshit-backup-file-name ${selectedFile ? 'has-file' : ''}`}
                title={selectedFile?.name ?? 'No file chosen'}
              >
                {selectedFile?.name ?? 'No file chosen'}
              </span>
              {#if selectedFile}
                <span class="batshit-settings-form-help">{formatBackupBytes(selectedFile.size)}</span>
              {/if}
            </div>
            <div class="batshit-backup-action-row">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onclick={onPreflight}
                disabled={!selectedFile || preflightBusy || restoreBusy}
              >
                {#if preflightBusy}
                  <Loader2 class="animate-spin" aria-hidden="true" />
                  {stageProgress !== null && stageProgress < 100
                    ? `Staging ${stageProgress}%`
                    : 'Inspecting'}
                {:else}
                  <RefreshCw aria-hidden="true" />
                  Inspect
                {/if}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onclick={onRestore}
                disabled={!selectedFile || !preflight || !preflight.disk.sufficient || restoreBusy || preflightBusy}
              >
                {#if restoreBusy}
                  <Loader2 class="animate-spin" aria-hidden="true" />
                  Restoring
                {:else}
                  <Upload aria-hidden="true" />
                  Restore
                {/if}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>

    {#if uploadCheck}
      <div class="rounded-md border border-border/80 bg-muted/30 p-3" data-testid="backup-upload-check">
        {#if uploadCheck.rootProblem}
          <p class="batshit-settings-form-help is-danger">{uploadCheck.exportBlockedMessage}</p>
        {:else if uploadCheck.problemCount === 0}
          <p class="batshit-settings-form-help">
            {#if uploadCheck.fileBackedCount === 0}
              This instance has no uploaded files for a backup to check.
            {:else}
              {uploadCheck.foundCount} uploaded {uploadCheck.foundCount === 1 ? 'file was found as a regular file' : 'files were found as regular files'} in the upload folder{uploadCheck.legacyCopyCount > 0
                ? `, and ${uploadCheck.legacyCopyCount} older ${uploadCheck.legacyCopyCount === 1 ? 'upload will use the copy saved in its record' : 'uploads will use the copies saved in their records'}`
                : ''}. This check only looks for each file; a backup still reads every file as it copies it,
              and stops if one cannot be read.
            {/if}
          </p>
        {:else}
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {uploadCheck.problemFileCount}
              {uploadCheck.problemFileCount === 1 ? 'file' : 'files'} cannot be backed up
            </Badge>
            {#if uploadCheck.problemCount !== uploadCheck.problemFileCount}
              <Badge variant="outline">{uploadCheck.problemCount} upload records</Badge>
            {/if}
            {#if uploadCheck.counts.missing > 0}
              <Badge variant="outline">{uploadCheck.counts.missing} missing</Badge>
            {/if}
            {#if uploadCheck.counts.unreadable > 0}
              <Badge variant="outline">{uploadCheck.counts.unreadable} unreadable</Badge>
            {/if}
            {#if uploadCheck.counts.notAFile > 0}
              <Badge variant="outline">{uploadCheck.counts.notAFile} not a file</Badge>
            {/if}
            {#if uploadCheck.counts.unsupportedRecord > 0}
              <Badge variant="outline">
                {uploadCheck.counts.unsupportedRecord} unsupported {uploadCheck.counts.unsupportedRecord === 1 ? 'record' : 'records'}
              </Badge>
            {/if}
            {#if uploadCheck.fileBackedCount > 0}
              <Badge variant="outline">{uploadCheck.foundCount} of {uploadCheck.fileBackedCount} found</Badge>
            {/if}
          </div>
          <p class="batshit-settings-form-help is-warning">
            A backup stops until these are fixed. Fix each one where it is used; Batshit does not
            delete these records for you.
          </p>
          {#if describeUploadFolderHint(uploadCheck)}
            <p class="batshit-settings-form-help is-warning">{describeUploadFolderHint(uploadCheck)}</p>
          {/if}
          {#if canMakePartialBackup(uploadCheck)}
            <div class="batshit-backup-action-row mt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onclick={makePartialBackup}
                disabled={exportBusy || uploadCheckBusy}
              >
                <Download aria-hidden="true" />
                Make a Partial Backup
              </Button>
            </div>
            {#if partialBackupNote}
              <p class="batshit-settings-form-help is-warning">{partialBackupNote}</p>
            {/if}
          {/if}
          <details class="mt-3" open>
            <summary class="batshit-settings-form-label">Files and Reasons</summary>
            <div class="mt-3 space-y-3">
              {#each uploadCheck.problems as problem (problem.key)}
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-form-label-line">
                    <span class="batshit-settings-form-label break-all">{problem.relativePath}</span>
                    <Badge variant="outline">{describeUploadProblemKind(problem)}</Badge>
                  </div>
                  <p class="batshit-settings-form-help">{problem.owner.label}</p>
                  <p class={`batshit-settings-form-help ${problem.owner.urgent ? 'is-danger' : ''}`}>
                    {problem.owner.repair}
                  </p>
                </div>
              {/each}
            </div>
            {#if uploadCheck.truncated}
              <p class="batshit-settings-form-help">
                Showing the first {uploadCheck.listLimit} of {uploadCheck.problemCount}.
              </p>
            {/if}
          </details>
        {/if}
      </div>
    {/if}

    {#if uploadCheckError}
      <p class="batshit-settings-form-help is-danger">{uploadCheckError}</p>
    {/if}

    {#if preflight}
      <div class="rounded-md border border-border/80 bg-muted/30 p-3">
        <div class="flex flex-wrap items-center gap-2">
          {#if preflight.manifest.completeness === 'partial'}
            <Badge variant="outline">Partial backup</Badge>
          {/if}
          <Badge variant="outline">Created {formatBackupDate(preflight.manifest.createdAt)}</Badge>
          <Badge variant="outline">Batshit {preflight.manifest.app.version}</Badge>
          <Badge variant="outline">{preflight.redisRecordCount} Redis records</Badge>
          <Badge variant="outline">
            {preflight.fileAssetCount} files / {formatBackupBytes(preflight.fileAssetBytes)}
          </Badge>
          {#if preflight.hostFileCount > 0}
            <Badge variant="outline">
              {preflight.hostFileCount} skill and voice files / {formatBackupBytes(preflight.hostFileBytes)}
            </Badge>
          {/if}
          <Badge variant="outline">
            Secrets {preflight.manifest.secrets.included ? 'Included' : 'Excluded'}
          </Badge>
          <Badge variant="outline">Archive {formatBackupBytes(preflight.stage.archiveBytes)}</Badge>
          {#if preflight.userRemapRequired}
            <Badge variant="outline">
              {preflight.sourceUserId} -> {preflight.targetUserId}
            </Badge>
          {/if}
        </div>
        <div class="mt-3 rounded border border-border/70 bg-background/60 px-2.5 py-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="batshit-settings-form-label">Restore Disk Space</span>
            <span class={`batshit-settings-form-help ${preflight.disk.sufficient ? '' : 'is-danger'}`}>
              {formatBackupBytes(preflight.disk.requiredBytes)} required / {formatBackupBytes(preflight.disk.availableBytes)} available
            </span>
          </div>
          <p class="batshit-settings-form-help">
            Required space covers restored upload, skill, and voice files, the validated Redis plan, and a disk-backed copy of current Redis data for rollback.
          </p>
        </div>
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          {#each preflight.manifest.contents.groups.filter((group) => group.recordCount > 0 || group.fileAssetCount > 0) as group}
            <div class="rounded border border-border/70 bg-background/60 px-2.5 py-2">
              <div class="flex items-center justify-between gap-2">
                <span class="batshit-settings-form-label">{group.label}</span>
                <span class="batshit-settings-form-help">
                  {group.recordCount}{group.fileAssetCount ? ` + ${group.fileAssetCount} files` : ''}
                </span>
              </div>
            </div>
          {/each}
        </div>
        <div class="mt-3 space-y-2">
          {#each preflight.warnings as warning}
            <div class="flex gap-2 text-sm text-muted-foreground">
              <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
              <span>{warning}</span>
            </div>
          {/each}
        </div>
        {#if preflight.requiresDestructiveConfirmation}
          <label class="mt-3 flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              class="mt-1 h-4 w-4"
              checked={confirmReplace}
              onchange={(event) =>
                onConfirmReplaceChange((event.target as HTMLInputElement).checked)}
            />
            <span>
              Replace current Batshit data with this {preflight.manifest.completeness === 'partial' ? 'partial backup' : 'backup'}. I understand this is not a merge.
            </span>
          </label>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="batshit-settings-form-help is-danger">{error}</p>
    {/if}
  </div>
</SettingsAccordionCard>
