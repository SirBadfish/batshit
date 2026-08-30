<script lang="ts">
  import { AlertCircle, Download, FileArchive, KeyRound, Loader2, RefreshCw, Upload } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    formatBackupBytes,
    formatBackupDate,
    type BackupPreflightSummary
  } from './adminSettingsTypes'

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
    onExport: (includeSecrets: boolean) => void
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
                Goons, icons, projects, and tool records are bundled into one zip.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="batshit-backup-action-row">
            <Button
              type="button"
              size="sm"
              onclick={() => onExport(false)}
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
              onclick={() => onExport(true)}
              disabled={exportBusy}
            >
              <KeyRound aria-hidden="true" />
              With Secrets
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

    {#if preflight}
      <div class="rounded-md border border-border/80 bg-muted/30 p-3">
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">Created {formatBackupDate(preflight.manifest.createdAt)}</Badge>
          <Badge variant="outline">Batshit {preflight.manifest.app.version}</Badge>
          <Badge variant="outline">{preflight.redisRecordCount} Redis records</Badge>
          <Badge variant="outline">
            {preflight.fileAssetCount} files / {formatBackupBytes(preflight.fileAssetBytes)}
          </Badge>
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
            Required space covers restored upload files, the validated Redis plan, and a disk-backed copy of current Redis data for rollback.
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
            <span>Replace current Batshit data with this backup. I understand this is not a merge.</span>
          </label>
        {/if}
      </div>
    {/if}

    {#if error}
      <p class="batshit-settings-form-help is-danger">{error}</p>
    {/if}
  </div>
</SettingsAccordionCard>
