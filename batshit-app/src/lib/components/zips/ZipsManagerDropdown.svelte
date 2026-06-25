<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Select from '$lib/components/ui/select'
  import {
    Edit3,
    FileEdit,
    FileText,
    FolderOpen,
    Globe,
    Search,
    Terminal,
    Wrench
  } from '@lucide/svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { zippingService, type UnzippedItem } from '$lib/services/zipping'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { onMount } from 'svelte'
  import type { Component } from 'svelte'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import * as messageStore from '$lib/stores/messages.svelte'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { getUserSettings } from '$lib/stores/userSettings.svelte'
  import { normalizeId } from '$lib/utils/idNormalizer'
  import { calculateAgentMessagesFromEndByIndex } from '$lib/utils/zipMessageAge'
  import { calculateZipActivation } from '$lib/utils/zipActivation'
  import { buildZipStatusPresentation, type ZipStatusPresentation } from '$lib/utils/zipStatusPresentation'
  import { normalizeCompactTool } from '$lib/utils/toolActivityContract'
  import {
    getHiddenRawSidecarZipIds,
    shouldShowZipManagerItem
  } from '$lib/components/zips/zipManagerRows'
  import type { IconRef } from '$lib/icons/iconTypes'
  import { getProjectTreeIconRef } from '$lib/icons/fileTypeIcons'
  import FullTool from '$lib/components/renderers/tools/templates/FullTool.svelte'
  import ZipbatshitWrapper from '$lib/components/renderers/wrappers/ZipbatshitWrapper.svelte'

  type ZipManagerFilter = 'unzipped' | 'zipped' | 'all'
  type ZipManagerSort = 'chat' | 'manual' | 'tokens' | 'newest'
  type ZipManagerToolStatus = 'loading' | 'success' | 'error' | 'info'
  type ZipManagerExpandedReason = 'buffer' | 'user' | 'agent'

  interface ZipListItem {
    id: string
    type: string
    name?: string
    tokens: number
    description?: string
    createdAt: number
    source: string
    sessionId?: string
    messageId?: string
    isUnzipped?: boolean
    unzippedItem?: UnzippedItem | null
    isCoolTool?: boolean
    metadata?: Record<string, any>
  }

  interface ZipManagerRow extends ZipListItem {
    normalizedId: string
    title: string
    detail: string
    isZipped: boolean
    isUnzippedNow: boolean
    isManuallyUnzipped: boolean
    isPermanent: boolean
    remainingMessages: number | null
    expandedReason?: ZipManagerExpandedReason
    manualZip: boolean
    autoZip: boolean
    agentControlled: boolean
    aboutToZip: boolean
    presentation: ZipStatusPresentation
    toolTitle: string
    toolSubtitle: string
    toolIcon: Component
    toolIconRef: IconRef | null
    toolStatus: ZipManagerToolStatus
  }

  let { sessionId = null }: { sessionId: string | null } = $props()

  let allZips = $state<ZipListItem[]>([])
  let unzippedItems = $state<UnzippedItem[]>([])
  let isOpen = $state(false)
  let isLoading = $state(false)
  let loadError = $state<string | null>(null)
  let filter = $state<ZipManagerFilter>('unzipped')
  let sortMode = $state<ZipManagerSort>('chat')

  const sortOptions: { value: ZipManagerSort; label: string }[] = [
    { value: 'chat', label: 'Chat order' },
    { value: 'manual', label: 'Manual first' },
    { value: 'tokens', label: 'Tokens high' },
    { value: 'newest', label: 'Newest first' }
  ]

  const userSettings = $derived(getUserSettings())
  const globalZipSettings = $derived(userSettings?.global_zip_settings || undefined)
  const alwaysShowZipBorders = $derived(userSettings?.always_show_zip_borders || false)
  const showZippedBadges = $derived(userSettings?.show_zipped_badges ?? true)
  const zippedBadgesHoverOnly = $derived(userSettings?.zipped_badges_hover_only ?? false)
  const showZippedBorders = $derived(userSettings?.show_zipped_borders ?? true)
  const zippedBordersHoverOnly = $derived(userSettings?.zipped_borders_hover_only ?? true)
  const showUnzippedBadges = $derived(userSettings?.show_unzipped_badges ?? true)
  const unzippedBadgesHoverOnly = $derived(userSettings?.unzipped_badges_hover_only ?? false)
  const showUnzippedBorders = $derived(userSettings?.show_unzipped_borders ?? true)
  const unzippedBordersHoverOnly = $derived(userSettings?.unzipped_borders_hover_only ?? true)
  const sessionMessages = $derived(sessionId ? messageStore.getMessages(sessionId) : [])
  const messageAgeByIndex = $derived(calculateAgentMessagesFromEndByIndex(sessionMessages))
  const hiddenRawSidecarZipIds = $derived(getHiddenRawSidecarZipIds(allZips))

  const rows = $derived.by(() =>
    allZips
      .filter((zip) => shouldShowZipManagerItem(zip, hiddenRawSidecarZipIds))
      .map(buildManagerRow)
      .filter((row): row is ZipManagerRow => Boolean(row))
  )
  const unzippedRows = $derived(rows.filter((row) => row.isUnzippedNow))
  const zippedRows = $derived(rows.filter((row) => !row.isUnzippedNow))
  const displayRows = $derived.by(() => {
    const sourceRows =
      filter === 'unzipped'
        ? unzippedRows
        : filter === 'zipped'
          ? zippedRows
          : rows

    return [...sourceRows].sort(compareZipRows)
  })
  const sortLabel = $derived(
    sortOptions.find((option) => option.value === sortMode)?.label ?? 'Chat order'
  )

  const unzippedTokenTotal = $derived(
    unzippedRows.reduce((sum, row) => sum + (row.tokens || 0), 0)
  )
  const triggerManualUnzippedCount = $derived.by(
    () => new Set(
      unzippedItems
        .map((item) => item?.zipId ? normalizeId(item.zipId) : '')
        .filter(Boolean)
    ).size
  )
  const permanentCount = $derived(unzippedRows.filter((row) => row.isPermanent).length)
  const temporaryCount = $derived(
    unzippedRows.filter((row) => row.presentation.duration === 'countdown').length
  )

  let previousSessionId = $state<string | null | undefined>(undefined)

  $effect(() => {
    if (sessionId !== previousSessionId) {
      const targetSessionId = sessionId
      previousSessionId = targetSessionId
      if (targetSessionId) {
        allZips = []
        unzippedItems = []
        void zippingService.setCurrentSession(targetSessionId).then(() => {
          if (sessionId === targetSessionId) {
            syncUnzippedItems()
            if (isOpen) void loadZipItems()
          }
        })
      } else {
        allZips = []
        unzippedItems = []
      }
    }
  })

  function syncUnzippedItems(items?: UnzippedItem[]) {
    unzippedItems = Array.isArray(items) ? items : zippingService.getAllUnzipped()
    reconcileZipRows(unzippedItems)
  }

  function isSameZipId(left?: string | null, right?: string | null) {
    if (!left || !right) return false
    return left === right || normalizeId(left) === normalizeId(right)
  }

  function findUnzippedItemForZip(zip: ZipListItem, items = unzippedItems): UnzippedItem | null {
    return items.find((item) => isSameZipId(item?.zipId, zip.id)) ?? null
  }

  function reconcileZipRows(items = unzippedItems) {
    if (allZips.length === 0) return
    allZips = allZips.map((zip) => {
      const unzippedItem = findUnzippedItemForZip(zip, items)
      const nextIsUnzipped = Boolean(unzippedItem)
      if (zip.isUnzipped === nextIsUnzipped && zip.unzippedItem === unzippedItem) {
        return zip
      }
      return {
        ...zip,
        isUnzipped: nextIsUnzipped,
        unzippedItem
      }
    })
  }

  function updateCachedZipState(zipId: string, unzippedItem: UnzippedItem | null) {
    allZips = allZips.map((zip) => {
      if (!isSameZipId(zip.id, zipId)) return zip
      return {
        ...zip,
        isUnzipped: Boolean(unzippedItem),
        unzippedItem
      }
    })
  }

  function dispatchZipManagerActivity() {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('checkZipActivity', {
        detail: { sessionId }
      })
    )
    window.dispatchEvent(
      new CustomEvent('zipActivityChanged', {
        detail: { sessionId }
      })
    )
  }

  async function loadZipItems() {
    if (!sessionId) {
      allZips = []
      unzippedItems = []
      return
    }

    isLoading = true
    loadError = null

    try {
      await zippingService.ensureSessionLoaded(sessionId)
      syncUnzippedItems()
      const response = await fetch(`/api/zips/list?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { 'x-internal-api-request': '1' }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const payload = await response.json()
      allZips = Array.isArray(payload?.zips) ? payload.zips : []
      reconcileZipRows()
    } catch (error) {
      console.error('[ZipManager] Failed to load zip list:', error)
      loadError = 'Could not load zip items.'
    } finally {
      isLoading = false
    }
  }

  function handleZipStateChanged(event: Event) {
    const detail = (event as CustomEvent<{
      sessionId?: string | null
      unzipped?: UnzippedItem[]
    }>).detail

    if (detail?.sessionId !== sessionId) return
    syncUnzippedItems(detail.unzipped)
  }

  function handleZipActivity(event: Event) {
    const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail
    if (detail?.sessionId && detail.sessionId !== sessionId) return
    if (isOpen) void loadZipItems()
  }

  async function handleZip(row: ZipManagerRow) {
    const controlZipId = getControlZipId(row)
    const ok = await zippingService.rezip(controlZipId, 'user')
    if (!ok) return
    updateCachedZipState(controlZipId, null)
    syncUnzippedItems()
    dispatchZipManagerActivity()
  }

  async function handleUnzip(row: ZipManagerRow, permanent = false) {
    const ok = await zippingService.unzip(
      row.normalizedId,
      permanent,
      10,
      row.toolTitle,
      row.description,
      row.tokens,
      'user'
    )
    if (!ok) return
    const unzippedItem =
      zippingService.getUnzippedInfo(row.normalizedId) ??
      zippingService.getUnzippedInfo(row.id) ??
      null
    updateCachedZipState(row.normalizedId, unzippedItem)
    syncUnzippedItems()
    dispatchZipManagerActivity()
  }

  async function handleReturnAutomatic(row: ZipManagerRow) {
    const controlZipId = getControlZipId(row)
    const ok = await zippingService.returnToAutomatic(controlZipId)
    if (!ok) return
    updateCachedZipState(controlZipId, null)
    syncUnzippedItems()
    dispatchZipManagerActivity()
  }

  function getControlZipId(row: ZipManagerRow) {
    return getUnzippedItem(row)?.zipId || row.normalizedId || row.id
  }

  function addZipCandidate(ids: Set<string>, zipId?: string | null) {
    if (!zipId) return
    ids.add(zipId)
    ids.add(normalizeId(zipId))
  }

  function getLocateCandidateZipIds(row: ZipManagerRow) {
    const ids = new Set<string>()
    addZipCandidate(ids, row.id)
    addZipCandidate(ids, row.normalizedId)

    const rowToolCallId = firstString(row.metadata?.toolCallId)
    const rowRawSidecarZipId = firstString(row.metadata?.rawSidecarZipId)

    for (const zip of allZips) {
      const zipToolCallId = firstString(zip.metadata?.toolCallId)
      const zipRawSidecarZipId = firstString(zip.metadata?.rawSidecarZipId)

      if (rowRawSidecarZipId && isSameZipId(rowRawSidecarZipId, zip.id)) {
        addZipCandidate(ids, zip.id)
      }
      if (zipRawSidecarZipId && isSameZipId(zipRawSidecarZipId, row.id)) {
        addZipCandidate(ids, zip.id)
      }
      if (rowToolCallId && zipToolCallId === rowToolCallId && zip.type === 'cool_tool') {
        addZipCandidate(ids, zip.id)
      }
    }

    return Array.from(ids).filter(Boolean)
  }

  async function clearAll() {
    const confirmed = await confirmDialog({
      title: 'Zip all unzipped items?',
      description: `This will compress ${unzippedRows.length} unzipped item(s) for this session.`,
      confirmLabel: 'Zip All'
    })
    if (!confirmed) return

    const rowsToZip = [...unzippedRows]
    await Promise.all(rowsToZip.map((row) => zippingService.rezip(row.normalizedId, 'user')))
    rowsToZip.forEach((row) => updateCachedZipState(row.normalizedId, null))
    syncUnzippedItems()
    dispatchZipManagerActivity()
  }

  function handleLocate(row: ZipManagerRow) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:locate-zip', {
        detail: {
          zipId: row.id,
          normalizedZipId: row.normalizedId,
          candidateZipIds: getLocateCandidateZipIds(row),
          messageId: row.messageId,
          label: row.toolTitle
        }
      })
    )
  }

  function handleRowClick(event: MouseEvent, row: ZipManagerRow) {
    if (shouldIgnoreRowLocate(event.target)) return
    handleLocate(row)
  }

  function handleRowKeydown(event: KeyboardEvent, row: ZipManagerRow) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    if (shouldIgnoreRowLocate(event.target)) return
    event.preventDefault()
    handleLocate(row)
  }

  function shouldIgnoreRowLocate(target: EventTarget | null) {
    if (!(target instanceof Element)) return false
    return Boolean(
      target.closest(
        [
          '.token-badge-container',
          '.unzip-button-group',
          'button:not(.tool-header-button)',
          'a',
          'input',
          'textarea',
          'select',
          '[data-no-row-locate]'
        ].join(', ')
      )
    )
  }

  function handleSortChange(value: string | string[]) {
    const next = Array.isArray(value) ? value[0] : value
    if (isZipManagerSort(next)) sortMode = next
  }

  function isZipManagerSort(value: unknown): value is ZipManagerSort {
    return value === 'chat' || value === 'manual' || value === 'tokens' || value === 'newest'
  }

  function handleOpenChange(open: boolean) {
    isOpen = open
    if (open) void loadZipItems()
  }

  function getMessageContext(zip: ZipListItem) {
    const messageIndex = zip.messageId
      ? sessionMessages.findIndex((message) => message.id === zip.messageId)
      : -1
    const message = messageIndex >= 0 ? sessionMessages[messageIndex] : null
    const agent = message?.agent_id
      ? agentStore.getAgentById(message.agent_id) ?? agentStore.getCurrentAgent()
      : agentStore.getCurrentAgent()

    return {
      message,
      agent,
      messagesFromEnd: messageIndex >= 0 ? messageAgeByIndex[messageIndex] ?? 0 : 9999
    }
  }

  function getUnzippedItem(zip: ZipListItem): UnzippedItem | null {
    const normalized = normalizeId(zip.id)
    return (
      zippingService.getUnzippedInfo(zip.id) ??
      zippingService.getUnzippedInfo(normalized) ??
      zip.unzippedItem ??
      null
    )
  }

  function compareZipRows(left: ZipManagerRow, right: ZipManagerRow) {
    switch (sortMode) {
      case 'manual': {
        const manualDelta = getManualSortWeight(left) - getManualSortWeight(right)
        if (manualDelta !== 0) return manualDelta
        return compareChronological(left, right)
      }
      case 'tokens': {
        const tokenDelta = (right.tokens || 0) - (left.tokens || 0)
        if (tokenDelta !== 0) return tokenDelta
        return compareChronological(left, right)
      }
      case 'newest':
        return compareChronological(right, left)
      case 'chat':
      default:
        return compareChronological(left, right)
    }
  }

  function compareChronological(left: ZipManagerRow, right: ZipManagerRow) {
    const timeDelta = (left.createdAt || 0) - (right.createdAt || 0)
    if (timeDelta !== 0) return timeDelta
    return `${left.toolTitle} ${left.toolSubtitle}`.localeCompare(`${right.toolTitle} ${right.toolSubtitle}`)
  }

  function getManualSortWeight(row: ZipManagerRow) {
    if (row.isPermanent) return 0
    if (row.isManuallyUnzipped || row.manualZip || row.agentControlled) return 1
    return 2
  }

  function resolveRemainingMessages(
    unzippedItem: UnzippedItem | null,
    activation: ReturnType<typeof calculateZipActivation>
  ) {
    if (unzippedItem && !unzippedItem.permanent && typeof unzippedItem.duration === 'number') {
      return Math.max(0, unzippedItem.duration - (unzippedItem.messageCount || 0))
    }

    if (
      !unzippedItem &&
      !activation.shouldCompress &&
      activation.meetsThreshold &&
      activation.bufferSize > 0
    ) {
      return Math.max(1, activation.bufferSize - activation.messagesFromEnd)
    }

    return null
  }

  function buildManagerRow(zip: ZipListItem): ZipManagerRow | null {
    if (!zip?.id) return null

    const normalizedId = normalizeId(zip.id)
    const unzippedItem = getUnzippedItem(zip)
    const isRezipped =
      zippingService.isRezipped(zip.id) ||
      zippingService.isRezipped(normalizedId)
    const rezippedSource =
      zippingService.getRezippedSource(zip.id) ||
      zippingService.getRezippedSource(normalizedId)
    const context = getMessageContext(zip)
    const activation = calculateZipActivation({
      zipType: zip.type || 'all_other',
      messagesFromEnd: context.messagesFromEnd,
      zipData: {
        type: zip.type,
        tokens: zip.tokens,
        metadata: zip.metadata || {},
        name: zip.name,
        content: undefined
      },
      agentSettings: context.agent,
      globalSettings: globalZipSettings,
      toolName: zip.metadata?.toolName || zip.name,
      fallbackTokens: zip.tokens || 0,
      isUnzipped: Boolean(unzippedItem),
      isRezipped
    })
    const isManuallyUnzipped = Boolean(unzippedItem)
    const isUnzippedNow = isManuallyUnzipped || !activation.shouldCompress
    const expandedReason = unzippedItem
      ? unzippedItem.source === 'agent' ? 'agent' : 'user'
      : isUnzippedNow ? 'buffer' : undefined
    const remainingMessages = resolveRemainingMessages(unzippedItem, activation)
    const aboutToZip =
      isUnzippedNow &&
      !unzippedItem &&
      !isRezipped &&
      !activation.autoZip &&
      activation.meetsThreshold &&
      activation.bufferSize > 0 &&
      context.messagesFromEnd === activation.bufferSize - 1
    const agentControlled = unzippedItem?.source === 'agent' || rezippedSource === 'agent'
    const presentation = buildZipStatusPresentation({
      isZipped: !isUnzippedNow,
      isUnzipped: isManuallyUnzipped,
      expandedReason,
      isPermanent: Boolean(unzippedItem?.permanent),
      remainingMessages,
      manualZip: isRezipped,
      autoZip: activation.autoZip,
      agentControlled,
      aboutToZip
    })
    const labelParts = splitZipDescription(zip.description || zip.name || zip.id)
    const toolPresentation = buildToolPresentation(zip, labelParts)

    return {
      ...zip,
      normalizedId,
      title: labelParts.title,
      detail: labelParts.detail,
      isZipped: !isUnzippedNow,
      isUnzippedNow,
      isManuallyUnzipped,
      isPermanent: Boolean(unzippedItem?.permanent),
      remainingMessages,
      expandedReason,
      manualZip: isRezipped,
      autoZip: activation.autoZip,
      agentControlled,
      aboutToZip,
      presentation,
      ...toolPresentation
    }
  }

  function buildToolPresentation(
    zip: ZipListItem,
    labelParts: { title: string; detail: string }
  ): Pick<
    ZipManagerRow,
    'toolTitle' | 'toolSubtitle' | 'toolIcon' | 'toolIconRef' | 'toolStatus'
  > {
    const metadata = zip.metadata || {}
    const toolArgs = toRecord(metadata.toolArgs) ?? toRecord(metadata.toolInput) ?? toRecord(metadata.input) ?? {}
    const toolResult =
      metadata.toolResult ??
      metadata.result ??
      metadata.output ??
      metadata.observation ??
      {}
    const rawToolName =
      firstString(
        metadata.toolName,
        metadata.tool_name,
        metadata.originalToolName,
        metadata.name,
        zip.name
      ) ?? labelParts.title
    const normalized = normalizeCompactTool({
      toolName: rawToolName,
      toolArgs,
      toolResult,
      metadata
    })
    const operationKind = inferOperationKind(zip, labelParts, normalized.operationKind)
    const titleTarget = splitToolTitleTarget(labelParts.title)
    const target =
      titleTarget.target ||
      firstString(
        metadata.artifactName,
        toolArgs.filePath,
        toolArgs.file_path,
        toolArgs.path,
        toolArgs.command,
        toolArgs.query,
        toolArgs.pattern
      ) ||
      ''
    const title = resolveToolTitle(operationKind, titleTarget.title, metadata, normalized.displayToolName)
    const subtitle = resolveToolSubtitle({
      operationKind,
      target,
      detail: labelParts.detail,
      toolArgs,
      toolResult,
      metadata,
      fallbackTitle: titleTarget.title
    })
    const icon = resolveToolIcon(operationKind, target)
    return {
      toolTitle: title,
      toolSubtitle: subtitle,
      toolIcon: icon.icon,
      toolIconRef: icon.iconRef,
      toolStatus: resolveToolStatus(zip, labelParts, toolResult)
    }
  }

  function toRecord(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, any>
      : null
  }

  function firstString(...values: unknown[]) {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
    return undefined
  }

  function splitToolTitleTarget(title: string) {
    const match = title.match(/^(.+?)\s+-\s+(.+)$/)
    if (!match) return { title, target: '' }
    return { title: match[1].trim(), target: match[2].trim() }
  }

  function inferOperationKind(
    zip: ZipListItem,
    labelParts: { title: string; detail: string },
    normalizedOperationKind?: string
  ) {
    if (normalizedOperationKind && normalizedOperationKind !== 'unknown_tool') {
      return normalizedOperationKind
    }

    const haystack = [
      zip.type,
      zip.name,
      zip.description,
      zip.metadata?.operationKind,
      zip.metadata?.rendererFamily,
      zip.metadata?.toolName,
      labelParts.title,
      labelParts.detail
    ].filter(Boolean).join(' ').toLowerCase()

    if (haystack.includes('skill_read') || haystack.includes('skill read')) return 'skill_read'
    if (haystack.includes('read_file') || haystack.includes('read file')) return 'read_file'
    if (haystack.includes('write_file') || haystack.includes('write file') || haystack.includes('overwrite')) return 'write_file'
    if (haystack.includes('edit_file') || haystack.includes('edit file') || haystack.includes('apply patch')) return 'edit_file'
    if (haystack.includes('web_search') || haystack.includes('web search')) return 'web_search'
    if (haystack.includes('search_files') || haystack.includes('search files')) return 'search_files'
    if (haystack.includes('list_files') || haystack.includes('list files')) return 'list_files'
    if (haystack.includes('fetch_zip') || haystack.includes('fetch zip')) return 'fetch_zip'
    if (haystack.includes('dynamic') && haystack.includes('search')) return 'dynamic_find'
    if (haystack.includes('tool search') || haystack.includes('tool_find')) return 'tool_find'
    if (haystack.includes('bash') || haystack.includes('execute_command') || haystack.includes('execute command')) return 'bash'
    return 'unknown_tool'
  }

  function resolveToolTitle(
    operationKind: string,
    fallbackTitle: string,
    metadata: Record<string, any>,
    displayToolName?: string
  ) {
    const rendererTitle = firstString(metadata.rendererTitle)
    if (rendererTitle) return rendererTitle
    if (displayToolName) return displayToolName

    switch (operationKind) {
      case 'read_file':
        return 'Read File'
      case 'skill_read':
        return 'Skill Read'
      case 'write_file':
        return 'Write File'
      case 'edit_file':
        return 'Edit File'
      case 'web_search':
        return 'Web Search'
      case 'search_files':
        return 'Search Files'
      case 'list_files':
        return 'List Files'
      case 'bash':
        return 'Bash'
      case 'fetch_zip':
        return 'Fetch Zip'
      case 'dynamic_find':
      case 'tool_find':
        return 'Dynamic Tool Search'
      default:
        return fallbackTitle || 'Tool'
    }
  }

  function resolveToolSubtitle(options: {
    operationKind: string
    target: string
    detail: string
    toolArgs: Record<string, any>
    toolResult: any
    metadata: Record<string, any>
    fallbackTitle: string
  }) {
    const target = options.target.trim()
    const detail = options.detail.trim()
    const fileName = extractFileName(target)
    const lineCount = firstString(
      options.metadata.lineCount,
      options.toolResult?.lineCount,
      detail.match(/(\d[\d,]*)\s+lines?/i)?.[1]
    )
    const query = firstString(options.toolArgs.query, options.toolArgs.pattern, options.toolResult?.query)
    const command = firstString(options.toolArgs.command, options.toolArgs.cmd, target)

    switch (options.operationKind) {
      case 'read_file':
        return [fileName || target, lineCount ? `${lineCount} lines` : detail].filter(Boolean).join(' • ')
      case 'skill_read':
        return [
          firstString(options.toolResult?.skillName, options.toolArgs.skillName) || fileName || target,
          lineCount ? `${lineCount} lines` : detail
        ].filter(Boolean).join(' • ')
      case 'write_file':
        return [fileName || target, lineCount ? `${lineCount} lines written` : detail].filter(Boolean).join(' • ')
      case 'edit_file':
        return [fileName || target, detail].filter(Boolean).join(' • ')
      case 'web_search':
        return query || target || detail
      case 'search_files':
        return detail || query || target
      case 'list_files':
        return detail && target ? `${detail} in ${target}` : detail || target
      case 'bash':
        return command || detail || 'Shell activity'
      default:
        return target || detail || options.fallbackTitle
    }
  }

  function resolveToolIcon(operationKind: string, target: string): {
    icon: Component
    iconRef: IconRef | null
  } {
    if (operationKind === 'read_file' || operationKind === 'skill_read') {
      const fileName = extractFileName(target) || 'file'
      return {
        icon: FileText,
        iconRef: getProjectTreeIconRef({
          name: fileName,
          type: 'file'
        })
      }
    }
    if (operationKind === 'write_file') return { icon: FileEdit, iconRef: null }
    if (operationKind === 'edit_file') return { icon: Edit3, iconRef: null }
    if (operationKind === 'web_search') return { icon: Globe, iconRef: null }
    if (operationKind === 'search_files' || operationKind === 'dynamic_find' || operationKind === 'tool_find') {
      return { icon: Search, iconRef: null }
    }
    if (operationKind === 'list_files') return { icon: FolderOpen, iconRef: null }
    if (operationKind === 'bash') return { icon: Terminal, iconRef: null }
    return { icon: Wrench, iconRef: null }
  }

  function resolveToolStatus(
    zip: ZipListItem,
    labelParts: { title: string; detail: string },
    toolResult: any
  ): ZipManagerToolStatus {
    const failed =
      zip.metadata?.success === false ||
      zip.metadata?.blocked === true ||
      Boolean(zip.metadata?.error) ||
      (toolResult && typeof toolResult === 'object' && !Array.isArray(toolResult) &&
        (toolResult.success === false || toolResult.blocked === true || Boolean(toolResult.error))) ||
      /\b(?:error|failed|blocked|exit\s+[1-9]\d*)\b/i.test(`${labelParts.title} ${labelParts.detail}`)
    return failed ? 'error' : 'success'
  }

  function extractFileName(value: string) {
    const firstSegment = value.split('•')[0]?.trim() || ''
    const clean = firstSegment.replace(/^["']|["']$/g, '')
    return clean.split(/[\\/]/).filter(Boolean).at(-1) || clean
  }

  function splitZipDescription(value: string) {
    const raw = value.trim()
    const match = raw.match(/^([^:]+):\s*(.+?)(?:\s+-\s+(.+))?$/)
    if (!match) {
      return { title: raw, detail: '' }
    }

    const label = formatZipLabel(match[1])
    const target = match[2]?.trim() || ''
    const detail = match[3]?.trim() || ''

    return {
      title: target ? `${label} - ${target}` : label,
      detail
    }
  }

  function formatZipLabel(value: string) {
    return value
      .replace(/^batshit_server_/, '')
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ')
  }

  function formatTokens(tokens: number) {
    return `${Math.max(0, Math.round(tokens || 0)).toLocaleString()} tokens`
  }

  function emptyCopy() {
    if (filter === 'zipped') return 'No zipped items in this session yet.'
    if (filter === 'all') return 'No zip items in this session yet.'
    return 'Nothing is unzipped right now.'
  }

  onMount(() => {
    syncUnzippedItems()
    window.addEventListener('batshit:zip-state-changed', handleZipStateChanged)
    window.addEventListener('checkZipActivity', handleZipActivity)

    return () => {
      window.removeEventListener('batshit:zip-state-changed', handleZipStateChanged)
      window.removeEventListener('checkZipActivity', handleZipActivity)
    }
  })
</script>

<DropdownMenu.Root onOpenChange={handleOpenChange}>
  <DropdownMenu.Trigger
    class="zips-manager-trigger"
    aria-label="Manage zips"
    title="Manage zips"
    data-testid="manage-zips-button"
    data-ab-control="manage-zips"
  >
    <BatshitIcon id="zip" class="zips-manager-trigger-icon" />
    {#if triggerManualUnzippedCount > 0}
      <Badge class="zips-manager-count-badge" variant="secondary">
        {triggerManualUnzippedCount}
      </Badge>
    {/if}
    <span class="zips-manager-screen-reader">Manage zips</span>
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="end" class="zips-manager-content">
    <div class="zips-manager-header">
      <div class="zips-manager-header-row">
        <div class="zips-manager-heading">
          <div class="zips-manager-title">Zip Manager</div>
        </div>
        {#if unzippedRows.length > 0}
          <Button
            variant="outline"
            size="xs"
            class="zips-manager-clear-button"
            onclick={clearAll}
          >
            Zip all unzipped
          </Button>
        {/if}
      </div>

      <div class="zips-manager-meta-row">
        <div class="zips-manager-stats" aria-label="Zip session stats">
          <div class="zips-manager-stat">
            <span>{unzippedRows.length}</span> unzipped
          </div>
          <div class="zips-manager-stat">
            <span>{formatTokens(unzippedTokenTotal)}</span>
          </div>
          <div class="zips-manager-stat">
            <span>{permanentCount}</span> always
          </div>
          <div class="zips-manager-stat">
            <span>{temporaryCount}</span> countdown
          </div>
        </div>

        <div class="zips-manager-sort">
          <Select.Root
            type="single"
            value={sortMode}
            onValueChange={handleSortChange}
          >
            <Select.Trigger
              size="sm"
              class="zips-manager-sort-trigger"
              aria-label="Sort zip items"
            >
              {sortLabel}
            </Select.Trigger>
            <Select.Content class="zips-manager-sort-content">
              {#each sortOptions as option}
                <Select.Item value={option.value}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      <div class="zips-manager-filter" role="tablist" aria-label="Zip item filter">
        <button
          type="button"
          role="tab"
          class:active={filter === 'unzipped'}
          aria-selected={filter === 'unzipped'}
          onclick={() => filter = 'unzipped'}
        >
          <span>Unzipped</span>
          <strong>{unzippedRows.length}</strong>
        </button>
        <button
          type="button"
          role="tab"
          class:active={filter === 'zipped'}
          aria-selected={filter === 'zipped'}
          onclick={() => filter = 'zipped'}
        >
          <span>Zipped</span>
          <strong>{zippedRows.length}</strong>
        </button>
        <button
          type="button"
          role="tab"
          class:active={filter === 'all'}
          aria-selected={filter === 'all'}
          onclick={() => filter = 'all'}
        >
          <span>All</span>
          <strong>{rows.length}</strong>
        </button>
      </div>
    </div>

    {#if loadError}
      <div class="zips-manager-empty">
        <div class="zips-manager-empty-title">{loadError}</div>
      </div>
    {:else if isLoading && rows.length === 0}
      <div class="zips-manager-empty">
        <div class="zips-manager-empty-title">Loading zip items...</div>
      </div>
    {:else if displayRows.length === 0}
      <div class="zips-manager-empty">
        <div class="zips-manager-empty-title">{emptyCopy()}</div>
      </div>
    {:else}
      <div class="zips-manager-list">
        {#each displayRows as row (row.id)}
          <div
            class="zips-manager-row"
            class:is-zipped={row.isZipped}
            class:is-unzipped={row.isUnzippedNow}
            role="button"
            tabindex="0"
            aria-label={`Locate ${row.toolTitle} in chat`}
            title={`Locate ${row.toolTitle} in chat`}
            onclick={(event) => handleRowClick(event, row)}
            onkeydown={(event) => handleRowKeydown(event, row)}
          >
            <div class="zips-manager-tool-shell">
              <ZipbatshitWrapper
                isZipped={row.isZipped}
                zipId={row.normalizedId}
                tokens={row.tokens}
                isUnzipped={row.isManuallyUnzipped}
                expandedReason={row.expandedReason}
                isPermanent={row.isPermanent}
                remainingMessages={row.remainingMessages}
                aboutToZip={row.aboutToZip}
                autoZip={row.autoZip}
                agentControlled={row.agentControlled}
                manualZip={row.manualZip}
                onToggleUnzip={(permanent: boolean) => handleUnzip(row, permanent)}
                onZipNow={() => handleZip(row)}
                onReturnAutomatic={() => handleReturnAutomatic(row)}
                name={row.toolTitle}
                description={row.description || row.toolSubtitle || row.toolTitle}
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
                <FullTool
                  icon={row.toolIcon}
                  iconRef={row.toolIconRef}
                  title={row.toolTitle}
                  subtitle={row.toolSubtitle}
                  status={row.toolStatus}
                  interactive={false}
                />
              </ZipbatshitWrapper>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.zips-manager-trigger) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 30px;
    padding: 0 0.5rem;
    border-radius: 0 0.375rem 0.375rem 0;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 500;
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      opacity 150ms ease-out;
  }

  :global(.zips-manager-trigger:hover) {
    background: var(--accent);
    color: var(--accent-foreground);
  }

  :global(.zips-manager-trigger:focus-visible) {
    outline: none;
  }

  :global(.zips-manager-trigger-icon) {
    width: 16px;
    height: 16px;
  }

  :global(.zips-manager-count-badge) {
    position: absolute;
    top: -4px;
    right: -7px;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 16px;
    height: 16px;
    width: auto;
    padding: 0 0.2rem;
    border: 1px solid oklch(0.94 0.006 289.95 / 0.18);
    border-radius: 999px;
    background: var(--bs-app-count-badge-bg);
    box-shadow: 0 0 0 1px oklch(0.02 0.004 280 / 0.28);
    color: var(--bs-app-title);
    font-size: 0.58rem;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    white-space: nowrap;
  }

  :global(.zips-manager-content) {
    width: min(37.5rem, calc(100vw - 1.5rem));
    max-width: calc(100vw - 1.5rem);
  }

  .zips-manager-header {
    padding: 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .zips-manager-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .zips-manager-heading {
    min-width: 0;
  }

  .zips-manager-title,
  .zips-manager-empty-title,
  .zips-manager-stat span {
    color: var(--foreground);
    font-weight: 500;
  }

  .zips-manager-title {
    font-size: 0.875rem;
    font-weight: 600;
  }

  :global(.zips-manager-clear-button) {
    height: 1.55rem;
    padding: 0 0.55rem;
    border-color: color-mix(in oklab, var(--foreground) 18%, var(--border));
    background: color-mix(in oklab, var(--muted) 34%, transparent);
    color: var(--foreground);
    font-size: 0.67rem;
    font-weight: 500;
  }

  :global(.zips-manager-clear-button:hover) {
    border-color: color-mix(in oklab, var(--foreground) 28%, var(--border));
    background: var(--bs-app-field);
  }

  .zips-manager-meta-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.65rem;
  }

  .zips-manager-stats {
    display: flex;
    flex-wrap: wrap;
    flex: 1 1 auto;
    gap: 0.5rem;
    min-width: 0;
  }

  .zips-manager-stat {
    padding: 0.22rem 0.48rem;
    border: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
    border-radius: 0.375rem;
    background: color-mix(in oklab, var(--muted) 28%, transparent);
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    line-height: 1;
  }

  .zips-manager-sort {
    flex: 0 0 auto;
    margin-left: auto;
  }

  .zips-manager-sort :global(.zips-manager-sort-trigger) {
    width: 7.9rem;
    height: 1.55rem;
    min-height: 0;
    padding: 0 0.45rem;
    border-color: color-mix(in oklab, var(--border) 68%, transparent);
    border-radius: 0.4rem;
    background: color-mix(in oklab, var(--muted) 24%, transparent);
    color: var(--muted-foreground);
    font-size: 0.67rem;
    line-height: 1;
  }

  .zips-manager-sort :global(.zips-manager-sort-trigger:hover),
  .zips-manager-sort :global(.zips-manager-sort-trigger:focus-visible) {
    border-color: color-mix(in oklab, var(--foreground) 20%, var(--border));
    background: var(--bs-app-field);
    color: var(--foreground);
  }

  :global(.zips-manager-sort-content) {
    min-width: 8rem;
  }

  .zips-manager-filter {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.25rem;
    margin-top: 0.65rem;
    padding: 0.2rem;
    border: 1px solid color-mix(in oklab, var(--border) 62%, transparent);
    border-radius: 0.5rem;
    background: oklch(0.08 0.012 278 / 0.72);
  }

  .zips-manager-filter button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    min-width: 0;
    height: 1.75rem;
    border: 1px solid transparent;
    border-radius: 0.375rem;
    background: transparent;
    color: var(--muted-foreground);
    font-size: 0.72rem;
    line-height: 1;
    cursor: pointer;
    transition:
      background-color 150ms ease-out,
      border-color 150ms ease-out,
      color 150ms ease-out;
  }

  .zips-manager-filter button:hover,
  .zips-manager-filter button.active {
    border-color: color-mix(in oklab, var(--foreground) 14%, transparent);
    background: var(--bs-app-field);
    color: var(--foreground);
  }

  .zips-manager-filter strong {
    color: inherit;
    font-size: 0.66rem;
    font-weight: 500;
    opacity: 0.78;
  }

  .zips-manager-empty {
    padding: 2rem 0.75rem;
    text-align: center;
  }

  .zips-manager-empty-title {
    font-size: 0.875rem;
  }

  .zips-manager-list {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: min(28rem, calc(100vh - 16rem));
    overflow-y: auto;
    padding: 0.5rem 0.45rem;
  }

  .zips-manager-row {
    display: block;
    min-width: 0;
    border-radius: 0.45rem;
    cursor: pointer;
  }

  .zips-manager-tool-shell {
    min-width: 0;
  }

  .zips-manager-tool-shell :global(.batshit-zip-wrapper) {
    margin: 0;
  }

  .zips-manager-tool-shell :global(.full-tool) {
    margin: 0;
  }

  .zips-manager-row:focus-visible {
    outline: none;
  }

  .zips-manager-row:focus-visible :global(.batshit-zip-wrapper) {
    outline: 1px dotted color-mix(in oklab, var(--foreground) 36%, transparent);
    outline-offset: 2px;
  }

  .zips-manager-screen-reader {
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
