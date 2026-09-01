<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Paperclip, X, Upload, Trash2, Loader2, RefreshCw, AlertTriangle, CheckCircle2 } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { onMount, untrack } from 'svelte'
  import { toast } from 'svelte-sonner'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import ClipThumbnailTile from '$lib/components/clips/ClipThumbnailTile.svelte'
  import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
  import {
    getClipFileIconName,
    isClipImage,
    resolveClipContextTokens,
    resolveClipPreviewUrl
  } from '$lib/utils/clipPresentation'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import { getUserSettings } from '$lib/stores/userSettings.svelte'
  import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
  import type { PageData } from '../../../routes/$types'
  
  // Props
  let { 
    sessionId = null,
    pageData,
    onClippedItemsChange = (_clips: Clip[]) => {}
  }: { 
    sessionId: string | null,
    pageData: PageData | null
    onClippedItemsChange?: (clips: Clip[]) => void
  } = $props()
  
  // Types for clips
  interface Clip {
    id: string
    filename: string
    description?: string
    fileType?: string
    mimeType?: string
    externalUrl?: string
    displayUrl?: string  // URL for display in frontend (may differ from externalUrl)
    localUrl?: string
    thumbnailUrl?: string
    externalTokens?: number
    localTokens?: number
    storageMode: 'local'
    uploadedAt: string
    isClipped?: boolean
    systemClip?: boolean
    unclipAfter?: number | null
    messagesUntilUnclip?: number | null
  }

  interface SessionClipStateEntry {
    clipId: string
    unclipAfter?: number | null
    messagesUntilUnclip?: number | null
  }

  interface ManagedTunnelStatus {
    installed: boolean
    reason?: string | null
    error?: string
    autoStart?: boolean
    targetUrl?: string
    tunnelProvider?: string
    tunnel?: {
      running: boolean
      publicUrl: string | null
      targetUrl: string | null
      pid: number | null
      startedAt: string | null
      lastError: string | null
    }
  }
  
  // State for clips
  let clipVault = $state<Clip[]>([]) // All user's clips (plus system)
  let clippedItems = $state<Clip[]>([]) // Currently clipped items
  let totalTokens = $state(0)
  let systemClipVault = $derived(clipVault.filter((c) => c.systemClip))
  let userClipVault = $derived(clipVault.filter((c) => !c.systemClip))
  let isOpen = $state(false)
  let fileInput: HTMLInputElement
  let managedTunnelStatus = $state<ManagedTunnelStatus | null>(null)
  let managedTunnelBusy = $state(false)
  let managedTunnelError = $state<string | null>(null)
  let bulkDeleteMode = $state(false)
  let selectedClipIds = $state<string[]>([])
  let bulkDeleteBusy = $state(false)
  let vaultVisibleUserClips = $derived(userClipVault.filter((c) => !c.isClipped))
  let allUserClipIds = $derived(userClipVault.map((clip) => clip.id))
  let allUserClipsSelected = $derived(
    allUserClipIds.length > 0 && allUserClipIds.every((clipId) => selectedClipIds.includes(clipId))
  )

  function upsertClip(clip: Clip, shouldClip: boolean) {
    const existingIndex = clipVault.findIndex((item) => item.id === clip.id)
    const merged = existingIndex >= 0
      ? {
          ...clipVault[existingIndex],
          ...clip,
          isClipped: shouldClip || clipVault[existingIndex].isClipped,
          unclipAfter: clip.unclipAfter ?? clipVault[existingIndex].unclipAfter ?? null,
          messagesUntilUnclip:
            clip.messagesUntilUnclip ?? clipVault[existingIndex].messagesUntilUnclip ?? null
        }
      : { ...clip, isClipped: shouldClip }

    if (existingIndex >= 0) {
      clipVault = [
        ...clipVault.slice(0, existingIndex),
        merged,
        ...clipVault.slice(existingIndex + 1)
      ]
    } else {
      clipVault = [...clipVault, merged]
    }

    if (shouldClip) {
      if (!clippedItems.some((item) => item.id === merged.id)) {
        clippedItems = [...clippedItems, merged]
      } else {
        clippedItems = clippedItems.map((item) => (item.id === merged.id ? merged : item))
      }
    }
  }
  
  // Calculate total tokens
  $effect(() => {
    totalTokens = clippedItems.reduce((sum, clip) => {
      const tokens = resolveClipContextTokens(clip)
      return sum + (tokens || 0)
    }, 0)
  })

  $effect(() => {
    onClippedItemsChange(clippedItems.map((clip) => ({ ...clip })))
  })

  function applySessionStateToVault(
    clips: Clip[],
    stateEntries: SessionClipStateEntry[] = []
  ) {
    const stateMap = new Map(
      stateEntries
        .filter((entry) => entry?.clipId)
        .map((entry) => [entry.clipId, entry])
    )

    const nextVault = clips.map((clip) => {
      const sessionEntry = stateMap.get(clip.id)
      return {
        ...clip,
        isClipped: Boolean(sessionEntry),
        unclipAfter: sessionEntry?.unclipAfter ?? null,
        messagesUntilUnclip: sessionEntry?.messagesUntilUnclip ?? null
      }
    })

    clipVault = nextVault
    clippedItems = nextVault.filter((clip) => clip.isClipped)
  }

  function deriveFileType(mimeType?: string, filename?: string): string | undefined {
    const normalizedMime = mimeType?.toLowerCase() || ''
    const extension = filename?.split('.').pop()?.toLowerCase() || ''
    if (normalizedMime.startsWith('image/')) return 'image'
    if (normalizedMime.startsWith('text/') || normalizedMime === 'application/json') return 'text'
    if (normalizedMime.includes('pdf') || extension === 'pdf') return 'pdf'
    return undefined
  }

  function getClipFileIconRef(clip: Clip) {
    return getProjectTreeIconRef({
      name: getClipFileIconName(clip),
      type: 'file'
    })
  }

  function getUploadSettingsSnapshot() {
    const settings = getUserSettings() ?? pageData?.userSettings ?? null
    const uiSettings = settings?.ui_settings || {}
    const nestedUpload = uiSettings.upload_settings || {}
    const rootUpload = settings?.upload_settings || {}
    const tunnelProvider =
      nestedUpload.tunnel_provider === 'cloudflared_managed' ||
      rootUpload.tunnel_provider === 'cloudflared_managed'
        ? 'cloudflared_managed'
        : nestedUpload.tunnel_provider === 'manual' ||
            rootUpload.tunnel_provider === 'manual'
          ? 'manual'
          : 'none'

    return {
      tunnelProvider,
      cloudflaredAutoStart:
        nestedUpload.cloudflared_auto_start ||
        rootUpload.cloudflared_auto_start ||
        false,
    }
  }

  const managedTunnelEnabled = $derived.by(() => {
    const settings = getUploadSettingsSnapshot()
    return settings.tunnelProvider === 'cloudflared_managed'
  })

  const managedTunnelIsReady = $derived(
    managedTunnelEnabled && Boolean(managedTunnelStatus?.tunnel?.running && managedTunnelStatus?.tunnel?.publicUrl)
  )
  const managedTunnelNeedsAttention = $derived(
    managedTunnelEnabled && !managedTunnelBusy && !managedTunnelIsReady
  )
  const clipsTriggerLabel = $derived(
    managedTunnelNeedsAttention ? 'Manage clips, tunnel unavailable' : 'Manage clips'
  )

  $effect(() => {
    if (managedTunnelIsReady && managedTunnelBusy) {
      managedTunnelBusy = false
    }
  })

  async function refreshManagedTunnelStatus(options?: {
    forceStart?: boolean
    silent?: boolean
  }) {
    if (!managedTunnelEnabled) return
    if (managedTunnelBusy) return

    managedTunnelBusy = true
    managedTunnelError = null

    try {
      const response = await fetch('/api/native-tools/cloudflared/tunnel', options?.forceStart
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'start' })
          }
        : undefined)
      const payload = await response.json().catch(() => ({}))
      managedTunnelStatus = payload as ManagedTunnelStatus

      if (!response.ok) {
        throw new Error(
          (payload && (payload.error || payload.reason)) || 'Failed to refresh managed tunnel'
        )
      }

      if (options?.forceStart && !options.silent) {
        toast.success('Managed tunnel refreshed')
      }

      await loadClips()
    } catch (error) {
      managedTunnelError =
        error instanceof Error ? error.message : 'Failed to refresh managed tunnel'
      if (!options?.silent) {
        toast.error(managedTunnelError)
      }
    } finally {
      managedTunnelBusy = false
    }
  }
  
  // Load clips from storage
  async function loadClips() {
    try {
      // Fetch user's clips from the API
      const response = await fetch('/api/clips')
      if (response.ok) {
        const clips = await response.json()
        const mappedClips = clips.map((clip: any) => ({
          id: clip.id,
          filename: clip.filename,
          description: clip.description,
          fileType: clip.fileType,
          mimeType: clip.mimeType,
          externalUrl: clip.externalUrl,
          displayUrl: clip.displayUrl, // Add displayUrl for frontend rendering
          localUrl: clip.localUrl,
          thumbnailUrl: clip.thumbnailUrl,
          externalTokens: clip.externalTokens,
          localTokens: clip.localTokens,
          storageMode: clip.storageMode,
          uploadedAt: clip.created_at,
          isClipped: false, // Initially not clipped to current message
          systemClip: clip.systemClip === true,
          unclipAfter: null,
          messagesUntilUnclip: null
        }))
        
        // Load session clip state if we have a session (single source of truth)
        if (sessionId) {
          const sessionResponse = await fetch(`/api/session-clips/state/${sessionId}`)
          if (sessionResponse.ok) {
            const sessionState = await sessionResponse.json()
            applySessionStateToVault(
              mappedClips,
              Array.isArray(sessionState?.clips) ? sessionState.clips : []
            )
            return
          }
        }

        clipVault = mappedClips
        clippedItems = mappedClips.filter((clip: Clip) => clip.isClipped)
      }
    } catch (error) {
      console.error('Failed to load clips:', error)
      toast.error('Failed to load clips')
    }
  }
  
  async function uploadFilesInternal(files: File[]) {
    if (files.length === 0) return

    const uploadToast = toast.loading(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`)

    try {
      // Fetch fresh settings from API to avoid stale pageData
      let uiSettings: any = {}
      try {
        const settingsResponse = await fetch('/api/user/settings')
        if (settingsResponse.ok) {
          const settingsData = await settingsResponse.json()
          uiSettings = settingsData?.settings?.ui_settings || {}
        }
      } catch (err) {
        console.warn('Failed to fetch fresh settings, using pageData:', err)
        uiSettings = pageData?.userSettings?.ui_settings || {}
      }

      const compressionSettings = {
        compress_images: uiSettings.compress_images !== false,
        compression_quality: uiSettings.compression_quality || 40,
        max_image_size: uiSettings.max_image_size || '1024',
        force_jpeg: uiSettings.force_jpeg !== false
      }
      
      // Create FormData
      const formData = new FormData()
      for (const file of files) {
        formData.append('files', file)
      }
      
      // Add session ID
      if (sessionId) {
        formData.append('sessionId', sessionId)
      }
      
      // Add user ID
      if (pageData?.user?.id) {
        formData.append('userId', pageData.user.id)
      }
      
      // Add settings
      formData.append('compressionSettings', JSON.stringify(compressionSettings))
      formData.append('uploadSettings', JSON.stringify({
        strategy: 'local',
        storage_mode: 'local',
        webhookUrl: '',
        webhookAuth: '',
        tunnel_url: '',
        use_https: false,
        tunnel_provider: 'none',
        cloudflared_auto_start: false,
        cloudflared_target_url: ''
      }))
      
      // Upload through the session-authed app proxy (batshit-server's upload
      // routes are service-token-gated and not browser-reachable directly)
      const response = await fetch('/api/uploads/clips', {
        method: 'POST',
        body: formData
      })
      
      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`)
      }
      
      const result = await response.json()
      
      // Process uploaded files into clips
      if (result.files) {
        for (const file of result.files) {
          // The server now returns clipData with the clip info
          if (file.clipData) {
            const storageMode: Clip['storageMode'] = 'local'
            const returnedTokens = file.clipData.tokens
            const clip: Clip = {
              id: file.clipData.id,
              filename: file.originalName,
              fileType: deriveFileType(file.mimetype, file.originalName),
              mimeType: file.mimetype,
              externalUrl: file.externalUrl,
              displayUrl: file.displayUrl, // Include displayUrl for frontend rendering
              localUrl: file.localUrl || file.url,
              thumbnailUrl:
                typeof file.mimetype === 'string' && file.mimetype.startsWith('image/')
                  ? file.displayUrl || file.localUrl || file.url
                  : undefined,
              externalTokens:
                file.externalTokens ??
                file.clipData.externalTokens,
              localTokens:
                file.localTokens ??
                file.clipData.localTokens ??
                returnedTokens,
              storageMode,
              uploadedAt: new Date().toISOString(),
              isClipped: true, // Auto-clip on upload
              unclipAfter: null,
              messagesUntilUnclip: null
            }
            
            // Add to vault and clipped items
            clipVault = [...clipVault, clip]
            clippedItems = [...clippedItems, clip]
            
            // Attach to session using NEW session state API
            if (sessionId) {
              try {
                // NEW: Use session state API for tracking clips
                await fetch('/api/session-clips/state', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    sessionId,
                    clipId: clip.id,
                    action: 'attach'
                  })
                })
              } catch (error) {
                console.error('Failed to attach clip to session:', error)
              }
            }
          }
        }
        
        toast.dismiss(uploadToast)
        toast.success(`Uploaded and clipped ${result.files.length} file${result.files.length > 1 ? 's' : ''}`)
      }
    } catch (error) {
      toast.dismiss(uploadToast)
      toast.error(`Upload failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Handle file upload (input)
  async function handleUpload(event: Event) {
    const target = event.target as HTMLInputElement
    const files = target.files ? Array.from(target.files) : []
    if (files.length === 0) return

    await uploadFilesInternal(files)

    // Reset file input
    target.value = ''
  }

  // Allow drag/drop callers (ChatInput) to reuse Clip Vault uploads.
  export async function uploadFiles(files: File[] | FileList) {
    const list = Array.isArray(files) ? files : Array.from(files)
    await uploadFilesInternal(list)
  }
  
  // Toggle clip status
  async function toggleClip(clip: Clip) {
    const wasClipped = clip.isClipped
    clip.isClipped = !clip.isClipped
    
    if (clip.isClipped) {
      clippedItems = [...clippedItems, clip]
      // Update session state (NEW approach)
      if (sessionId) {
        try {
          await fetch('/api/session-clips/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              clipId: clip.id,
              action: 'attach',
              unclipAfter: null
            })
          })
          clippedItems = clippedItems.map((item) =>
            item.id === clip.id
              ? { ...item, unclipAfter: null, messagesUntilUnclip: null }
              : item
          )
        } catch (error) {
          console.error('Failed to clip item:', error)
          // Revert on error
          clip.isClipped = wasClipped
          clippedItems = clippedItems.filter(c => c.id !== clip.id)
          toast.error('Failed to clip item')
        }
      }
    } else {
      clippedItems = clippedItems.filter(c => c.id !== clip.id)
      // Update session state (NEW approach)
      if (sessionId) {
        try {
          await fetch('/api/session-clips/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              clipId: clip.id,
              action: 'detach'
            })
          })
        } catch (error) {
          console.error('Failed to unclip item:', error)
          // Revert on error
          clip.isClipped = wasClipped
          clippedItems = [...clippedItems, clip]
          toast.error('Failed to unclip item')
        }
      }
    }
  }

  async function setClipOneTimeMode(clipId: string, enabled: boolean) {
    const nextDuration = enabled ? 1 : null
    const update = (clip: Clip) =>
      clip.id === clipId
        ? {
            ...clip,
            unclipAfter: nextDuration,
            messagesUntilUnclip: nextDuration
          }
        : clip

    clipVault = clipVault.map(update)
    clippedItems = clippedItems.map(update)

    if (!sessionId) return

    try {
      const response = await fetch('/api/session-clips/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          clipId,
          action: 'update_duration',
          unclipAfter: nextDuration
        })
      })
      if (!response.ok) {
        throw new Error('Failed to persist clip duration')
      }
    } catch (error) {
      console.error('Failed to update one-message clip duration:', error)
      toast.error('Failed to update clip duration')
      if (sessionId) {
        await loadClips()
      }
    }
  }
  
  // Unclip all
  async function unclipAll() {
    clipVault = clipVault.map(c => ({ ...c, isClipped: false }))
    clippedItems = []

    if (!sessionId) return

    try {
      await fetch(`/api/session-clips/state/${sessionId}`, {
        method: 'DELETE'
      })
    } catch (error) {
      console.error('Failed to clear session clip state:', error)
    }
  }

  function setBulkDeleteMode(enabled: boolean) {
    bulkDeleteMode = enabled
    selectedClipIds = []
  }

  function toggleBulkDeleteMode() {
    setBulkDeleteMode(!bulkDeleteMode)
  }

  function isClipSelected(clipId: string) {
    return selectedClipIds.includes(clipId)
  }

  function setClipSelected(clipId: string, selected: boolean) {
    selectedClipIds = selected
      ? Array.from(new Set([...selectedClipIds, clipId]))
      : selectedClipIds.filter((id) => id !== clipId)
  }

  function toggleClipSelection(clipId: string) {
    setClipSelected(clipId, !isClipSelected(clipId))
  }

  function selectAllUserClips() {
    selectedClipIds = allUserClipsSelected ? [] : allUserClipIds
  }

  async function deleteSelectedClips() {
    if (!pageData?.user?.id) {
      toast.error('User not authenticated')
      return
    }

    const clipIds = selectedClipIds.filter((clipId) => userClipVault.some((clip) => clip.id === clipId))
    if (clipIds.length === 0) return

    const confirmed = await confirmDialog({
      title: `Delete ${clipIds.length} clip${clipIds.length === 1 ? '' : 's'}?`,
      description: 'This permanently deletes the selected clips and removes them from any chats where they are attached. This action cannot be undone.',
      confirmLabel: `Delete ${clipIds.length} Clip${clipIds.length === 1 ? '' : 's'}`,
      tone: 'destructive'
    })
    if (!confirmed) return

    bulkDeleteBusy = true
    try {
      const response = await fetch('/api/clips', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipIds })
      })

      if (!response.ok) {
        throw new Error('Failed to delete clips')
      }

      const deletedSet = new Set(clipIds)
      clipVault = clipVault.filter((clip) => !deletedSet.has(clip.id))
      clippedItems = clippedItems.filter((clip) => !deletedSet.has(clip.id))
      selectedClipIds = []
      bulkDeleteMode = false
      toast.success(`Deleted ${clipIds.length} clip${clipIds.length === 1 ? '' : 's'}`)
    } catch (error) {
      console.error('Error bulk deleting clips:', error)
      toast.error('Failed to delete selected clips')
    } finally {
      bulkDeleteBusy = false
    }
  }
  
  // Delete a clip permanently
  async function deleteClip(clip: Clip) {
    if (!pageData?.user?.id) {
      toast.error('User not authenticated')
      return
    }
    
    const confirmDelete = await confirmDialog({
      title: `Delete "${clip.filename}"?`,
      description: 'This permanently deletes the clip. This action cannot be undone.',
      confirmLabel: 'Delete Clip',
      tone: 'destructive'
    })
    if (!confirmDelete) return
    
    try {
      const response = await fetch(`/api/clips/${clip.id}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        }
      })
      
      if (response.ok) {
        // Remove from local state
        clipVault = clipVault.filter(c => c.id !== clip.id)
        clippedItems = clippedItems.filter(c => c.id !== clip.id)
        selectedClipIds = selectedClipIds.filter((id) => id !== clip.id)
        toast.success(`Deleted ${clip.filename}`)
      } else {
        throw new Error('Failed to delete clip')
      }
    } catch (error) {
      console.error('Error deleting clip:', error)
      toast.error('Failed to delete clip')
    }
  }
  
  // Format token display
  function formatTokens(tokens: number | undefined): string {
    if (!tokens) return '0'
    if (tokens > 1000) {
      return `${(tokens / 1000).toFixed(1)}k`
    }
    return tokens.toString()
  }

  function formatClipContextTokens(clip: Clip): string {
    return formatTokens(resolveClipContextTokens(clip))
  }
  
  onMount(() => {
    loadClips()
    if (managedTunnelEnabled) {
      void refreshManagedTunnelStatus({ silent: true })
    }

    const handleClipUploaded = (event: Event) => {
      const detail = (event as CustomEvent)?.detail
      const incoming = detail?.clip as Clip | undefined
      if (!incoming) return

      const shouldClip =
        Boolean(detail?.autoClip) &&
        Boolean(detail?.sessionId) &&
        Boolean(sessionId) &&
        detail.sessionId === sessionId

      upsertClip(incoming, shouldClip)
    }

    const handleManagedTunnelStatus = (event: Event) => {
      const detail = (event as CustomEvent)?.detail
      if (!detail || !managedTunnelEnabled) return
      if (detail.payload) {
        managedTunnelStatus = detail.payload as ManagedTunnelStatus
        managedTunnelError = typeof detail.error === 'string' ? detail.error : null
        if ((detail.payload as ManagedTunnelStatus)?.tunnel?.publicUrl) {
          managedTunnelBusy = false
        }
        void loadClips()
      }
    }

    const handleSessionClipStateChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>)?.detail
      if (!detail?.sessionId || !sessionId || detail.sessionId !== sessionId) return
      void loadClips()
    }

    window.addEventListener('batshit:clip-uploaded', handleClipUploaded as EventListener)
    window.addEventListener('batshit:managed-tunnel-status', handleManagedTunnelStatus as EventListener)
    window.addEventListener(
      LIVE_SETTINGS_EVENTS.sessionClipStateChanged,
      handleSessionClipStateChanged as EventListener
    )

    return () => {
      window.removeEventListener('batshit:clip-uploaded', handleClipUploaded as EventListener)
      window.removeEventListener('batshit:managed-tunnel-status', handleManagedTunnelStatus as EventListener)
      window.removeEventListener(
        LIVE_SETTINGS_EVENTS.sessionClipStateChanged,
        handleSessionClipStateChanged as EventListener
      )
    }
  })

  let previousIsOpen = $state(false)
  $effect(() => {
    const openingNow = isOpen && !previousIsOpen
    previousIsOpen = isOpen

    if (openingNow) {
      untrack(() => {
        void loadClips()
        if (managedTunnelEnabled) {
          void refreshManagedTunnelStatus({ silent: true })
        }
      })
    }
  })
  
  // Watch for session changes and clear clip states
  let previousSessionId = $state<string | null>(null)
	  $effect(() => {
	    // If session changed (including new session or switching sessions)
	    if (previousSessionId !== null && previousSessionId !== sessionId) {
	      // Clear all clip states (but keep the clips in the vault)
      clipVault = clipVault.map(clip => ({ ...clip, isClipped: false }))
      clippedItems = []
      
      // Load clips for new session if there is one
      if (sessionId) {
        loadClips()
      }
    }
    
    previousSessionId = sessionId
  })
  
  // Export function to get current clipped items with clip syntax
  // TEMPORARY: Still needed during transition to session state
  export function getClippedItemsSyntax(): string {
    if (clippedItems.length === 0) return ''
    
    return clippedItems.map(clip => {
      // Use NEW universal clip syntax: {{batshit-clip:id:::filename}}
      return `{{batshit-clip:${clip.id}:::${clip.filename}}}`
    }).join('\n')
  }
  
  // NEW: Get clipped items for session state (no syntax generation)
  export function getClippedItems(): Clip[] {
    return clippedItems
  }

  export async function detachClipById(clipId: string) {
    const clip = clippedItems.find((item) => item.id === clipId) || clipVault.find((item) => item.id === clipId)
    if (!clip) return
    await toggleClip(clip)
  }

  export async function setClipOneTime(clipId: string, enabled: boolean) {
    await setClipOneTimeMode(clipId, enabled)
  }

  export async function handleMessageAccepted(options?: { waitForServer?: boolean }) {
    const oneTimeIds = clippedItems
      .filter((clip) => (clip.messagesUntilUnclip ?? clip.unclipAfter ?? null) === 1)
      .map((clip) => clip.id)

    if (oneTimeIds.length > 0) {
      clipVault = clipVault.map((clip) =>
        oneTimeIds.includes(clip.id)
          ? { ...clip, isClipped: false, unclipAfter: null, messagesUntilUnclip: null }
          : clip
      )
      clippedItems = clippedItems.filter((clip) => !oneTimeIds.includes(clip.id))
    }

    if (sessionId && options?.waitForServer !== false) {
      await loadClips()
    }
  }
  
  // NEW: Update session clip state when clips change
  async function updateSessionClipState() {
    if (!sessionId) return
    
    try {
      // Clear existing state
      await fetch(`/api/session-clips/state/${sessionId}`, {
        method: 'DELETE'
      })
      
      // Add all currently clipped items to session state
      for (const clip of clippedItems) {
        await fetch('/api/session-clips/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            clipId: clip.id,
            action: 'attach'
          })
        })
      }
    } catch (error) {
      console.error('Failed to update session clip state:', error)
    }
  }
</script>

<DropdownMenu.Root bind:open={isOpen}>
  <DropdownMenu.Trigger
    class="clips-manager-trigger"
    aria-label={clipsTriggerLabel}
    title={clipsTriggerLabel}
    data-testid="manage-clips-button"
    data-ab-control="manage-clips"
  >
    <Paperclip class="clips-manager-trigger-icon" />
    {#if managedTunnelNeedsAttention}
      <span class="clips-manager-tunnel-attention-dot" aria-hidden="true"></span>
    {/if}
    {#if clippedItems.length > 0}
      <Badge
        class="clips-manager-count-badge"
        variant="secondary"
      >
        {clippedItems.length}
      </Badge>
    {/if}
    <span class="clips-manager-screen-reader">Manage clips</span>
  </DropdownMenu.Trigger>
  
<DropdownMenu.Content
  align="end"
  class="clips-manager-content mx-[15px]"
>
    <!-- Header -->
    <div class="px-2 py-1.5">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium">Clipped Items</span>
        <div class="flex items-center gap-1">
          {#if clippedItems.length > 0}
            <Button 
              variant="ghost" 
              size="sm" 
              class="h-6 text-xs px-2"
              onclick={unclipAll}
            >
              Unclip All
            </Button>
          {/if}
          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2"
            onclick={() => fileInput?.click()}
          >
            <Upload class="h-3 w-3 mr-1" />
            Upload
          </Button>
        </div>
      </div>
      
      {#if totalTokens > 0}
        <div class="text-xs text-muted-foreground mt-1">
          Total: {totalTokens.toLocaleString()} tokens
          {#if totalTokens > 10000}
            <span class="text-yellow-500 ml-1">⚠️ High token usage</span>
          {/if}
        </div>
      {/if}
    </div>

    {#if managedTunnelEnabled}
      <div class="px-2 pb-2">
        <div class={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs ${
          managedTunnelIsReady
            ? 'batshit-success-chip'
            : managedTunnelBusy
              ? 'border-sky-500/30 bg-sky-500/10 text-sky-300'
              : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
        }`}>
          <div class="flex items-center gap-2 min-w-0">
            {#if managedTunnelBusy}
              <Loader2 class="h-3.5 w-3.5 animate-spin shrink-0" />
              <span class="truncate">Tunnel connecting...</span>
            {:else if managedTunnelIsReady}
              <CheckCircle2 class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">Tunnel ready</span>
            {:else}
              <AlertTriangle class="h-3.5 w-3.5 shrink-0" />
              <span class="truncate">Tunnel unavailable</span>
            {/if}
          </div>

          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2 text-[11px]"
            onclick={() => refreshManagedTunnelStatus({ forceStart: true })}
            disabled={managedTunnelBusy}
          >
            <RefreshCw class={`mr-1 h-3 w-3 ${managedTunnelBusy ? 'animate-spin' : ''}`} />
            Refresh Tunnel
          </Button>
        </div>
        {#if managedTunnelStatus?.tunnel?.publicUrl}
          <div class="mt-1 truncate text-[10px] text-muted-foreground">
            {managedTunnelStatus.tunnel.publicUrl}
          </div>
        {:else if managedTunnelError}
          <div class="mt-1 text-[10px] text-amber-400">{managedTunnelError}</div>
        {/if}
      </div>
    {/if}
    
    <DropdownMenu.Separator />
    
    <!-- Clipped Items Section -->
    {#if clippedItems.length === 0}
      <div class="px-2 py-6 text-center">
        <div class="text-sm text-muted-foreground mb-2">No clipped items</div>
        <Button
          variant="outline"
          size="sm"
          onclick={() => fileInput?.click()}
        >
          <Upload class="h-3 w-3 mr-1" />
          Upload Files
        </Button>
      </div>
    {:else}
      <div class="max-h-60 overflow-y-auto">
        {#each clippedItems as clip}
          <DropdownMenu.Item 
            class="clips-manager-active-row group flex items-start gap-2 py-2"
            onSelect={(e) => e.preventDefault()}
          >
            {#if bulkDeleteMode && !clip.systemClip}
              <Checkbox
                checked={isClipSelected(clip.id)}
                onCheckedChange={(checked: boolean) => setClipSelected(clip.id, checked === true)}
                class="mt-1 shrink-0"
                aria-label={`Select ${clip.filename} for deletion`}
              />
            {/if}
            <div class="mt-0.5 shrink-0">
              <ClipThumbnailTile clip={clip} size="sm" />
            </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1">
                  <span class="text-sm truncate">
                    {clip.filename}
                  </span>
                  {#if clip.systemClip}
                    <Badge variant="secondary" class="h-5 text-[10px]">batshit</Badge>
                  {/if}
                </div>
              <div class="text-xs text-muted-foreground flex items-center gap-2 mt-1">
                <span>
                  {formatClipContextTokens(clip)} tokens
                </span>
                {#if (clip.messagesUntilUnclip ?? clip.unclipAfter ?? null) === 1}
                  <span class="text-blue-500">• Next message only</span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              {#if !bulkDeleteMode}
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-6 w-6 shrink-0"
                  onclick={() => toggleClip(clip)}
                  aria-label={`Unclip ${clip.filename}`}
                  title="Unclip"
                >
                  <X class="h-3 w-3" />
                </Button>
                {#if !clip.systemClip}
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onclick={() => deleteClip(clip)}
                    aria-label={`Delete clip ${clip.filename} permanently`}
                    title="Delete permanently"
                  >
                    <Trash2 class="h-3 w-3 text-destructive" />
                  </Button>
                {/if}
              {/if}
            </div>
          </DropdownMenu.Item>
        {/each}
      </div>
    {/if}
    
    <DropdownMenu.Separator />
    
    <!-- Clip Vault Section -->
    <div class="px-2 py-1.5 space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">Clip Vault</span>
        <div class="flex items-center gap-1">
          {#if userClipVault.length > 0}
            <Button
              variant={bulkDeleteMode ? 'secondary' : 'ghost'}
              size="sm"
              class="h-6 px-2 text-[11px]"
              onclick={toggleBulkDeleteMode}
              disabled={bulkDeleteBusy}
            >
              {bulkDeleteMode ? 'Cancel' : 'Bulk Delete'}
            </Button>
          {/if}
          <span class="text-xs text-muted-foreground">{clipVault.length} total</span>
        </div>
      </div>

      {#if bulkDeleteMode}
        <div class="clips-manager-bulk-bar">
          <Button
            variant="ghost"
            size="sm"
            class="h-6 px-2 text-[11px]"
            onclick={selectAllUserClips}
            disabled={userClipVault.length === 0 || bulkDeleteBusy}
          >
            {allUserClipsSelected ? 'Clear All' : 'Select All'}
          </Button>
          <span class="clips-manager-bulk-count">
            {selectedClipIds.length} selected
          </span>
          <Button
            variant="destructive"
            size="sm"
            class="h-6 px-2 text-[11px]"
            onclick={deleteSelectedClips}
            disabled={selectedClipIds.length === 0 || bulkDeleteBusy}
          >
            <Trash2 class="mr-1 h-3 w-3" />
            Delete
          </Button>
        </div>
      {/if}

      {#if systemClipVault.length > 0}
        <div class="space-y-1">
          <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Batshit Clips</div>
          <div class="max-h-32 overflow-y-auto space-y-1 pr-1">
            {#each systemClipVault.filter(c => !c.isClipped) as clip}
              <div class="clips-manager-vault-row group flex items-center gap-1 rounded-sm transition-colors">
                <button
                  class="clips-manager-vault-row-button flex-1 text-left px-2 py-1"
                  onclick={() => toggleClip(clip)}
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="clips-manager-vault-file-icon" aria-hidden="true">
                        {#if isClipImage(clip) && resolveClipPreviewUrl(clip)}
                          <img src={resolveClipPreviewUrl(clip) || ''} alt="" class="clips-manager-vault-preview" />
                        {:else}
                          <IconRenderer
                            ref={getClipFileIconRef(clip)}
                            label={clip.filename}
                            iconClass="clips-manager-file-type-icon"
                            imageClass="clips-manager-file-type-icon"
                          />
                        {/if}
                      </span>
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-xs truncate flex-1">{clip.filename}</span>
                        {#if clip.description}
                          <span class="text-[11px] text-muted-foreground whitespace-normal break-words">{clip.description}</span>
                        {/if}
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <Badge variant="secondary" class="h-5 text-[10px]">batshit</Badge>
                      <span class="text-xs text-muted-foreground">
                        {formatClipContextTokens(clip)} tok
                      </span>
                    </div>
                  </div>
                </button>
              </div>
            {/each}
            {#if systemClipVault.filter(c => !c.isClipped).length === 0}
              <div class="text-[11px] text-muted-foreground px-2 py-1">All Batshit clips are attached</div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="space-y-1">
        <div class="flex items-center justify-between gap-2">
          <div class="text-[11px] uppercase tracking-wide text-muted-foreground">Your Clips</div>
          {#if bulkDeleteMode}
            <div class="text-[11px] text-muted-foreground">{userClipVault.length} selectable</div>
          {/if}
        </div>
        {#if userClipVault.length === 0}
          <div class="text-xs text-muted-foreground text-center py-2">
            Your uploaded files will appear here
          </div>
        {:else}
          <div class="max-h-48 overflow-y-auto space-y-1 pr-1">
            {#each vaultVisibleUserClips as clip}
              <div class={`clips-manager-vault-row group flex items-center gap-1 rounded-sm transition-colors ${bulkDeleteMode && isClipSelected(clip.id) ? 'is-selected' : ''}`}>
                {#if bulkDeleteMode}
                  <Checkbox
                    checked={isClipSelected(clip.id)}
                    onCheckedChange={(checked: boolean) => setClipSelected(clip.id, checked === true)}
                    class="ml-2 shrink-0"
                    aria-label={`Select ${clip.filename} for deletion`}
                  />
                {/if}
                <button
                  class="clips-manager-vault-row-button flex-1 text-left px-2 py-1"
                  onclick={() => bulkDeleteMode ? toggleClipSelection(clip.id) : toggleClip(clip)}
                >
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="clips-manager-vault-file-icon" aria-hidden="true">
                        {#if isClipImage(clip) && resolveClipPreviewUrl(clip)}
                          <img src={resolveClipPreviewUrl(clip) || ''} alt="" class="clips-manager-vault-preview" />
                        {:else}
                          <IconRenderer
                            ref={getClipFileIconRef(clip)}
                            label={clip.filename}
                            iconClass="clips-manager-file-type-icon"
                            imageClass="clips-manager-file-type-icon"
                          />
                        {/if}
                      </span>
                      <div class="flex flex-col gap-0.5 min-w-0">
                        <span class="text-xs truncate flex-1">
                          {clip.filename}
                          {#if clip.isClipped}
                            <span class="clips-manager-inline-status">clipped</span>
                          {/if}
                        </span>
                        {#if clip.description}
                          <span class="text-[11px] text-muted-foreground whitespace-normal break-words">{clip.description}</span>
                        {/if}
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <span class="text-xs text-muted-foreground">
                        {formatClipContextTokens(clip)} tok
                      </span>
                    </div>
                  </div>
                </button>
                {#if !bulkDeleteMode}
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                    onclick={() => deleteClip(clip)}
                    aria-label={`Delete clip ${clip.filename} permanently`}
                    title="Delete permanently"
                  >
                    <Trash2 class="h-3 w-3 text-destructive" />
                  </Button>
                {/if}
              </div>
            {/each}
            {#if vaultVisibleUserClips.length === 0}
              <div class="text-[11px] text-muted-foreground px-2 py-1">All your clips are attached</div>
            {/if}
          </div>
        {/if}
      </div>
    </div>
    
    <DropdownMenu.Separator />
    
    <div class="px-2 py-1.5 text-xs text-muted-foreground">
      Clips are reusable across all your chats
    </div>
  </DropdownMenu.Content>
</DropdownMenu.Root>

<!-- Hidden file input -->
<input
  bind:this={fileInput}
  type="file"
  multiple
  accept="image/*,.pdf,.doc,.docx,.txt,.md,.csv"
  class="hidden"
  onchange={handleUpload}
/>

<style>
  :global(.clips-manager-trigger) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    padding: 0 0.5rem;
    border-radius: 0.375rem 0 0 0.375rem;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 500;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      opacity 150ms ease-out;
  }

  :global(.clips-manager-trigger:hover) {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  :global(.clips-manager-trigger:focus-visible) {
    outline: none;
  }

  :global(.clips-manager-trigger:disabled) {
    opacity: 0.5;
  }

  :global(.clips-manager-trigger-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.clips-manager-count-badge) {
    position: absolute;
    top: -4px;
    right: -4px;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid oklch(0.94 0.006 289.95 / 0.18);
    background: var(--bs-app-count-badge-bg);
    box-shadow: 0 0 0 1px oklch(0.02 0.004 280 / 0.28);
    color: var(--bs-app-title);
    font-size: 0.625rem;
  }

  :global(.clips-manager-tunnel-attention-dot) {
    position: absolute;
    right: 5px;
    bottom: 5px;
    z-index: 3;
    width: 7px;
    height: 7px;
    border: 1px solid oklch(0.11 0.02 276 / 0.95);
    border-radius: 999px;
    background: oklch(0.78 0.145 82);
    box-shadow:
      0 0 0 1px oklch(0.84 0.13 82 / 0.32),
      0 0 8px oklch(0.78 0.145 82 / 0.28);
    pointer-events: none;
  }

  :global(.clips-manager-content) {
    width: min(600px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
  }

  :global(.clips-manager-active-row) {
    margin: 0.25rem 0.5rem;
    border: 1px solid color-mix(in oklab, var(--border) 58%, transparent);
    border-radius: 0.375rem;
    background: color-mix(in oklab, var(--background) 76%, transparent);
  }

  :global(.clips-manager-active-row:hover),
  .clips-manager-vault-row:hover {
    border-color: color-mix(in oklab, var(--foreground) 22%, var(--border));
    background: color-mix(in oklab, var(--accent) 50%, transparent);
  }

  .clips-manager-bulk-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid color-mix(in oklab, var(--border) 65%, transparent);
    border-radius: 0.375rem;
    background: color-mix(in oklab, var(--muted) 28%, transparent);
  }

  .clips-manager-bulk-count {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }

  .clips-manager-vault-row {
    border: 1px solid color-mix(in oklab, var(--border) 88%, transparent);
    background: color-mix(in oklab, var(--background) 78%, transparent);
    cursor: pointer;
  }

  .clips-manager-vault-row.is-selected {
    border-color: color-mix(in oklab, var(--primary) 48%, var(--border));
    background: color-mix(in oklab, var(--primary) 12%, transparent);
  }

  .clips-manager-vault-row:focus-within {
    outline: 2px solid color-mix(in oklab, var(--foreground) 24%, transparent);
    outline-offset: 1px;
  }

  .clips-manager-vault-row-button {
    min-width: 0;
    border-radius: 0.375rem;
  }

  .clips-manager-vault-file-icon {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 0.1875rem;
  }

  .clips-manager-vault-preview {
    width: 16px;
    height: 16px;
    object-fit: cover;
    display: block;
  }

  :global(.clips-manager-file-type-icon) {
    width: 16px;
    height: 16px;
  }

  .clips-manager-inline-status {
    margin-left: 0.375rem;
    color: var(--muted-foreground);
    font-size: 0.625rem;
    font-weight: 400;
  }

  .clips-manager-screen-reader {
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
</style>
