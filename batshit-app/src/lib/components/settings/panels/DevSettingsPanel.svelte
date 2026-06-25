<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import * as Card from '$lib/components/ui/card'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Textarea } from '$lib/components/ui/textarea'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import SystemPromptEditor from '$lib/components/settings/SystemPromptEditor.svelte'
  import {
    BookOpen,
    ChevronDown,
    Copy,
    Database,
    ExternalLink,
    Eye,
    Loader2,
    Pencil,
    RefreshCcw,
    Sparkles
  } from '@lucide/svelte'
  import type { ClipRow, UserSettingsRow } from '$lib/types/database'
  import type { CatalogSyncReportIndexEntry, CatalogSyncStoredReport } from '$lib/types/modelCatalogSyncReport'
  import type { CompatibilityMatrixSnapshot } from '$lib/types/compatibilityMatrix'
  import { copyTextToClipboard } from '$lib/utils/clipboard'

  type CatalogReadinessPayload = {
    ready: boolean
    status: 'ready' | 'degraded'
    checkedAt: string
    warnings: string[]
    checks: {
      kvRestApiUrl: boolean
      kvWriteToken: boolean
      kvReadToken: boolean
      readTokenSource: 'read-only' | 'write-fallback' | 'missing'
    }
    probes: {
      readReports: {
        ok: boolean
        statusCode?: number
        message?: string
      }
      writeProbe: {
        ok: boolean
        statusCode?: number
        message?: string
      }
    }
  }

  type PanelData = {
    user?: { id: string; email?: string | null; is_admin?: boolean } | null
    userSettings?: UserSettingsRow | null
  } | null

  let { data = null }: { data?: PanelData } = $props()

  const isRegistryAdmin = $derived(Boolean(data?.user?.is_admin))

  async function copyReportJson(report: CatalogSyncStoredReport) {
    try {
      await copyTextToClipboard(JSON.stringify(report, null, 2))
    } catch (error) {
      console.error('Failed to copy catalog report JSON:', error)
    }
  }

  type SystemClip = ClipRow & { systemClip?: boolean }
  type SystemClipTemplate = {
    id: string
    filename: string
    description: string
  }

  const SYSTEM_CLIP_TEMPLATES: SystemClipTemplate[] = [
    {
      id: 'batshit_guide',
      filename: 'Batshit Guide',
      description: 'On-demand Batshit helper: zips, clips, agents, models, quick how-tos.'
    },
    {
      id: 'goon_guide',
      filename: 'Goon Guide',
      description: 'VRoid-first Goons + motion vault (VRMA/FBX).'
    }
  ]

  let systemClips = $state<SystemClip[]>([])
  let systemClipError = $state<string | null>(null)
  let systemClipsLoading = $state(false)
  let systemClipCreatingId = $state<string | null>(null)
  let clipViewerOpen = $state(false)
  let clipViewerTitle = $state('')
  let clipViewerContent = $state('')
  let clipViewerLink = $state<string | null>(null)
  let clipViewerMode = $state<'view' | 'edit'>('view')
  let clipViewerClip = $state<SystemClip | null>(null)
  const missingSystemClips = $derived(
    SYSTEM_CLIP_TEMPLATES.filter(
      (template) =>
        !systemClips.some(
          (clip) =>
            clip.id === template.id || clip.filename.toLowerCase() === template.filename.toLowerCase()
        )
    )
  )

  let catalogReportIndex = $state<CatalogSyncReportIndexEntry[]>([])
  let catalogReportsLoading = $state(false)
  let catalogReportsError = $state<string | null>(null)
  let catalogReadiness = $state<CatalogReadinessPayload | null>(null)
  let catalogReadinessLoading = $state(false)
  let catalogReadinessError = $state<string | null>(null)

  let catalogSyncRunning = $state(false)
  let catalogSyncError = $state<string | null>(null)

  let reportOpenById = $state<Record<string, boolean>>({})
  let reportDetails = $state<Record<string, CatalogSyncStoredReport | null>>({})
  let reportDetailsLoading = $state<Record<string, boolean>>({})
  let reportDetailsError = $state<Record<string, string | null>>({})

  let matrixDraftJson = $state('')
  let matrixPublished = $state<CompatibilityMatrixSnapshot | null>(null)
  let matrixLoading = $state(false)
  let matrixPublishing = $state(false)
  let matrixError = $state<string | null>(null)

  let n8nMatrixSnapshot = $state<CompatibilityMatrixSnapshot | null>(null)
  let n8nMatrixSyncing = $state(false)
  let n8nMatrixError = $state<string | null>(null)

  onMount(async () => {
    await loadSystemClips()
    if (isRegistryAdmin) {
      await loadCatalogReadiness()
      await loadCatalogReports()
      await loadCompatibilityMatrixAdmin()
    }
  })

  $effect(() => {
    if (!isRegistryAdmin) return

    for (const entry of catalogReportIndex) {
      const id = entry.id
      if (!reportOpenById[id]) continue
      if (reportDetails[id]) continue
      if (reportDetailsLoading[id]) continue
      void loadReportDetails(id)
    }
  })

  async function loadSystemClips() {
    systemClipsLoading = true
    systemClipError = null
    try {
      const response = await fetch('/api/clips')
      if (!response.ok) {
        throw new Error('Failed to load clips')
      }
      const payload = await response.json()
      const clips = (payload ?? []) as SystemClip[]
      systemClips = clips
        .filter((clip) => clip.systemClip)
        .sort((a, b) => a.filename.localeCompare(b.filename))
    } catch (error) {
      console.error('Failed to load system clips:', error)
      systemClipError = 'Unable to load Batshit clips right now. Try again in a moment.'
    } finally {
      systemClipsLoading = false
    }
  }

  async function createSystemClip(template: SystemClipTemplate) {
    systemClipCreatingId = template.id
    try {
      const response = await fetch(`/api/clips/system/${template.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: template.filename,
          description: template.description,
          content: '',
          fileType: 'text',
          mimeType: 'text/markdown',
          tags: ['batshit', 'system', 'helper']
        })
      })

      if (!response.ok) {
        throw new Error('Failed to create system clip')
      }

      const clip = (await response.json()) as SystemClip
      await loadSystemClips()
      clipViewerTitle = clip.filename
      clipViewerContent = clip.content || ''
      clipViewerLink = getClipLink(clip)
      clipViewerClip = clip
      clipViewerMode = 'edit'
      clipViewerOpen = true
    } catch (error) {
      console.error('Failed to create system clip:', error)
      toast.error('Could not create system clip')
    } finally {
      systemClipCreatingId = null
    }
  }

  function getClipLink(clip: SystemClip) {
    return clip.displayUrl ?? clip.externalUrl ?? clip.localUrl ?? null
  }

  async function openSystemClip(clip: SystemClip, mode: 'view' | 'edit' = 'view') {
    try {
      const response = await fetch(`/api/clips/${clip.id}`)
      if (!response.ok) {
        throw new Error('Failed to load clip')
      }
      const payload = (await response.json()) as SystemClip
      clipViewerTitle = payload.filename
      clipViewerContent = payload.content || payload.description || 'No text content available.'
      clipViewerLink = getClipLink(payload)
      clipViewerClip = payload
      clipViewerMode = mode
      clipViewerOpen = true
    } catch (error) {
      console.error('Failed to open system clip:', error)
      toast.error('Could not open this clip')
    }
  }

  async function saveSystemClip(newContent: string) {
    if (!clipViewerClip) return
    try {
      const updated = { ...clipViewerClip, content: newContent, updated_at: new Date().toISOString() }
      const response = await fetch(`/api/clips/system/${clipViewerClip.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated)
      })
      if (!response.ok) {
        throw new Error('Failed to save clip')
      }
      clipViewerClip = updated
      clipViewerContent = newContent
      clipViewerMode = 'view'
      clipViewerOpen = false
      toast.success('System clip updated')
      await loadSystemClips()
    } catch (error) {
      console.error('Failed to save system clip:', error)
      toast.error('Could not save this clip')
    }
  }

  async function loadCatalogReports() {
    catalogReportsLoading = true
    catalogReportsError = null

    try {
      const response = await fetch('/api/admin/model-catalog/reports?limit=20')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load catalog sync reports')
        throw new Error(message)
      }

      const result = await response.json()
      const reports: CatalogSyncReportIndexEntry[] = Array.isArray(result?.reports) ? result.reports : []
      untrack(() => {
        catalogReportIndex = reports
        // Ensure Collapsible binds never see `undefined`
        const nextOpenById: Record<string, boolean> = { ...reportOpenById }
        for (const report of reports) {
          if (typeof nextOpenById[report.id] !== 'boolean') {
            nextOpenById[report.id] = false
          }
        }
        reportOpenById = nextOpenById
      })
    } catch (err) {
      console.error('Catalog report index load failed:', err)
      untrack(() => {
        catalogReportsError = err instanceof Error ? err.message : 'Failed to load catalog sync reports'
      })
    } finally {
      untrack(() => {
        catalogReportsLoading = false
      })
    }
  }

  async function loadCatalogReadiness() {
    catalogReadinessLoading = true
    catalogReadinessError = null

    try {
      const response = await fetch('/api/admin/model-catalog/readiness')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load catalog readiness')
        throw new Error(message)
      }

      const result = await response.json()
      catalogReadiness = result as CatalogReadinessPayload
    } catch (err) {
      console.error('Catalog readiness load failed:', err)
      catalogReadiness = null
      catalogReadinessError = err instanceof Error ? err.message : 'Failed to load catalog readiness'
    } finally {
      catalogReadinessLoading = false
    }
  }

  async function refreshCatalogSyncAdminPanel() {
    await Promise.all([loadCatalogReadiness(), loadCatalogReports()])
  }

  async function loadReportDetails(id: string) {
    if (!id) return

    reportDetailsLoading[id] = true
    reportDetailsError[id] = null

    try {
      const response = await fetch(`/api/admin/model-catalog/reports/${encodeURIComponent(id)}`)
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load report')
        throw new Error(message)
      }

      const result = await response.json()
      const report: CatalogSyncStoredReport | null = result?.report ?? null
      if (!report) {
        throw new Error('Report not found')
      }

      untrack(() => {
        reportDetails[id] = report
      })
    } catch (err) {
      console.error('Catalog report detail load failed:', err)
      untrack(() => {
        reportDetailsError[id] = err instanceof Error ? err.message : 'Failed to load report'
      })
    } finally {
      untrack(() => {
        reportDetailsLoading[id] = false
      })
    }
  }

  async function runCatalogSyncNow() {
    catalogSyncRunning = true
    catalogSyncError = null

    try {
      const response = await fetch('/api/admin/model-catalog/sync', {
        method: 'POST'
      })

      if (!response.ok) {
        const message = await extractError(response, 'Catalog sync failed')
        throw new Error(message)
      }

      const result = await response.json()
      const fetchedAt = typeof result?.fetchedAt === 'string' ? result.fetchedAt : null

      toast.success('Model catalog sync complete')

      await loadCatalogReports()

      if (fetchedAt) {
        untrack(() => {
          const openId =
            catalogReportIndex.find((entry) => entry.fetchedAt === fetchedAt)?.id ?? fetchedAt
          reportOpenById = { ...reportOpenById, [openId]: true }
        })
      }
    } catch (err) {
      console.error('Catalog sync failed:', err)
      untrack(() => {
        catalogSyncError = err instanceof Error ? err.message : 'Catalog sync failed'
      })
      toast.error(err instanceof Error ? err.message : 'Catalog sync failed')
    } finally {
      untrack(() => {
        catalogSyncRunning = false
      })
    }
  }

  function formatMatrixJson(snapshot: CompatibilityMatrixSnapshot | null) {
    if (!snapshot) {
      matrixDraftJson = ''
      return
    }
    matrixDraftJson = JSON.stringify(snapshot, null, 2)
  }

  function parseMatrixDraftJson(): CompatibilityMatrixSnapshot | null {
    if (!matrixDraftJson.trim()) return null
    let parsed: any
    try {
      parsed = JSON.parse(matrixDraftJson)
    } catch (err) {
      throw new Error('Matrix JSON must be valid JSON.')
    }

    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error('Matrix JSON must include an entries array.')
    }

    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : new Date().toISOString(),
      entries: parsed.entries
    }
  }

  function formatMatrixEditor() {
    try {
      const snapshot = parseMatrixDraftJson()
      if (snapshot) {
        formatMatrixJson(snapshot)
      }
    } catch (err) {
      matrixError = err instanceof Error ? err.message : 'Failed to format matrix JSON'
      toast.error(matrixError)
    }
  }

  async function loadCompatibilityMatrixAdmin() {
    matrixLoading = true
    matrixError = null

    try {
      const response = await fetch('/api/admin/compatibility-matrix')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load compatibility matrix')
        throw new Error(message)
      }

      const result = await response.json()
      const published = result?.published ?? null
      n8nMatrixSnapshot = result?.n8n ?? null
      matrixPublished = published
      formatMatrixJson(published)
    } catch (err) {
      console.error('Compatibility matrix load failed:', err)
      matrixError = err instanceof Error ? err.message : 'Failed to load compatibility matrix'
    } finally {
      matrixLoading = false
    }
  }

  async function publishMatrix() {
    matrixPublishing = true
    matrixError = null

    try {
      const snapshot = parseMatrixDraftJson()
      if (!snapshot) {
        throw new Error('Matrix JSON is empty.')
      }

      const response = await fetch('/api/admin/compatibility-matrix/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to publish compatibility matrix')
        throw new Error(message)
      }

      const result = await response.json()
      matrixPublished = result?.published ?? null
      toast.success('Compatibility matrix published')
    } catch (err) {
      console.error('Compatibility matrix publish failed:', err)
      matrixError = err instanceof Error ? err.message : 'Failed to publish compatibility matrix'
      toast.error(matrixError)
    } finally {
      matrixPublishing = false
    }
  }

  async function runN8nMatrixSync() {
    n8nMatrixSyncing = true
    n8nMatrixError = null

    try {
      const response = await fetch('/api/admin/compatibility-matrix/n8n-sync', {
        method: 'POST'
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to sync n8n parameters')
        throw new Error(message)
      }

      const result = await response.json()
      n8nMatrixSnapshot = result?.snapshot ?? null
      const entryCount =
        typeof result?.entries === 'number'
          ? result.entries
          : result?.snapshot?.entries?.length ?? 0
      if (entryCount > 0) {
        toast.success(`n8n parameter sync complete (${entryCount} entries)`)
      } else {
        n8nMatrixError =
          'No chat model parameters were detected. Check N8N_API_URL, N8N_API_KEY, and provider mappings.'
        toast.error(n8nMatrixError)
      }
    } catch (err) {
      console.error('n8n compatibility sync failed:', err)
      n8nMatrixError = err instanceof Error ? err.message : 'Failed to sync n8n parameters'
      toast.error(n8nMatrixError)
    } finally {
      n8nMatrixSyncing = false
    }
  }

  function formatTimestamp(value?: string | null) {
    if (!value) return 'Unknown'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString()
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const result = await response.json()
      if (typeof result?.error === 'string') return result.error
    } catch (err) {
      // ignore
    }

    try {
      const text = await response.text()
      if (text) return text
    } catch (err) {
      // ignore
    }

    return fallback
  }
</script>

<div class="batshit-settings-surface">
<div class="space-y-4">
  <Card.Root class="batshit-settings-card batshit-settings-card-default">
    <Card.Header>
      <Card.Title class="flex items-center gap-2">
        <BookOpen class="h-4 w-4" />
        Batshit System Clips
      </Card.Title>
      <Card.Description>
        Reference clips shipped with Batshit (Batshit Guide + Goon Guide). Attach from chat or view/edit here.
      </Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3">
      {#if systemClipsLoading}
        <div class="batshit-settings-caption">Loading system clips…</div>
      {:else if systemClipError}
        <div class="text-sm text-destructive">{systemClipError}</div>
      {:else if systemClips.length === 0}
        <div class="space-y-2">
          {#each SYSTEM_CLIP_TEMPLATES as template}
            <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
              <div class="space-y-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="batshit-settings-form-label truncate">{template.filename}</span>
                  <span class="batshit-settings-form-label">Missing</span>
                </div>
                <p class="text-xs text-muted-foreground whitespace-pre-wrap break-words">{template.description}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => createSystemClip(template)}
                  disabled={systemClipCreatingId === template.id}
                >
                  {#if systemClipCreatingId === template.id}
                    <Loader2 class="animate-spin" />
                  {/if}
                  Create
                </Button>
              </div>
            </div>
          {/each}
        </div>
        <div class="batshit-settings-form-label">
          Create an empty system clip, then paste in the content and save.
        </div>
      {:else}
        <div class="space-y-2">
          {#each systemClips as clip}
            <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
              <div class="space-y-1 min-w-0">
                <div class="flex items-center gap-2">
                  <span class="batshit-settings-form-label truncate">{clip.filename}</span>
                  <span class="batshit-settings-form-label">Batshit clip</span>
                </div>
                {#if clip.description}
                  <p class="text-xs text-muted-foreground whitespace-pre-wrap break-words">{clip.description}</p>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Button size="sm" variant="outline" onclick={() => openSystemClip(clip, 'view')}>
                  <Eye aria-hidden="true" />

                  View
                </Button>
                <Button size="sm" variant="secondary" onclick={() => openSystemClip(clip, 'edit')}>
                  <Pencil aria-hidden="true" />

                  Edit
                </Button>
                {#if getClipLink(clip)}
                  <Button
                    variant="outline"
                    size="sm"
                    href={getClipLink(clip) as string}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink aria-hidden="true" />
                    Open clip
                  </Button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
        {#if missingSystemClips.length > 0}
          <div class="mt-3 space-y-2 border-t border-border/60 pt-3">
            <div class="batshit-settings-child-label">
              Missing System Clips
            </div>
            {#each missingSystemClips as template}
              <div class="flex items-start justify-between gap-3 batshit-settings-muted-panel">
                <div class="space-y-1 min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="batshit-settings-form-label truncate">{template.filename}</span>
                    <span class="batshit-settings-form-label">Missing</span>
                  </div>
                  <p class="text-xs text-muted-foreground whitespace-pre-wrap break-words">{template.description}</p>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    onclick={() => createSystemClip(template)}
                    disabled={systemClipCreatingId === template.id}
                  >
                    {#if systemClipCreatingId === template.id}
                      <Loader2 class="animate-spin" />
                    {/if}
                    Create
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/if}
    </Card.Content>
  </Card.Root>

  {#if isRegistryAdmin}
    <Card.Root class="batshit-settings-card batshit-settings-card-default">
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <Database class="h-4 w-4" />
          Model Catalog Registry Sync
        </Card.Title>
        <Card.Description>
          Runs the global model catalog sync and shows a history of recent runs. Admin-only.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onclick={refreshCatalogSyncAdminPanel}
            disabled={catalogReportsLoading || catalogSyncRunning || catalogReadinessLoading}
          >
            {#if catalogReportsLoading || catalogReadinessLoading}
              <Loader2 class="animate-spin" />
            {:else}
              <RefreshCcw  />
            {/if}
            Refresh
          </Button>

          <Button
            size="sm"
            onclick={runCatalogSyncNow}
            disabled={catalogSyncRunning}
          >
            {#if catalogSyncRunning}
              <Loader2 class="animate-spin" />
            {/if}
            Run sync now
          </Button>
        </div>

        {#if catalogReadinessError}
          <div class="batshit-settings-inline-alert is-danger">
            {catalogReadinessError}
          </div>
        {:else if catalogReadiness}
          <div class="batshit-settings-muted-panel space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
              <div class="batshit-settings-inline-strong">KV readiness</div>
              <Badge
                variant="outline"
                class={`batshit-settings-status-badge ${catalogReadiness.ready ? 'is-success' : 'is-warning'}`}
              >
                {catalogReadiness.ready ? 'ready' : 'needs attention'}
              </Badge>
            </div>
            <div class="batshit-settings-form-label">
              Checked {formatTimestamp(catalogReadiness.checkedAt)}
            </div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>URL {catalogReadiness.checks.kvRestApiUrl ? 'ok' : 'missing'}</span>
              <span>· Write token {catalogReadiness.checks.kvWriteToken ? 'ok' : 'missing'}</span>
              <span>· Read token {catalogReadiness.checks.kvReadToken ? `${catalogReadiness.checks.readTokenSource}` : 'missing'}</span>
              <span>· Read probe {catalogReadiness.probes.readReports.ok ? 'ok' : 'failed'}</span>
              <span>· Write probe {catalogReadiness.probes.writeProbe.ok ? 'ok' : 'failed'}</span>
            </div>
            {#if catalogReadiness.warnings.length}
              <div class="space-y-1">
                {#each catalogReadiness.warnings as warning}
                  <div class="batshit-settings-warning-text text-xs">{warning}</div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if catalogSyncError}
          <div class="batshit-settings-inline-alert is-danger">
            {catalogSyncError}
          </div>
        {/if}

        {#if catalogReportsError}
          <div class="batshit-settings-inline-alert is-danger">
            {catalogReportsError}
          </div>
        {/if}

        {#if catalogReportsLoading && !catalogReportIndex.length}
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            Loading report history…
          </div>
        {:else if !catalogReportIndex.length}
          <div class="batshit-settings-caption">
            No report history yet. Run a sync to create the first report.
          </div>
        {:else}
          <div class="space-y-2">
            {#each catalogReportIndex as entry (entry.id)}
              <Collapsible.Root bind:open={reportOpenById[entry.id]}>
                <Collapsible.Trigger class="batshit-settings-collapsible-trigger w-full flex items-center justify-between text-left">
                  <div class="flex flex-col gap-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="batshit-settings-form-label">{formatTimestamp(entry.fetchedAt)}</span>
                      <Badge variant="outline" class={`batshit-settings-status-badge ${entry.status === 'ok' ? 'is-success' : 'is-warning'}`}>
                        {entry.status === 'ok' ? 'ok' : 'degraded'}
                      </Badge>
                      <Badge variant="outline" class="text-[11px] font-normal">
                        models {entry.models}
                      </Badge>
                      <Badge variant="outline" class="text-[11px] font-normal">
                        +{entry.diffTotals.addedModelsTotal} −{entry.diffTotals.removedModelsTotal} Δ{entry.diffTotals.connectionChangesTotal}
                      </Badge>
                      <Badge variant="outline" class="text-[11px] font-normal">
                        {entry.trigger}
                      </Badge>
                      {#if entry.warningAlert?.active}
                        <Badge variant="outline" class="batshit-settings-status-badge is-warning">
                          alert x{entry.warningAlert.streak}
                        </Badge>
                      {/if}
                    </div>
                    <div class="batshit-settings-form-label">
                      vercel {entry.counts.vercel ?? 0} · openrouter {entry.counts.openrouter ?? 0} · direct {(
                        (entry.counts.openai ?? 0) +
                        (entry.counts.anthropic ?? 0) +
                        (entry.counts.google ?? 0) +
                        (entry.counts.mistral ?? 0) +
                        (entry.counts.groq ?? 0) +
                        (entry.counts.deepseek ?? 0) +
                        (entry.counts.zai ?? 0) +
                        (entry.counts.zai_coding ?? 0) +
                        (entry.counts.fal ?? 0) +
                        (entry.counts.luma ?? 0) +
                        (entry.counts.replicate ?? 0) +
                        (entry.counts.elevenlabs ?? 0) +
                        (entry.counts.deepgram ?? 0) +
                        (entry.counts.assemblyai ?? 0) +
                        (entry.counts.cohere ?? 0)
                      )}
                    </div>
                  </div>

                  <ChevronDown class={`h-4 w-4 transition-transform ${reportOpenById[entry.id] ? 'rotate-180' : ''}`} />
                </Collapsible.Trigger>

                <Collapsible.Content class="pt-3">
                  {#if reportDetailsLoading[entry.id]}
                    <div class="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 class="h-4 w-4 animate-spin" />
                      Loading report…
                    </div>
                  {:else if reportDetailsError[entry.id]}
                    <div class="batshit-settings-inline-alert is-danger">
                      {reportDetailsError[entry.id]}
                    </div>
                  {:else if reportDetails[entry.id]}
                    {@const report = reportDetails[entry.id] as CatalogSyncStoredReport}
                    <div class="space-y-4">
                      {#if report.warningAlert?.active}
                        <div class="batshit-settings-inline-alert is-warning">
                          {report.warningAlert.message}
                        </div>
                      {/if}

                      <div class="flex flex-wrap items-center justify-between gap-2">
                        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span>fetchedAt: <code class="rounded bg-muted/40 px-1 py-0.5">{report.fetchedAt}</code></span>
                          {#if report.previousFetchedAt}
                            <span>prev: <code class="rounded bg-muted/40 px-1 py-0.5">{report.previousFetchedAt}</code></span>
                          {/if}
                        </div>
                        <Button
                          size="sm"
                          variant="secondary"
                          onclick={() => copyReportJson(report)}
                        >
                          <Copy aria-hidden="true" />

                          Copy JSON
                        </Button>
                      </div>

                      <div class="space-y-2">
                        <div class="batshit-settings-child-label">Source results</div>
                        <div class="grid gap-2">
                          {#each report.sources as source (source.connectionId)}
                            <div class="batshit-settings-muted-panel">
                              <div class="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <code class="font-mono">{source.connectionId}</code>
                                <div class="flex items-center gap-2">
                                  <Badge variant="outline" class="text-[11px] font-normal">
                                    {source.skipped ? 'skipped' : source.usedFallback ? 'fallback' : 'ok'}
                                  </Badge>
                                  <span class="text-muted-foreground">fetched {source.fetchedCount}</span>
                                </div>
                              </div>
                              {#if source.warning || source.error}
                                <div class="mt-2 text-xs">
                                  {#if source.warning}
                                    <div class="batshit-settings-warning-text">{source.warning}</div>
                                  {/if}
                                  {#if source.error}
                                    <div class="text-destructive">{source.error}</div>
                                  {/if}
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </div>
                      </div>

                      <div class="space-y-2">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                          <div class="batshit-settings-child-label">Diff</div>
                          <div class="flex flex-wrap items-center gap-2 text-xs">
                            <Badge variant="outline" class="text-[11px] font-normal">Added {report.diff.addedModelsTotal}</Badge>
                            <Badge variant="outline" class="text-[11px] font-normal">Removed {report.diff.removedModelsTotal}</Badge>
                            <Badge variant="outline" class="text-[11px] font-normal">Changes {report.diff.connectionChangesTotal}</Badge>
                          </div>
                        </div>

                        {#if report.diff.addedModelsTotal > 0}
                          <div class="batshit-settings-muted-panel">
                            <div class="batshit-settings-form-label mb-2">Added models</div>
                            <div class="grid gap-1 text-xs">
                              {#each report.diff.addedModels as item (item.key)}
                                <div class="flex items-center justify-between gap-2">
                                  <span class="truncate">{item.displayName}</span>
                                  <code class="text-muted-foreground">{item.key}</code>
                                </div>
                              {/each}
                            </div>
                          </div>
                        {/if}

                        {#if report.diff.removedModelsTotal > 0}
                          <div class="batshit-settings-muted-panel">
                            <div class="batshit-settings-form-label mb-2">Removed models</div>
                            <div class="grid gap-1 text-xs">
                              {#each report.diff.removedModels as item (item.key)}
                                <div class="flex items-center justify-between gap-2">
                                  <span class="truncate">{item.displayName}</span>
                                  <code class="text-muted-foreground">{item.key}</code>
                                </div>
                              {/each}
                            </div>
                          </div>
                        {/if}

                        {#if report.diff.connectionChangesTotal > 0}
                          <div class="batshit-settings-muted-panel">
                            <div class="batshit-settings-form-label mb-2">Connection changes</div>
                            <div class="grid gap-1 text-xs">
                              {#each report.diff.connectionChanges as change (change.key)}
                                <div class="flex items-start justify-between gap-3">
                                  <div class="truncate">{change.displayName}</div>
                                  <div class="shrink-0 text-right text-muted-foreground">
                                    {#if change.addedConnections.length}
                                      <span>+{change.addedConnections.join(', ')}</span>
                                    {/if}
                                    {#if change.removedConnections.length}
                                      <span class={change.addedConnections.length ? 'ml-2' : ''}>-{change.removedConnections.join(', ')}</span>
                                    {/if}
                                  </div>
                                </div>
                              {/each}
                            </div>
                          </div>
                        {/if}
                      </div>
                    </div>
                  {/if}
                </Collapsible.Content>
              </Collapsible.Root>
            {/each}
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root class="batshit-settings-card batshit-settings-card-default">
      <Card.Header>
        <Card.Title class="flex items-center gap-2">
          <Database class="h-4 w-4" />
          Compatibility Matrix
        </Card.Title>
        <Card.Description>
          Edit, save, and publish the global parameter Compatibility Matrix.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        <div class="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onclick={loadCompatibilityMatrixAdmin}
            disabled={matrixLoading || matrixPublishing}
          >
            {#if matrixLoading}
              <Loader2 class="animate-spin" />
            {/if}
            Reload
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onclick={formatMatrixEditor}
            disabled={!matrixDraftJson.trim()}
          >
            <Sparkles aria-hidden="true" />
            Format JSON
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onclick={() => formatMatrixJson(matrixPublished)}
            disabled={!matrixPublished}
          >
            <RefreshCcw aria-hidden="true" />

            Load published
          </Button>
        </div>

        {#if matrixError}
          <div class="batshit-settings-inline-alert is-danger">
            {matrixError}
          </div>
        {/if}

        <Textarea
          rows={14}
          class="font-mono text-xs"
          placeholder={'{"version": 1, "fetchedAt": "...", "entries": []}'}
          bind:value={matrixDraftJson}
        />

        <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <div class="space-x-2">
            {#if matrixPublished?.fetchedAt}
              <span>Published {formatTimestamp(matrixPublished.fetchedAt)}</span>
            {/if}
            {#if matrixPublished?.entries}
              <span>· Entries {matrixPublished.entries.length}</span>
            {/if}
            {#if n8nMatrixSnapshot?.fetchedAt}
              <span>· n8n sync {formatTimestamp(n8nMatrixSnapshot.fetchedAt)}</span>
            {/if}
          </div>
          <div class="flex items-center gap-2">
            <Button size="sm" onclick={publishMatrix} disabled={matrixPublishing}>
              {#if matrixPublishing}
                <Loader2 class="animate-spin" />
              {/if}
              Publish
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onclick={runN8nMatrixSync}
              disabled={n8nMatrixSyncing}
            >
              {#if n8nMatrixSyncing}
                <Loader2 class="animate-spin" />
              {/if}
              Sync n8n params
            </Button>
          </div>
        </div>

        {#if n8nMatrixError}
          <div class="batshit-settings-inline-alert is-danger">
            {n8nMatrixError}
          </div>
        {/if}

        <div class="batshit-settings-muted-panel batshit-settings-caption">
          <div class="batshit-settings-inline-strong">Manual vs automatic refresh</div>
          <div class="mt-1">
            <code>Sync n8n params</code> uses the n8n credentials saved in this Batshit instance for the current admin user.
            <code class="ml-1">Publish</code> pushes whatever is in the editor to the hosted Upstash registry.
          </div>
          <div class="mt-2">
            The daily automatic refresh is a separate Vercel cron on <code>api.batshit.ai</code>. That hosted job does not use your local Dev tab session, so it only works when the hosted deployment has its own <code>N8N_API_URL</code> plus n8n auth configured.
          </div>
        </div>
      </Card.Content>
    </Card.Root>
  {/if}
</div>
</div>

<SystemPromptEditor
  bind:open={clipViewerOpen}
  title={clipViewerTitle || 'Batshit clip'}
  description={clipViewerLink ? `Open in new tab: ${clipViewerLink}` : 'System clip'}
  prompt={clipViewerContent}
  readOnly={clipViewerMode === 'view'}
  width="large"
  onSave={saveSystemClip}
  onCancel={() => (clipViewerContent = '')}
/>
