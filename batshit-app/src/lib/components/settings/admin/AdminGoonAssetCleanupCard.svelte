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
        uses anymore. Cleanup only removes orphaned upload records and files; it does not change
        active Goon settings.
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
              are orphaned. Clean Orphans asks for confirmation before deleting anything.
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
            disabled={auditBusy || cleanupBusy || (audit !== null && audit.orphanRecordCount <= 0)}
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
        <Badge variant="outline">{formatBackupBytes(audit.orphanBytes)} orphaned</Badge>
      </div>
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
    </div>
  {/if}

  {#if error}
    <p class="batshit-settings-form-help is-danger">{error}</p>
  {/if}
</SettingsAccordionCard>
