<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Download, Loader2, RefreshCw, Trash2 } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'

  type CliRuntimeId = 'codex' | 'claude'

  type CliRuntimeSummary = {
    managed: {
      installed: boolean
      version: string | null
      pinnedVersion: string
      executablePath: string | null
      supported: boolean
      unsupportedReason: string | null
      displayName: string
    }
    resolution: {
      executable: string
      source: 'env' | 'managed' | 'path' | 'well-known' | 'not-found'
      managedVersion?: string
      found: boolean
    }
  }

  interface Props {
    runtime: CliRuntimeId
    /** Called after a successful install/remove so the parent can refresh connection status. */
    onChanged?: () => void
  }

  let { runtime, onChanged }: Props = $props()

  const displayName = $derived(runtime === 'codex' ? 'Codex CLI' : 'Claude Code CLI')
  const approxDownload = $derived(runtime === 'codex' ? 'about 90 MB' : 'about 120 MB')

  let summary = $state<CliRuntimeSummary | null>(null)
  let loading = $state(true)
  let busyOperation = $state<'install' | 'uninstall' | null>(null)
  let errorMessage = $state<string | null>(null)

  const sourceLabel = $derived.by(() => {
    if (!summary) return null
    switch (summary.resolution.source) {
      case 'env':
        return 'Using a custom path from your environment settings'
      case 'managed':
        return `Installed by Batshit (version ${summary.managed.version ?? summary.resolution.managedVersion ?? 'unknown'})`
      case 'path':
        return 'Using your own install found on this computer'
      case 'well-known':
        return 'Using your own install found on this computer'
      default:
        return 'Not installed yet'
    }
  })

  async function refresh() {
    loading = true
    errorMessage = null
    try {
      const response = await fetch('/api/cli-runtimes')
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || `Failed to check ${displayName} status.`)
      }
      summary = payload?.runtimes?.[runtime] ?? null
    } catch (error) {
      summary = null
      errorMessage = error instanceof Error ? error.message : `Failed to check ${displayName} status.`
    } finally {
      loading = false
    }
  }

  async function runOperation(operation: 'install' | 'uninstall') {
    busyOperation = operation
    errorMessage = null
    try {
      const response = await fetch('/api/cli-runtimes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runtime, operation })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(
          payload?.error || `Failed to ${operation === 'install' ? 'install' : 'remove'} ${displayName}.`
        )
      }
      summary = {
        managed: payload.managed,
        resolution: payload.resolution
      }
      toast.success(
        operation === 'install'
          ? `${displayName} installed. Next step: sign in.`
          : `${displayName} managed install removed.`
      )
      onChanged?.()
      dispatchModelConnectionsUpdated('runtime')
    } catch (error) {
      errorMessage =
        error instanceof Error
          ? error.message
          : `Failed to ${operation === 'install' ? 'install' : 'remove'} ${displayName}.`
    } finally {
      busyOperation = null
    }
  }

  $effect(() => {
    void runtime
    void refresh()
  })
</script>

<div class="batshit-settings-inline-alert is-dashed space-y-2" data-testid="cli-runtime-manager-{runtime}">
  <div class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <p class="batshit-settings-parent-label">{displayName}</p>
      {#if loading}
        <p class="batshit-settings-form-meta">Checking install status…</p>
      {:else if summary}
        <p class="batshit-settings-form-meta">{sourceLabel}</p>
        {#if summary.resolution.found && summary.resolution.source !== 'not-found'}
          <p class="batshit-settings-caption batshit-model-id truncate" title={summary.resolution.executable}>
            {summary.resolution.executable}
          </p>
        {/if}
      {:else}
        <p class="batshit-settings-form-meta">Status unavailable.</p>
      {/if}
    </div>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="h-8 w-8 shrink-0"
      title="Refresh {displayName} status"
      aria-label="Refresh {displayName} status"
      onclick={refresh}
      disabled={loading || busyOperation !== null}
    >
      <RefreshCw class={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
    </Button>
  </div>

  {#if summary && !summary.managed.supported}
    <p class="batshit-settings-form-meta text-amber-600 dark:text-amber-400">
      {summary.managed.unsupportedReason}
    </p>
  {:else if summary}
    <div class="flex flex-wrap items-center gap-2">
      {#if busyOperation === 'install'}
        <Button type="button" size="sm" disabled>
          <Loader2 class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          Downloading ({approxDownload})…
        </Button>
      {:else if summary.managed.installed}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onclick={() => runOperation('install')}
          disabled={busyOperation !== null}
        >
          <Download class="mr-1.5 h-3.5 w-3.5" />
          Reinstall
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onclick={() => runOperation('uninstall')}
          disabled={busyOperation !== null}
        >
          {#if busyOperation === 'uninstall'}
            <Loader2 class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          {:else}
            <Trash2 class="mr-1.5 h-3.5 w-3.5" />
          {/if}
          Remove
        </Button>
      {:else if !summary.resolution.found}
        <Button
          type="button"
          size="sm"
          onclick={() => runOperation('install')}
          disabled={busyOperation !== null}
        >
          <Download class="mr-1.5 h-3.5 w-3.5" />
          Install {displayName}
        </Button>
        <span class="batshit-settings-caption">One click — Batshit downloads and manages it for you.</span>
      {:else}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onclick={() => runOperation('install')}
          disabled={busyOperation !== null}
        >
          <Download class="mr-1.5 h-3.5 w-3.5" />
          Install Batshit-managed copy
        </Button>
        <span class="batshit-settings-caption">Optional — your own install keeps working.</span>
      {/if}
    </div>
    {#if summary.managed.installed && summary.resolution.source !== 'managed'}
      <p class="batshit-settings-form-meta text-amber-600 dark:text-amber-400">
        A Batshit-managed install exists, but an explicit environment override is being used instead.
      </p>
    {/if}
  {/if}

  {#if errorMessage}
    <p class="batshit-settings-form-meta text-destructive">{errorMessage}</p>
  {/if}
</div>
