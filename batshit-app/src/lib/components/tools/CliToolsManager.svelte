<script lang="ts">
  import { onDestroy } from 'svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Card from '$lib/components/ui/card'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_CLI_TOOL_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import {
    ChevronDown,
    Loader2,
    RefreshCw,
    TerminalSquare,
    Trash2,
    TestTube2
  } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  import CliToolInlineSettingsCard from './CliToolInlineSettingsCard.svelte'
  import type { CliToolRecord } from '$lib/types/database'

  interface Props {
    userId?: string | null
  }

  let { userId = null }: Props = $props()

  let tools = $state<CliToolRecord[]>([])
  let loading = $state(false)
  let error = $state<string | null>(null)
  let selectedToolId = $state<string | null>(null)
  let testingToolId = $state<string | null>(null)
  let deleteBusy = $state(false)
  let deleteDisclosureOpen = $state(false)
  let transientValidationSummaryByTool = $state<Record<string, string>>({})
  let transientValidationTimerByTool = new Map<string, ReturnType<typeof setTimeout>>()
  const sortedTools = $derived([...tools].sort((a, b) => a.title.localeCompare(b.title)))
  const selectedTool = $derived(
    sortedTools.find((tool) => tool.toolId === selectedToolId) ?? null
  )

  function getStatusTone(status: string | null | undefined): string {
    return (status ?? '').toLowerCase() === 'active'
      ? 'batshit-success-chip'
      : 'border-border/60 bg-muted/30 text-muted-foreground'
  }

  function getStatusLabel(status: string | null | undefined): string {
    if (!status) return 'Unknown'
    return status.charAt(0).toUpperCase() + status.slice(1)
  }

  function getValidationBadgeTone(status: string | null | undefined): string {
    switch ((status ?? '').toLowerCase()) {
      case 'passed':
        return 'batshit-success-chip'
      case 'failed':
        return 'border-destructive/30 bg-destructive/10 text-destructive'
      default:
        return 'border-border/60 bg-muted/30 text-muted-foreground'
    }
  }

  function getValidationLabel(status: string | null | undefined): string {
    switch ((status ?? '').toLowerCase()) {
      case 'passed':
        return 'Validation Passed'
      case 'failed':
        return 'Validation Failed'
      default:
        return 'Not Tested Yet'
    }
  }

  function getValidationDetails(tool: CliToolRecord): string {
    if (tool.lastValidationSummary?.trim()) {
      return tool.lastValidationSummary.trim()
    }

    switch ((tool.lastValidationStatus ?? '').toLowerCase()) {
      case 'passed':
        return 'The latest validation run completed successfully.'
      case 'failed':
        return 'The latest validation run failed. Re-run the test after making fixes.'
      default:
        return 'Run validation to confirm this tool still works the way you expect.'
    }
  }

  function getCliToolIconRef(tool: CliToolRecord) {
    return normalizeIconRef(tool.iconRef ?? tool.iconHint, DEFAULT_CLI_TOOL_ICON_REF)
  }

  function clearTransientValidationSummary(toolId: string) {
    const timer = transientValidationTimerByTool.get(toolId)
    if (timer) {
      clearTimeout(timer)
      transientValidationTimerByTool.delete(toolId)
    }
  }

  function setTransientValidationSummary(toolId: string, summary: string) {
    clearTransientValidationSummary(toolId)
    transientValidationSummaryByTool = {
      ...transientValidationSummaryByTool,
      [toolId]: summary
    }
    const timer = setTimeout(() => {
      const next = { ...transientValidationSummaryByTool }
      delete next[toolId]
      transientValidationSummaryByTool = next
      transientValidationTimerByTool.delete(toolId)
    }, 4500)
    transientValidationTimerByTool.set(toolId, timer)
  }

  function getVisibleValidationDetails(tool: CliToolRecord): string | null {
    const transient = transientValidationSummaryByTool[tool.toolId]
    if (transient?.trim()) return transient.trim()
    if ((tool.lastValidationStatus ?? '').toLowerCase() === 'failed') {
      return getValidationDetails(tool)
    }
    return null
  }

  function getAccessTone(allowWrite: boolean): string {
    return allowWrite
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      : 'border-border/60 bg-muted/30 text-muted-foreground'
  }

  function getAccessLabel(allowWrite: boolean): string {
    return allowWrite ? 'Edits allowed' : 'Read-only'
  }

  function getNetworkTone(allowNetwork: boolean): string {
    return allowNetwork
      ? 'border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300'
      : 'border-border/60 bg-muted/30 text-muted-foreground'
  }

  function getNetworkLabel(allowNetwork: boolean): string {
    return allowNetwork ? 'Uses network' : 'No network'
  }

  function getCliToolBehaviorLabel(tool: CliToolRecord): string {
    if (tool.allowWrite && tool.allowNetwork) return 'Writes + Network'
    if (tool.allowWrite) return 'Can Write'
    if (tool.allowNetwork) return 'Uses Network'
    return 'Read-Only'
  }

  function getSidebarValidationLabel(status: string | null | undefined): string {
    switch ((status ?? '').toLowerCase()) {
      case 'passed':
        return 'Validated'
      case 'failed':
        return 'Validation Failed'
      default:
        return 'Needs Testing'
    }
  }

  function getOutputSummary(outputMode: CliToolRecord['outputMode'] | null | undefined): string {
    switch (outputMode) {
      case 'json':
        return 'Returns JSON Output'
      case 'mixed':
        return 'Returns Mixed Output'
      default:
        return 'Returns Text Output'
    }
  }

  function getCliToolSidebarSubtext(tool: CliToolRecord): string {
    return `${getStatusLabel(tool.status)} • ${getSidebarValidationLabel(tool.lastValidationStatus)} • ${getCliToolBehaviorLabel(tool)}`
  }

  async function loadTools() {
    if (!userId) return
    loading = true
    error = null
    try {
      const response = await fetch('/api/cli-tools')
      if (!response.ok) throw new Error('Failed to load CLI tools')
      const payload = await response.json()
      tools = Array.isArray(payload.tools) ? payload.tools : []
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Failed to load CLI tools'
    } finally {
      loading = false
    }
  }

  async function handleDelete(tool: CliToolRecord) {
    deleteBusy = true
    try {
      const response = await fetch(`/api/cli-tools/${tool.toolId}`, { method: 'DELETE' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Failed to delete CLI tool')
      toast.success('CLI tool deleted')
      deleteDisclosureOpen = false
      await loadTools()
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : 'Failed to delete CLI tool')
    } finally {
      deleteBusy = false
    }
  }

  async function handleTest(tool: CliToolRecord) {
    testingToolId = tool.toolId
    try {
      const response = await fetch(`/api/cli-tools/${tool.toolId}/test`, { method: 'POST' })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || 'Failed to validate CLI tool')
      if (payload.success && typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
        setTransientValidationSummary(tool.toolId, payload.summary.trim())
      } else {
        clearTransientValidationSummary(tool.toolId)
      }
      toast.success(payload.success ? 'CLI tool validation passed' : 'CLI tool validation failed')
      await loadTools()
    } catch (testError) {
      clearTransientValidationSummary(tool.toolId)
      toast.error(testError instanceof Error ? testError.message : 'Failed to validate CLI tool')
    } finally {
      testingToolId = null
    }
  }

  $effect(() => {
    if (userId) {
      void loadTools()
    }
  })

  $effect(() => {
    if (sortedTools.length === 0) {
      selectedToolId = null
      return
    }

    if (!selectedToolId || !sortedTools.some((tool) => tool.toolId === selectedToolId)) {
      selectedToolId = sortedTools[0]?.toolId ?? null
    }
  })

  $effect(() => {
    selectedToolId
    deleteDisclosureOpen = false
  })

  onDestroy(() => {
    for (const timer of transientValidationTimerByTool.values()) {
      clearTimeout(timer)
    }
    transientValidationTimerByTool.clear()
  })
</script>

<div class="space-y-4">
  <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
    <div class="flex items-center gap-1.5">
      <h3 class="text-base font-semibold text-foreground">CLI Tools</h3>
      <SettingsInfoMenu ariaLabel="About CLI Tools" contentClass="w-96">
        <p>
          CLI tools are agent-managed command records. This tab is for reviewing saved tools,
          testing them, and adjusting user-owned display and safety settings.
        </p>
        <p class="mt-2">
          Technical manifest fields stay visible for inspection, but command wiring is handled by
          the CLI tool skill and Fabric controls.
        </p>
      </SettingsInfoMenu>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <Button variant="outline" onclick={loadTools} disabled={loading}>
        <RefreshCw class={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        Refresh
      </Button>
    </div>
  </div>

  {#if error}
    <div class="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {error}
    </div>
  {/if}

  {#if loading && tools.length === 0}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      Loading CLI tools…
    </div>
  {:else if tools.length === 0}
    <Card.Root class="batshit-settings-card batshit-settings-card-default">
      <Card.Content class="space-y-4 py-10 text-center">
        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-full border bg-muted/30">
          <TerminalSquare class="h-5 w-5 text-muted-foreground" />
        </div>
        <div class="space-y-2">
          <div class="font-medium">No CLI tools yet</div>
          <p class="text-sm text-muted-foreground">
            Saved CLI tools created by Batshit agents will appear here for review, validation, and
            safety adjustments.
          </p>
        </div>
      </Card.Content>
    </Card.Root>
  {:else}
    <div class="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Card.Root class="batshit-settings-card batshit-settings-card-default">
        <Card.Header class="pb-2">
          <div class="flex items-center gap-1">
            <Card.Title class="text-base">Saved CLI Tools</Card.Title>
            <SettingsInfoMenu ariaLabel="About Saved CLI Tools">
              <p>Pick a CLI tool to edit, test, or review.</p>
            </SettingsInfoMenu>
          </div>
        </Card.Header>
        <Card.Content class="batshit-settings-card-content-flush">
          <div class="settings-sidebar-items">
            {#each sortedTools as tool (tool.toolId)}
              <button
                type="button"
                class="settings-sidebar-item settings-sidebar-item-with-avatar"
                data-state={tool.toolId === selectedToolId ? 'active' : 'inactive'}
                onclick={() => (selectedToolId = tool.toolId)}
              >
                <div class="settings-sidebar-item-media pt-0.5">
                  <div class="flex h-9 w-9 items-center justify-center rounded-lg border border-border/70 bg-muted/20">
                    <IconRenderer
                      ref={getCliToolIconRef(tool)}
                      label={tool.title}
                      iconClass="h-5 w-5 text-muted-foreground"
                    />
                  </div>
                </div>
                <div class="settings-sidebar-item-content">
                  <span class="settings-sidebar-item-title truncate">{tool.title}</span>
                  <span class="settings-sidebar-item-subtext truncate">
                    {getCliToolSidebarSubtext(tool)}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        </Card.Content>
      </Card.Root>

      <div class="space-y-4">
        {#if selectedTool}
          <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-display-card">
            <Card.Content class="space-y-4 py-3">
              <div class="flex items-start justify-between gap-4">
                <div class="min-w-0 flex-1 space-y-3">
                  <div class="space-y-1.5">
                    <div class="flex flex-wrap items-center gap-2">
                      <IconRenderer
                        ref={getCliToolIconRef(selectedTool)}
                        label={selectedTool.title}
                        iconClass="h-4 w-4 text-muted-foreground"
                      />
                      <div class="font-medium text-foreground">{selectedTool.title}</div>
                      <SettingsInfoMenu ariaLabel="About CLI Tool Badges" contentClass="w-96">
                        <p>
                          <span class="font-medium text-foreground">Active</span> means this saved
                          CLI tool is available in Batshit.
                        </p>
                        <p class="mt-2">
                          <span class="font-medium text-foreground">Validation Passed</span> means
                          the latest test run succeeded.
                        </p>
                        <p class="mt-2">
                          <span class="font-medium text-foreground">Read-Only</span>,
                          <span class="font-medium text-foreground"> Edits Allowed</span>, and
                          <span class="font-medium text-foreground"> Uses Network</span> show the
                          important runtime boundaries this tool is configured with.
                        </p>
                      </SettingsInfoMenu>
                      <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${getStatusTone(selectedTool.status)}`}>
                        {getStatusLabel(selectedTool.status)}
                      </span>
                      <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${getAccessTone(selectedTool.allowWrite)}`}>
                        {getAccessLabel(selectedTool.allowWrite)}
                      </span>
                      <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${getNetworkTone(selectedTool.allowNetwork)}`}>
                        {getNetworkLabel(selectedTool.allowNetwork)}
                      </span>
                    </div>

                    <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span class="font-medium text-muted-foreground">Tool ID:</span>
                      <span class="font-mono text-foreground/80">{selectedTool.toolId}</span>
                      <span aria-hidden="true">•</span>
                      <span>{getOutputSummary(selectedTool.outputMode)}</span>
                    </div>

                    <div class="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                      <span class="min-w-0 truncate">
                        Connected to: <span class="font-mono">{selectedTool.executable}</span>
                      </span>
                    </div>
                  </div>

                  <p class="text-sm text-foreground/85">{selectedTool.description}</p>

                  <div class="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
                    <div class="min-w-0 flex-1">
                      <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${getValidationBadgeTone(selectedTool.lastValidationStatus)}`}>
                        {getValidationLabel(selectedTool.lastValidationStatus)}
                      </span>
                      {#if getVisibleValidationDetails(selectedTool)}
                        <p class="mt-1 text-muted-foreground">{getVisibleValidationDetails(selectedTool)}</p>
                      {/if}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      class="h-7 shrink-0 px-2.5 text-[11px] text-foreground"
                      onclick={() => handleTest(selectedTool)}
                      disabled={testingToolId === selectedTool.toolId}
                    >
                      {#if testingToolId === selectedTool.toolId}
                        <Loader2 class="mr-1.5 h-3 w-3 animate-spin" />
                      {:else}
                        <TestTube2 class="mr-1.5 h-3 w-3" />
                      {/if}
                      Test
                    </Button>
                  </div>

                  {#if selectedTool.tags.length > 0}
                    <div class="flex flex-wrap gap-1.5 pt-1">
                      {#each selectedTool.tags as tag}
                        <Badge variant="outline" class="border-border/60 bg-transparent text-[10px] text-muted-foreground">
                          {tag}
                        </Badge>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
            </Card.Content>
          </Card.Root>

          <CliToolInlineSettingsCard
            tool={selectedTool}
            onToolUpdated={(updatedTool) => {
              tools = tools.map((tool) => (tool.toolId === updatedTool.toolId ? updatedTool : tool))
            }}
          />

          <Collapsible.Root bind:open={deleteDisclosureOpen}>
            <div>
              <Collapsible.Trigger class="batshit-settings-delete-trigger">
                <span class="batshit-settings-delete-trigger-label">
                  <Trash2 class="batshit-settings-delete-trigger-icon" />
                  Delete CLI Tool
                </span>
                <ChevronDown
                  class={`batshit-settings-delete-chevron ${deleteDisclosureOpen ? 'is-open' : ''}`}
                />
              </Collapsible.Trigger>
              <Collapsible.Content class="batshit-settings-delete-content">
                <div class="batshit-settings-delete-content-inner">
                  <div class="batshit-settings-delete-copy">
                    <p>Permanently removes this CLI tool from Batshit.</p>
                    <p>Use this when the tool is obsolete or should be rebuilt cleanly.</p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    class="batshit-settings-delete-action"
                    onclick={() => handleDelete(selectedTool)}
                    disabled={deleteBusy}
                  >
                    {#if deleteBusy}
                      <Loader2 class="batshit-settings-delete-action-icon is-spinning" />
                    {:else}
                      <Trash2 class="batshit-settings-delete-action-icon" />
                    {/if}
                    Delete CLI Tool
                  </Button>
                </div>
              </Collapsible.Content>
            </div>
          </Collapsible.Root>
        {/if}
      </div>
    </div>
  {/if}
</div>
