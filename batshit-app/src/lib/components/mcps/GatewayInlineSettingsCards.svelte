<script lang="ts">
  import type { MCPGateway, MCPGatewayEnvRef, MCPToolGrouping } from '$lib/types/database'
  import { onMount, untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import { DEFAULT_MCP_GATEWAY_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { parseIconRef, type IconRef } from '$lib/icons/iconTypes'
  import { AlertCircle, FolderTree, Loader2, Plus, Settings2, Trash2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import MCPToolGroupingEditor from './MCPToolGroupingEditor.svelte'
  // BL-1370, BL-1393: the saves on their way, the unknown outcomes and the owned reads belong to a
  // module shared by every card and the panel: the panel unmounts the card when the Tools tab
  // changes or Settings closes, and its saves and reads go on.
  import {
    asSentence,
    classifySaveFailure,
    clearOutcomeUnknown,
    failureConfirmsGatewaySaved,
    gatewayLockReason,
    gatewayReadFailure,
    markOutcomeUnknown,
    requestGatewayRead,
    savesOnTheirWay,
    settleSave,
    startSave,
    subscribeGatewaySaveEvents,
    type GatewayLockReason,
    type GatewaySaveEvent,
    type GatewaySaveSection
  } from './gatewaySaveState'

  const INFRA_KEYS = new Set([
    'batshit_token',
    'n8n_internal_key',
    'n8n_api_key',
    'n8n_api_url',
    'batshit_artifact_complete_url',
    'n8n_instance_mcp_token',
    'ai_gateway',
    'browserbase_project_id',
    'browserbase_api_url',
    'browseruse_base_url',
    'kernel_base_url'
  ])

  type SaveState = 'idle' | 'saving' | 'saved' | 'error'
  type EnvRefRow = MCPGatewayEnvRef & { id: string }
  // BL-1369: a save is captured whole when it is queued, for the gateway the form holds: the
  // request, the baseline it sets when it lands, and the fill it was typed into. Sending it reads
  // nothing live, so a pick of another gateway can send it at once.
  interface CapturedSave {
    gatewayId: string
    gatewayName: string
    url: string
    body: string
    signature: string
    fillCount: number
  }
  // One per card section (Gateway Settings, MCP Groups): the one queued save and its timer, and
  // the gateway the form was filled for while that gateway's own save was on its way, or while a
  // failed save of it may have been stored (BL-1370, BL-1393: the section is read-only until those
  // saves answer and a read of the saved gateway succeeds). Then, for the form this card holds
  // (BL-1393): the order the newest save was sent in and the newest save whose answer reached the
  // form (an older answer moves nothing of it), the failed save that only a change may send again,
  // and whether a failed save may have been stored, so no value of the form counts as saved. Read
  // only by the hydration effect, the savers and the edit guards, never tracked.
  interface SaveLane {
    section: GatewaySaveSection
    queued: CapturedSave | null
    timer: ReturnType<typeof setTimeout> | null
    lockedFor: string | null
    lastSentAt: number
    answeredAt: number
    failedSignature: string | null
    baselineUnknown: boolean
  }

  interface Props {
    gateway: MCPGateway
    userId?: string | null
    onGatewayUpdated?: (gateway: MCPGateway) => void
  }

  let { gateway, userId = null, onGatewayUpdated = () => {} }: Props = $props()

  let hydrating = $state(false)
  let name = $state('')
  let url = $state('')
  let authKeyName = $state('')
  let availableApiKeys = $state<string[]>([])
  let loadingApiKeys = $state(false)
  let availableTools = $state<string[]>([])
  let availableToolMetadata = $state<Record<string, { mcpName?: string }>>({})
  let loadingTools = $state(false)
  let toolGroupings = $state<MCPToolGrouping[]>([])
  let iconRef = $state<IconRef>(DEFAULT_MCP_GATEWAY_ICON_REF)
  let command = $state('')
  let argsText = $state('')
  let cwdPolicy = $state<'none' | 'project' | 'fixed'>('none')
  let cwdValue = $state('')
  let startupTimeoutMs = $state('10000')
  let toolCallTimeoutMs = $state('60000')
  let envRefs = $state<EnvRefRow[]>([])
  let dockerProfile = $state('default')

  let settingsSaveState = $state<SaveState>('idle')
  let settingsSaveError = $state<string | null>(null)
  let groupingSaveState = $state<SaveState>('idle')
  let groupingSaveError = $state<string | null>(null)
  let persistedSettingsSignature = $state('')
  let persistedGroupingSignature = $state('')
  let groupInputOpen = $state(false)
  let hydratedGatewayId = $state<string | null>(null)
  // BL-1370, BL-1393: what the template shows of each lane's lock (and the read failure behind a
  // Retry); never read by an autosave effect.
  let settingsLockNote = $state<GatewayLockReason | null>(null)
  let groupingLockNote = $state<GatewayLockReason | null>(null)
  let readFailureMessage = $state<string | null>(null)
  const settingsLockedUi = $derived(settingsLockNote !== null)
  const groupingLockedUi = $derived(groupingLockNote !== null)
  // BL-550: per card section, its save lane and a count of the times the hydration effect filled
  // its fields; plus the `updated_at` of the newest copy of this gateway the form has taken. Read
  // only by the hydration effect and the savers, never tracked, so they are plain variables.
  const newLane = (section: GatewaySaveSection): SaveLane => ({
    section,
    queued: null,
    timer: null,
    lockedFor: null,
    lastSentAt: 0,
    answeredAt: 0,
    failedSignature: null,
    baselineUnknown: false
  })
  const settingsLane = newLane('settings')
  const groupingLane = newLane('grouping')
  let settingsFillCount = 0
  let groupingFillCount = 0
  let formCopyUpdatedAt: string | null = null
  // This card's identity in the answers every card hears, and whether it is still mounted (a
  // save that answers after its card went away is never that card's form).
  const card = {}
  let mounted = true
  // Only the newest tool list request writes (a late answer for a gateway picked away from
  // never fills another gateway's MCP Groups editor).
  let toolsRequest = 0

  const groupingGatewayTypes = new Set([
    'n8n-mcp-trigger',
    'n8n-instance-mcp',
    'docker-catalog',
    'custom',
    'stdio'
  ])

  const supportsGrouping = $derived(groupingGatewayTypes.has(gateway.type))
  const isReadOnly = $derived(gateway.type === 'n8n-mcp-client')
  const isRuntimeManagedDockerUrl = $derived(
    gateway.type === 'docker-catalog' && gateway.metadata?.runtimeManagedUrl === true
  )
  const isRuntimeManagedDockerProfile = $derived(
    gateway.type === 'docker-catalog' && gateway.metadata?.runtimeManagedProfile === true
  )
  const dockerRuntimeManagedReason = $derived(
    gateway.metadata?.runtimeManagedUrlReason === 'mac-app-docker-gateway' ? 'mac' : 'docker'
  )
  const dockerProfilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

  function createEnvRefRow(value?: Partial<MCPGatewayEnvRef>): EnvRefRow {
    return {
      id: crypto.randomUUID(),
      envVar: value?.envVar ?? '',
      savedKeyRef: value?.savedKeyRef ?? ''
    }
  }

  function parseArgsInput(value: string) {
    return value
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  function normalizeEnvRefs(value: EnvRefRow[]): MCPGatewayEnvRef[] {
    return value
      .map((entry) => ({
        envVar: entry.envVar.trim(),
        savedKeyRef: entry.savedKeyRef.trim()
      }))
      .filter((entry) => entry.envVar.length > 0 || entry.savedKeyRef.length > 0)
  }

  function sanitizeToolGroupingsInput(value: unknown): MCPToolGrouping[] {
    if (!Array.isArray(value)) return []

    const normalized: MCPToolGrouping[] = []
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const rawName = (entry as Record<string, unknown>).mcpName
      const mcpName = typeof rawName === 'string' ? rawName.trim() : ''
      if (!mcpName) continue

      const rawToolIds = (entry as Record<string, unknown>).toolIds
      const toolIds = Array.isArray(rawToolIds)
        ? Array.from(
            new Set(
              rawToolIds
                .map((toolId) => (typeof toolId === 'string' ? toolId.trim() : ''))
                .filter((toolId) => toolId.length > 0)
            )
          )
        : []

      const raw = entry as Record<string, unknown>
      const rawIconRef = Object.prototype.hasOwnProperty.call(raw, 'icon_ref')
        ? raw.icon_ref
        : raw.iconRef
      const grouping: MCPToolGrouping = { mcpName, toolIds }
      if (rawIconRef !== undefined) {
        grouping.icon_ref = rawIconRef === null ? null : parseIconRef(rawIconRef)
      }

      normalized.push(grouping)
    }

    return normalized
  }

  function formatKeyLabel(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
  }

  function normalizeDockerProfileInput(value: string) {
    return value.trim() || 'default'
  }

  function isValidDockerProfile(value: string) {
    return dockerProfilePattern.test(normalizeDockerProfileInput(value))
  }

  function getDockerProfileFromGateway(source: MCPGateway) {
    const metadata = source.metadata && typeof source.metadata === 'object'
      ? source.metadata
      : {}
    const raw = metadata.dockerProfile ?? metadata.docker_profile
    return typeof raw === 'string' && raw.trim() ? raw.trim() : 'default'
  }

  async function loadApiKeys() {
    loadingApiKeys = true
    try {
      const response = await fetch('/api/settings/api-keys')
      if (!response.ok) return
      const data = await response.json()
      if (data.success && data.keys) {
        availableApiKeys = Object.entries(data.keys)
          .filter(([key, info]: [string, any]) => info.status === 'ready' && !INFRA_KEYS.has(key))
          .map(([key]) => key)
          .sort()
      }
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error loading API keys:', error)
    } finally {
      loadingApiKeys = false
    }
  }

  async function loadToolsForGateway(gatewayId: string) {
    if (!userId || !supportsGrouping) return

    const request = ++toolsRequest
    loadingTools = true
    try {
      const response = await fetch(`/api/mcp/gateways/${gatewayId}/tools?userId=${userId}`)
      if (!response.ok) throw new Error('Failed to load tools')

      const data = await response.json()
      if (request !== toolsRequest) return
      const mcps = Array.isArray(data?.mcps) ? data.mcps : []
      const allTools: string[] = []
      const metadata: Record<string, { mcpName?: string }> = {}
      for (const mcp of mcps) {
        for (const tool of mcp.tools) {
          allTools.push(tool.id)
          metadata[tool.id] = { mcpName: tool.mcpName || mcp.name }
        }
      }

      availableTools = allTools
      availableToolMetadata = metadata
    } catch (error) {
      if (request !== toolsRequest) return
      console.error('[GatewayInlineSettingsCards] Error loading tools:', error)
      toast.error('Failed to load tools from gateway')
    } finally {
      if (request === toolsRequest) loadingTools = false
    }
  }

  function makeSettingsSignature() {
    return JSON.stringify({
      name: name.trim(),
      iconRef,
      url: url.trim(),
      authKeyName,
      command: command.trim(),
      args: parseArgsInput(argsText),
      cwdPolicy,
      cwdValue: cwdValue.trim(),
      startupTimeoutMs: Number(startupTimeoutMs) || 10000,
      toolCallTimeoutMs: Number(toolCallTimeoutMs) || 60000,
      envRefs: normalizeEnvRefs(envRefs),
      dockerProfile: gateway.type === 'docker-catalog'
        ? normalizeDockerProfileInput(dockerProfile)
        : undefined
    })
  }

  function makeGroupingSignature() {
    return JSON.stringify(sanitizeToolGroupingsInput(toolGroupings))
  }

  const isValid = $derived.by(() => {
    if (!name.trim()) return false
    if (gateway.type === 'stdio') {
      if (!command.trim()) return false
      if (cwdPolicy === 'fixed' && !cwdValue.trim()) return false
      for (const entry of normalizeEnvRefs(envRefs)) {
        if (!entry.envVar || !entry.savedKeyRef) return false
      }
      return true
    }

    if (gateway.type === 'n8n-mcp-client') return true
    if (
      gateway.type === 'docker-catalog' &&
      !isRuntimeManagedDockerProfile &&
      !isValidDockerProfile(dockerProfile)
    ) return false
    if (!url.trim()) return false
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  })

  /**
   * True when the incoming copy was written before the newest one the form took. Every gateway
   * update stamps `updated_at`, so once the form holds a stamped copy, a copy without one is older.
   */
  function isOlderCopy(incoming: string | undefined, current: string | null) {
    if (!current) return false
    if (!incoming) return true
    const incomingAt = Date.parse(incoming)
    const currentAt = Date.parse(current)
    return Number.isFinite(incomingAt) && Number.isFinite(currentAt) && incomingAt < currentAt
  }

  function flightsOf(lane: SaveLane, gatewayId: string) {
    return savesOnTheirWay(lane.section, gatewayId)
  }

  /** The form's baseline, or null while a failed save of it may have been stored (BL-1393). */
  function baselineOf(lane: SaveLane, persistedSignature: string) {
    return lane.baselineUnknown ? null : persistedSignature
  }

  /**
   * BL-1393: a failed save. Only a 409 or 401 proves nothing was stored; any other failure (a 500
   * after the CLI profile sync or the read-back failed, no answer at all) may follow a stored
   * write, so the saved gateway is read, and a form filled for it stays read-only until that read
   * succeeds. It is never called a canceled write. The form it was typed into keeps its draft and
   * gets the error (returned); only a change of that form sends it again, never a new copy, a read
   * or a settled save, while the form still holds what failed and no newer save of it is queued or
   * was sent since. Any other form gets a notice that names the gateway (null is returned).
   * BL-1410: when the answer vouches that the record was stored (`recordSaved`, from its fields,
   * never its text), the "may have been saved" hedge is left out; the read still settles the rest.
   */
  function failSave(
    lane: SaveLane,
    save: CapturedSave,
    sentAt: number,
    status: number | null,
    message: string,
    recordSaved: boolean,
    own: boolean,
    live: () => string
  ) {
    const unknown = classifySaveFailure(status) === 'unknown'
    if (unknown) markOutcomeUnknown(lane.section, save.gatewayId)
    let ownError: string | null = null
    if (own) {
      lane.answeredAt = sentAt
      lane.failedSignature =
        live() === save.signature && lane.queued === null && lane.lastSentAt === sentAt ? save.signature : null
      if (unknown) lane.baselineUnknown = true
      ownError = !unknown
        ? message
        : recordSaved
          ? asSentence(message)
          : `${asSentence(message)} The change may have been saved.`
    } else {
      const what = lane.section === 'settings' ? 'Gateway Settings' : 'MCP Groups'
      toast.error(
        !unknown
          ? `Could not save ${what} for "${save.gatewayName}": ${message}`
          : recordSaved
            ? `${what} for "${save.gatewayName}": ${asSentence(message)} Batshit is reading the saved gateway.`
            : `Could not confirm the ${what} save for "${save.gatewayName}": ${asSentence(message)} Batshit is reading the saved gateway.`
      )
    }
    if (unknown) void requestGatewayRead(userId, save.gatewayId)
    return ownError
  }

  /** Drops the queued save without sending it; true when there was one. */
  function dropQueued(lane: SaveLane) {
    if (lane.timer) clearTimeout(lane.timer)
    lane.timer = null
    const dropped = lane.queued !== null
    lane.queued = null
    return dropped
  }

  function sendQueued(lane: SaveLane, send: (save: CapturedSave) => Promise<void>) {
    const save = lane.queued
    dropQueued(lane)
    if (save) void send(save)
  }

  /** The 600 ms autosave debounce: a newer capture replaces the queued one and waits again. */
  function queueSave(lane: SaveLane, save: CapturedSave, send: (save: CapturedSave) => Promise<void>) {
    dropQueued(lane)
    lane.queued = save
    lane.timer = setTimeout(() => sendQueued(lane, send), 600)
  }

  /**
   * Locks a section for the gateway its form was filled for while a reason holds, or opens it.
   * BL-1393: while a failed save may have been stored, the section waits for a read of the saved
   * gateway (one on its way is joined); after that read failed, only Retry asks again.
   */
  function setLock(lane: SaveLane, gatewayId: string) {
    const reason = gatewayLockReason(lane.section, gatewayId)
    lane.lockedFor = reason === null ? null : gatewayId
    if (lane.section === 'settings') settingsLockNote = reason
    else groupingLockNote = reason
    if (reason === 'read-failed') readFailureMessage = gatewayReadFailure(gatewayId)
    if (reason === 'reading') void requestGatewayRead(userId, gatewayId)
  }

  function retryGatewayRead() {
    const gatewayId = settingsLane.lockedFor ?? groupingLane.lockedFor
    if (!gatewayId) return
    void requestGatewayRead(userId, gatewayId)
    for (const lane of [settingsLane, groupingLane]) {
      if (lane.lockedFor === gatewayId) setLock(lane, gatewayId)
    }
  }

  // BL-1370: a section read-only for that gateway takes a copy that landed from another card (one
  // unmounted since: its panel may be gone), and opens once the gateway has no save of that
  // section on its way and (BL-1393) no failed save of it that may have been stored, which a read
  // of the saved gateway settles. Never on a timer. The panel installs a read's copy itself.
  function hearSaveEvent(event: GatewaySaveEvent) {
    if (event.kind === 'save-settled') {
      const lane = event.section === 'settings' ? settingsLane : groupingLane
      if (lane.lockedFor !== event.gatewayId) return
      // The panel hears the copy first: when it cannot order it, it marks the gateway unknown
      // before this lock is checked (a panel opened since the save was sent never heard of it).
      try {
        if (event.landed && event.from !== card) onGatewayUpdated(event.landed)
      } finally {
        setLock(lane, event.gatewayId)
      }
      return
    }
    for (const lane of [settingsLane, groupingLane]) {
      if (lane.lockedFor === event.gatewayId) setLock(lane, event.gatewayId)
    }
  }

  onMount(() => {
    const unsubscribe = subscribeGatewaySaveEvents(hearSaveEvent)
    return () => {
      // A card that goes away sends its queued saves at once (BL-1369), so a card mounted next
      // sees them on their way; a failure then shows a notice that names the gateway.
      mounted = false
      unsubscribe()
      sendQueued(settingsLane, sendSettingsSave)
      sendQueued(groupingLane, sendGroupingSave)
    }
  })

  // BL-1370: the guards for controls a disabled fieldset does not reach (Select and IconPicker
  // content is portalled out of it; the editor's and env ref handlers are guarded as well).
  const settingsEditable = () => settingsLane.lockedFor === null
  const groupingEditable = () => groupingLane.lockedFor === null

  $effect(() => {
    hydrating = true
    untrack(() => {
      const gatewayChanged = hydratedGatewayId !== gateway.id
      // BL-1369: a pick of another gateway sends the saves queued for the gateway the form held
      // at once, as they were captured, before the fields are filled again.
      if (gatewayChanged) {
        sendQueued(settingsLane, sendSettingsSave)
        sendQueued(groupingLane, sendGroupingSave)
      }
      // BL-550: a new copy of the gateway this form already holds (a Refresh reloads the list, a
      // save answers) replaces a card's fields only while they equal its baseline and no save of
      // that card is queued or on its way (the BL-942 rule), and never with a copy older than the
      // one the form last took (a list read that started before this form's save landed). Before,
      // a Refresh that ended while an argument edit waited in the debounce put the old argument
      // back in the form, and the debounced save then sent it. BL-1370: a section that is
      // read-only for this gateway holds no edit, so any copy that is not older fills it.
      // BL-1393: a form whose failed save may have been stored has no known baseline, so a read
      // of the saved gateway never takes its draft back.
      const olderCopy = !gatewayChanged && isOlderCopy(gateway.updated_at, formCopyUpdatedAt)
      const keepSettings =
        !gatewayChanged &&
        (olderCopy ||
          (settingsLane.lockedFor !== gateway.id &&
            (settingsLane.queued !== null ||
              flightsOf(settingsLane, gateway.id) > 0 ||
              makeSettingsSignature() !== baselineOf(settingsLane, persistedSettingsSignature))))
      const keepGrouping =
        !gatewayChanged &&
        (olderCopy ||
          (groupingLane.lockedFor !== gateway.id &&
            (groupingLane.queued !== null ||
              flightsOf(groupingLane, gateway.id) > 0 ||
              makeGroupingSignature() !== baselineOf(groupingLane, persistedGroupingSignature))))

      if (!keepSettings) {
        name = gateway.name
        iconRef = normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF)
        url = gateway.url || ''
        authKeyName = gateway.authKeyName || ''
        command = gateway.stdioConfig?.command || ''
        argsText = Array.isArray(gateway.stdioConfig?.args) ? gateway.stdioConfig.args.join('\n') : ''
        cwdPolicy = gateway.stdioConfig?.cwdPolicy || 'none'
        cwdValue = gateway.stdioConfig?.cwdValue || ''
        startupTimeoutMs = String(gateway.stdioConfig?.startupTimeoutMs ?? 10000)
        toolCallTimeoutMs = String(gateway.stdioConfig?.toolCallTimeoutMs ?? 60000)
        dockerProfile = getDockerProfileFromGateway(gateway)
        envRefs = Array.isArray(gateway.stdioConfig?.envRefs)
          ? gateway.stdioConfig.envRefs.map((entry) => createEnvRefRow(entry))
          : []
        persistedSettingsSignature = makeSettingsSignature()
        settingsFillCount += 1
        settingsLane.failedSignature = null
        settingsLane.baselineUnknown = false
      }
      if (!keepGrouping) {
        toolGroupings = sanitizeToolGroupingsInput(gateway.toolGroupings)
        persistedGroupingSignature = makeGroupingSignature()
        groupingFillCount += 1
        groupingLane.failedSignature = null
        groupingLane.baselineUnknown = false
      }
      if (gatewayChanged) {
        formCopyUpdatedAt = gateway.updated_at ?? null
      } else if (!olderCopy && gateway.updated_at) {
        formCopyUpdatedAt = gateway.updated_at
      }

      if (gatewayChanged) {
        // BL-1370: a gateway picked back while its own save is on its way was just filled from the
        // panel's copy from before that save; its section is read-only until the save answers.
        // BL-1393: so is a gateway whose failed save may have been stored, until a read of the
        // saved gateway succeeds.
        setLock(settingsLane, gateway.id)
        setLock(groupingLane, gateway.id)
        settingsSaveState = 'idle'
        settingsSaveError = null
        groupingSaveState = 'idle'
        groupingSaveError = null
        groupInputOpen = false
      }

      hydratedGatewayId = gateway.id
    })
    hydrating = false

    if (gateway.type === 'custom' || gateway.type === 'stdio') {
      void loadApiKeys()
    }
    if (supportsGrouping && userId) {
      void loadToolsForGateway(gateway.id)
    } else {
      toolsRequest += 1
      loadingTools = false
      availableTools = []
      availableToolMetadata = {}
    }
  })

  /** The save of the form as it is now, for the gateway it holds (the autosave effect checked). */
  function captureSettingsSave(signature: string): CapturedSave {
    // The STDIO check result (lastTestStatus, lastTestAt, lastError, toolCount) is not sent: it
    // belongs to Refresh and Test, and the server keeps the stored one (BL-550).
    const payload =
      gateway.type === 'stdio'
        ? {
            name: name.trim(),
            icon_ref: iconRef,
            url: undefined,
            stdioConfig: {
              command: command.trim(),
              args: parseArgsInput(argsText),
              cwdPolicy,
              ...(cwdPolicy === 'fixed' && cwdValue.trim() ? { cwdValue: cwdValue.trim() } : {}),
              envRefs: normalizeEnvRefs(envRefs),
              startupTimeoutMs: Number(startupTimeoutMs) || 10000,
              toolCallTimeoutMs: Number(toolCallTimeoutMs) || 60000
            }
          }
        : {
            name: name.trim(),
            icon_ref: iconRef,
            // BL-1377: only what this form owns. A runtime-managed URL is the runtime's (its field is
            // read-only and shows the runtime address), so it is not sent; the stored URL stays.
            ...(isRuntimeManagedDockerUrl ? {} : { url: url.trim() }),
            ...(gateway.type === 'custom' ? { authKeyName: authKeyName || undefined } : {}),
            // The browser copy of `metadata` is never sent back (it carries runtime presentation
            // fields and other writers' keys; the server merges onto the stored metadata). A Docker
            // profile this form manages is sent with every settings save, the same one included, so
            // the next edit rewrites a profile file that failed (BL-1386); a runtime-managed one is
            // not this form's, so nothing of `metadata` is sent and the containerized check never runs.
            ...(gateway.type === 'docker-catalog' && !isRuntimeManagedDockerProfile
              ? { metadata: { dockerProfile: normalizeDockerProfileInput(dockerProfile) } }
              : {})
          }

    return {
      gatewayId: gateway.id,
      gatewayName: gateway.name,
      url: `/api/mcp/gateways/${gateway.id}?userId=${userId}`,
      body: JSON.stringify(payload),
      signature,
      fillCount: settingsFillCount
    }
  }

  async function sendSettingsSave(save: CapturedSave) {
    const sentAt = startSave('settings', save.gatewayId)
    settingsLane.lastSentAt = sentAt
    // BL-550, BL-1369: a landing changes the status, the error and the baseline only of the form it
    // was typed into: this card still mounted, the gateway shown, not filled again since, and
    // (BL-1393) no newer save of that form answered already. A pick of another gateway, even this
    // one picked back, makes it someone else's: a failure is then a notice that names the
    // gateway, and a success only reaches the panel.
    const ownForm = () =>
      mounted &&
      save.gatewayId === hydratedGatewayId &&
      save.fillCount === settingsFillCount &&
      sentAt > settingsLane.answeredAt
    let landed: MCPGateway | null = null
    let status: number | null = null
    let recordSaved = false
    try {
      const response = await fetch(save.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: save.body
      })
      status = response.status
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        recordSaved = failureConfirmsGatewaySaved(body, save.gatewayId)
        throw new Error(body.error || 'Failed to update gateway')
      }

      clearOutcomeUnknown('settings', save.gatewayId, sentAt)
      const updatedGateway = (body.gateway ?? null) as MCPGateway | null
      // Stored, but with no copy (the route answers null for a gateway deleted after the write): a
      // form filled for it waits for a read of the saved gateway, as after an unknown outcome.
      if (!updatedGateway) {
        markOutcomeUnknown('settings', save.gatewayId)
        void requestGatewayRead(userId, save.gatewayId)
      }
      if (ownForm()) {
        // A landed save moves the baseline to what it sent, never to the live form, so text typed
        // while it was on its way still reads as unsaved. While a newer edit waits, or another
        // save is still on its way, the section is not saved yet; a form that no longer holds
        // what landed (a newer draft that is not valid) is not shown as saved either.
        settingsLane.answeredAt = sentAt
        settingsLane.baselineUnknown = false
        persistedSettingsSignature = save.signature
        settingsSaveError = null
        settingsSaveState =
          settingsLane.queued || flightsOf(settingsLane, save.gatewayId) > 1
            ? 'saving'
            : makeSettingsSignature() === save.signature
              ? 'saved'
              : 'idle'
        const savedFill = settingsFillCount
        setTimeout(() => {
          if (settingsSaveState === 'saved' && settingsFillCount === savedFill) settingsSaveState = 'idle'
        }, 1600)
      }
      landed = updatedGateway
      if (updatedGateway) onGatewayUpdated(updatedGateway)
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error updating gateway:', error)
      const message = error instanceof Error ? error.message : 'Failed to update gateway'
      const ownError = failSave(settingsLane, save, sentAt, status, message, recordSaved, ownForm(), makeSettingsSignature)
      if (ownError !== null) {
        settingsSaveState = 'idle'
        settingsSaveError = ownError
      }
    } finally {
      settleSave('settings', save.gatewayId, landed, card)
    }
  }

  $effect(() => {
    if (hydrating || !userId || isReadOnly) return
    // BL-1369: the form belongs to the gateway the hydration effect last filled it for. A gateway
    // it has not taken yet is never paired with it; the hydration effect sends the queued save
    // first, then fills the form.
    if (gateway.id !== hydratedGatewayId) return

    const signature = makeSettingsSignature()
    if (
      signature === baselineOf(settingsLane, persistedSettingsSignature) ||
      !isValid ||
      signature === settingsLane.failedSignature
    ) {
      // Back at its baseline, not valid, or (BL-1393) the save that just failed, which only a
      // change sends again: the queued save is dropped, never sent.
      if (dropQueued(settingsLane)) {
        settingsSaveState = flightsOf(settingsLane, gateway.id) > 0 ? 'saving' : 'idle'
      }
      return
    }
    // BL-1370, BL-1393: read-only while this gateway's own save is on its way, or a failed save
    // of it may have been stored and no read of the saved gateway has succeeded since.
    if (settingsLane.lockedFor === gateway.id) return
    settingsLane.failedSignature = null

    settingsSaveState = 'saving'
    settingsSaveError = null
    queueSave(settingsLane, captureSettingsSave(signature), sendSettingsSave)
  })

  /** The MCP Groups save of the form as it is now, for the gateway it holds. */
  function captureGroupingSave(signature: string): CapturedSave {
    return {
      gatewayId: gateway.id,
      gatewayName: gateway.name,
      url: `/api/mcp/gateways/${gateway.id}?userId=${userId}`,
      body: JSON.stringify({ toolGroupings: sanitizeToolGroupingsInput(toolGroupings) }),
      signature,
      fillCount: groupingFillCount
    }
  }

  async function sendGroupingSave(save: CapturedSave) {
    const sentAt = startSave('grouping', save.gatewayId)
    groupingLane.lastSentAt = sentAt
    const ownForm = () =>
      mounted &&
      save.gatewayId === hydratedGatewayId &&
      save.fillCount === groupingFillCount &&
      sentAt > groupingLane.answeredAt
    let landed: MCPGateway | null = null
    let status: number | null = null
    let recordSaved = false
    try {
      const response = await fetch(save.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: save.body
      })
      status = response.status
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        recordSaved = failureConfirmsGatewaySaved(body, save.gatewayId)
        throw new Error(body.error || 'Failed to update tool grouping')
      }

      clearOutcomeUnknown('grouping', save.gatewayId, sentAt)
      const updatedGateway = (body.gateway ?? null) as MCPGateway | null
      if (!updatedGateway) {
        markOutcomeUnknown('grouping', save.gatewayId)
        void requestGatewayRead(userId, save.gatewayId)
      }
      if (ownForm()) {
        groupingLane.answeredAt = sentAt
        groupingLane.baselineUnknown = false
        persistedGroupingSignature = save.signature
        groupingSaveError = null
        groupingSaveState =
          groupingLane.queued || flightsOf(groupingLane, save.gatewayId) > 1
            ? 'saving'
            : makeGroupingSignature() === save.signature
              ? 'saved'
              : 'idle'
        const savedFill = groupingFillCount
        setTimeout(() => {
          if (groupingSaveState === 'saved' && groupingFillCount === savedFill) groupingSaveState = 'idle'
        }, 1600)
      }
      landed = updatedGateway
      if (updatedGateway) onGatewayUpdated(updatedGateway)
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error updating grouping:', error)
      const message = error instanceof Error ? error.message : 'Failed to update tool grouping'
      const ownError = failSave(groupingLane, save, sentAt, status, message, recordSaved, ownForm(), makeGroupingSignature)
      if (ownError !== null) {
        groupingSaveState = 'idle'
        groupingSaveError = ownError
      }
    } finally {
      settleSave('grouping', save.gatewayId, landed, card)
    }
  }

  $effect(() => {
    if (hydrating || !userId || !supportsGrouping || isReadOnly) return
    if (gateway.id !== hydratedGatewayId) return

    const signature = makeGroupingSignature()
    if (
      signature === baselineOf(groupingLane, persistedGroupingSignature) ||
      signature === groupingLane.failedSignature
    ) {
      if (dropQueued(groupingLane)) {
        groupingSaveState = flightsOf(groupingLane, gateway.id) > 0 ? 'saving' : 'idle'
      }
      return
    }
    if (groupingLane.lockedFor === gateway.id) return
    groupingLane.failedSignature = null

    groupingSaveState = 'saving'
    groupingSaveError = null
    queueSave(groupingLane, captureGroupingSave(signature), sendGroupingSave)
  })

  function addEnvRef() {
    if (!settingsEditable()) return
    envRefs = [...envRefs, createEnvRefRow()]
  }

  function removeEnvRef(id: string) {
    if (!settingsEditable()) return
    envRefs = envRefs.filter((entry) => entry.id !== id)
  }

  function updateEnvRef(id: string, field: 'envVar' | 'savedKeyRef', value: string) {
    if (!settingsEditable()) return
    envRefs = envRefs.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry))
  }
</script>

<!-- BL-1370, BL-1393: why a section is read-only (the Agent Settings note, BL-979). -->
{#snippet lockNote(note: GatewayLockReason, waiting: string, spacing: string)}
  <div class="batshit-settings-note is-dashed flex items-center gap-2 {spacing}" role="status">
    {#if note === 'read-failed'}
      <AlertCircle class="h-4 w-4" />
      <span>Batshit could not read the saved gateway: {readFailureMessage}. This section stays read-only until it can.</span>
      <Button type="button" variant="outline" size="sm" onclick={retryGatewayRead}>Retry</Button>
    {:else}
      <Loader2 class="h-4 w-4 animate-spin" />
      <span>{note === 'saving' ? waiting : 'Checking the saved gateway…'}</span>
    {/if}
  </div>
{/snippet}

{#if !isReadOnly}
  <SettingsAccordionCard
    name="mcp-source-detail-cards"
    title="Gateway Settings"
    icon={Settings2}
    open
    contentClass="space-y-4"
  >
    {#snippet actions()}
      <div class="flex items-center gap-2 sm:ml-auto">
        <SettingsSaveStatus
          state={settingsSaveError ? 'error' : settingsSaveState}
          error={settingsSaveError}
          savingLabel="Saving..."
          savedLabel="Settings Saved"
          sticky={false}
        />
      </div>
    {/snippet}

    {#if settingsLockNote}
      {@render lockNote(settingsLockNote, 'Waiting for saved gateway settings…', '')}
    {/if}
    <fieldset disabled={settingsLockedUi} inert={settingsLockedUi} class="min-w-0 space-y-4 border-0 p-0 mx-0">
      <div class="batshit-settings-form-stack">
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label class="batshit-settings-form-label" for={`gateway-name-${gateway.id}`}>
                Gateway Name
              </Label>
            </div>
          </div>
          <div class="batshit-settings-form-control">
            <Input
              id={`gateway-name-${gateway.id}`}
              bind:value={name}
              placeholder="Gateway name"
            />
          </div>
        </div>

        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label class="batshit-settings-form-label">Icon</Label>
            </div>
          </div>
          <div class="batshit-settings-form-control is-compact-action">
            <IconPicker
              bind:value={() => iconRef, (next) => { if (next && settingsEditable()) iconRef = next }}
              disabled={isReadOnly || settingsLockedUi}
              triggerLabel="Choose Icon"
              onlineSearchHint={name}
            />
          </div>
        </div>
      </div>

      {#if gateway.type === 'stdio'}
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`stdio-command-${gateway.id}`}>
                  Command
                </Label>
                <SettingsInfoMenu ariaLabel="About STDIO Command">
                  <p>The executable or script Batshit launches for this local STDIO MCP source.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input id={`stdio-command-${gateway.id}`} bind:value={command} />
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label">Working Directory</Label>
                <SettingsInfoMenu ariaLabel="About Working Directory">
                  <p>
                    Choose whether this source launches from Batshit's active project, a fixed
                    directory, or no custom directory.
                  </p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Select.Root
                type="single"
                value={cwdPolicy}
                onValueChange={(value) => {
                  if (settingsEditable()) cwdPolicy = (value as typeof cwdPolicy) ?? 'none'
                }}
              >
                <Select.Trigger class="w-full">
                  <span data-slot="select-value" class="batshit-settings-form-label">
                    {cwdPolicy === 'project'
                      ? 'Project directory'
                      : cwdPolicy === 'fixed'
                        ? 'Fixed directory'
                        : 'No custom cwd'}
                  </span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="none">No custom cwd</Select.Item>
                  <Select.Item value="project">Project directory</Select.Item>
                  <Select.Item value="fixed">Fixed directory</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>
          </div>

          {#if cwdPolicy === 'fixed'}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label class="batshit-settings-form-label" for={`stdio-cwd-${gateway.id}`}>
                    Fixed Directory
                  </Label>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input id={`stdio-cwd-${gateway.id}`} bind:value={cwdValue} />
              </div>
            </div>
          {/if}

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`startup-timeout-${gateway.id}`}>
                  Startup Timeout
                </Label>
                <SettingsInfoMenu ariaLabel="About Startup Timeout">
                  <p>How long Batshit waits for the STDIO server process to start, in milliseconds.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id={`startup-timeout-${gateway.id}`}
                type="number"
                min="1000"
                step="1000"
                bind:value={startupTimeoutMs}
              />
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`tool-timeout-${gateway.id}`}>
                  Tool Call Timeout
                </Label>
                <SettingsInfoMenu ariaLabel="About Tool Call Timeout">
                  <p>How long one tool call may run before Batshit treats it as timed out.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id={`tool-timeout-${gateway.id}`}
                type="number"
                min="1000"
                step="1000"
                bind:value={toolCallTimeoutMs}
              />
            </div>
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="batshit-settings-form-label-line">
            <Label class="batshit-settings-form-label" for={`stdio-args-${gateway.id}`}>
              Arguments
            </Label>
            <SettingsInfoMenu ariaLabel="About STDIO Arguments">
              <p>One launch argument per line. This stays as a multiline field so long command lists stay readable.</p>
            </SettingsInfoMenu>
          </div>
          <Textarea id={`stdio-args-${gateway.id}`} rows={4} bind:value={argsText} />
        </div>

        <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-1.5">
              <p class="batshit-settings-form-label">Environment References</p>
              <SettingsInfoMenu ariaLabel="About Environment References" contentClass="w-80">
                <p>
                  Map saved API keys into environment variables without storing raw secrets in the
                  gateway record.
                </p>
              </SettingsInfoMenu>
            </div>
            <Button type="button" variant="outline" size="sm" onclick={addEnvRef}>
              <Plus  />
              Add Env Ref
            </Button>
          </div>

          {#if loadingApiKeys}
            <div class="batshit-settings-caption flex items-center gap-2">
              <Loader2 class="h-3 w-3 animate-spin" />
              Loading keys...
            </div>
          {:else if envRefs.length === 0}
            <div class="batshit-settings-note is-dashed">
              No env refs yet.
            </div>
          {:else}
            <div class="space-y-3">
              {#each envRefs as entry (entry.id)}
                <div class="batshit-settings-card-subtle-frame is-compact">
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label class="batshit-settings-form-label" for={`env-var-${entry.id}`}>
                            Env Var
                          </Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id={`env-var-${entry.id}`}
                          value={entry.envVar}
                          oninput={(event) => updateEnvRef(entry.id, 'envVar', (event.currentTarget as HTMLInputElement).value)}
                          placeholder="GITHUB_TOKEN"
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label class="batshit-settings-form-label">Saved Key</Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={entry.savedKeyRef || undefined}
                          onValueChange={(value) => updateEnvRef(entry.id, 'savedKeyRef', value ?? '')}
                        >
                          <Select.Trigger class="w-full">
                            <span data-slot="select-value" class="batshit-settings-form-label">
                              {entry.savedKeyRef ? formatKeyLabel(entry.savedKeyRef) : 'Choose a saved key'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each availableApiKeys as key}
                              <Select.Item value={key}>{formatKeyLabel(key)}</Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>
                    </div>

                    <div class="batshit-settings-form-row is-compact">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <span class="batshit-settings-form-label">Remove Env Ref</span>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control is-compact-action">
                        <Button type="button" variant="ghost" size="icon" onclick={() => removeEnvRef(entry.id)}>
                          <Trash2  />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`gateway-url-${gateway.id}`}>
                  {gateway.type === 'docker-catalog' ? 'Gateway URL' : 'MCP Endpoint URL'}
                </Label>
                <SettingsInfoMenu ariaLabel="About Gateway URL">
                  <p>The endpoint Batshit contacts when discovering or calling tools from this MCP source.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id={`gateway-url-${gateway.id}`}
                bind:value={url}
                disabled={isRuntimeManagedDockerUrl}
                placeholder={
                  gateway.type === 'docker-catalog'
                    ? 'http://localhost:8080/mcp'
                    : gateway.type === 'n8n-instance-mcp'
                      ? 'http://localhost:5678/mcp-server/http'
                      : 'http://localhost:5678/mcp/your-path'
                }
              />
              {#if isRuntimeManagedDockerUrl}
                <p class="batshit-settings-form-help">
                  {dockerRuntimeManagedReason === 'mac'
                    ? 'Managed by the Mac runtime. Restart Batshit from Runtime Doctor after changing runtime config.'
                    : 'Managed by Docker. Change .env.docker, then restart containers.'}
                </p>
              {/if}
            </div>
          </div>

          {#if gateway.type === 'docker-catalog'}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label class="batshit-settings-form-label" for={`docker-profile-${gateway.id}`}>
                    Docker Profile
                  </Label>
                  <SettingsInfoMenu ariaLabel="About Docker Profile" contentClass="w-80">
                    <p>
                      The Docker MCP profile ID passed to Docker the next time Batshit launches the
                      gateway. Relaunch Batshit after changing it.
                    </p>
                    <p class="mt-2">
                      Use letters, numbers, dots, underscores, and hyphens only.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control-group">
                <Input
                  id={`docker-profile-${gateway.id}`}
                  bind:value={dockerProfile}
                  disabled={isRuntimeManagedDockerProfile}
                  placeholder="default"
                  aria-invalid={!isRuntimeManagedDockerProfile && !isValidDockerProfile(dockerProfile)}
                />
                {#if isRuntimeManagedDockerProfile}
                  <p class="batshit-settings-form-help">
                    Managed by Docker. Change DOCKER_MCP_PROFILE in .env.docker, then restart containers.
                  </p>
                {/if}
                {#if !isRuntimeManagedDockerProfile && !isValidDockerProfile(dockerProfile)}
                  <div class="batshit-settings-inline-alert is-danger">
                    Use the Docker MCP profile ID, such as <span class="batshit-settings-inline-strong">default</span>. Letters, numbers, dots, underscores, and hyphens only.
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          {#if gateway.type === 'custom'}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label class="batshit-settings-form-label">Auth Key</Label>
                  <SettingsInfoMenu ariaLabel="About Auth Key">
                    <p>Choose a saved API key to send with this custom MCP source, or leave auth off.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                {#if loadingApiKeys}
                  <div class="batshit-settings-caption flex items-center gap-2">
                    <Loader2 class="h-3 w-3 animate-spin" />
                    Loading keys...
                  </div>
                {:else if availableApiKeys.length === 0}
                  <div class="batshit-settings-note is-dashed">
                    No API keys configured. Add keys in Settings -> API Keys first.
                  </div>
                {:else}
                  <Select.Root
                    type="single"
                    value={authKeyName || undefined}
                    onValueChange={(value) => {
                      if (settingsEditable()) authKeyName = value ?? ''
                    }}
                  >
                    <Select.Trigger class="w-full">
                      <span data-slot="select-value" class="batshit-settings-form-label">
                        {authKeyName ? formatKeyLabel(authKeyName) : 'None (no auth)'}
                      </span>
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">None (no auth)</Select.Item>
                      {#each availableApiKeys as key}
                        <Select.Item value={key}>{formatKeyLabel(key)}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </fieldset>
  </SettingsAccordionCard>
{/if}

<SettingsAccordionCard
  name="mcp-source-detail-cards"
  title="MCP Groups"
  icon={FolderTree}
>
  {#snippet info()}
      <SettingsInfoMenu ariaLabel="About MCP Groups" contentClass="w-96">
        <p>
          MCP groups help organize tools when a source returns one large mixed list instead of
          separating tools by MCP server.
        </p>
        <p class="mt-2">
          It is best to use group names the AI will understand clearly, such as
          <span class="batshit-settings-form-label">“firecrawl”</span>
          or
          <span class="batshit-settings-form-label">“github”</span>.
        </p>
      </SettingsInfoMenu>
  {/snippet}

  {#snippet actions()}
    <div class="flex items-center gap-2 sm:ml-auto">
      {#if supportsGrouping && !isReadOnly}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={groupingLockedUi}
          onclick={() => {
            if (groupingEditable()) groupInputOpen = true
          }}
        >
          <Plus  />
          Add MCP Group
        </Button>
      {/if}

      <SettingsSaveStatus
        state={groupingSaveError ? 'error' : groupingSaveState}
        error={groupingSaveError}
        savingLabel="Saving..."
        savedLabel="Settings Saved"
        sticky={false}
      />
    </div>
  {/snippet}

    {#if groupingLockNote}
      {@render lockNote(groupingLockNote, 'Waiting for saved MCP groups…', 'mb-4')}
    {/if}
    {#if isReadOnly}
      <div class="batshit-settings-note is-dashed">
        This source is auto-discovered from n8n and is managed inside n8n.
      </div>
    {:else if !supportsGrouping}
      <div class="batshit-settings-note is-dashed">
        This gateway type does not currently use tool grouping.
      </div>
    {:else if loadingTools}
      <div class="batshit-settings-caption flex items-center gap-2">
        <Loader2 class="h-4 w-4 animate-spin" />
        Loading tools…
      </div>
    {:else}
      <fieldset disabled={groupingLockedUi} inert={groupingLockedUi} class="min-w-0 border-0 p-0 mx-0">
        {#if availableTools.length === 0}
          <div class="batshit-settings-note is-dashed mb-4">
            No tools are available yet. Make sure the source is reachable, then refresh it.
          </div>
        {/if}
        <MCPToolGroupingEditor
          availableTools={availableTools}
          toolMetadata={availableToolMetadata}
          bind:showNewGroupInput={groupInputOpen}
          groupings={toolGroupings}
          onChange={(nextGroupings: MCPToolGrouping[]) => {
            if (groupingEditable()) toolGroupings = sanitizeToolGroupingsInput(nextGroupings)
          }}
        />
      </fieldset>
    {/if}
</SettingsAccordionCard>
