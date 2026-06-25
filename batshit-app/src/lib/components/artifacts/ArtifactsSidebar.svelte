<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Badge from '$lib/components/ui/badge'
  import * as Select from '$lib/components/ui/select'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Label } from '$lib/components/ui/label'
  import WidgetPlacementConfig from './WidgetPlacementConfig.svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import ArtifactSourceBadge from '$lib/components/artifacts/ArtifactSourceBadge.svelte'
  import { getArtifactIframeSandbox } from '$lib/artifacts/artifactIframeSandbox'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { DEFAULT_ARTIFACT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import {
    Loader2,
    RefreshCw,
    Edit3,
    Globe,
    ChevronDown,
    ClipboardList
  } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { cn } from '$lib/utils'
  import { copyTextToClipboard } from '$lib/utils/clipboard'
  import { downloadText, downloadBlob } from '$lib/utils/download'
  import { dispatchSessionClipStateChanged } from '$lib/utils/liveSettingsEvents'
  import { onMount } from 'svelte'
  import {
    applyArtifactPowerSourceToMetadata,
    ARTIFACT_POWER_SOURCE_OPTIONS,
    getArtifactPowerSourceOption,
    resolveArtifactPowerSource,
    type ArtifactPowerSource
  } from '$lib/artifacts/artifactPowerSource'
  
  // Panel constraints
  const MIN_WIDTH = 480
  const MAX_WIDTH = 1200  // Increased max width
  const MIN_CHAT_WIDTH = 480
  const RIGHT_RAIL_FALLBACK_WIDTH = 48
  
  // Props
  let {
    open = $bindable(false),
    artifacts = $bindable([]),
    currentArtifact = $bindable(null),
    activeSessionId = null,
    width = $bindable(400),
    onArtifactSelect = (artifact: any) => {},
    onVersionSelect = (artifactId: string, versionId: string) => {},
    onArtifactRefresh = (artifactId: string) => {},
    onModeChange = (artifactId: string, mode: 'edit' | 'published') => {},
    onStartDrag = () => {},
    onDrag = (width: number) => {},
    onEndDrag = () => {}
  } = $props<{
    open?: boolean
    artifacts?: any[]
    currentArtifact?: any | null
    activeSessionId?: string | null
    width?: number
    onArtifactSelect?: (artifact: any) => void
    onVersionSelect?: (artifactId: string, versionId: string) => void
    onArtifactRefresh?: (artifactId: string) => void | Promise<void>
    onModeChange?: (artifactId: string, mode: 'edit' | 'published') => void
    onStartDrag?: () => void
    onDrag?: (width: number) => void
    onEndDrag?: () => void
  }>()
  
  // Local state
  let settingsOpen = $state(false)
  let iframeLoaded = $state(false)
  let iframeRefreshKey = $state(0)
  let lastIframeSrc = $state('')
  let showAdvancedBuilder = $state(false)

  // Sidebar now acts as zone/view surface only. Build controls live in Settings -> Artifacts.
  const computedEditMode = $derived(false)
  let panelWidth = $state(width) // Use prop width
  let isDragging = $state(false)
  let dragStartX = $state(0)
  let dragStartWidth = $state(0)
  let searchQuery = $state('')
  let editorContent = $state('')
  let versionNote = $state('')
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let diffVersion = $state<number | null>(null)
  let diffSummary = $state('')
  let editableName = $state('')
  let webhookUrl = $state('')
  let powerSource = $state<ArtifactPowerSource>('built_in')
  let systemPrompt = $state('')
  let zone = $state<string | null>(null)
  let slug = $state('')
  let slugEdited = $state(false)
  let pendingMetadata = $state<Record<string, any>>({})
  type SettingsSection = 'main' | 'zones' | 'code' | 'versions' | 'blueprint'
  const SETTINGS_ACCORDION_KEY = 'artifactSettingsOpenSection'
  let openSection = $state<SettingsSection | null>(null)
  let mainOpen = $state(false)
  let zonesOpen = $state(false)
  let codeOpen = $state(false)
  let versionsOpen = $state(false)
  let blueprintOpen = $state(false)
  let blueprintContent = $state('')

  const selectedPowerSourceOption = $derived(getArtifactPowerSourceOption(powerSource))
  const slugifyName = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_+|_+$/g, '')
      || 'artifact'

  function setExclusiveSection(section: SettingsSection | null) {
    openSection = section
    mainOpen = section === 'main'
    zonesOpen = section === 'zones'
    codeOpen = section === 'code'
    versionsOpen = section === 'versions'
    blueprintOpen = section === 'blueprint'
  }

  function toggleSection(section: SettingsSection) {
    setExclusiveSection(openSection === section ? null : section)
  }

  $effect(() => {
    if (!slugEdited) {
      slug = slugifyName(editableName || currentArtifact?.name || 'artifact')
    }
  })

  // Persist and synchronize accordion open state
  $effect(() => {
    if (typeof window === 'undefined') return
    if (openSection) {
      localStorage.setItem(SETTINGS_ACCORDION_KEY, openSection)
    } else {
      localStorage.removeItem(SETTINGS_ACCORDION_KEY)
    }
  })

  function syncSection(section: SettingsSection, isOpen: boolean) {
    if (isOpen) {
      setExclusiveSection(section)
    } else if (openSection === section) {
      setExclusiveSection(null)
    }
  }

  $effect(() => syncSection('main', mainOpen))
  $effect(() => syncSection('zones', zonesOpen))
  $effect(() => syncSection('code', codeOpen))
  $effect(() => syncSection('versions', versionsOpen))
  $effect(() => syncSection('blueprint', blueprintOpen))

  $effect(() => {
    if (
      !showAdvancedBuilder &&
      (openSection === 'code' || openSection === 'versions' || openSection === 'blueprint')
    ) {
      setExclusiveSection(null)
    }
  })

  // Update panelWidth when prop changes
  $effect(() => {
    if (width) {
      panelWidth = width
    }
  })

  $effect(() => {
    if (currentArtifact) {
      editorContent = currentArtifact.content || ''
      editableName = currentArtifact.name || ''
      slug = currentArtifact.slug || slugifyName(currentArtifact.name || '')
      slugEdited = false
      versionNote = ''
      webhookUrl = currentArtifact.webhook_url || ''
      powerSource = resolveArtifactPowerSource(currentArtifact)
      systemPrompt = currentArtifact.system_prompt || currentArtifact.custom_prompt || ''
      zone = currentArtifact.zone || null
      blueprintContent = currentArtifact.blueprint || ''
      pendingMetadata = currentArtifact.metadata || {}
      diffVersion = null
      diffSummary = ''
      saveState = 'idle'
      saveError = null
    }
  })

  // Filtered artifacts based on search
  const filteredArtifacts = $derived(
    artifacts.filter((artifact: { name: string; type: string; }) => 
      artifact.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      artifact.type.toLowerCase().includes(searchQuery.toLowerCase())
    )
  )
  
  function getArtifactIconRef(artifact: any) {
    return normalizeIconRef(artifact?.icon_ref ?? artifact?.icon, DEFAULT_ARTIFACT_ICON_REF)
  }
  
  // Get mode info
  function getModeInfo(mode: string) {
    switch (mode) {
      case 'published':
        return { icon: Globe, color: 'artifact-sidebar-status-published', label: 'Published (live)' }
      default:
        return { icon: Edit3, color: 'artifact-sidebar-status-draft', label: 'Draft' }
    }
  }

  function formatTimestamp(value?: string) {
    if (!value) return ''
    try {
      return new Date(value).toLocaleString()
    } catch (err) {
      return value
    }
  }
  
  type ArtifactMode = 'edit' | 'published'
  
  // Handle iframe load
  function handleIframeLoad() {
    iframeLoaded = true
  }

  function getArtifactVersionKey(artifact: any) {
    return artifact?.updated_at || artifact?.updatedAt || artifact?.version || artifact?.mode || ''
  }

  function getArtifactIframeSrc(artifact: any) {
    if (!artifact?.id) return ''
    const basePath = `/artifact/${encodeURIComponent(artifact.id)}`
    const params = new URLSearchParams()
    if (activeSessionId) params.set('sessionId', activeSessionId)
    if (iframeRefreshKey > 0) params.set('refresh', String(iframeRefreshKey))
    const versionKey = getArtifactVersionKey(artifact)
    if (versionKey) params.set('artifactVersion', String(versionKey))
    const query = params.toString()
    return query ? `${basePath}?${query}` : basePath
  }

  const currentArtifactIframeSrc = $derived.by(() =>
    currentArtifact ? getArtifactIframeSrc(currentArtifact) : ''
  )

  async function refreshCurrentArtifact() {
    if (!currentArtifact?.id) return
    iframeLoaded = false
    iframeRefreshKey += 1
    await onArtifactRefresh(currentArtifact.id)
  }

  // Copy artifact content
  async function copyContent() {
    if (!currentArtifact) return
    
    try {
      await copyTextToClipboard(currentArtifact.content)
      toast.success('Copied to clipboard!')
    } catch (error) {
      toast.error('Failed to copy content')
    }
  }
  
  // Download artifact
  async function downloadArtifact() {
    if (!currentArtifact) return

    try {
      const result = await downloadText(
        currentArtifact.content,
        `${currentArtifact.name}.${currentArtifact.type}`,
        {
          title: 'Download Artifact',
          mimeType: 'text/plain'
        }
      )
      if (!result.canceled) toast.success('Download started!')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to download artifact')
    }
  }

  function replaceArtifact(updated: any) {
    currentArtifact = updated
    artifacts = artifacts.map((a: any) => (a.id === updated.id ? updated : a))
  }

  async function saveArtifact(targetMode: ArtifactMode = (currentArtifact?.mode || 'edit') as ArtifactMode) {
    if (!currentArtifact) return

    saveState = 'saving'
    saveError = null

    try {
      const sourceOption = getArtifactPowerSourceOption(powerSource)
      const metadata = applyArtifactPowerSourceToMetadata(pendingMetadata, powerSource)
      const payload: Record<string, any> = {
        name: editableName || 'Untitled Artifact',
        slug: slug?.trim() || null,
        content: editorContent,
        versionDescription: versionNote || undefined,
        brain_type: sourceOption.brainType,
        ai_enabled: sourceOption.brainType !== 'none',
        webhook_url: sourceOption.usesWebhook ? (webhookUrl.trim() || null) : null,
        system_prompt: sourceOption.acceptsSystemPrompt ? (systemPrompt || null) : null,
        custom_prompt: sourceOption.acceptsSystemPrompt ? (systemPrompt || null) : null,
        zone: zone || null,
        blueprint: blueprintContent || null,
        widget_position: null,
        metadata,
        sessionId: currentArtifact.last_edited_session || currentArtifact.created_in_session,
        mode: targetMode
      }

      const response = await fetch(`/api/artifacts/${currentArtifact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || 'Failed to save artifact')
      }

      const updated = await response.json()
      replaceArtifact(updated)
      pendingMetadata = updated.metadata || pendingMetadata
      versionNote = ''
      saveState = 'saved'
      setTimeout(() => (saveState = 'idle'), 1200)
      toast.success(`Artifact ${targetMode === 'published' ? 'saved & published' : 'saved as draft'}`)
    } catch (error) {
      console.error('Failed to save artifact:', error)
      saveError = error instanceof Error ? error.message : 'Failed to save artifact'
      saveState = 'idle'
      toast.error(saveError)
    }
  }

  async function rollbackVersion(targetVersion: number) {
    if (!currentArtifact) return
    try {
      const response = await fetch('/api/artifacts/versions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifactId: currentArtifact.id, targetVersion })
      })

      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || 'Failed to restore version')
      }

      // Refresh current artifact from API to keep versions accurate
      const refreshed = await fetch(`/api/artifacts/${currentArtifact.id}`)
      const refreshedData = refreshed.ok ? await refreshed.json() : currentArtifact
      replaceArtifact(refreshedData)
      toast.success(`Restored to version ${targetVersion}`)
    } catch (error) {
      console.error('Failed to rollback version:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to restore version')
    }
  }

  function getVersionEntry(versionNumber: number) {
    if (!currentArtifact?.versions) return null
    return currentArtifact.versions.find((v: any) => v.version === versionNumber) || null
  }

  function summarizeDiff(oldVersion: any, newVersion: any) {
    const oldTokens = Math.ceil((oldVersion?.content?.length || 0) / 4)
    const newTokens = Math.ceil((newVersion?.content?.length || 0) / 4)
    const delta = newTokens - oldTokens
    const tokenText = `${delta >= 0 ? '+' : ''}${delta} tokens`
    return `${tokenText} | v${oldVersion?.version ?? '?'} → v${newVersion?.version ?? '?'}`
  }

  function selectDiff(versionNumber: number) {
    const target = getVersionEntry(versionNumber)
    const current = getVersionEntry(currentArtifact?.version || versionNumber)
    if (target && current) {
      diffVersion = versionNumber
      diffSummary = summarizeDiff(target, current)
    }
  }

  $effect(() => {
    const nextSrc = currentArtifactIframeSrc
    if (!nextSrc) {
      lastIframeSrc = ''
      iframeLoaded = false
      return
    }

    if (nextSrc !== lastIframeSrc) {
      lastIframeSrc = nextSrc
      iframeLoaded = false
    }
  })
  
  // Calculate maximum width based on viewport and other sidebars
  function getMaxWidth() {
    if (typeof window === 'undefined') return MAX_WIDTH

    const sidebarGap = document.querySelector('[data-slot="sidebar-gap"]') as HTMLElement | null
    const mainSidebar = document.querySelector('.batshit-sidebar') as HTMLElement | null
    const mainSidebarWidth = document.body.classList.contains('sidebar-overlay')
      ? 0
      : sidebarGap?.getBoundingClientRect().width || mainSidebar?.getBoundingClientRect().width || 0
    
    // Get the projects sidebar width if it exists and is open
    const projectsSidebar = document.querySelector('.projects-sidebar')
    const projectsSidebarWidth = projectsSidebar?.getBoundingClientRect().width || 0

    const rightRail = document.querySelector('.artifact-icon-column') as HTMLElement | null
    const rightRailWidth = rightRail?.getBoundingClientRect().width || RIGHT_RAIL_FALLBACK_WIDTH
    
    // Calculate available space while preserving minimum chat width
    const availableWidth =
      window.innerWidth -
      mainSidebarWidth -
      projectsSidebarWidth -
      MIN_CHAT_WIDTH -
      rightRailWidth
    
    // Return the smaller of MAX_WIDTH or available width
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, availableWidth))
  }
  
  // Handle drag start
  export function handleDragStart(e: MouseEvent) {
    isDragging = true
    dragStartX = e.clientX
    dragStartWidth = panelWidth
    
    // Add dragging class to body
    document.body.classList.add('dragging-artifacts')
    
    // Prevent text selection while dragging
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    
    onStartDrag()
  }
  
  // Handle drag move
  function handleDragMove(e: MouseEvent) {
    if (!isDragging) return
    
    const deltaX = dragStartX - e.clientX // Negative because we're dragging from right side
    const newWidth = dragStartWidth + deltaX
    
    // Apply constraints
    const maxWidth = getMaxWidth()
    panelWidth = Math.min(Math.max(MIN_WIDTH, newWidth), maxWidth)
    onDrag(panelWidth)
  }
  
  // Handle drag end
  function handleDragEnd() {
    if (!isDragging) return
    
    isDragging = false
    
    // Remove dragging class from body
    document.body.classList.remove('dragging-artifacts')
    document.body.style.userSelect = ''
    document.body.style.cursor = ''
    
    // Save to localStorage
    localStorage.setItem('artifactsPanelWidth', panelWidth.toString())
    onEndDrag()
  }
  
  // Set up global mouse event listeners for dragging
  $effect(() => {
    if (typeof window === 'undefined') return
    
    const handleMove = (e: MouseEvent) => handleDragMove(e)
    const handleEnd = () => handleDragEnd()
    
    if (isDragging) {
      window.addEventListener('mousemove', handleMove)
      window.addEventListener('mouseup', handleEnd)
      
      return () => {
        window.removeEventListener('mousemove', handleMove)
        window.removeEventListener('mouseup', handleEnd)
      }
    }
  })
  
  // Restore saved width on mount and setup message listener
  onMount(() => {
    const savedSection = localStorage.getItem(SETTINGS_ACCORDION_KEY)
    if (savedSection === 'main' || savedSection === 'zones' || savedSection === 'code' || savedSection === 'versions' || savedSection === 'blueprint') {
      setExclusiveSection(savedSection as SettingsSection)
    }
    const savedWidth = localStorage.getItem('artifactsPanelWidth')
    if (savedWidth) {
      const width = parseInt(savedWidth, 10)
      if (!isNaN(width)) {
        panelWidth = Math.min(Math.max(MIN_WIDTH, width), MAX_WIDTH)
      }
    }
    
    // Listen for messages from artifacts
    const handleMessage = (event: MessageEvent) => {
      // Artifact iframes intentionally run with an opaque origin because their sandbox
      // excludes allow-same-origin. Only accept opaque-origin messages for the visible artifact.
      if (event.origin !== window.location.origin && event.origin !== 'null') return
      if (event.origin === 'null' && event.data?.artifactId !== currentArtifact?.id) return
      
	      if (event.data?.type === 'batshit:artifact:ready') {
	        // SA-042: Persist fabric fields reported by artifact iframe
        const fabricFields = event.data.fabricFields
        if (Array.isArray(fabricFields) && fabricFields.length > 0 && event.data.artifactId) {
          fetch(`/api/artifacts/${event.data.artifactId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              metadata: { fabric_fields: fabricFields }
            })
          }).catch(err => console.warn('Failed to persist fabric fields:', err))
        }
      }
      
	      // Handle other artifact messages if needed
	      if (event.data?.type === 'batshit:artifact:request') {
	        // Could handle specific artifact requests here
	      }

      if (event.data?.type === 'batshit:artifact:download') {
        const requestId = typeof event.data.requestId === 'string' ? event.data.requestId : ''
        const filename = typeof event.data.filename === 'string' ? event.data.filename : 'artifact-output'
        const mimeType = typeof event.data.mimeType === 'string' ? event.data.mimeType : undefined
        const blob = event.data.blob instanceof Blob ? event.data.blob : null
        const source = event.source
        const respond = (payload: Record<string, unknown>) => {
          if (source && 'postMessage' in source) {
            ;(source as Window).postMessage(
              {
                type: 'batshit:artifact:download-result',
                artifactId: currentArtifact?.id,
                requestId,
                ...payload
              },
              '*'
            )
          }
        }

        if (!blob) {
          respond({ success: false, error: 'Artifact download did not include file content.' })
          return
        }

        downloadBlob(blob, filename, {
          title: 'Download Artifact Output',
          mimeType
        })
          .then((result) => respond({ success: true, canceled: result.canceled }))
          .catch((error) =>
            respond({
              success: false,
              error: error instanceof Error ? error.message : 'Artifact download failed.'
            })
          )
      }

      if (event.data?.type === 'batshit:session-clip-state-changed') {
        const detail = event.data?.data ?? {}
        const sharedSessionId =
          typeof detail.sessionId === 'string' && detail.sessionId.trim()
            ? detail.sessionId.trim()
            : null
        if (!sharedSessionId) return

        dispatchSessionClipStateChanged({
          sessionId: sharedSessionId,
          clipId: typeof detail.clipId === 'string' ? detail.clipId : undefined,
          source: detail.source === 'artifact-share' ? 'artifact-share' : 'unknown'
        })
      }
    }
    
    window.addEventListener('message', handleMessage)
    
    // Cleanup
    return () => {
      window.removeEventListener('message', handleMessage)
    }
  })
</script>

<!-- Sidebar container -->
<div class={`artifact-sidebar-shell ${open ? 'is-open' : 'is-closed'}`}
  style="width: {open ? `${panelWidth}px` : '0'}; transition: width 0.2s ease-in-out">
  {#if open}
    <div class="artifact-sidebar-panel">
      <!-- Main Content Area -->
      <div class="artifact-sidebar-main">
        {#if !currentArtifact}
          <div class="artifact-sidebar-empty">
            <p class="artifact-sidebar-empty-copy">
              Select an artifact from the right rail to view it here.
            </p>
          </div>
        {:else}
          <!-- Artifact Detail View -->
          <div class="artifact-sidebar-detail">
            <!-- Artifact Header -->
            <div class="artifact-sidebar-header">
              <div class="artifact-sidebar-inline-row">
                <div class="artifact-sidebar-title-row">
                  <span class="artifact-sidebar-icon-wrap">
                    <IconRenderer
                      ref={getArtifactIconRef(currentArtifact)}
                      label={currentArtifact.name || 'Artifact'}
                      iconClass="artifact-sidebar-detail-icon"
                    />
                    <ArtifactSourceBadge artifact={currentArtifact} class="artifact-sidebar-source-badge" />
                  </span>
                  <h3 class="artifact-sidebar-title" title={currentArtifact.name}>
                    {currentArtifact.name}
                  </h3>
                  <ArtifactSourceBadge artifact={currentArtifact} showLabel size="sm" />
                </div>
                <div class="artifact-sidebar-header-actions">
                  <Tooltip.Root>
                    <Tooltip.Trigger>
                      <Button
                        variant="ghost"
                        size="icon"
                        class="artifact-sidebar-icon-button"
                        onclick={() => {
                          window.dispatchEvent(new CustomEvent('batshit:open-settings', {
                            detail: { tab: 'artifacts', artifactId: currentArtifact.id }
                          }))
                        }}
                        title="Edit in Settings"
                        aria-label={`Edit artifact ${currentArtifact.name} in settings`}
                      >
                        <Edit3 class="artifact-sidebar-button-icon" />
                      </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>Edit in Settings</Tooltip.Content>
                  </Tooltip.Root>
                  <Tooltip.Root>
                    <Tooltip.Trigger>
                      <Button
                        variant="ghost"
                        size="icon"
                        class="artifact-sidebar-icon-button"
                        onclick={() => void refreshCurrentArtifact()}
                        title="Refresh"
                        aria-label={`Refresh artifact ${currentArtifact.name}`}
                      >
                        <RefreshCw class="artifact-sidebar-button-icon" />
                      </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content>Refresh</Tooltip.Content>
                  </Tooltip.Root>
                </div>
              </div>
            </div>
            <div class="artifact-sidebar-main">
              {#if settingsOpen}
                <div class="artifact-sidebar-settings-scroll">
                  <div class="artifact-sidebar-settings-pad" id="artifact-settings-top">
                    <div class="artifact-sidebar-stack-md">
                      <Collapsible.Root bind:open={mainOpen}>
                        <Collapsible.Trigger onclick={() => toggleSection('main')} class="artifact-sidebar-section-trigger">
                          <div class="artifact-sidebar-section-label">
                            <span class="artifact-sidebar-strong">1. Main Settings</span>
                            <span class="artifact-sidebar-muted">Prompt, source, and publish context</span>
                          </div>
                          <ChevronDown class="artifact-sidebar-button-icon" />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="artifact-sidebar-section-content">
                          <div class="artifact-sidebar-card artifact-sidebar-stack-lg">
                            <div class="artifact-sidebar-raised-card artifact-sidebar-stack-md">
                              <div class="artifact-sidebar-row-between">
                                <div>
                                  <p class="artifact-sidebar-card-title">Build with Artifact System Skills</p>
                                  <p class="artifact-sidebar-helper">
                                    Build/edit is skill-led. Use chat to run artifact skills, then save + publish in this panel.
                                  </p>
                                </div>
                                <Badge.Badge variant="outline">
                                  {computedEditMode ? 'Build context' : 'View context'}
                                </Badge.Badge>
                              </div>
                              <div class="artifact-sidebar-wrap-row">
                                <Badge.Badge variant="outline">/artifact-creator</Badge.Badge>
                              </div>
                              <p class="artifact-sidebar-helper">
                                The unified artifact skill handles all power sources. External MCP access follows normal Dynamic MCP discoverability.
                              </p>
                            </div>

                            <div class="artifact-sidebar-raised-card artifact-sidebar-stack-sm">
                              <p class="artifact-sidebar-card-title">Artifact Details (read-only)</p>
                              <div class="artifact-sidebar-info-grid">
                                <div>
                                  <p class="artifact-sidebar-muted">Name</p>
                                  <p class="artifact-sidebar-value artifact-sidebar-truncate" title={currentArtifact?.name}>{currentArtifact?.name || 'Untitled Artifact'}</p>
                                </div>
                                <div>
                                  <p class="artifact-sidebar-muted">Power Source</p>
                                  <div class="artifact-sidebar-inline-row-tight">
                                    <IconRenderer
                                      ref={selectedPowerSourceOption.iconRef}
                                      label={selectedPowerSourceOption.label}
                                      class="artifact-sidebar-button-icon"
                                      iconClass="artifact-sidebar-inline-icon-small"
                                    />
                                    <p class="artifact-sidebar-value">{selectedPowerSourceOption.label}</p>
                                  </div>
                                </div>
                                <div>
                                  <p class="artifact-sidebar-muted">Slug</p>
                                  <p class="artifact-sidebar-value artifact-sidebar-break-all">{slug || 'auto-generated'}</p>
                                </div>
                                <div>
                                  <p class="artifact-sidebar-muted">Publish Zone</p>
                                  <p class="artifact-sidebar-value">{zone || 'Not selected'}</p>
                                </div>
                              </div>
                              {#if currentArtifact?.control_manifest?.controlIds?.length}
                                <div class="artifact-sidebar-control-list">
                                  <p class="artifact-sidebar-helper">
                                    Artifact Controls ({currentArtifact.control_manifest.controlIds.length})
                                  </p>
                                  <div class="artifact-sidebar-wrap-row-tight">
                                    {#each currentArtifact.control_manifest.controlIds.slice(0, 6) as controlId}
                                      <Badge.Badge variant="outline" class="artifact-sidebar-tiny-badge">{controlId}</Badge.Badge>
                                    {/each}
                                    {#if currentArtifact.control_manifest.controlIds.length > 6}
                                      <Badge.Badge variant="outline" class="artifact-sidebar-tiny-badge">+{currentArtifact.control_manifest.controlIds.length - 6} more</Badge.Badge>
                                    {/if}
                                  </div>
                                </div>
                              {/if}
                            </div>

                            <div class="artifact-sidebar-dashed-note artifact-sidebar-dashed-note-soft">
                              Name, slug, power source, webhook URL, and artifact source details are optional advanced controls.
                              Toggle Advanced Builder below only when needed.
                            </div>

                            {#if showAdvancedBuilder}
                            <div class="artifact-sidebar-grid-2">
                              <div class="artifact-sidebar-stack-sm">
                                <Label for="artifact-name">Name</Label>
                                <Input id="artifact-name" bind:value={editableName} />
                              </div>
                              <div class="artifact-sidebar-stack-sm">
                                <Label for="artifact-slug">Slug</Label>
                                <Input
                                  id="artifact-slug"
                                  value={slug}
                                  oninput={(event) => {
                                    slug = (event.currentTarget as HTMLInputElement).value
                                    slugEdited = true
                                  }}
                                  placeholder="auto-generated"
                                />
                                <p class="artifact-sidebar-helper">Used for internal references. Must be unique per artifact.</p>
                              </div>
                            </div>

                            <div class="artifact-sidebar-grid-2">
                              <div class="artifact-sidebar-stack-sm">
                                <Label>Artifact Power Source</Label>
                                <Select.Root
                                  type="single"
                                  value={powerSource}
                                  onValueChange={(value) => {
                                    powerSource = value as ArtifactPowerSource
                                    pendingMetadata = applyArtifactPowerSourceToMetadata(pendingMetadata, powerSource)
                                  }}
                                >
                                  <Select.Trigger class="artifact-sidebar-full-width">
                                    <span data-slot="select-value" class="artifact-sidebar-power-value">
                                      <IconRenderer
                                        ref={selectedPowerSourceOption.iconRef}
                                        label={selectedPowerSourceOption.label}
                                        class="artifact-sidebar-provider-icon"
                                        iconClass="artifact-sidebar-button-icon"
                                      />
                                      {selectedPowerSourceOption.label}
                                    </span>
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each ARTIFACT_POWER_SOURCE_OPTIONS as option (option.value)}
                                      <Select.Item value={option.value} label={option.label}>
                                        <div class="artifact-sidebar-power-item">
                                          <IconRenderer
                                            ref={option.iconRef}
                                            label={option.label}
                                            class="artifact-sidebar-power-icon"
                                            iconClass="artifact-sidebar-button-icon"
                                          />
                                          <div class="artifact-sidebar-min-w-0">
                                            <div class="artifact-sidebar-power-item-title">{option.label}</div>
                                            <div class="artifact-sidebar-power-item-desc">{option.description}</div>
                                          </div>
                                        </div>
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                                <p class="artifact-sidebar-helper">{selectedPowerSourceOption.description}</p>
                              </div>

                              {#if selectedPowerSourceOption.usesWebhook}
                                <div class="artifact-sidebar-stack-sm">
                                  <Label for="artifact-webhook">Webhook URL</Label>
                                  <Input
                                    id="artifact-webhook"
                                    placeholder="https://your-n8n.com/webhook/artifact"
                                    bind:value={webhookUrl}
                                  />
                                </div>
                              {/if}
                            </div>
                            {#if selectedPowerSourceOption.acceptsSystemPrompt}
                              <div class="artifact-sidebar-stack-sm">
                                <Label for="artifact-prompt">Artifact System Prompt</Label>
                                <Textarea
                                  id="artifact-prompt"
                                  placeholder="Runtime instructions for this artifact"
                                  bind:value={systemPrompt}
                                  class="artifact-sidebar-system-prompt"
                                />
                              </div>
                            {/if}
                            {/if}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>

                      <Collapsible.Root bind:open={zonesOpen}>
                        <Collapsible.Trigger onclick={() => toggleSection('zones')} class="artifact-sidebar-section-trigger">
                          <div class="artifact-sidebar-section-label">
                            <span class="artifact-sidebar-strong">2. Zones</span>
                            <span class="artifact-sidebar-muted">Choose where this artifact is published</span>
                          </div>
                          <ChevronDown class="artifact-sidebar-button-icon" />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="artifact-sidebar-section-content">
                          <div class="artifact-sidebar-card artifact-sidebar-stack-sm">
                            <WidgetPlacementConfig
                              position={zone || undefined}
                              onPositionChange={(pos) => zone = pos || null}
                            />
                            <div class="artifact-sidebar-helper artifact-sidebar-stack-xs">
                              <p>Sidebar mini-widgets sit in a ~240px slot above the user area; we show two by default and tuck the rest into an accordion.</p>
                              <p>Header icons open a roomy overlay; great for large artifacts. Trigger dropdown is for buttons/forms only and stays open until explicitly closed.</p>
                            </div>
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>

                      <div class="artifact-sidebar-builder-note artifact-sidebar-stack-sm">
                        <p class="artifact-sidebar-builder-title">Advanced Builder (optional)</p>
                        <p>
                          Turn this on only when you need raw code editing, version diff/restore, blueprint notes, or direct name/slug/power-source/webhook edits.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onclick={() => {
                            showAdvancedBuilder = !showAdvancedBuilder
                          }}
                        >
                          {showAdvancedBuilder ? 'Hide Advanced Builder' : 'Show Advanced Builder'}
                        </Button>
                      </div>

                      {#if showAdvancedBuilder}
                      <Collapsible.Root bind:open={codeOpen}>
                        <Collapsible.Trigger onclick={() => toggleSection('code')} class="artifact-sidebar-section-trigger">
                          <div class="artifact-sidebar-section-label">
                            <span class="artifact-sidebar-strong">3. Code</span>
                            <span class="artifact-sidebar-muted">Edit, note, and save</span>
                          </div>
                          <ChevronDown class="artifact-sidebar-button-icon" />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="artifact-sidebar-section-content">
                          <div class="artifact-sidebar-stack-sm">
                            <Label for="artifact-code">Artifact HTML / JS</Label>
                            <Textarea
                              id="artifact-code"
                              class="artifact-sidebar-code-editor"
                              bind:value={editorContent}
                            />
                            <Input
                              class="artifact-sidebar-version-note-input"
                              placeholder="Version note (optional, saved when you click Save above)"
                              bind:value={versionNote}
                            />
                            {#if saveError}
                              <p class="artifact-sidebar-error-text">{saveError}</p>
                            {/if}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>

                      <Collapsible.Root bind:open={versionsOpen}>
                        <Collapsible.Trigger onclick={() => toggleSection('versions')} class="artifact-sidebar-section-trigger">
                          <div class="artifact-sidebar-section-label">
                            <span class="artifact-sidebar-strong">4. Versions</span>
                            <span class="artifact-sidebar-muted">Restore or diff prior saves</span>
                          </div>
                          <ChevronDown class="artifact-sidebar-button-icon" />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="artifact-sidebar-section-content">
                          <div class="artifact-sidebar-card artifact-sidebar-version-shell">
                            <div class="artifact-sidebar-row-between">
                              <div>
                                <p class="artifact-sidebar-value">Version history</p>
                                <p class="artifact-sidebar-helper">Quick restore and compact diffs</p>
                              </div>
                              <Badge.Badge variant="outline">v{currentArtifact.version || 1}</Badge.Badge>
                            </div>

                            {#if currentArtifact.versions?.length}
                              {#each [...currentArtifact.versions].sort((a, b) => (b.version || 0) - (a.version || 0)) as version}
                                <div class="artifact-sidebar-version-item">
                                  <div class="artifact-sidebar-row-between">
                                    <div>
                                      <div class="artifact-sidebar-value">v{version.version}</div>
                                      <div class="artifact-sidebar-helper">{formatTimestamp(version.created_at)}</div>
                                    </div>
                                    <div class="artifact-sidebar-inline-row">
                                      {#if currentArtifact.version === version.version}
                                        <Badge.Badge variant="outline">Current</Badge.Badge>
                                      {:else}
                                        <Button size="sm" variant="ghost" onclick={() => rollbackVersion(Number(version.version))}>
                                          Restore
                                        </Button>
                                      {/if}
                                      <Button size="sm" variant="outline" onclick={() => selectDiff(Number(version.version))}>
                                        Diff
                                      </Button>
                                    </div>
                                  </div>
                                  {#if version.description}
                                    <p class="artifact-sidebar-version-description">{version.description}</p>
                                  {/if}
                                </div>
                              {/each}
                              {#if diffVersion && currentArtifact}
                                {@const target = getVersionEntry(diffVersion)}
                                {@const current = getVersionEntry(currentArtifact.version)}
                                <div class="artifact-sidebar-diff-card">
                                  <div class="artifact-sidebar-row-between">
                                    <div>
                                      <div class="artifact-sidebar-value">Diff v{diffVersion} → v{currentArtifact.version}</div>
                                      <div class="artifact-sidebar-helper">{diffSummary}</div>
                                    </div>
                                    <Button size="sm" variant="ghost" onclick={() => diffVersion = null}>Close</Button>
                                  </div>
                                  <div class="artifact-sidebar-diff-grid">
                                    <div class="artifact-sidebar-stack-xs">
                                      <div class="artifact-sidebar-helper">v{target?.version} (older)</div>
                                      <pre class="artifact-sidebar-code-preview">{target?.content}</pre>
                                    </div>
                                    <div class="artifact-sidebar-stack-xs">
                                      <div class="artifact-sidebar-helper">v{current?.version} (current)</div>
                                      <pre class="artifact-sidebar-code-preview">{current?.content}</pre>
                                    </div>
                                  </div>
                                </div>
                              {/if}
                            {:else}
                              <p class="artifact-sidebar-muted-copy">No versions yet. Saving will create version 1.</p>
                            {/if}
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>

                      <Collapsible.Root bind:open={blueprintOpen}>
                        <Collapsible.Trigger onclick={() => toggleSection('blueprint')} class="artifact-sidebar-section-trigger">
                          <div class="artifact-sidebar-section-label">
                            <span class="artifact-sidebar-strong">5. Blueprint</span>
                            <span class="artifact-sidebar-muted">Planning & progress notes</span>
                          </div>
                          <ChevronDown class="artifact-sidebar-button-icon" />
                        </Collapsible.Trigger>
                        <Collapsible.Content class="artifact-sidebar-section-content">
                          <div class="artifact-sidebar-card artifact-sidebar-stack-md">
                            <div class="artifact-sidebar-row-between">
                              <div class="artifact-sidebar-inline-row">
                                <ClipboardList class="artifact-sidebar-button-icon artifact-sidebar-muted-icon" />
                                <Label for="artifact-blueprint">Blueprint</Label>
                              </div>
                              {#if blueprintContent}
                                <Badge.Badge variant="outline">Has notes</Badge.Badge>
                              {/if}
                            </div>
                            <Textarea
                              id="artifact-blueprint"
                              class="artifact-sidebar-blueprint-editor"
                              placeholder="# Blueprint: {currentArtifact?.name || 'Artifact Name'}&#10;Status: Planning | In Progress | Complete&#10;&#10;## Vision&#10;[What this artifact should do]&#10;&#10;## Plan&#10;[Decisions made, approach chosen]&#10;&#10;## Progress Log&#10;- [timestamp] Created artifact&#10;&#10;## Notes&#10;[Additional context, reminders]"
                              bind:value={blueprintContent}
                            />
                            <p class="artifact-sidebar-helper">
                              A planning and progress document for complex artifact builds. Use markdown. Both you and the PA can edit this to track vision, decisions, and progress across sessions.
                            </p>
                          </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                      {/if}
                    </div>
                  </div>
                </div>
              {:else}
                <div class="artifact-sidebar-preview">
                  {#if !iframeLoaded}
                    <div class="artifact-sidebar-loader">
                      <Loader2 class="artifact-sidebar-loader-icon" />
                    </div>
                  {/if}
                  <iframe
                    src={currentArtifactIframeSrc}
                    title="{currentArtifact.name} preview"
                    class="artifact-sidebar-iframe"
                    sandbox={getArtifactIframeSandbox(currentArtifact)}
                    onload={handleIframeLoad}
                  ></iframe>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  :global(.artifact-sidebar-shell) {
    position: relative;
    z-index: var(--z-surface);
    height: 100%;
    overflow: hidden;
    border-left: 0 solid transparent;
    background: var(--bs-app-inset-surface);
    color: var(--bs-app-text);
  }

  :global(.artifact-sidebar-shell.is-open) {
    border-left: 1px solid var(--bs-app-inner-line);
  }

  :global(.artifact-sidebar-panel),
  :global(.artifact-sidebar-detail) {
    display: flex;
    height: 100%;
    flex-direction: column;
  }

  :global(.artifact-sidebar-main) {
    flex: 1 1 0;
    min-height: 0;
    overflow: hidden;
  }

  :global(.artifact-sidebar-empty),
  :global(.artifact-sidebar-loader) {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  :global(.artifact-sidebar-empty) {
    height: 100%;
    padding: 24px;
  }

  :global(.artifact-sidebar-empty-copy) {
    color: var(--bs-app-muted-text);
    text-align: center;
    font-size: 0.875rem;
  }

  :global(.artifact-sidebar-header) {
    padding: 12px 16px;
    border-bottom: 1px solid var(--bs-app-inner-line);
  }

  :global(.artifact-sidebar-inline-row),
  :global(.artifact-sidebar-title-row),
  :global(.artifact-sidebar-header-actions),
  :global(.artifact-sidebar-row-between),
  :global(.artifact-sidebar-wrap-row),
  :global(.artifact-sidebar-wrap-row-tight),
  :global(.artifact-sidebar-inline-row-tight),
  :global(.artifact-sidebar-model-menu-trigger),
  :global(.artifact-sidebar-model-menu-inner),
  :global(.artifact-sidebar-model-menu-text),
  :global(.artifact-sidebar-power-value),
  :global(.artifact-sidebar-power-item) {
    display: flex;
  }

  :global(.artifact-sidebar-inline-row),
  :global(.artifact-sidebar-title-row),
  :global(.artifact-sidebar-row-between),
  :global(.artifact-sidebar-model-menu-trigger),
  :global(.artifact-sidebar-model-menu-inner),
  :global(.artifact-sidebar-power-value),
  :global(.artifact-sidebar-power-item) {
    align-items: center;
  }

  :global(.artifact-sidebar-row-between),
  :global(.artifact-sidebar-model-menu-trigger) {
    justify-content: space-between;
  }

  :global(.artifact-sidebar-inline-row),
  :global(.artifact-sidebar-title-row),
  :global(.artifact-sidebar-model-menu-inner),
  :global(.artifact-sidebar-power-value),
  :global(.artifact-sidebar-power-item) {
    gap: 8px;
  }

  :global(.artifact-sidebar-inline-row-tight) {
    align-items: center;
    gap: 6px;
  }

  :global(.artifact-sidebar-title-row) {
    flex: 1 1 0;
    min-width: 0;
  }

  :global(.artifact-sidebar-header-actions) {
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
  }

  :global(.artifact-sidebar-icon-wrap) {
    position: relative;
    display: inline-flex;
    flex-shrink: 0;
  }

  :global(.artifact-sidebar-source-badge) {
    position: absolute;
    right: -4px;
    bottom: -4px;
  }

  :global(.artifact-sidebar-title),
  :global(.artifact-sidebar-truncate),
  :global(.artifact-sidebar-value.artifact-sidebar-truncate),
  :global(.artifact-sidebar-model-menu-title),
  :global(.artifact-sidebar-model-menu-meta),
  :global(.artifact-sidebar-power-item-title),
  :global(.artifact-sidebar-power-item-desc) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.artifact-sidebar-title),
  :global(.artifact-sidebar-strong) {
    font-weight: 600;
  }

  :global(.artifact-sidebar-title) {
    min-width: 0;
  }

  :global(.artifact-sidebar-button-icon),
  :global(.artifact-sidebar-detail-icon),
  :global(.artifact-sidebar-provider-icon),
  :global(.artifact-sidebar-power-icon),
  :global(.artifact-sidebar-inline-icon-small) {
    flex-shrink: 0;
  }

  :global(.artifact-sidebar-button-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.artifact-sidebar-detail-icon),
  :global(.artifact-sidebar-provider-icon),
  :global(.artifact-sidebar-power-icon) {
    width: 20px;
    height: 20px;
  }

  :global(.artifact-sidebar-inline-icon-small) {
    width: 14px;
    height: 14px;
  }

  :global(.artifact-sidebar-muted-icon),
  :global(.artifact-sidebar-muted),
  :global(.artifact-sidebar-helper),
  :global(.artifact-sidebar-muted-copy),
  :global(.artifact-sidebar-model-menu-meta),
  :global(.artifact-sidebar-power-item-desc),
  :global(.artifact-sidebar-version-description) {
    color: var(--bs-app-muted-text);
  }

  :global(.artifact-sidebar-icon-button) {
    width: 32px;
    height: 32px;
  }

  :global(.artifact-sidebar-settings-scroll) {
    position: relative;
    height: 100%;
    overflow-y: auto;
  }

  :global(.artifact-sidebar-settings-pad) {
    padding: 16px;
  }

  :global(.artifact-sidebar-stack-lg),
  :global(.artifact-sidebar-stack-md),
  :global(.artifact-sidebar-stack-sm),
  :global(.artifact-sidebar-stack-xs),
  :global(.artifact-sidebar-stack-xxs),
  :global(.artifact-sidebar-model-menu-text) {
    flex-direction: column;
  }

  :global(.artifact-sidebar-stack-lg) {
    display: flex;
    gap: 16px;
  }

  :global(.artifact-sidebar-stack-md) {
    display: flex;
    gap: 12px;
  }

  :global(.artifact-sidebar-stack-sm) {
    display: flex;
    gap: 8px;
  }

  :global(.artifact-sidebar-stack-xs) {
    display: flex;
    gap: 4px;
  }

  :global(.artifact-sidebar-stack-xxs) {
    display: flex;
    gap: 2px;
  }

  :global(.artifact-sidebar-section-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 6px;
    background: var(--bs-app-field);
    color: var(--bs-app-field-text);
    padding: 8px 12px;
    text-align: left;
    transition: background-color 0.16s ease;
  }

  :global(.artifact-sidebar-section-trigger:hover) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.artifact-sidebar-section-label) {
    display: flex;
    flex-direction: column;
    font-size: 0.875rem;
  }

  :global(.artifact-sidebar-section-content) {
    padding-top: 12px;
  }

  :global(.artifact-sidebar-card),
  :global(.artifact-sidebar-raised-card),
  :global(.artifact-sidebar-role-card),
  :global(.artifact-sidebar-dashed-note),
  :global(.artifact-sidebar-builder-note),
  :global(.artifact-sidebar-version-item),
  :global(.artifact-sidebar-diff-card),
  :global(.artifact-sidebar-code-preview),
  :global(.artifact-sidebar-danger-note) {
    border: 1px solid var(--bs-app-field-line);
    border-radius: 6px;
  }

  :global(.artifact-sidebar-card) {
    background: var(--bs-app-field);
    padding: 12px;
  }

  :global(.artifact-sidebar-raised-card) {
    background: color-mix(in oklab, var(--bs-app-card) 70%, var(--bs-app-inset-surface));
    padding: 12px;
  }

  :global(.artifact-sidebar-role-card) {
    background: var(--bs-app-field);
    padding: 12px;
  }

  :global(.artifact-sidebar-card-title) {
    font-size: 0.875rem;
    font-weight: 600;
  }

  :global(.artifact-sidebar-helper),
  :global(.artifact-sidebar-dashed-note),
  :global(.artifact-sidebar-builder-note),
  :global(.artifact-sidebar-danger-note),
  :global(.artifact-sidebar-tiny-badge) {
    font-size: 0.75rem;
  }

  :global(.artifact-sidebar-dashed-note),
  :global(.artifact-sidebar-builder-note) {
    border-style: dashed;
    background: var(--bs-app-field);
    color: var(--bs-app-muted-text);
    padding: 8px 12px;
  }

  :global(.artifact-sidebar-dashed-note-soft),
  :global(.artifact-sidebar-builder-note) {
    background: color-mix(in oklab, var(--bs-app-field) 76%, transparent);
  }

  :global(.artifact-sidebar-danger-note) {
    border-color: oklch(from var(--destructive) l c h / 0.4);
    background: oklch(from var(--destructive) l c h / 0.1);
    color: var(--destructive);
    padding: 8px 12px;
  }

  :global(.artifact-sidebar-builder-title) {
    color: var(--bs-app-title);
    font-weight: 500;
  }

  :global(.artifact-sidebar-info-grid),
  :global(.artifact-sidebar-grid-2),
  :global(.artifact-sidebar-diff-grid) {
    display: grid;
    gap: 12px;
  }

  :global(.artifact-sidebar-info-grid) {
    gap: 8px;
    font-size: 0.75rem;
  }

  @media (min-width: 640px) {
    :global(.artifact-sidebar-info-grid) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (min-width: 768px) {
    :global(.artifact-sidebar-grid-2),
    :global(.artifact-sidebar-diff-grid) {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  :global(.artifact-sidebar-diff-grid) {
    margin-top: 12px;
  }

  :global(.artifact-sidebar-control-list) {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-top: 4px;
  }

  :global(.artifact-sidebar-wrap-row) {
    flex-wrap: wrap;
    gap: 8px;
  }

  :global(.artifact-sidebar-wrap-row-tight) {
    flex-wrap: wrap;
    gap: 4px;
  }

  :global(.artifact-sidebar-full-width) {
    width: 100%;
  }

  :global(.artifact-sidebar-select-value),
  :global(.artifact-sidebar-power-value),
  :global(.artifact-sidebar-model-menu-trigger),
  :global(.artifact-sidebar-model-menu-title),
  :global(.artifact-sidebar-muted-copy) {
    font-size: 0.875rem;
  }

  :global(.artifact-sidebar-model-menu-trigger) {
    min-height: 36px;
    border: 1px solid var(--bs-app-field-line);
    border-radius: 6px;
    background: var(--bs-app-field);
    padding: 8px 12px;
    color: var(--bs-app-field-text);
    transition: background-color 0.16s ease;
  }

  :global(.artifact-sidebar-model-menu-trigger:hover) {
    border-color: var(--bs-app-field-line-hover);
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.artifact-sidebar-model-menu-trigger:focus-visible) {
    outline: none;
    box-shadow: 0 0 0 1px var(--bs-app-primary-soft);
  }

  :global(.artifact-sidebar-model-menu-content) {
    width: 320px;
  }

  :global(.artifact-sidebar-model-menu-inner),
  :global(.artifact-sidebar-model-menu-text),
  :global(.artifact-sidebar-min-w-0),
  :global(.artifact-sidebar-power-item > .artifact-sidebar-min-w-0) {
    min-width: 0;
  }

  :global(.artifact-sidebar-model-menu-meta),
  :global(.artifact-sidebar-power-item-desc),
  :global(.artifact-sidebar-version-description) {
    font-size: 0.75rem;
  }

  :global(.artifact-sidebar-power-item-title) {
    font-size: 0.875rem;
    font-weight: 500;
  }

  :global(.artifact-sidebar-value) {
    font-weight: 500;
  }

  :global(.artifact-sidebar-break-all) {
    word-break: break-all;
  }

  :global(.artifact-sidebar-error-text) {
    color: var(--destructive);
    font-size: 0.875rem;
  }

  :global(.artifact-sidebar-system-prompt) {
    min-height: 120px;
  }

  :global(.artifact-sidebar-code-editor) {
    min-height: 260px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.875rem;
  }

  :global(.artifact-sidebar-version-note-input) {
    flex: 1 1 0;
    min-width: 220px;
  }

  :global(.artifact-sidebar-version-shell) {
    border-color: var(--bs-app-field-line);
  }

  :global(.artifact-sidebar-version-item) {
    width: 100%;
    padding: 12px;
    transition: background-color 0.16s ease;
  }

  :global(.artifact-sidebar-version-item:hover) {
    background: var(--bs-app-field-hover);
  }

  :global(.artifact-sidebar-version-description) {
    margin-top: 4px;
  }

  :global(.artifact-sidebar-diff-card) {
    margin-top: 12px;
    background: color-mix(in oklab, var(--bs-app-card) 72%, transparent);
    padding: 12px;
  }

  :global(.artifact-sidebar-code-preview) {
    max-height: 16rem;
    overflow-y: auto;
    background: var(--bs-app-card);
    padding: 8px;
    font-size: 0.75rem;
    white-space: pre-wrap;
  }

  :global(.artifact-sidebar-blueprint-editor) {
    min-height: 200px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 0.875rem;
  }

  :global(.artifact-sidebar-preview) {
    position: relative;
    height: 100%;
    background: var(--bs-app-card);
  }

  :global(.artifact-sidebar-loader) {
    position: absolute;
    inset: 0;
  }

  :global(.artifact-sidebar-loader-icon) {
    width: 32px;
    height: 32px;
    color: var(--bs-app-muted-text);
    animation: artifact-sidebar-spin 1s linear infinite;
  }

  :global(.artifact-sidebar-iframe) {
    width: 100%;
    height: 100%;
    border: 0;
  }

  @keyframes artifact-sidebar-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Enhanced resize handle visibility */
  :global(body.dragging-artifacts) {
    cursor: col-resize !important;
  }
  
  :global(body.dragging-artifacts *) {
    cursor: col-resize !important;
    user-select: none !important;
  }
</style>
