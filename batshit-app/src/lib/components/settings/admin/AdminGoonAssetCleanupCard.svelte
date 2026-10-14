<script lang="ts">
  import { Loader2, RefreshCw, Trash2 } from '@lucide/svelte'
  import * as Label from '$lib/components/ui/label'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    formatBackupBytes,
    formatGoonUploadType,
    visibleGoonAssetTypeRows,
    type GoonAssetAuditSummary
  } from './adminSettingsTypes'

  interface Props {
    auditBusy: boolean
    cleanupBusy: boolean
    audit: GoonAssetAuditSummary | null
    error: string | null
    onInspect: () => void
    onCleanup: () => void
  }

  let { auditBusy, cleanupBusy, audit, error, onInspect, onCleanup }: Props = $props()
</script>

<SettingsAccordionCard
  name="admin-settings-cards"
  title="Goon Asset Cleanup"
  icon={Trash2}
  contentClass="space-y-4"
>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Goon Asset Cleanup" contentClass="w-80">
      <p>
        Finds uploaded Goon files that no current Goon, Motion Vault item, Closet item, or Scene
        references. Inspect explains each orphan. Scene files with unknown reference history are
        preserved because a failed or partial settings write can remove their references.
        Cleanup never restores settings or guesses where a file belonged.
      </p>
    </SettingsInfoMenu>
  {/snippet}
  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label">Garbage Collection</Label.Root>
          <SettingsInfoMenu ariaLabel="About Goon Garbage Collection" contentClass="w-80">
            <p>
              Use Inspect first to see how many Goon upload records are still referenced and how many
              are orphaned. An orphan has no current saved reference; that alone does not prove it
              was removed intentionally. Clean Orphans asks for confirmation and deletes only the
              inspected eligible files. Preserved files stay in storage.
            </p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <div class="batshit-backup-action-row">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onclick={onInspect}
            disabled={auditBusy || cleanupBusy}
          >
            {#if auditBusy}
              <Loader2 class="animate-spin" aria-hidden="true" />
              Inspecting
            {:else}
              <RefreshCw aria-hidden="true" />
              Inspect
            {/if}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onclick={onCleanup}
            disabled={auditBusy || cleanupBusy || !audit || audit.cleanupCandidateCount <= 0}
          >
            {#if cleanupBusy}
              <Loader2 class="animate-spin" aria-hidden="true" />
              Cleaning
            {:else}
              <Trash2 aria-hidden="true" />
              Clean Orphans
            {/if}
          </Button>
        </div>
      </div>
    </div>
  </div>

  {#if audit}
    <div class="rounded-md border border-border/80 bg-muted/30 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{audit.uploadRecordCount} upload records</Badge>
        <Badge variant="outline">{audit.referencedRecordCount} referenced</Badge>
        <Badge variant="outline">{audit.orphanRecordCount} orphaned</Badge>
        <Badge variant="outline">{audit.cleanupCandidateCount} eligible for cleanup</Badge>
        <Badge variant="outline">{audit.preservedOrphanRecordCount} preserved</Badge>
        <Badge variant="outline">{formatBackupBytes(audit.cleanupCandidateBytes)} eligible</Badge>
      </div>
      {#if audit.preservedOrphanRecordCount > 0}
        <p class="batshit-settings-form-help is-warning">
          Scene files are preserved. The audit has no earlier settings snapshot to determine
          whether their references were lost recently or removed intentionally.
        </p>
      {/if}
      {#if audit.orphanRecordCount > 0}
        <div class="mt-3 grid gap-2 sm:grid-cols-2">
          {#each visibleGoonAssetTypeRows(audit).filter((entry) => entry.orphanRecordCount > 0) as entry}
            <div class="rounded border border-border/70 bg-background/60 px-2.5 py-2">
              <div class="flex items-center justify-between gap-2">
                <span class="batshit-settings-form-label">
                  {formatGoonUploadType(entry.uploadType)}
                </span>
                <span class="batshit-settings-form-help">
                  {entry.orphanRecordCount} / {formatBackupBytes(entry.orphanBytes)}
                </span>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {#if audit.orphans.length > 0 || audit.cleanupCandidates.length > 0}
        <details class="mt-3">
          <summary class="batshit-settings-form-label">Files and Reasons</summary>
          <div class="mt-3 space-y-3">
            {#each [...audit.orphans, ...audit.cleanupCandidates.filter((candidate) => !audit.orphans.some((orphan) => orphan.uploadType === candidate.uploadType && orphan.filename === candidate.filename))] as file (`${file.uploadType}/${file.filename}`)}
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label break-all">{file.filename}</span>
                  <Badge variant="outline">{file.cleanupEligible ? 'Eligible' : 'Preserved'}</Badge>
                </div>
                <p class="batshit-settings-form-help">{formatGoonUploadType(file.uploadType)} · {formatBackupBytes(file.size)}</p>
                <p class="batshit-settings-form-help">{file.reason}</p>
              </div>
            {/each}
          </div>
        </details>
      {/if}
    </div>
  {/if}

  {#if error}
    <p class="batshit-settings-form-help is-danger">{error}</p>
  {/if}
</SettingsAccordionCard>
