<script lang="ts">
  import { onMount } from 'svelte'
  import { ChevronDown, RefreshCw } from '@lucide/svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'

  /**
   * SA-072 P1: the one read-only Pinokio line in Settings → Admin → Runtimes (DL-01). It only
   * reports what `/api/pinokio/status` detects: no setting, nothing started. The row copies the
   * other runtime rows (a label, its (i), a status badge, and a Refresh behind the disclosure);
   * the panel decides which runtime row is open.
   */
  interface Props {
    open: boolean
    onToggle: () => void
  }

  type PinokioStatus = {
    available: boolean
    reason:
      | 'containerized'
      | 'unsupported_platform'
      | 'not_installed'
      | 'unsupported_version'
      | 'pterm_missing'
      | 'not_running'
      | null
    message: string
    version: string | null
    versionFloor: string
  }

  type Tone = 'ok' | 'warning' | 'bad' | 'checking'

  let { open, onToggle }: Props = $props()

  let status = $state<PinokioStatus | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function load(fresh = false) {
    busy = true
    error = null
    try {
      const response = await fetch(`/api/pinokio/status${fresh ? '?fresh=1' : ''}`)
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload?.pinokio) {
        throw new Error(payload?.error || 'Batshit could not check for Pinokio.')
      }
      status = payload.pinokio as PinokioStatus
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Batshit could not check for Pinokio.'
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void load()
  })

  const badge = $derived.by((): { tone: Tone; label: string } | null => {
    if (busy) return { tone: 'checking', label: 'Checking…' }
    if (!status) return null
    if (status.available) return { tone: 'ok', label: 'Detected' }
    switch (status.reason) {
      case 'not_running':
        return { tone: 'warning', label: 'Not Running' }
      case 'containerized':
        return { tone: 'warning', label: 'Not in Docker' }
      case 'unsupported_version':
      case 'unsupported_platform':
        return { tone: 'bad', label: 'Unsupported' }
      case 'pterm_missing':
        return { tone: 'bad', label: 'Unavailable' }
      default:
        return { tone: 'bad', label: 'Not Detected' }
    }
  })

  function badgeClass(tone: Tone) {
    return `batshit-settings-child-label runtime-status-badge is-${tone}`
  }
</script>

<div class="batshit-settings-disclosure-row" data-testid="pinokio-runtime-row">
  <Collapsible.Root {open}>
    <div class="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left">
      <div class="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          class="batshit-settings-form-label border-0 bg-transparent p-0 text-left"
          aria-expanded={open}
          onclick={onToggle}
        >
          Pinokio
        </button>
        <SettingsInfoMenu ariaLabel="About Pinokio" contentClass="w-80">
          <p>
            Pinokio is an optional app launcher. When it runs on this computer (version 8.2.0 or newer),
            your agents can list the apps installed in it and, after you click Approve, start one.
            Batshit never installs, stops, or deletes Pinokio apps, and it works the same without Pinokio.
          </p>
        </SettingsInfoMenu>
      </div>
      <button
        type="button"
        class="flex flex-wrap items-center gap-2 border-0 bg-transparent p-0"
        aria-expanded={open}
        onclick={onToggle}
      >
        {#if badge}
          <Badge variant="outline" class={badgeClass(badge.tone)}>{badge.label}</Badge>
        {/if}
        <ChevronDown class={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
    </div>
    <Collapsible.Content class="space-y-3 px-4 pb-4">
      <div class="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onclick={() => load(true)} disabled={busy}>
          <RefreshCw class={`${busy ? 'animate-spin' : ''}`} />
          {busy ? 'Checking…' : 'Refresh'}
        </Button>
      </div>
      {#if error}
        <p class="batshit-settings-form-help is-danger">{error}</p>
      {:else if status}
        <p class="batshit-settings-form-label break-all" data-testid="pinokio-runtime-line">
          {status.message}
        </p>
      {:else}
        <p class="batshit-settings-form-label">Pinokio has not been checked yet.</p>
      {/if}
    </Collapsible.Content>
  </Collapsible.Root>
</div>
