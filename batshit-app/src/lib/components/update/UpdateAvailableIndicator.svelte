<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Bell,
    ExternalLink,
    RefreshCw,
    ShieldCheck
  } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import type { BatshitUpdateStatus } from '$lib/types/updateStatus'

  const CACHE_KEY = 'batshit:update-status:v1'
  const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
  const UPDATE_DOCS_URL = 'https://docs.batshit.ai/installation/updating-batshit/'

  type CachedUpdateStatus = {
    savedAt: number
    status: BatshitUpdateStatus
  }

  let status = $state<BatshitUpdateStatus | null>(null)
  let checking = $state(false)
  let open = $state(false)

  const showIndicator = $derived(Boolean(status?.updateAvailable))
  const checkedLabel = $derived.by(() => {
    if (!status?.checkedAt) return null
    const date = new Date(status.checkedAt)
    if (Number.isNaN(date.getTime())) return null
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  })

  function readCachedStatus(): CachedUpdateStatus | null {
    if (typeof localStorage === 'undefined') return null
    try {
      const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
      if (!parsed || typeof parsed.savedAt !== 'number' || !parsed.status) return null
      return parsed as CachedUpdateStatus
    } catch {
      return null
    }
  }

  function writeCachedStatus(nextStatus: BatshitUpdateStatus) {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        status: nextStatus
      })
    )
  }

  async function checkForUpdates(force = false) {
    if (checking) return

    if (!force) {
      const cached = readCachedStatus()
      if (cached && Date.now() - cached.savedAt < CHECK_INTERVAL_MS) {
        status = cached.status
        return
      }
    }

    checking = true
    try {
      const response = await fetch(`/api/app/update-status${force ? '?force=1' : ''}`)
      if (!response.ok) {
        throw new Error(`Update check failed with ${response.status}`)
      }
      const nextStatus = (await response.json()) as BatshitUpdateStatus
      status = nextStatus
      writeCachedStatus(nextStatus)
    } catch (error) {
      console.warn('[UpdateAvailableIndicator] Update check failed:', error)
      status = null
    } finally {
      checking = false
    }
  }

  function openAdminBackup() {
    open = false
    window.dispatchEvent(new CustomEvent('batshit:open-settings', { detail: { tab: 'admin' } }))
  }

  onMount(() => {
    void checkForUpdates(false)
  })
</script>

{#if showIndicator && status}
  <DropdownMenu.Root bind:open>
    <Tooltip.Root>
      <Tooltip.Trigger>
        {#snippet child({ props })}
          <DropdownMenu.Trigger
            {...props}
            class="update-available-trigger"
            aria-label="Update available"
            title="Update available"
            data-testid="update-available-button"
            data-ab-control="update-available"
          >
            <Bell class="update-available-trigger-icon" />
            <span class="update-available-dot"></span>
            <span class="update-available-screen-reader">Update available</span>
          </DropdownMenu.Trigger>
        {/snippet}
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>Update Available</p>
      </Tooltip.Content>
    </Tooltip.Root>

    <DropdownMenu.Content align="end" class="update-available-menu-content">
      <div class="update-available-menu-shell">
        <div class="update-available-menu-heading">
          <div>
            <DropdownMenu.Label class="update-available-menu-title">Update Available</DropdownMenu.Label>
            <p class="update-available-menu-subtitle">
              {status.currentVersion} → {status.latestVersion}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            class="update-available-refresh"
            aria-label="Refresh update check"
            title="Refresh update check"
            disabled={checking}
            onclick={() => checkForUpdates(true)}
          >
            <RefreshCw class={`update-available-refresh-icon ${checking ? 'is-spinning' : ''}`} />
          </Button>
        </div>

        <DropdownMenu.Separator />

        <div class="update-available-backup-note">
          <ShieldCheck class="update-available-note-icon" />
          <p>Alpha update: back up from Admin before replacing the app or rebuilding Docker.</p>
        </div>

        <div class="update-available-meta">
          <div>
            <span>Channel</span>
            <strong>{status.channel}</strong>
          </div>
          {#if checkedLabel}
            <div>
              <span>Checked</span>
              <strong>{checkedLabel}</strong>
            </div>
          {/if}
        </div>

        <div class="update-available-actions">
          <Button variant="secondary" size="sm" onclick={openAdminBackup}>
            Backup First
          </Button>
          <Button variant="outline" size="sm" href={UPDATE_DOCS_URL} target="_blank" rel="noreferrer">
            Update Docs
            <ExternalLink class="update-available-action-icon" />
          </Button>
          {#if status.releaseUrl}
            <Button variant="default" size="sm" href={status.releaseUrl} target="_blank" rel="noreferrer">
              Release
              <ExternalLink class="update-available-action-icon" />
            </Button>
          {/if}
        </div>
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}

<style>
  :global(.update-available-trigger) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: var(--app-header-height);
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--foreground);
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  :global(.update-available-trigger:hover),
  :global(.update-available-trigger[data-state='open']) {
    background: color-mix(in oklab, #f59e0b 14%, transparent);
    color: color-mix(in oklab, #f59e0b 82%, var(--foreground));
  }

  :global(.update-available-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 2px var(--ring);
  }

  :global(.update-available-trigger-icon) {
    width: 16px;
    height: 16px;
  }

  .update-available-dot {
    position: absolute;
    top: 11px;
    right: 10px;
    width: 7px;
    height: 7px;
    border: 1px solid var(--background);
    border-radius: 999px;
    background: #f59e0b;
  }

  .update-available-screen-reader {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  :global(.update-available-menu-content) {
    width: min(380px, calc(100vw - 24px));
    max-height: min(520px, calc(100vh - 24px));
  }

  .update-available-menu-shell {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
  }

  .update-available-menu-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  :global(.update-available-menu-title) {
    padding: 0;
    font-size: 0.875rem;
  }

  .update-available-menu-subtitle {
    margin: 2px 0 0;
    color: var(--muted-foreground);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
  }

  :global(.update-available-refresh) {
    width: 30px;
    height: 30px;
    flex: 0 0 auto;
  }

  :global(.update-available-refresh-icon),
  :global(.update-available-action-icon) {
    width: 14px;
    height: 14px;
  }

  :global(.update-available-refresh-icon.is-spinning) {
    animation: update-spin 700ms linear infinite;
  }

  .update-available-backup-note {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 9px;
    padding: 10px;
    border: 1px solid color-mix(in oklab, #f59e0b 28%, var(--border));
    border-radius: 8px;
    background: color-mix(in oklab, #f59e0b 9%, transparent);
    color: var(--foreground);
  }

  .update-available-backup-note p {
    margin: 0;
    font-size: 0.8125rem;
    line-height: 1.35;
  }

  :global(.update-available-note-icon) {
    width: 16px;
    height: 16px;
    margin-top: 1px;
    color: #d97706;
  }

  .update-available-meta {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .update-available-meta div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in oklab, var(--muted) 62%, transparent);
  }

  .update-available-meta span {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    line-height: 1;
    text-transform: uppercase;
  }

  .update-available-meta strong {
    overflow: hidden;
    font-size: 0.8125rem;
    font-weight: 600;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .update-available-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
  }

  :global(.update-available-actions .bs-button) {
    gap: 6px;
  }

  @keyframes update-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
