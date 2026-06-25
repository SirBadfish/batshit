<script lang="ts">
  import { parseMessageContent, processIntermediateStepsToSegments } from '$lib/utils/messageFormatter'
  import { compileForUserBatch } from '$lib/services/messageCompiler'
  import { extractAllReferences } from '$lib/services/universalResolver'
  import { normalizeId } from '$lib/utils/idNormalizer'
  import { getTypeZipSettings } from '$lib/utils/toolRenderMap'
  import { calculateZipActivation } from '$lib/utils/zipActivation'
  import { extractVisibleBatshitCueState } from '$lib/utils/batshitCue'
  import { hideStreamingHiddenControlBlocks } from '$lib/utils/zipControl'
  import TextRenderer from '../renderers/content/TextRenderer.svelte'
  import CodeRenderer from '../renderers/content/CodeRenderer.svelte'
  import TerminalRenderer from '../renderers/content/TerminalRenderer.svelte'
  import ZipRenderer_batshit from '../renderers/wrappers/ZipbatshitRenderer.svelte'
  import ImageRenderer from '../renderers/content/ImageRenderer.svelte'
  import FileRenderer from '../renderers/content/FileRenderer.svelte'
  import ErrorRenderer from '../renderers/content/ErrorRenderer.svelte'
  import CoolToolRenderer from '$lib/components/renderers/tools/CoolToolRenderer.svelte'
  import ZipbatshitWrapper from '../renderers/wrappers/ZipbatshitWrapper.svelte'
  import ToolActivityGroup from './ToolActivityGroup.svelte'
  import ToolActivitySegment from './ToolActivitySegment.svelte'
  import { buildInlineCoolToolStep } from './buildInlineCoolToolStep'
  import LoadingIndicator from './LoadingIndicator.svelte'
  import { buildHydratedCoolToolStep } from './coolToolHydration'
  import { zippingService, type UnzippedItem } from '$lib/services/zipping'
  import { api } from '$lib/services/api'
  import { onMount, onDestroy, untrack } from 'svelte'
  import { estimateTokens } from '$lib/utils/tokens'
  import {
    estimateCoolToolAiTokens,
    parseCoolToolPayload
  } from '$lib/utils/coolToolAiContent'
  import { buildToolActivityGroups } from './toolActivityGrouping'
  import * as agentStore from '$lib/stores/agents.svelte'
  import * as sessionStore from '$lib/stores/session.svelte'
  import * as groupStore from '$lib/stores/groups.svelte'
  import { page } from '$app/state'
  import { getUserSettings } from '$lib/stores/userSettings.svelte'
  import * as projectStore from '$lib/stores/projects.svelte'
  import { 
    getCachedZipMetadataForIds, 
    cacheZipMetadata, 
    cacheMissingZipMetadata,
    chunkZipMetadataIds,
    haveSameZipMetadataEntries,
    isZipMetadataMissCached
  } from '$lib/stores/zipMetadataCache.svelte'
  import {
    collectTrustedClipIdsFromMetadata,
    collectTrustedZipIdsFromMetadata,
    extractTrustedClipIdsFromContent,
    extractTrustedZipIdsFromContent,
    isConcreteClipId,
    isConcreteZipId,
    isTrustedClipReferenceId
  } from '$lib/utils/zipReferenceSafety'

  type IntermediateStep = {
    type: 'tool' | 'tool_error' | 'error'
    toolName: string
    toolArgs?: any
    toolResult?: any
    error?: string
    timestamp?: string
  }

  const ZIP_METADATA_BATCH_SIZE = 100
  
  let {
    content,
    role,
    messageIndex = 0,
    totalMessages = 0,
    agentMessagesFromEnd = null,
    messageId = '',
    isStreaming = false,
    sessionId = '',
    onClipsDetected = () => {},
    intermediateSteps,
    metadata,
    agentSettings = null
  } = $props<{
    content: string
    role: string
    messageIndex?: number
    totalMessages?: number
    agentMessagesFromEnd?: number | null
    messageId?: string
    isStreaming?: boolean
    sessionId?: string
    onClipsDetected?: (clips: { subsequent: any[], first: any[] }) => void
    intermediateSteps?: IntermediateStep[]
    metadata?: any
    agentSettings?: any
  }>()
  
  
  const stripClips = (text: string, removeAll: boolean = false) => {
    if (role === 'user' && (text?.includes('{{batshit-clip|') || text?.includes('{{batshit-clip:'))) {
      if (removeAll) {
        let result = text.replace(/\{\{batshit-clip\|[^}]+\}\}[^{]*\{\{\/batshit-clip\}\}/g, '')
        result = result.replace(/\{\{batshit-clip:[^}]+\}\}/g, '')
        return result
      }
      return text
    }
    return text
  }
  
  let strippedContent = $state('')
  let compiledContent = $state('')
  let isCompiling = $state(false)
  let lastCompiledSource = $state<string | null>(null)
  let pendingCompileSource = $state<string | null>(null)
  let compileToken = 0
  
  let sessionClipState = $state<any>(null)
  let messageClips = $state<Array<any>>([])  
  let firstAppearanceClips = $state<Array<any>>([])  
  let subsequentClips = $state<Array<any>>([])  
  let clipsLoaded = $state(false)
  let lastClipLoadKey = $state<string | null>(null)
  let pendingClipLoadKey = $state<string | null>(null)

  // Cache hydrated Cool Tool data pulled directly from zip content (works even when zipped)
  let coolToolFromZip = $state(new Map<string, any>())
  let pendingCoolToolFetch = $state(new Set<string>())
  let missingCoolToolZips = $state(new Set<string>())
  let coolToolHydrationQueue = new Set<string>()
  let coolToolHydrationTimer: ReturnType<typeof setTimeout> | null = null
  const COOL_TOOL_ZIP_HYDRATION_BATCH_SIZE = 100
  const messagesAgo = $derived(
    Math.max(0, agentMessagesFromEnd ?? totalMessages - messageIndex - 1)
  )

  function coercePositiveNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
    return value
  }

  function resolvePromptTokenCount(zipData: any): number | undefined {
    return (
      coercePositiveNumber(zipData?.promptTokens) ??
      coercePositiveNumber(zipData?.aiTokens) ??
      coercePositiveNumber(zipData?.metadata?.promptTokens) ??
      coercePositiveNumber(zipData?.metadata?.aiTokens) ??
      (zipData?.metadata?.tokenBasis === 'ai_expanded'
        ? coercePositiveNumber(zipData?.tokens) ?? coercePositiveNumber(zipData?.metadata?.tokens)
        : undefined)
    )
  }

  function isCoolToolZipData(zipData: any): boolean {
    return (
      zipData?.type === 'cool_tool' ||
      zipData?.metadata?.originalType === 'cool_tool' ||
      zipData?.metadata?.zipType === 'cool_tool'
    )
  }

  function resolveZipTokens(zipId?: string, fallback = 0) {
    if (!zipId) return fallback
    const normalized = normalizeId(zipId)
    const meta =
      zipMetadataFromRedis.get(zipId) ||
      (normalized !== zipId ? zipMetadataFromRedis.get(normalized) : undefined)
    const resolvedMeta = meta || Array.from(zipMetadataFromRedis.entries()).find(
      ([candidateId]) => normalizeId(candidateId) === normalized
    )?.[1]
    const promptTokens = resolvePromptTokenCount(resolvedMeta)
    if (promptTokens !== undefined) return promptTokens
    if (isCoolToolZipData(resolvedMeta)) {
      const parsedPayload = parseCoolToolPayload(resolvedMeta?.content)
      if (parsedPayload) {
        return estimateCoolToolAiTokens(normalized, resolvedMeta, parsedPayload)
      }
      return fallback
    }
    const tokens = resolvedMeta?.tokens ?? resolvedMeta?.metadata?.tokens
    return typeof tokens === 'number' && tokens > 0 ? tokens : fallback
  }

  $effect(() => {
    if (!intermediateSteps || intermediateSteps.length === 0) return
    const touchesFiles = intermediateSteps.some((step: IntermediateStep) =>
      ['batshit_server_overwrite_file', 'batshit_server_edit_file', 'write_file', 'edit_file'].includes(step.toolName)
    )
    if (touchesFiles) {
      projectStore.markFileTreeStale()
    }
  })

  const hasOnlyCoolToolZips = (value: string) => {
    if (!value || !value.includes('{{batshit-zip:')) return false
    const regex = /\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/g
    let match: RegExpExecArray | null = null
    let foundTrusted = false
    while ((match = regex.exec(value)) !== null) {
      const zipId = match[1] || ''
      const normalized = normalizeId(zipId)
      if (validZipIds && !validZipIds.has(normalized)) {
        continue
      }
      if (!zipId.includes('cool_tool')) {
        return false
      }
      foundTrusted = true
    }
    return foundTrusted
  }

  function isCoolToolHydrated(zipId: string): boolean {
    const normalized = normalizeId(zipId)
    return coolToolFromZip.has(zipId) || coolToolFromZip.has(normalized)
  }

  function isCoolToolPending(zipId: string): boolean {
    const normalized = normalizeId(zipId)
    return pendingCoolToolFetch.has(zipId) || pendingCoolToolFetch.has(normalized)
  }

  function isCoolToolMissing(zipId: string): boolean {
    const normalized = normalizeId(zipId)
    return missingCoolToolZips.has(zipId) || missingCoolToolZips.has(normalized)
  }

  function setCoolToolStep(map: Map<string, any>, zipId: string, step: any) {
    map.set(zipId, step)
    const normalized = normalizeId(zipId)
    if (normalized !== zipId) {
      map.set(normalized, step)
    }
  }

  function markCoolToolMissing(set: Set<string>, zipId: string) {
    set.add(zipId)
    const normalized = normalizeId(zipId)
    if (normalized !== zipId) {
      set.add(normalized)
    }
  }

  function scheduleCoolToolHydration() {
    if (coolToolHydrationTimer) return
    coolToolHydrationTimer = setTimeout(() => {
      coolToolHydrationTimer = null
      const ids = Array.from(coolToolHydrationQueue)
      coolToolHydrationQueue = new Set()
      void hydrateCoolToolZipBatch(ids)
    }, 0)
  }

  function hydrateCoolToolFromZip(zipId: string) {
    if (!zipId || isCoolToolHydrated(zipId) || isCoolToolPending(zipId) || isCoolToolMissing(zipId)) return

    coolToolHydrationQueue.add(zipId)
    const nextPending = new Set(pendingCoolToolFetch)
    nextPending.add(zipId)
    const normalized = normalizeId(zipId)
    if (normalized !== zipId) {
      nextPending.add(normalized)
    }
    pendingCoolToolFetch = nextPending
    scheduleCoolToolHydration()
  }

  async function hydrateCoolToolZipBatch(zipIds: string[]) {
    const ids = Array.from(new Set(zipIds.filter(Boolean))).filter(
      (id) => !isCoolToolHydrated(id) && !isCoolToolMissing(id)
    )
    if (ids.length === 0) return

    try {
      const zipMap = new Map<string, any>()
      for (let i = 0; i < ids.length; i += COOL_TOOL_ZIP_HYDRATION_BATCH_SIZE) {
        const batch = ids.slice(i, i + COOL_TOOL_ZIP_HYDRATION_BATCH_SIZE)
        const batchMap = await api.getZips(batch)
        for (const [id, zip] of batchMap) {
          zipMap.set(id, zip)
        }
      }
      const nextCoolTools = new Map(coolToolFromZip)
      const nextMissing = new Set(missingCoolToolZips)

      for (const zipId of ids) {
        const zip = zipMap.get(zipId)
        if (!zip?.content) {
          markCoolToolMissing(nextMissing, zipId)
          continue
        }

        try {
          // Zip content is JSON string of the intermediateStep structure.
          const parsed = typeof zip.content === 'string' ? JSON.parse(zip.content) : zip.content
          setCoolToolStep(nextCoolTools, zipId, buildHydratedCoolToolStep(parsed))
        } catch (parseError) {
          console.error('[MessageContent] Failed to parse cool_tool zip', zipId, parseError)
          markCoolToolMissing(nextMissing, zipId)
        }
      }

      coolToolFromZip = nextCoolTools
      missingCoolToolZips = nextMissing
    } catch (err) {
      console.error('[MessageContent] Failed to hydrate cool_tool zip batch', err)
      const nextMissing = new Set(missingCoolToolZips)
      ids.forEach((zipId) => markCoolToolMissing(nextMissing, zipId))
      missingCoolToolZips = nextMissing
    } finally {
      const nextPending = new Set(pendingCoolToolFetch)
      ids.forEach((zipId) => {
        nextPending.delete(zipId)
        nextPending.delete(normalizeId(zipId))
      })
      pendingCoolToolFetch = nextPending
    }
  }

  function extractZipIdFromReference(ref: string): string | null {
    if (!ref) return null
    const match = ref.match(/\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/)
    return match ? match[1] : null
  }

  function collectImageZipIds(payload: any, ids: Set<string>) {
    if (!payload) return
    const parsed = typeof payload === 'string'
      ? (() => {
          try { return JSON.parse(payload) } catch { return payload }
        })()
      : payload

    if (Array.isArray(parsed)) {
      parsed.forEach((item) => collectImageZipIds(item, ids))
      return
    }

    if (parsed && typeof parsed === 'object') {
      const refs = (parsed as any).imageZipReferences || (parsed as any).image_zip_references
      if (Array.isArray(refs)) {
        refs.forEach((ref) => {
          if (typeof ref !== 'string') return
          const zipId = extractZipIdFromReference(ref)
          if (zipId) ids.add(normalizeId(zipId))
        })
      }

      const nested = (parsed as any).result ?? (parsed as any).output ?? (parsed as any).content
      if (nested && nested !== parsed) {
        collectImageZipIds(nested, ids)
      }
    }
  }

  const toolImageZipIds = $derived.by((): Set<string> => {
    const ids = new Set<string>()
    for (const tool of coolToolFromZip.values()) {
      collectImageZipIds(tool?.toolResult ?? tool?.observation, ids)
    }
    return ids
  })

  const metadataImageZipIds = $derived.by((): Set<string> => {
    const ids = Array.isArray(metadata?.imageZipIds) ? metadata.imageZipIds : []
    return new Set(ids.map((id: string) => normalizeId(id)))
  })

  const hiddenImageZipIds = $derived.by((): Set<string> => {
    const combined = new Set<string>()
    for (const id of toolImageZipIds) combined.add(normalizeId(id))
    for (const id of metadataImageZipIds) combined.add(normalizeId(id))
    return combined
  })

  function buildClipLoadKey(sourceContent: string, currentSessionId: string, userId?: string): string {
    const trustedMetadataClipIds = collectTrustedClipIdsFromMetadata(metadata)
      .map((id) => normalizeId(id))
      .filter(Boolean)
      .sort()
      .join(',')
    return [currentSessionId || '', userId || '', trustedMetadataClipIds, sourceContent].join('\u001f')
  }

  function markClipLoadHandled(loadKey: string) {
    lastClipLoadKey = loadKey
    if (pendingClipLoadKey === loadKey) {
      pendingClipLoadKey = null
    }
  }

  function resetClipRenderState(nextContent = content) {
    firstAppearanceClips = []
    subsequentClips = []
    messageClips = []
    sessionClipState = null
    strippedContent = nextContent
    clipsLoaded = true
    onClipsDetected({ subsequent: [], first: [] })
  }
  
  const getSessionClipTracker = () => {
    if (typeof window !== 'undefined' && sessionId) {
      if (!(window as any).sessionClipTrackers) {
        (window as any).sessionClipTrackers = {}
      }
      if (!(window as any).sessionClipTrackers[sessionId]) {
        (window as any).sessionClipTrackers[sessionId] = new Map()
      }
      return (window as any).sessionClipTrackers[sessionId] as Map<string, number>
    }
    return new Map<string, number>()
  }
  
  // Load clips when content changes (reactive, not just onMount)
  $effect(() => {
    const sourceContent = content || ''
    const currentSessionId = sessionId
    const userId = page.data.user?.id

    if (!sourceContent) {
      resetClipRenderState('')
      lastClipLoadKey = null
      pendingClipLoadKey = null
      return
    }

    const hasClips =
      sourceContent.includes('{{batshit-clip:') || sourceContent.includes('{{batshit-clip|')

    if (!hasClips) {
      const loadKey = buildClipLoadKey(sourceContent, currentSessionId, userId)
      if (loadKey !== lastClipLoadKey) {
        resetClipRenderState(sourceContent)
        markClipLoadHandled(loadKey)
      }
      return
    }

    const loadKey = buildClipLoadKey(sourceContent, currentSessionId, userId)
    if (loadKey === lastClipLoadKey || loadKey === pendingClipLoadKey) return

    pendingClipLoadKey = loadKey
    clipsLoaded = isStreaming

    if (!currentSessionId) {
      resetClipRenderState(sourceContent)
      markClipLoadHandled(loadKey)
      return
    }

    void (async () => {
      try {
        const response = await fetch(`/api/session-clips/state/${currentSessionId}`)
        if (pendingClipLoadKey !== loadKey) return
        if (!response.ok) {
          resetClipRenderState(sourceContent)
          markClipLoadHandled(loadKey)
          return
        }

        const loadedSessionClipState = await response.json()
        if (pendingClipLoadKey !== loadKey) return

        sessionClipState = loadedSessionClipState

        const references = extractAllReferences(sourceContent)
        const trustedClipIds = new Set(collectTrustedClipIdsFromMetadata(metadata))
        if (Array.isArray(loadedSessionClipState?.clips)) {
          for (const clipState of loadedSessionClipState.clips) {
            if (typeof clipState?.clipId === 'string' && clipState.clipId.trim()) {
              trustedClipIds.add(clipState.clipId.trim())
            }
          }
        }
        const clipReferences = references.filter(
          ref =>
            ref.type === 'clip' &&
            (isTrustedClipReferenceId(ref.id, trustedClipIds) || isConcreteClipId(ref.id))
        )
        const embeddedClipIds = extractTrustedClipIdsFromContent(sourceContent, {
          trustedClipIds,
          allowConcreteWithoutTrustedSet: true
        })

        const fetchedClips = await Promise.all(embeddedClipIds.map(async (clipId) => {
          let isFirstAppearance = false
          const clipTracker = getSessionClipTracker()

          if (!clipTracker.has(clipId)) {
            clipTracker.set(clipId, messageIndex)
            isFirstAppearance = true
          } else {
            const firstSeenIndex = clipTracker.get(clipId)
            isFirstAppearance = (firstSeenIndex === messageIndex)
          }

          const clipRef = clipReferences.find(ref => normalizeId(ref.id) === normalizeId(clipId))
          let filename = clipRef?.optionalContent || 'Unknown'
          let displayUrl = ''
          let externalUrl = ''
          let localUrl = ''
          let fullResolutionUrl = ''
          let contentType = ''
          let mimeType = ''
          let contentText = ''
          let tokens: number | undefined = undefined
          let fileSize: number | undefined = undefined
          let fetchedClip = false

          try {
            if (userId) {
              const response = await fetch(`/api/clips/${clipId}?userId=${userId}`)
              if (response.ok) {
                const clipData = await response.json()
                fetchedClip = true
                filename = clipData.filename || filename
                displayUrl = clipData.displayUrl || ''
                externalUrl = clipData.externalUrl || ''
                localUrl = clipData.localUrl || ''
                fullResolutionUrl = clipData.fullResolutionUrl || ''
                mimeType = clipData.mimeType || ''
                contentText = clipData.content || ''
                tokens = clipData.localTokens || clipData.externalTokens
                fileSize = clipData.fileSize
                if (mimeType.startsWith('image/')) contentType = 'image'
                else if (mimeType.startsWith('text/')) contentType = 'text'
                else contentType = 'file'
              }
            }
          } catch (error) {
            console.error('[MessageContent] Error fetching clip data:', error)
          }

          if (!fetchedClip && !isTrustedClipReferenceId(clipId, trustedClipIds)) {
            return null
          }

          if (!displayUrl && !externalUrl && !localUrl && sourceContent.includes('{{batshit-clip|')) {
            const clipDataRegex = new RegExp(`\\{\\{batshit-clip\\|id:${clipId}\\|[^}]+\\}\\}([^{]+)\\{\\{/batshit-clip\\}\\}`)
            const clipMatch = sourceContent.match(clipDataRegex)
            if (clipMatch) {
              filename = clipMatch[1] || filename
              const urlMatch = clipMatch[0].match(/displayUrl:([^|}]+)/)
              if (urlMatch) displayUrl = urlMatch[1]
              const extMatch = clipMatch[0].match(/externalUrl:([^|}]+)/)
              if (extMatch) externalUrl = extMatch[1]
              const locMatch = clipMatch[0].match(/localUrl:([^|}]+)/)
              if (locMatch) localUrl = locMatch[1]
            }
          }

          return {
            clipId,
            isFirstAppearance,
            filename,
            displayUrl,
            externalUrl,
            localUrl,
            fullResolutionUrl,
            url: displayUrl || externalUrl || localUrl,
            mimeType,
            contentType,
            content: contentText,
            tokens,
            fileSize
          }
        }))
        if (pendingClipLoadKey !== loadKey) return

        const allClips = fetchedClips.filter(
          (clip): clip is NonNullable<(typeof fetchedClips)[number]> => Boolean(clip)
        )
        const nextFirstAppearanceClips = allClips.filter(c => c.isFirstAppearance)
        const nextSubsequentClips = allClips.filter(c => !c.isFirstAppearance)

        let nextStrippedContent = sourceContent
        if (nextSubsequentClips.length > 0) {
          nextSubsequentClips.forEach(clip => {
            const oldClipRegex = new RegExp(`\\{\\{batshit-clip\\|id:${clip.clipId}\\|[^}]+\\}\\}[^{]*\\{\\{/batshit-clip\\}\\}`, 'g')
            const newClipRegex = new RegExp(`\\{\\{batshit-clip:${clip.clipId}(?::::[^}]+)?\\}\\}`, 'g')
            nextStrippedContent = nextStrippedContent.replace(oldClipRegex, '')
            nextStrippedContent = nextStrippedContent.replace(newClipRegex, '')
          })
        }

        firstAppearanceClips = nextFirstAppearanceClips
        subsequentClips = nextSubsequentClips
        messageClips = allClips
        strippedContent = nextStrippedContent
        clipsLoaded = true
        markClipLoadHandled(loadKey)
        onClipsDetected({ subsequent: nextSubsequentClips, first: nextFirstAppearanceClips })
      } catch (error) {
        console.error('Failed to load session clip state:', error)
        if (pendingClipLoadKey === loadKey) {
          resetClipRenderState(sourceContent)
          markClipLoadHandled(loadKey)
        }
      }
    })()
  })
  
  // SA-911: Single unified effect for content compilation (removed duplicate effect that was causing race conditions)
  $effect(() => {
    if (role === 'assistant') {
      strippedContent = content
      
      if (isStreaming) {
        // CRITICAL FIX: Always update compiledContent during streaming for reactivity
        compiledContent = hideStreamingHiddenControlBlocks(content)
        isCompiling = false
        pendingCompileSource = null
        lastCompiledSource = null
      } else if (extractZipIds(content, validZipIds).length === 0) {
        compiledContent = content
        isCompiling = false
        pendingCompileSource = null
        lastCompiledSource = content
      } else if (hasOnlyCoolToolZips(content)) {
        // Tool-only messages already hydrate from Redis; no compile needed.
        compiledContent = content
        isCompiling = false
        pendingCompileSource = null
        lastCompiledSource = content
      } else {
        if (content === lastCompiledSource || content === pendingCompileSource) {
          return
        }
        pendingCompileSource = content
        isCompiling = true
        const token = ++compileToken
        compileForUserBatch(content).then(compiled => {
          if (token !== compileToken) return
          compiledContent = compiled
          isCompiling = false
          pendingCompileSource = null
          lastCompiledSource = content
        }).catch(error => {
          if (token !== compileToken) return
          console.error('[MessageContent] Failed to compile content', error)
          compiledContent = content
          isCompiling = false
          pendingCompileSource = null
        })
      }
    } else if (role === 'user') {
      if (!strippedContent) {
        strippedContent = content
      }
      
      if (isStreaming) {
        // CRITICAL FIX: Always update compiledContent during streaming for reactivity
        compiledContent = strippedContent
        isCompiling = false
        pendingCompileSource = null
        lastCompiledSource = null
      } else if (extractZipIds(strippedContent, validZipIds).length === 0) {
        compiledContent = strippedContent
        isCompiling = false
        pendingCompileSource = null
        lastCompiledSource = strippedContent
      } else {
        if (strippedContent === lastCompiledSource || strippedContent === pendingCompileSource) {
          return
        }
        pendingCompileSource = strippedContent
        isCompiling = true
        const token = ++compileToken
        compileForUserBatch(strippedContent).then(compiled => {
          if (token !== compileToken) return
          compiledContent = compiled
          isCompiling = false
          pendingCompileSource = null
          lastCompiledSource = strippedContent
        }).catch(error => {
          if (token !== compileToken) return
          console.error('[MessageContent] Failed to compile content', error)
          compiledContent = strippedContent
          isCompiling = false
          pendingCompileSource = null
        })
      }
    }
  })
  
  let zipMetadataFromRedis = $state<Map<string, any>>(new Map())
  let isFetchingZipMetadata = $state(false)
  let forceRefreshCounter = $state(0)
  let pendingZipRefresh = $state(false)
  let zipRefreshTimeout: ReturnType<typeof setTimeout> | null = null
  let zipFetchBackoffUntil = $state<number | null>(null)
  let zipFetchBackoffDelayMs = $state(1000)
  let zipFetchBackoffTimeout: ReturnType<typeof setTimeout> | null = null

  // User settings - must be declared before activeZipIds which uses globalZipSettings
  const userSettings = $derived(getUserSettings())
  const globalZipSettings = $derived(userSettings?.global_zip_settings || undefined)
  const currentSession = $derived(sessionStore.getCurrentSession())
  const groups = $derived(groupStore.getGroups())
  const activeGroupId = $derived(currentSession?.metadata?.group_chat?.group_id || null)
  const activeGroup = $derived(
    activeGroupId ? groups.find((group) => group.id === activeGroupId) || null : null
  )
  const mergedGlobalZipSettings = $derived(globalZipSettings)
  const currentAgent = $derived(activeGroup ? null : (agentSettings ?? agentStore.getCurrentAgent()))


  const zipIdMetadata = $derived.by((): {
    hasExplicitIds: boolean
    rawIds: string[]
    normalized: string[]
  } => {
    const hasExplicitIds =
      typeof metadata === 'object' &&
      metadata !== null &&
      ('zipIds' in metadata || 'zip_ids' in metadata || 'zipReferences' in metadata)
    const rawIds = collectTrustedZipIdsFromMetadata(metadata)
    const normalized = rawIds.map((id) => normalizeId(id)).filter(Boolean)
    return { hasExplicitIds, rawIds, normalized }
  })

  const validZipIds = $derived.by((): Set<string> | null => {
    if (isStreaming) return null

    if (zipIdMetadata.hasExplicitIds) {
      return new Set(zipIdMetadata.normalized)
    }

    if (zipMetadataFromRedis.size > 0) {
      return new Set(
        Array.from(zipMetadataFromRedis.keys())
          .map((id) => normalizeId(id))
          .filter(Boolean)
      )
    }

    const hasZipSyntax = typeof content === 'string' && content.includes('{{batshit-zip:')
    if (hasZipSyntax) {
      return new Set()
    }

    return null
  })

  function clearZipRefreshTimeout() {
    if (zipRefreshTimeout) {
      clearTimeout(zipRefreshTimeout)
      zipRefreshTimeout = null
    }
  }

  function scheduleZipRefresh() {
    clearZipRefreshTimeout()
    zipRefreshTimeout = setTimeout(() => {
      refreshZipMetadata()
      zipRefreshTimeout = null
    }, 400)
  }

  function clearZipFetchBackoff() {
    if (zipFetchBackoffTimeout) {
      clearTimeout(zipFetchBackoffTimeout)
      zipFetchBackoffTimeout = null
    }
    zipFetchBackoffUntil = null
    zipFetchBackoffDelayMs = 1000
  }

  function replaceZipMetadataIfChanged(nextMetadata: Map<string, any>) {
    if (haveSameZipMetadataEntries(zipMetadataFromRedis, nextMetadata)) return
    zipMetadataFromRedis = nextMetadata
  }

  function scheduleZipFetchBackoff() {
    if (zipFetchBackoffTimeout) {
      clearTimeout(zipFetchBackoffTimeout)
    }
    const delay = Math.min(zipFetchBackoffDelayMs * 2, 30000)
    zipFetchBackoffDelayMs = delay
    zipFetchBackoffUntil = Date.now() + delay
    zipFetchBackoffTimeout = setTimeout(() => {
      zipFetchBackoffUntil = null
      pendingZipRefresh = true
      scheduleZipRefresh()
    }, delay)
  }

  async function fetchZipMetadataBatches(zipIds: string[], streaming: boolean): Promise<any[]> {
    const metadata: any[] = []

    for (const batch of chunkZipMetadataIds(zipIds, ZIP_METADATA_BATCH_SIZE)) {
      const res = await fetch('/api/zips/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ids: batch })
      })

      if (res.status === 429) {
        throw new Error('HTTP 429: Too Many Requests')
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }

      const data = await res.json()
      if (data.error) {
        throw new Error(data.error)
      }

      if (!Array.isArray(data)) {
        throw new Error('Unexpected zip metadata response format')
      }

      const returnedIds = new Set(
        data
          .map((zip: any) => (typeof zip?.id === 'string' ? zip.id : null))
          .filter(Boolean)
      )
      const missingIds = batch.filter(id => !returnedIds.has(id))
      if (missingIds.length > 0) {
        cacheMissingZipMetadata(missingIds, streaming ? 1000 : undefined)
      }

      metadata.push(...data)
    }

    return metadata
  }
  
  const activeZipIds = $derived.by(() => {
    const active = new Set<string>()

    // Skip zip activation entirely while streaming to avoid churn
    if (isStreaming) {
      return active
    }
    
    const refreshCount = forceRefreshCounter
    
    const hasMetadata = zipMetadataFromRedis.size > 0
    const agent = currentAgent
    const messagesFromEnd = messagesAgo
    
    const extractedZipIds = extractZipIds(compiledContent || content, validZipIds)

    if (hasMetadata) {
      for (const [zipId, zipData] of zipMetadataFromRedis) {
        const type = zipData?.type || zipData?.metadata?.type || 'all_other'
        const activation = calculateZipActivation({
          zipType: type,
          messagesFromEnd,
          zipData,
          agentSettings: agent,
          globalSettings: mergedGlobalZipSettings,
          toolName: zipData?.metadata?.toolName || zipData?.name,
          fallbackTokens: zipData?.tokens ?? zipData?.metadata?.tokens ?? 0,
          isUnzipped: zippingService.isUnzipped(normalizeId(zipId)),
          isRezipped: zippingService.isRezipped(normalizeId(zipId))
        })

        if (activation.shouldCompress) {
          active.add(normalizeId(zipId))
        }
      }
    } else {
      const fallbackSettings = getTypeZipSettings('all_other', agent, mergedGlobalZipSettings)

      for (const zipId of extractedZipIds) {
        const activation = calculateZipActivation({
          zipType: 'all_other',
          messagesFromEnd,
          agentSettings: agent,
          globalSettings: mergedGlobalZipSettings,
          zipData: {
            bufferSize: fallbackSettings.bufferSize,
            threshold: fallbackSettings.zipThreshold,
            tokens: fallbackSettings.zipThreshold
          },
          isUnzipped: zippingService.isUnzipped(normalizeId(zipId)),
          isRezipped: zippingService.isRezipped(normalizeId(zipId))
        })

        if (activation.shouldCompress) {
          active.add(normalizeId(zipId))
        }
      }
    }
    
    return active
  })
  
  // SA-911: Don't show empty segments while compiling - use raw content as fallback
  const segmentContent = $derived(isCompiling ? content : compiledContent)
  const visibleControlState = $derived.by(() => extractVisibleBatshitCueState(segmentContent))
  const visibleSegmentContent = $derived(visibleControlState.cleanedContent)
  const visibleControlNotes = $derived(visibleControlState.notes)

  const segments = $derived.by(() => {
    if (
      !clipsLoaded &&
      typeof visibleSegmentContent === 'string' &&
      (visibleSegmentContent.includes('{{batshit-clip:') || visibleSegmentContent.includes('{{batshit-clip|'))
    ) {
      return []
    }

    // Pass segmentContent for display (compiledContent if ready, raw if compiling)
    let parsed = parseMessageContent(
      visibleSegmentContent,
      role,
      content,
      clipsLoaded ? messageClips : [],
      validZipIds ?? undefined
    )

    if (hiddenImageZipIds.size > 0) {
      parsed = parsed.filter((seg) => {
        if (!seg?.zipId) return true
        if (seg?.type === 'cool_tool') return true
        const normalized = normalizeId(seg.zipId)
        return !hiddenImageZipIds.has(normalized)
      })
    }
    
    // SA-911: Placeholder-to-loading conversion removed - tools now handled inline during streaming
    return parsed as Array<{
    id?: string
    type: 'text' | 'code' | 'terminal' | 'batshit' | 'image' | 'file' | 'error' | 'diff' | 'cool_tool' | 'tool_result' | 'loading'
    content: string
    language?: string
    filename?: string
    source?: string
    tokens?: number
    name?: string
    path?: string
    description?: string
    contentType?: string
    [key: string]: any
  }>
  })

  // Hydrate cool_tool segments directly from their stored zip content so renderers get full metadata
  $effect(() => {
    segments.forEach((seg) => {
      if (seg?.type === 'cool_tool' && seg.zipId) {
        // Only hydrate server-side cool_tool zips (new format). Inline streaming markers use
        // deterministic ids and should render from inline payload until replaced at end.
        if (typeof seg.zipId === 'string' && seg.zipId.startsWith('cool_tool_')) {
          const normalized = normalizeId(seg.zipId)
          if (validZipIds && !validZipIds.has(normalized)) {
            return
          }
          hydrateCoolToolFromZip(seg.zipId)
        }
      }
    })
  })
  
  function extractZipIds(text: string, allowedIds?: Set<string> | null): string[] {
    const ids = new Set<string>()
    const newZipRegex = /\{\{batshit-zip:([^:}]+)(?::::[^}]*)?\}\}/g
    let match
    while ((match = newZipRegex.exec(text)) !== null) {
      const zipId = match[1]
      const normalized = normalizeId(zipId)
      if (allowedIds && !allowedIds.has(normalized)) continue
      ids.add(zipId)
    }
    const oldZipRegex = /\{\{batshit\|id:([^|]+)\|[^}]+\}\}/g
    while ((match = oldZipRegex.exec(text)) !== null) {
      const zipId = match[1]
      const normalized = normalizeId(zipId)
      if (allowedIds && !allowedIds.has(normalized)) continue
      ids.add(zipId)
    }
    return Array.from(ids)
  }


  // If a stream finishes and we skipped events, catch up with a debounced refresh
  $effect(() => {
    if (!isStreaming && pendingZipRefresh) {
      pendingZipRefresh = false
      scheduleZipRefresh()
    }
  })
  
  $effect(() => {
    // Explicitly track dependencies to prevent infinite loops
    const deps = { content, isStreaming, isFetchingZipMetadata, forceRefreshCounter };

    if (!deps.content || deps.isFetchingZipMetadata) return

    if (zipFetchBackoffUntil && Date.now() < zipFetchBackoffUntil) {
      return
    }

    // Extract zip IDs from RAW content, not compiled!
    const trustedZipIdsForFetch =
      validZipIds && validZipIds.size > 0 ? validZipIds : null
    const canProbeConcreteZipIds =
      deps.isStreaming ||
      (!zipIdMetadata.hasExplicitIds && zipMetadataFromRedis.size === 0)
    const zipIds = zipIdMetadata.hasExplicitIds
      ? Array.from(new Set(zipIdMetadata.rawIds))
      : extractTrustedZipIdsFromContent(deps.content, {
          trustedZipIds: trustedZipIdsForFetch,
          // Fetching a concrete-looking id is not the same as trusting it for render.
          // The reference only becomes trusted after /api/zips/batch returns metadata.
          allowConcreteWithoutTrustedSet: canProbeConcreteZipIds
        })
    if (zipIds.length === 0) {
      // Don't modify reactive state - just return
      return
    }
    
    const cachedMetadata = getCachedZipMetadataForIds(zipIds)
    if (cachedMetadata.size > 0) {
      // Use untrack to prevent state updates from re-triggering this effect
      untrack(() => {
        replaceZipMetadataIfChanged(cachedMetadata)
      })
    }

    const uncachedIds = zipIds.filter(
      (id): id is string =>
        typeof id === 'string' &&
        isConcreteZipId(id) &&
        !cachedMetadata.has(id) &&
        !isZipMetadataMissCached(id)
    )
    if (uncachedIds.length === 0) {
      return
    }

    // Use untrack for state update
    untrack(() => {
      isFetchingZipMetadata = true
    })
    fetchZipMetadataBatches(uncachedIds, deps.isStreaming)
      .then(data => {
        cacheZipMetadata(data)
        clearZipFetchBackoff()

        const combinedMap = new Map<string, any>(cachedMetadata)
        data.forEach((zip: any) => {
          combinedMap.set(zip.id, zip)
        })

        // Use untrack to prevent re-triggering the effect
        untrack(() => {
          replaceZipMetadataIfChanged(combinedMap)
          isFetchingZipMetadata = false
        })
      })
      .catch(error => {
        if (error instanceof Error && error.message.includes('HTTP 429')) {
          scheduleZipFetchBackoff()
        } else {
          console.error('[MessageContent] Failed to fetch zip metadata:', error)
          scheduleZipFetchBackoff()
        }
        untrack(() => { isFetchingZipMetadata = false })
      })
  })
  
  // Type-specific counters for consistent zip ID generation
  let terminalCounter = 0
  let errorCounter = 0
  let diffCounter = 0
  let toolResultCounter = 0
  
  // Function to get the next index for a specific type
  function getTypeIndex(type: string): number {
    switch (type) {
      case 'terminal':
        return terminalCounter++
      case 'error':
        return errorCounter++
      case 'diff':
        return diffCounter++
      case 'cool_tool':
        return toolResultCounter++
      default:
        return 0
    }
  }
  
  // Extract tool name from tool result content
  function extractToolName(content?: string): string {
    if (!content) return 'Tool'
    const match = content.match(/Tool:\s*([^\n]+)/)
    return match ? match[1].trim() : 'Tool'
  }
  
  // Extract just the result portion from tool result content
  function extractToolResult(content?: string): string {
    if (!content) return ''
    const resultMatch = content.match(/Result:\n(.+)$/s)
    return resultMatch ? resultMatch[1].trim() : content
  }

  const toolActivityGroups = $derived(
    buildToolActivityGroups(segments, messageId || 'message', coolToolFromZip)
  )

  function segmentStableKeyBase(segment: any) {
    const type = typeof segment?.type === 'string' && segment.type ? segment.type : 'segment'
    const rawId = segment?.zipId || segment?.id || segment?.toolId
    if (rawId) {
      const normalized = normalizeId(String(rawId))
      return `${type}:id:${normalized || rawId}`
    }

    if (type === 'image') {
      const source = segment?.src || segment?.fullResolutionSrc || segment?.url || segment?.title
      if (source) return `${type}:source:${source}`
    }

    if (type === 'file') {
      const source = segment?.path || segment?.url || segment?.filename
      if (source) return `${type}:source:${source}`
    }

    return type
  }

  const keyedSegments = $derived.by(() => {
    const counts = new Map<string, number>()
    return segments.map((segment, index) => {
      const base = segmentStableKeyBase(segment)
      const count = counts.get(base) ?? 0
      counts.set(base, count + 1)

      return {
        key: count === 0 ? base : `${base}:${count}`,
        segment,
        index
      }
    })
  })

  function toolActivityItemKey(item: { segment: any; index: number }) {
    const segment = item?.segment
    if (segment?.zipId || segment?.id || segment?.toolId) {
      return segmentStableKeyBase(segment)
    }
    return `${segment?.type || 'tool'}:${item.index}`
  }

  function getToolActivityZipIds(items: Array<{ segment: any; index: number }>) {
    const ids = new Set<string>()
    for (const item of items) {
      const rawId =
        typeof item?.segment?.zipId === 'string'
          ? item.segment.zipId
          : typeof item?.segment?.id === 'string'
            ? item.segment.id
            : ''
      if (!rawId) continue
      ids.add(rawId)
      ids.add(normalizeId(rawId))
      ids.add(rawId.replace(/-cool_tool-\d+$/, '-cool_tool-0'))
    }
    return Array.from(ids).filter(Boolean)
  }

  // DEPRECATED settings
  const alwaysShowZipBorders = $derived(userSettings?.always_show_zip_borders || false)
  // New 8 visual indicator settings
  const showZippedBadges = $derived(userSettings?.show_zipped_badges ?? true)
  const zippedBadgesHoverOnly = $derived(userSettings?.zipped_badges_hover_only ?? false)
  const showZippedBorders = $derived(userSettings?.show_zipped_borders ?? true)
  const zippedBordersHoverOnly = $derived(userSettings?.zipped_borders_hover_only ?? true)
  const showUnzippedBadges = $derived(userSettings?.show_unzipped_badges ?? true)
  const unzippedBadgesHoverOnly = $derived(userSettings?.unzipped_badges_hover_only ?? false)
  const showUnzippedBorders = $derived(userSettings?.show_unzipped_borders ?? true)
  const unzippedBordersHoverOnly = $derived(userSettings?.unzipped_borders_hover_only ?? true)
  function shouldShowAsZip(segment: any, segmentIndex: number): boolean {
    // Check if user wants to always show zip borders
    if (alwaysShowZipBorders) return true
    
    // NEW: If segment has isZip property, it came from an embedded zip
    if (segment.isZip && segment.zipId) {
      const normalizedSegmentId = normalizeId(segment.zipId)
      const metadata =
        zipMetadataFromRedis.get(segment.zipId) ||
        zipMetadataFromRedis.get(normalizedSegmentId)
      const fallbackTokens =
        metadata?.tokens ??
        metadata?.metadata?.tokens ??
        segment.tokens ??
        estimateTokens(segment.content || '')

      const activation = calculateZipActivation({
        zipType: segment.zipType || segment.type || metadata?.type || 'all_other',
        messagesFromEnd: messagesAgo,
        zipData: metadata ?? { tokens: fallbackTokens },
        agentSettings: currentAgent,
        globalSettings: mergedGlobalZipSettings,
        toolName: segment.toolName || metadata?.metadata?.toolName,
        fallbackTokens,
        isUnzipped: zippingService.isUnzipped(normalizedSegmentId),
        isRezipped: zippingService.isRezipped(normalizedSegmentId)
      })

      if (activation.shouldCompress) {
        return true
      }

      if (!metadata) {
        const isActive = Array.from(activeZipIds).some(
          (activeId) => normalizeId(activeId) === normalizedSegmentId
        )
        if (isActive) {
          return true
        }
      }

      return false
    }

    // For regular segments (terminal, diff, error) that might need zipping
    const zippableTypes = ['terminal', 'error', 'diff', 'cool_tool']
    if (zippableTypes.includes(segment.type)) {
      const typeCounter = segmentIndex // Use segmentIndex as a simple counter
      const expectedZipId = `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-${segment.type}-${typeCounter}`
      const normalizedExpectedId = normalizeId(expectedZipId)
      const metadata =
        zipMetadataFromRedis.get(expectedZipId) ||
        zipMetadataFromRedis.get(normalizedExpectedId)
      const fallbackTokens =
        metadata?.tokens ??
        metadata?.metadata?.tokens ??
        segment.tokens ??
        estimateTokens(segment.content || '')

      const activation = calculateZipActivation({
        zipType: segment.type,
        messagesFromEnd: messagesAgo,
        zipData: metadata ?? { tokens: fallbackTokens },
        agentSettings: currentAgent,
        globalSettings: mergedGlobalZipSettings,
        toolName: segment.toolName || metadata?.metadata?.toolName,
        fallbackTokens,
        isUnzipped: zippingService.isUnzipped(normalizedExpectedId),
        isRezipped: zippingService.isRezipped(normalizedExpectedId)
      })

      if (activation.shouldCompress) {
        return true
      }

      if (!metadata) {
        const isActive = Array.from(activeZipIds).some(
          (activeId) => normalizeId(activeId) === normalizedExpectedId
        )

        if (isActive) {
          return true
        }
      }
    }
    
    // For legacy Batshit zips (backward compatibility)
    if (segment.type === 'batshit') {
      // Special case: User uploads always show zip borders
      if (segment.source === 'USER' && 
          (segment.contentType === 'image' || segment.contentType === 'file' || 
           segment.path?.includes('/images/') || segment.path?.includes('/documents/'))) {
        return true
      }
      
      if (alwaysShowZipBorders) return true
      
      // Infer type from description for buffer check
      let zipType = 'default'
      if (segment.description?.includes('Terminal output')) zipType = 'terminal'
      else if (segment.description?.includes('Diff')) zipType = 'diff'
      else if (segment.description?.includes('Error')) zipType = 'error'
      
      const fallbackTokens = segment.tokens ?? estimateTokens(segment.content || '')
      const activation = calculateZipActivation({
        zipType,
        messagesFromEnd: messagesAgo,
        agentSettings: currentAgent,
        globalSettings: mergedGlobalZipSettings,
        zipData: { tokens: fallbackTokens },
        fallbackTokens,
        isUnzipped: zippingService.isUnzipped(normalizeId(segment.zipId || segment.id || '')),
        isRezipped: zippingService.isRezipped(normalizeId(segment.zipId || segment.id || ''))
      })

      return activation.shouldCompress
    }

    if (segment.type === 'cool_tool' && segment.isZip && segment.zipId) {
      // We always store cool_tool payloads as zips; respect user unzip state
      const normalizedExpectedId = segment.zipId.replace(/-cool_tool-\d+$/, '-cool_tool-0')
      const unzippedItem = zippingService.getUnzippedInfo(normalizedExpectedId)
      if (unzippedItem) return false
    }

    return false
  }
  
  function shouldNeverZip(segment: any): boolean {
    return false
  }

  function recordUnzippedInfo(map: Map<string, UnzippedItem>, zipId: string) {
    const normalized = normalizeId(zipId)
    const item =
      zippingService.getUnzippedInfo(normalized) ||
      zippingService.getUnzippedInfo(zipId)
    if (item) {
      map.set(normalized || zipId, item)
    }
  }

  type ExpandedReason = 'buffer' | 'user' | 'agent'

  function resolveZipVisualState(options: {
    zipId: string
    zipType: string
    zipData?: any
    toolName?: string
    fallbackTokens?: number
    messagesFromEnd: number
  }): {
    isUnzipped: boolean
    expandedReason?: ExpandedReason
    isPermanent?: boolean
    manualZip?: boolean
    aboutToZip?: boolean
    remainingMessages?: number | null
    autoZip?: boolean
    agentControlled?: boolean
  } {
    const normalized = normalizeId(options.zipId)
    if (!normalized) {
      return { isUnzipped: false }
    }

    const unzippedItem =
      unzippedInfo.get(normalized) ||
      unzippedInfo.get(options.zipId) ||
      zippingService.getUnzippedInfo(normalized)
    const isUnzipped = Boolean(unzippedItem)
    const isRezipped =
      zippingService.isRezipped(normalized) ||
      zippingService.isRezipped(options.zipId)
    const rezippedSource =
      zippingService.getRezippedSource(normalized) ||
      zippingService.getRezippedSource(options.zipId)
    const fallbackTokens =
      options.fallbackTokens ??
      options.zipData?.tokens ??
      options.zipData?.metadata?.tokens ??
      0

    const activation = calculateZipActivation({
      zipType: options.zipType,
      messagesFromEnd: options.messagesFromEnd,
      zipData: options.zipData ?? { tokens: fallbackTokens },
      agentSettings: currentAgent,
      globalSettings: mergedGlobalZipSettings,
      toolName: options.toolName,
      fallbackTokens,
      isUnzipped,
      isRezipped
    })

    const autoZip = activation.autoZip
    const effectiveUnzipped = isUnzipped

    let expandedReason: ExpandedReason | undefined
    if (effectiveUnzipped) {
      expandedReason = unzippedItem?.source === 'agent' ? 'agent' : 'user'
    } else if (!activation.shouldCompress) {
      expandedReason = 'buffer'
    }

    const aboutToZip =
      !autoZip &&
      !effectiveUnzipped &&
      !isRezipped &&
      !activation.exceedsBuffer &&
      activation.meetsThreshold &&
      activation.bufferSize > 0 &&
      options.messagesFromEnd === activation.bufferSize - 1
    const manualRemainingMessages =
      effectiveUnzipped &&
      !unzippedItem?.permanent &&
      typeof unzippedItem?.duration === 'number'
        ? Math.max(0, unzippedItem.duration - (unzippedItem.messageCount || 0))
        : null
    const autoRemainingMessages =
      !effectiveUnzipped &&
      !isRezipped &&
      !activation.shouldCompress &&
      activation.meetsThreshold &&
      activation.bufferSize > 0
        ? Math.max(1, activation.bufferSize - activation.messagesFromEnd)
        : null

    return {
      isUnzipped: effectiveUnzipped,
      expandedReason,
      isPermanent: Boolean(unzippedItem?.permanent),
      manualZip: isRezipped,
      aboutToZip,
      remainingMessages: manualRemainingMessages ?? autoRemainingMessages,
      autoZip,
      agentControlled: unzippedItem?.source === 'agent' || rezippedSource === 'agent'
    }
  }
  
  function handleUnzip(zipId: string, permanent: boolean, name?: string, description?: string, tokens?: number, _autoZip?: boolean) {
    zippingService.unzip(zipId, permanent, 10, name, description, tokens, 'user')
  }

  function handleZipNow(zipId: string) {
    zippingService.rezip(zipId, 'user')
  }

  function handleReturnAutomatic(zipId: string) {
    zippingService.returnToAutomatic(zipId)
  }
  
  function isZipUnzipped(zipId: string): boolean {
    return zippingService.isUnzipped(zipId)
  }
  
  let unzippedInfo = $state(new Map<string, UnzippedItem>())
  
  function updateUnzippedStates() {
    const info = new Map<string, UnzippedItem>()
    
    // Reset type counters for consistent ID generation
    let terminalIdx = 0
    let errorIdx = 0
    let diffIdx = 0
    let toolResultIdx = 0
    
    segments.forEach((segment: any, i) => {
      // Handle Cool Tools explicitly
      if (segment.type === 'cool_tool') {
        // Generate zipId the same way the render code does
        const zipId = segment.zipId || `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-cool_tool-${toolResultIdx++}`
        // Normalize Cool Tool zipId to always check with -0
        const normalizedZipId = zipId.replace(/-cool_tool-\d+$/, '-cool_tool-0')
        
        // Check if the normalized zipId is unzipped
        const isUnzipped = zippingService.isUnzipped(normalizedZipId)
        
        if (isUnzipped) {
          recordUnzippedInfo(info, normalizedZipId)
        }
      } else if (segment.type === 'image' && segment.zipId) {
        const normalizedZipId = normalizeId(segment.zipId)
        const isUnzipped = zippingService.isUnzipped(normalizedZipId)

        if (isUnzipped) {
          recordUnzippedInfo(info, normalizedZipId)
        }
      } else if (segment.type === 'batshit') {
        const zipId = segment.id || `zip-${i}`
        
        // Get unzipped item info if unzipped
        if (zippingService.isUnzipped(zipId)) {
          recordUnzippedInfo(info, zipId)
        }
      } else if (shouldShowAsZip(segment, i)) {
        // Also check for content that would be zipped
        // Try to find corresponding Batshit zip first
        const batshitzip = segments.find(
          (s) => s.type === 'batshit' &&
            segment.type === 'terminal' &&
            s.description?.includes('Terminal output')
        )
        
        let zipId
        if (segment.zipId) {
          zipId = segment.zipId
        } else {
          // Generate a consistent zip ID that matches what will be stored
          let typeIndex = 0
          switch (segment.type) {
            case 'terminal':
              typeIndex = terminalIdx++
              break
            case 'error':
              typeIndex = errorIdx++
              break
            case 'diff':
              typeIndex = diffIdx++
              break
            case 'cool_tool':
              typeIndex = toolResultIdx++
              break
          }
          
          // Extract session ID from the session store
          const sessionId = sessionStore.getCurrentSessionId() || 'unknown'
          zipId = batshitzip?.id || `${sessionId}-${messageId}-${segment.type}-${typeIndex}`
        }
        
        const isUnzipped = zippingService.isUnzipped(zipId)
        
        if (isUnzipped) {
          recordUnzippedInfo(info, zipId)
        }
      }
    })
    
    unzippedInfo = info
  }
  
  $effect(() => {
    updateUnzippedStates()
  })

  onDestroy(() => {
    clearZipRefreshTimeout()
    clearZipFetchBackoff()
    if (coolToolHydrationTimer) {
      clearTimeout(coolToolHydrationTimer)
      coolToolHydrationTimer = null
    }
    coolToolHydrationQueue = new Set()
  })
  
  function refreshZipMetadata() {
    if (!compiledContent) return
    zipMetadataFromRedis.clear()
    updateUnzippedStates()
    forceRefreshCounter++
  }
  
  // Listen for zip activity changes from Redis keyspace notifications! 🚀
  $effect(() => {
    const currentSessionId = sessionStore.getCurrentSessionId()
    
    const handleZipActivityChange = (event: CustomEvent) => {
      if (event.detail.sessionId === currentSessionId) {
        if (isStreaming) {
          pendingZipRefresh = true
          return
        }
        pendingZipRefresh = false
        scheduleZipRefresh()
      }
    }
    
    const handleCheckZipActivity = (event: CustomEvent) => {
      if (event.detail.sessionId === currentSessionId) {
        if (isStreaming) {
          pendingZipRefresh = true
          return
        }
        pendingZipRefresh = false
        scheduleZipRefresh()
      }
    }

    const handleZipStateChanged = (event: CustomEvent) => {
      if (event.detail.sessionId === currentSessionId) {
        if (isStreaming) {
          pendingZipRefresh = true
          return
        }
        pendingZipRefresh = false
        updateUnzippedStates()
        forceRefreshCounter++
      }
    }
    
    // Listen for the custom events
    window.addEventListener('zipActivityChanged', handleZipActivityChange as EventListener)
    window.addEventListener('checkZipActivity', handleCheckZipActivity as EventListener)
    window.addEventListener('batshit:zip-state-changed', handleZipStateChanged as EventListener)
    
    // Cleanup
    return () => {
      window.removeEventListener('zipActivityChanged', handleZipActivityChange as EventListener)
      window.removeEventListener('checkZipActivity', handleCheckZipActivity as EventListener)
      window.removeEventListener('batshit:zip-state-changed', handleZipStateChanged as EventListener)
      clearZipRefreshTimeout()
    }
  })
</script>

<div class="message-content-wrapper">
  <!-- Clips will be handled by parent ChatMessage component -->
  <div class="message-content">
    {#if isCompiling}
      <div class="message-content-loading">Loading tool results...</div>
    {/if}

    {#if visibleControlNotes.length > 0}
      <div class="message-control-notes">
        {#each visibleControlNotes as note (`${note.kind}-${note.value}`)}
          <div class="message-control-note">{note.label}</div>
        {/each}
      </div>
    {/if}
    
    <!-- Render first appearance clips before other content -->
    {#if role === 'user' && firstAppearanceClips.length > 0}
      {#each firstAppearanceClips as clip}
        <div class="clip-first-appearance" data-clip-id={clip.clipId}>
          {#if clip.url && clip.filename?.match(/\.(jpg|jpeg|png|gif|webp|svg)$/i)}
            <img 
              src={clip.url} 
              alt={clip.filename}
              class="clip-first-appearance-image"
            />
          {/if}
          <div class="clip-first-appearance-info">
            📎 {clip.filename}
          </div>
        </div>
      {/each}
    {/if}
    
    {#each keyedSegments as keyedSegment (keyedSegment.key)}
    {@const segment = keyedSegment.segment}
    {@const i = keyedSegment.index}
    {@const isToolGroupContinuation = toolActivityGroups.continuations.has(i)}
    {@const toolGroup = toolActivityGroups.groups.get(i)}
    {#if toolGroup}
      <ToolActivityGroup
        items={toolGroup.summary}
        isStreaming={isStreaming}
        zipIds={getToolActivityZipIds(toolGroup.items)}
      >
        {#each toolGroup.items as item (toolActivityItemKey(item))}
          <ToolActivitySegment
            segment={item.segment}
            segmentIndex={item.index}
            {messageId}
            currentSessionId={sessionStore.getCurrentSessionId() || 'unknown'}
            {messagesAgo}
            {zipMetadataFromRedis}
            {pendingCoolToolFetch}
            {missingCoolToolZips}
            {coolToolFromZip}
            {showZippedBadges}
            {zippedBadgesHoverOnly}
            {showZippedBorders}
            {zippedBordersHoverOnly}
            {showUnzippedBadges}
            {unzippedBadgesHoverOnly}
            {showUnzippedBorders}
            {unzippedBordersHoverOnly}
            {alwaysShowZipBorders}
            {resolveZipTokens}
            {resolveZipVisualState}
            {shouldShowAsZip}
            {handleUnzip}
            {handleZipNow}
            {handleReturnAutomatic}
          />
        {/each}
      </ToolActivityGroup>
    {:else if !isToolGroupContinuation && segment.type === 'text'}
      <TextRenderer content={segment.content} renderFileMentions={role === 'user'} />
    {:else if !isToolGroupContinuation && segment.type === 'loading'}
      <LoadingIndicator type="tool" text="Executing tool..." />
    {:else if !isToolGroupContinuation && segment.type === 'code'}
      <CodeRenderer
        content={segment.content}
        language={segment.language}
        filename={segment.filename}
        toolName={segment.toolName}
        path={segment.path}
        lineCountProp={segment.lineCount}
      />
    {:else if !isToolGroupContinuation && segment.type === 'terminal'}
      {@const wouldBeZipped = shouldShowAsZip(segment, i)}
      {@const fallbackZipId = wouldBeZipped ? `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-terminal-${getTypeIndex('terminal')}` : ''}
      {@const rawZipId = segment.zipId || fallbackZipId}
      {@const normalizedZipId = rawZipId ? normalizeId(rawZipId) : ''}
      {@const isZipContent = Boolean(normalizedZipId)}
      {@const zipMetadata = normalizedZipId
        ? zipMetadataFromRedis.get(rawZipId) || zipMetadataFromRedis.get(normalizedZipId)
        : undefined}
      {@const zipState = normalizedZipId
        ? resolveZipVisualState({
            zipId: normalizedZipId,
            zipType: 'terminal',
            zipData: zipMetadata,
            toolName: segment.toolName,
            fallbackTokens: estimateTokens(segment.content || ''),
            messagesFromEnd: messagesAgo
          })
        : { isUnzipped: false }}
      {@const isUnzipped = isZipContent ? zipState.isUnzipped : false}
      {@const collapse = isZipContent
        ? (!isUnzipped && shouldShowAsZip({ ...segment, zipId: normalizedZipId }, i))
        : (wouldBeZipped && !isUnzipped)}
      {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
      {@const isPermanent = Boolean(zipState.isPermanent)}
      {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
      {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
      {@const autoZip = Boolean(zipState.autoZip)}
      {@const manualZip = Boolean(zipState.manualZip)}
      <ZipbatshitWrapper 
        isZipped={collapse}
        zipId={normalizedZipId}
        tokens={estimateTokens(segment.content || '')}
        isUnzipped={isUnzipped}
        {expandedReason}
        {isPermanent}
        {remainingMessages}
        {aboutToZip}
        autoZip={autoZip}
        agentControlled={Boolean(zipState.agentControlled)}
        {manualZip}
        onToggleUnzip={(permanent: boolean) =>
          normalizedZipId &&
          handleUnzip(
            normalizedZipId,
            permanent,
            'Terminal Output',
            'terminal - Terminal output',
            estimateTokens(segment.content || ''),
            autoZip
          )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
        name="Terminal Output"
        description="terminal - Terminal output"
        {showZippedBadges}
        {zippedBadgesHoverOnly}
        {showZippedBorders}
        {zippedBordersHoverOnly}
        {showUnzippedBadges}
        {unzippedBadgesHoverOnly}
        {showUnzippedBorders}
        {unzippedBordersHoverOnly}
        {alwaysShowZipBorders}
      >
        <TerminalRenderer content={segment.content} />
      </ZipbatshitWrapper>
    {:else if !isToolGroupContinuation && segment.type === 'diff'}
      {@const wouldBeZipped = shouldShowAsZip(segment, i)}
      {@const fallbackZipId = wouldBeZipped ? `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-diff-${getTypeIndex('diff')}` : ''}
      {@const rawZipId = segment.zipId || fallbackZipId}
      {@const normalizedZipId = rawZipId ? normalizeId(rawZipId) : ''}
      {@const isZipContent = Boolean(normalizedZipId)}
      {@const zipMetadata = normalizedZipId
        ? zipMetadataFromRedis.get(rawZipId) || zipMetadataFromRedis.get(normalizedZipId)
        : undefined}
      {@const zipState = normalizedZipId
        ? resolveZipVisualState({
            zipId: normalizedZipId,
            zipType: 'diff',
            zipData: zipMetadata,
            toolName: segment.toolName,
            fallbackTokens: estimateTokens(segment.content || ''),
            messagesFromEnd: messagesAgo
          })
        : { isUnzipped: false }}
      {@const isUnzipped = isZipContent ? zipState.isUnzipped : false}
      {@const collapse = isZipContent
        ? (!isUnzipped && shouldShowAsZip({ ...segment, zipId: normalizedZipId }, i))
        : (wouldBeZipped && !isUnzipped)}
      {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
      {@const isPermanent = Boolean(zipState.isPermanent)}
      {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
      {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
      {@const autoZip = Boolean(zipState.autoZip)}
      {@const manualZip = Boolean(zipState.manualZip)}
      <ZipbatshitWrapper 
        isZipped={collapse}
        zipId={normalizedZipId}
        tokens={estimateTokens(segment.content || '')}
        isUnzipped={isUnzipped}
        {expandedReason}
        {isPermanent}
        {remainingMessages}
        {aboutToZip}
        autoZip={autoZip}
        agentControlled={Boolean(zipState.agentControlled)}
        {manualZip}
        onToggleUnzip={(permanent: boolean) =>
          normalizedZipId &&
          handleUnzip(
            normalizedZipId,
            permanent,
            segment.filename || 'Diff',
            `diff - ${segment.filename || 'File changes'}`,
            estimateTokens(segment.content || ''),
            autoZip
          )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
        name={segment.filename || 'Diff'}
        description={`diff - ${segment.filename || 'File changes'}`}
        {showZippedBadges}
        {zippedBadgesHoverOnly}
        {showZippedBorders}
        {zippedBordersHoverOnly}
        {showUnzippedBadges}
        {unzippedBadgesHoverOnly}
        {showUnzippedBorders}
        {unzippedBordersHoverOnly}
        {alwaysShowZipBorders}
      >
        <CodeRenderer 
          content={segment.content} 
          language="diff" 
          filename={segment.filename}
          toolName={segment.toolName}
          path={segment.path}
          lineCountProp={segment.lineCount}
        />
      </ZipbatshitWrapper>
    {:else if !isToolGroupContinuation && segment.type === 'batshit'}
      <!-- Special handling for zipped Cool Tools -->
      {#if segment.zipType === 'cool_tool'}
        {@const zipId = segment.id || `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-cool_tool-${getTypeIndex('cool_tool')}`}
        {@const normalizedZipId = normalizeId(zipId)}
        {@const segmentWithZipId = { ...segment, zipId: normalizedZipId, isZip: true, zipType: 'cool_tool' }}
        {@const toolName = segment.name || 'Tool Result'}
        {@const zipMetadata = zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)}
        {@const promptTokenPayload = parseCoolToolPayload(zipMetadata?.content)}
        {@const tokenEstimate = estimateCoolToolAiTokens(
          normalizedZipId,
          zipMetadata || { content: segment.content || '', metadata: segment.metadata || {} },
          promptTokenPayload
        )}
        {@const tokenCount = resolveZipTokens(zipId, tokenEstimate)}
        {@const zipState = resolveZipVisualState({
          zipId: normalizedZipId,
          zipType: 'cool_tool',
          zipData: zipMetadata,
          toolName,
          fallbackTokens: tokenCount,
          messagesFromEnd: messagesAgo
        })}
        {@const isUnzipped = zipState.isUnzipped}
        {@const collapse = !isUnzipped && shouldShowAsZip(segmentWithZipId, i)}
        {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
        {@const isPermanent = Boolean(zipState.isPermanent)}
        {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
        {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
        {@const autoZip = Boolean(zipState.autoZip)}
        {@const manualZip = Boolean(zipState.manualZip)}
        
        <ZipbatshitWrapper 
          isZipped={collapse}
          zipId={normalizedZipId}
          tokens={tokenCount}
          isUnzipped={isUnzipped}
          {expandedReason}
          {isPermanent}
          {remainingMessages}
          {aboutToZip}
          autoZip={autoZip}
          agentControlled={Boolean(zipState.agentControlled)}
          {manualZip}
          onToggleUnzip={(permanent: boolean) =>
            normalizedZipId &&
            handleUnzip(
              normalizedZipId,
              permanent,
              toolName,
              segment.description || `Tool execution: ${toolName}`,
              tokenCount,
              autoZip
            )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
          name={toolName}
          description={segment.description || `Tool execution: ${toolName}`}
          showZippedBadges={showZippedBadges}
        zippedBadgesHoverOnly={zippedBadgesHoverOnly}
        showZippedBorders={showZippedBorders}
        zippedBordersHoverOnly={zippedBordersHoverOnly}
        showUnzippedBadges={showUnzippedBadges}
        unzippedBadgesHoverOnly={unzippedBadgesHoverOnly}
        showUnzippedBorders={showUnzippedBorders}
        unzippedBordersHoverOnly={unzippedBordersHoverOnly}
        alwaysShowZipBorders={alwaysShowZipBorders}
        >
          <!-- Zipped Cool Tool - show summary -->
          <div class="message-muted-summary">
            {segment.description || `Tool execution: ${toolName}`}
          </div>
        </ZipbatshitWrapper>
      <!-- For images and files, always show content directly (not collapsible) -->
      {:else if segment.contentType === 'image' || segment.contentType === 'file' || segment.path?.includes('/images/') || segment.path?.includes('/documents/')}
        {@const zipId = segment.id || `zip-${i}`}
        {@const normalizedZipId = normalizeId(zipId)}
        {@const tokenCount = resolveZipTokens(zipId, segment.tokens || 0)}
        {@const zipMetadata = zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)}
        {@const zipType = segment.contentType || zipMetadata?.type || 'file'}
        {@const zipState = resolveZipVisualState({
          zipId: normalizedZipId,
          zipType,
          zipData: zipMetadata,
          toolName: segment.name,
          fallbackTokens: tokenCount,
          messagesFromEnd: messagesAgo
        })}
        {@const isUnzipped = zipState.isUnzipped}
        {@const collapse = !isUnzipped && shouldShowAsZip(segment, i)}
        {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
        {@const isPermanent = Boolean(zipState.isPermanent)}
        {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
        {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
        {@const autoZip = Boolean(zipState.autoZip)}
        {@const manualZip = Boolean(zipState.manualZip)}
        
        <ZipbatshitWrapper 
          isZipped={collapse}
          zipId={normalizedZipId || zipId}
          source={segment.source || 'USER'}
          tokens={tokenCount}
          {isUnzipped}
          {expandedReason}
          {isPermanent}
          {remainingMessages}
          {aboutToZip}
          autoZip={autoZip}
          agentControlled={Boolean(zipState.agentControlled)}
          {manualZip}
          onToggleUnzip={(permanent: boolean) =>
            zipId &&
            handleUnzip(
              zipId,
              permanent,
              segment.name || 'File',
              `${segment.contentType || 'file'} - ${segment.description || segment.name}`,
              segment.tokens,
              autoZip
            )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
          {alwaysShowZipBorders}
          showZippedBadges={showZippedBadges}
          zippedBadgesHoverOnly={zippedBadgesHoverOnly}
          showZippedBorders={showZippedBorders}
          zippedBordersHoverOnly={zippedBordersHoverOnly}
          showUnzippedBadges={showUnzippedBadges}
          unzippedBadgesHoverOnly={unzippedBadgesHoverOnly}
          showUnzippedBorders={showUnzippedBorders}
          unzippedBordersHoverOnly={unzippedBordersHoverOnly}
        >
          <ZipRenderer_batshit 
            id={segment.id || ''}
            source={segment.source || 'USER'}
            tokens={segment.tokens || 0}
            name={segment.name || ''}
            path={segment.path || ''}
            description={segment.description || ''}
            contentType={segment.contentType}
          />
        </ZipbatshitWrapper>
      {:else if segment.type === 'batshit' && segment.description === 'Tool usage output'}
        <!-- Special case for zipped tool content - render with ToolUseRenderer -->
        {@const zipId = segment.id || `zip-${i}`}
        {@const normalizedZipId = normalizeId(zipId)}
        {@const tokenCount = resolveZipTokens(zipId, segment.tokens || 0)}
        {@const zipMetadata = zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)}
        {@const zipType = zipMetadata?.type || 'cool_tool'}
        {@const zipState = resolveZipVisualState({
          zipId: normalizedZipId,
          zipType,
          zipData: zipMetadata,
          toolName: segment.name,
          fallbackTokens: tokenCount,
          messagesFromEnd: messagesAgo
        })}
        {@const isUnzipped = zipState.isUnzipped}
        {@const collapse = !isUnzipped && shouldShowAsZip(segment, i)}
        {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
        {@const isPermanent = Boolean(zipState.isPermanent)}
        {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
        {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
        {@const autoZip = Boolean(zipState.autoZip)}
        {@const manualZip = Boolean(zipState.manualZip)}
        
        <ZipbatshitWrapper 
          isZipped={collapse}
          zipId={normalizedZipId || zipId}
          source={segment.source || 'AI'}
          tokens={tokenCount}
          {isUnzipped}
          {expandedReason}
          {isPermanent}
          {remainingMessages}
          {aboutToZip}
          autoZip={autoZip}
          agentControlled={Boolean(zipState.agentControlled)}
          {manualZip}
          onToggleUnzip={(permanent: boolean) =>
            zipId &&
            handleUnzip(
              zipId,
              permanent,
              'Tool Output',
              segment.description || segment.name,
              segment.tokens,
              autoZip
            )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
          {alwaysShowZipBorders}
          showZippedBadges={showZippedBadges}
          zippedBadgesHoverOnly={zippedBadgesHoverOnly}
          showZippedBorders={showZippedBorders}
          zippedBordersHoverOnly={zippedBordersHoverOnly}
          showUnzippedBadges={showUnzippedBadges}
          unzippedBadgesHoverOnly={unzippedBadgesHoverOnly}
          showUnzippedBorders={showUnzippedBorders}
          unzippedBordersHoverOnly={unzippedBordersHoverOnly}
        >
          <ZipRenderer_batshit 
            id={segment.id || ''}
            source={segment.source || 'AI'}
            tokens={segment.tokens || 0}
            name={'Tool Output'}
            path={''}
            description={segment.description || ''}
            contentType={'text'}
          />
        </ZipbatshitWrapper>
      {:else if segment.type === 'batshit' && shouldShowAsZip(segment, i)}
        <!-- Batshit zip outside buffer - show with zip wrapper -->
        {@const zipId = segment.id || `zip-${i}`}
        {@const normalizedZipId = normalizeId(zipId)}
        {@const tokenCount = resolveZipTokens(zipId, segment.tokens || 0)}
        {@const zipMetadata = zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)}
        {@const zipType = zipMetadata?.type || 'all_other'}
        {@const zipState = resolveZipVisualState({
          zipId: normalizedZipId,
          zipType,
          zipData: zipMetadata,
          toolName: segment.name,
          fallbackTokens: tokenCount,
          messagesFromEnd: messagesAgo
        })}
        {@const isUnzipped = zipState.isUnzipped}
        {@const collapse = !isUnzipped && shouldShowAsZip(segment, i)}
        {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
        {@const isPermanent = Boolean(zipState.isPermanent)}
        {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
        {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
        {@const autoZip = Boolean(zipState.autoZip)}
        {@const manualZip = Boolean(zipState.manualZip)}
        
        <ZipbatshitWrapper 
          isZipped={collapse}
          zipId={normalizedZipId || zipId}
          source={segment.source || 'USER'}
          tokens={tokenCount}
          {isUnzipped}
          {expandedReason}
          {isPermanent}
          {remainingMessages}
          {aboutToZip}
          autoZip={autoZip}
          agentControlled={Boolean(zipState.agentControlled)}
          {manualZip}
          onToggleUnzip={(permanent: boolean) =>
            zipId &&
            handleUnzip(
              zipId,
              permanent,
              segment.name || 'File',
              `${(segment as any).contentType || 'file'} - ${segment.description || segment.name}`,
              segment.tokens,
              autoZip
            )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
          {alwaysShowZipBorders}
          showZippedBadges={showZippedBadges}
          zippedBadgesHoverOnly={zippedBadgesHoverOnly}
          showZippedBorders={showZippedBorders}
          zippedBordersHoverOnly={zippedBordersHoverOnly}
          showUnzippedBadges={showUnzippedBadges}
          unzippedBadgesHoverOnly={unzippedBadgesHoverOnly}
          showUnzippedBorders={showUnzippedBorders}
          unzippedBordersHoverOnly={unzippedBordersHoverOnly}
        >
          <!-- For zipped content, we show the zip reference, not the full content -->
          <!-- The user already saw the full content before it was zipped -->
          <ZipRenderer_batshit 
            id={segment.id || ''}
            source={segment.source || 'USER'}
            tokens={segment.tokens || 0}
            name={segment.name || ''}
            path={segment.path || ''}
            description={segment.description || ''}
            contentType={(segment as any).contentType}
          />
        </ZipbatshitWrapper>
      {:else}
        <!-- Within buffer zone - show as simple zip reference -->
        <ZipRenderer_batshit 
          id={segment.id || ''}
          source={segment.source || 'USER'}
          tokens={segment.tokens || 0}
          name={segment.name || ''}
          path={segment.path || ''}
          description={segment.description || ''}
          contentType={(segment as any).contentType}
        />
      {/if}
    {:else if !isToolGroupContinuation && segment.type === 'image'}
      {@const clipData = segment.id && messageClips.find(c => c.clipId === segment.id)}
      {@const isFirstAppearance = segment.id && firstAppearanceClips.some(c => c.clipId === segment.id)}
      {@const clipUrl = clipData?.url || clipData?.displayUrl || clipData?.externalUrl || clipData?.localUrl}
      {@const fullResolutionUrl = segment.fullResolutionSrc || clipData?.fullResolutionUrl || ''}
      {@const imageSrc = segment.src || clipUrl || ''}
      {@const isZipImage = Boolean(segment.isZip && segment.zipId)}
      {@const zipId = segment.zipId || ''}
      {@const normalizedZipId = zipId ? normalizeId(zipId) : ''}
      {@const tokenEstimate = resolveZipTokens(zipId, estimateTokens(imageSrc || ''))}
      {@const imageLabel = segment.title || segment.alt || 'Image'}
      {@const zipMetadata = isZipImage && normalizedZipId
        ? zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)
        : undefined}
      {@const zipState = isZipImage && normalizedZipId
        ? resolveZipVisualState({
            zipId: normalizedZipId,
            zipType: 'image',
            zipData: zipMetadata,
            toolName: imageLabel,
            fallbackTokens: tokenEstimate,
            messagesFromEnd: messagesAgo
          })
        : { isUnzipped: false }}
      {@const isUnzipped = zipState.isUnzipped}
      {@const collapse = isZipImage ? (!isUnzipped && shouldShowAsZip(segment, i)) : false}
      {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
      {@const isPermanent = Boolean(zipState.isPermanent)}
      {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
      {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
      {@const autoZip = Boolean(zipState.autoZip)}
      {@const manualZip = Boolean(zipState.manualZip)}
      {#if isFirstAppearance || !segment.id}
        <!-- Only render full image if it's a first appearance clip or not a clip at all -->
        {#if isZipImage && normalizedZipId}
          <ZipbatshitWrapper 
            isZipped={collapse}
            zipId={normalizedZipId}
            tokens={tokenEstimate}
            {isUnzipped}
            {expandedReason}
            {isPermanent}
            {remainingMessages}
            {aboutToZip}
            autoZip={autoZip}
            agentControlled={Boolean(zipState.agentControlled)}
            {manualZip}
            onToggleUnzip={(permanent: boolean) =>
              handleUnzip(
                normalizedZipId,
                permanent,
                imageLabel,
                `Image: ${imageLabel}`,
                tokenEstimate,
                autoZip
              )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
            name={imageLabel}
            description={`Image: ${imageLabel}`}
            {showZippedBadges}
            {zippedBadgesHoverOnly}
            {showZippedBorders}
            {zippedBordersHoverOnly}
            {showUnzippedBadges}
            {unzippedBadgesHoverOnly}
            {showUnzippedBorders}
            {unzippedBordersHoverOnly}
            {alwaysShowZipBorders}
          >
            <ImageRenderer 
              src={imageSrc} 
              alt={segment.alt || ''} 
              title={segment.title}
              width={segment.width}
              height={segment.height}
              clipId={segment.id}
              sessionId={sessionId}
              fullResolutionSrc={fullResolutionUrl}
              filename={clipData?.filename}
            />
          </ZipbatshitWrapper>
        {:else}
          <ImageRenderer 
            src={imageSrc} 
            alt={segment.alt || ''} 
            title={segment.title}
            width={segment.width}
            height={segment.height}
            clipId={segment.id}
            sessionId={sessionId}
            fullResolutionSrc={fullResolutionUrl}
            filename={clipData?.filename}
          />
        {/if}
      {/if}
    {:else if !isToolGroupContinuation && segment.type === 'file'}
      <FileRenderer 
        filename={segment.filename || ''} 
        url={segment.url || ''}
        size={segment.size}
        type={segment.fileType}
        tokens={segment.tokens}
        content={segment.content}
      />
    {:else if !isToolGroupContinuation && segment.type === 'error'}
      {@const wouldBeZipped = shouldShowAsZip(segment, i) && !shouldNeverZip(segment)}
      <!-- NEW: Use segment's zipId if it has one (from embedded zip) -->
      {@const zipId = segment.zipId || (wouldBeZipped ? `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-error-${getTypeIndex('error')}` : '')}
      {@const normalizedZipId = normalizeId(zipId)}
      {@const zipMetadata = normalizedZipId
        ? zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)
        : undefined}
      {@const zipState = normalizedZipId
        ? resolveZipVisualState({
            zipId: normalizedZipId,
            zipType: 'error',
            zipData: zipMetadata,
            toolName: 'error',
            fallbackTokens: estimateTokens(segment.content || ''),
            messagesFromEnd: messagesAgo
          })
        : { isUnzipped: false }}
      {@const isUnzipped = zipState.isUnzipped}
      {@const collapse = !isUnzipped && wouldBeZipped}
      {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
      {@const isPermanent = Boolean(zipState.isPermanent)}
      {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
      {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
      {@const autoZip = Boolean(zipState.autoZip)}
      {@const manualZip = Boolean(zipState.manualZip)}
      <ZipbatshitWrapper 
        isZipped={collapse}
        zipId={normalizedZipId}
        tokens={estimateTokens(segment.content || '')}
        {isUnzipped}
        {expandedReason}
        {isPermanent}
        {remainingMessages}
        {aboutToZip}
        autoZip={autoZip}
        agentControlled={Boolean(zipState.agentControlled)}
        {manualZip}
        onToggleUnzip={(permanent: boolean) =>
          handleUnzip(
            normalizedZipId,
            permanent,
            'Error Output',
            `error - ${segment.errorTitle || 'Error details'}`,
            estimateTokens(segment.content || ''),
            autoZip
          )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
        name="Error Output"
        description={`error - ${segment.errorTitle || 'Error details'}`}
        {showZippedBadges}
        {zippedBadgesHoverOnly}
        {showZippedBorders}
        {zippedBordersHoverOnly}
        {showUnzippedBadges}
        {unzippedBadgesHoverOnly}
        {showUnzippedBorders}
        {unzippedBordersHoverOnly}
        {alwaysShowZipBorders}
      >
        <ErrorRenderer 
          error={(segment as any).error || segment.content} 
          title={segment.errorTitle}
          stack={segment.stack}
          code={segment.code}
        />
      </ZipbatshitWrapper>
    {:else if !isToolGroupContinuation && segment.type === 'tool_result'}
      <!-- Generic Tool Result (fallback for tools without custom renderers) -->
      {#if segment.intermediateStep}
        <CoolToolRenderer intermediateStep={segment.intermediateStep} />
      {/if}
    {:else if !isToolGroupContinuation && segment.type === 'cool_tool'}
      {@const zipId = segment.zipId || `${sessionStore.getCurrentSessionId() || 'unknown'}-${messageId}-cool_tool-${getTypeIndex('cool_tool')}`}
      {@const segmentWithZipId = { ...segment, zipId, isZip: true, zipType: 'cool_tool' }}
      {@const toolName = segment.toolName || extractToolName(segment.content)}
      <!-- For Cool Tools, normalize the zipId to always use -0 for unzipped state checking -->
      {@const normalizedZipId = zipId.replace(/-cool_tool-\d+$/, '-cool_tool-0')}
      {@const zipMetadata = zipMetadataFromRedis.get(zipId) || zipMetadataFromRedis.get(normalizedZipId)}
      {@const hydratedStepForTokens = segment.zipId ? coolToolFromZip.get(normalizedZipId) : null}
      {@const inlineStepForTokens = buildInlineCoolToolStep(segment.toolData, toolName)}
      {@const promptTokenPayload =
        parseCoolToolPayload(zipMetadata?.content) ||
        hydratedStepForTokens ||
        inlineStepForTokens ||
        segment.intermediateStep ||
        segment.toolData ||
        null}
      {@const tokenEstimate = estimateCoolToolAiTokens(
        normalizedZipId,
        zipMetadata || { content: segment.content || '', metadata: segment.metadata || {} },
        promptTokenPayload
      )}
      {@const tokenCount = resolveZipTokens(zipId, tokenEstimate)}
      {@const zipState = resolveZipVisualState({
        zipId: normalizedZipId,
        zipType: 'cool_tool',
        zipData: zipMetadata,
        toolName,
        fallbackTokens: tokenCount,
        messagesFromEnd: messagesAgo
      })}
      {@const isUnzippedValue = zipState.isUnzipped}
      {@const collapse = !isUnzippedValue && shouldShowAsZip(segmentWithZipId, i)}
      {@const expandedReason = !collapse ? zipState.expandedReason : undefined}
      {@const isPermanent = Boolean(zipState.isPermanent)}
      {@const remainingMessages = !collapse ? zipState.remainingMessages : undefined}
      {@const aboutToZip = !collapse ? zipState.aboutToZip : false}
      {@const autoZip = Boolean(zipState.autoZip)}
      {@const manualZip = Boolean(zipState.manualZip)}
      {@const isMissingZip = isCoolToolMissing(zipId)}
      {@const isPendingZip = isCoolToolPending(zipId)}
      <ZipbatshitWrapper 
        isZipped={collapse}
        zipId={normalizedZipId}
        tokens={tokenCount}
        isUnzipped={isUnzippedValue}
        {expandedReason}
        {isPermanent}
        {remainingMessages}
        {aboutToZip}
        autoZip={autoZip}
        agentControlled={Boolean(zipState.agentControlled)}
        {manualZip}
        onToggleUnzip={(permanent: boolean) =>
          handleUnzip(
            normalizedZipId,
            permanent,
            toolName,
            `Tool execution: ${toolName}`,
            tokenCount,
            autoZip
          )}
          onZipNow={handleZipNow}
          onReturnAutomatic={handleReturnAutomatic}
        name={toolName}
        description={`Tool execution: ${toolName}`}
        showZippedBadges={showZippedBadges}
        zippedBadgesHoverOnly={zippedBadgesHoverOnly}
        showZippedBorders={showZippedBorders}
        zippedBordersHoverOnly={zippedBordersHoverOnly}
        showUnzippedBadges={showUnzippedBadges}
        unzippedBadgesHoverOnly={unzippedBadgesHoverOnly}
        showUnzippedBorders={showUnzippedBorders}
        unzippedBordersHoverOnly={unzippedBordersHoverOnly}
        alwaysShowZipBorders={alwaysShowZipBorders}
      >
        {#if isPendingZip}
          <CoolToolRenderer isPending={true} toolId={segment.zipId || segment.toolId} metadata={segment.metadata || {}} />
        {:else if isMissingZip}
          <div class="message-missing-tool-result">Tool result unavailable (zip missing)</div>
        {:else}
          {@const hydratedStep = segment.zipId ? coolToolFromZip.get(normalizedZipId) : null}
          {#if hydratedStep}
            <CoolToolRenderer
              intermediateStep={hydratedStep}
              metadata={segment.metadata || hydratedStep?.metadata || {}}
              toolId={segment.zipId || segment.toolId}
            />
          {:else if segment.toolData}
            {@const inlineStep = buildInlineCoolToolStep(segment.toolData, toolName)}
            {#if inlineStep}
              <CoolToolRenderer
                intermediateStep={inlineStep}
                metadata={segment.metadata || inlineStep.metadata || {}}
                toolId={segment.zipId || segment.toolId}
              />
            {:else}
              <CoolToolRenderer isPending={true} toolId={segment.zipId || segment.toolId} metadata={segment.metadata || {}} />
            {/if}
          {:else}
            <CoolToolRenderer isPending={true} toolId={segment.zipId || segment.toolId} metadata={segment.metadata || {}} />
          {/if}
        {/if}
      </ZipbatshitWrapper>
    {:else if !isToolGroupContinuation}
      <!-- Fallback for unknown types -->
      <div class="message-muted-summary">
        {segment.content}
      </div>
    {/if}
  {/each}
  </div>
  
  <!-- Tool results are now embedded in the content as Batshit zips -->
</div>

<style>
  .message-content-wrapper {
    position: relative;
    box-sizing: border-box;
    display: flex;
    align-items: stretch;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }
  
  .message-content {
    box-sizing: border-box;
    flex: 1;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
  }

  .message-content-loading {
    color: var(--muted-foreground);
    animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
  }

  .message-control-notes {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .message-control-note {
    color: var(--success-color);
    font-size: 0.6875rem;
    font-weight: 600;
  }

  .message-muted-summary {
    font-size: 0.875rem;
    opacity: 0.75;
  }

  .message-missing-tool-result {
    padding: 0.25rem 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }
  
  .message-content :global(> *:not(:last-child)) {
    margin-bottom: 0.5rem;
  }

  @keyframes pulse {
    50% {
      opacity: 0.5;
    }
  }
  
  /* Clips container styles are in ChatMessage.svelte */
  
  /* First appearance - full display before message content */
  .clip-first-appearance {
    display: none;  /* Hide this since we're showing clips differently */
  }
  
  .clip-first-appearance-image {
    max-width: 100%;
    max-height: 400px;
    object-fit: contain;
    border-radius: 0.375rem;
    margin-bottom: 0.5rem;
    display: block;
  }
  
  .clip-first-appearance-info {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--muted-foreground);
  }
  
  
  /* Clip badge styles have been moved to ChatMessage.svelte */
  
  /* Animation for attaching has been moved to ChatMessage.svelte */
</style>
