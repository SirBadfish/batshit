import { captureCliDcmWrite, readCliDcmPair, assertCliNativeValue } from '$lib/utils/cliToolGridEnable'
import type { AgentDcmDisplaySettingsSave } from '$lib/utils/agentBlockFieldSettings'
import type { ToolGridEnableControl } from '$lib/components/tools/ToolGridEnableCell.svelte'
import { normalizeNativeExecutionBackend, type NativeExecutionBackend } from '$lib/utils/nativeExecutionBackend'
import { readTypedFileToolsValue, typedFileToolsUnavailableReason, type TypedFileToolsHost } from '$lib/utils/typedFileToolsGrant'
import { fetchToolsHostFacts } from '$lib/utils/refreshedFileReadsSettings'
import { adoptTypedFileToolsAck, captureTypedFileToolsBaseline, TYPED_FILE_TOOLS_REVISION_HEADER, withExpectedTypedFileTools, type TypedFileToolsBaseline } from '$lib/utils/typedFileToolsSave'

type Agent = { id: string; user_id?: string; agentType?: string; created_at?: string; provider_specific_settings?: Record<string, any> | null; dcmDisplaySettings?: unknown; dcm_display_settings?: unknown }
const FIELDS: Record<string, string> = {
  bash: 'bashEnabled', web_search: 'webSearchEnabled', agent_browser_actions: 'agentBrowserEnabled',
  artifact_find: 'artifactRuntimeEnabled', fabric_find: 'batshitToolsEnabled',
  typed_file_tools: 'typedFileToolsEnabled', mcp_tools: 'dynamicMcpEnabled', cli_tools: 'cliToolsEnabled'
}
type Choice = { value: boolean; notice: string }
type State = { owner: string; pending: boolean; reading: boolean; loaded: boolean; observedTyped: boolean | null | undefined; baseline: TypedFileToolsBaseline | null; drafts: Record<string, Choice>; earlierUnknown: boolean }
const ownerOf = (row: Agent) => JSON.stringify([row.id, row.user_id, row.agentType, row.created_at])
function validNativeContainers(row: Agent): boolean {
  const provider = row.provider_specific_settings
  if (provider == null) return true
  if (typeof provider !== 'object' || Array.isArray(provider)) return false
  return provider.nativeTools == null || typeof provider.nativeTools === 'object' && !Array.isArray(provider.nativeTools)
}
export function chatGridNativeSettings(row: Agent | null | undefined): Record<string, any> {
  const nested = row?.provider_specific_settings?.nativeTools
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : {}
}
function bool(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (['true', '1', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase())) return true
    if (['false', '0', 'no', 'off', 'disabled'].includes(value.trim().toLowerCase())) return false
  }
  return fallback
}

/** The chat wrapper owns only these existing native choices. Reads never save; unknown writes
 * keep their exact draft until the human explicitly adopts a current saved choice. */
export function createChatToolGridEnableControls(input: {
  getAgent: () => Agent | null | undefined
  install: (owner: Agent, fields: Record<string, unknown>) => void
  readState: (id: string) => { generation: number; pending: boolean; record: object | null | undefined }
  refresh: (id: string) => void
  cliBusy?: () => boolean
  cliSnapshot?: () => unknown
  installCli?: (owner: Agent, patch: AgentDcmDisplaySettingsSave, record?: Agent) => void
  refreshCli?: (id: string) => void
}) {
  let states = $state<Record<string, State>>({})
  let host = $state<TypedFileToolsHost | null>(null)
  let hostFailed = $state(false)
  let hostStarted = false
  let hostReading = false
  let alive = true
  let selectedOwner: string | null = null
  function readHost() {
    if (hostReading) return
    hostStarted = true
    hostReading = true
    hostFailed = false
    void fetchToolsHostFacts().then(value => { if (alive) host = value }).catch(() => { if (alive) hostFailed = true }).finally(() => { hostReading = false })
  }
  function state(row: Agent): State {
    const owner = ownerOf(row)
    if (!states[row.id] || states[row.id].owner !== owner) states[row.id] = { owner, pending: false, reading: false, loaded: false, observedTyped: undefined, baseline: null, drafts: {}, earlierUnknown: false }
    return states[row.id]
  }
  function current(row: Agent, saved: State) {
    const live = input.getAgent()
    return alive && live?.id === row.id && ownerOf(live) === saved.owner && states[row.id] === saved
  }
  function backend(row: Agent): NativeExecutionBackend {
    const settings = chatGridNativeSettings(row)
    return normalizeNativeExecutionBackend(settings.executionBackend ?? settings.nativeExecutionBackend ?? settings.bashExecutionBackend ?? settings.nativeBashExecutionBackend) ??
      (String(settings.bashAccessMode ?? settings.nativeBashAccessMode ?? settings.bashPolicyMode).trim().toLowerCase() === 'dangerous' ? 'local' : host?.containerized || host?.platform !== 'darwin' ? 'docker_sandbox' : 'apple_container')
  }
  async function read(row: Agent, takeSavedField?: string) {
    const saved = state(row)
    const sourceState = input.readState(row.id)
    if (saved.pending || saved.reading || sourceState.pending) return
    if (!takeSavedField || takeSavedField === 'typedFileToolsEnabled') saved.observedTyped = readTypedFileToolsValue(chatGridNativeSettings(row).typedFileToolsEnabled)
    const before = JSON.stringify(chatGridNativeSettings(row))
    const cliBefore = JSON.stringify(input.cliSnapshot?.())
    saved.reading = true
    let superseded = false
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(row.id)}`, { cache: 'no-store' })
      if (!response.ok) throw new Error('The saved tool choices could not be read.')
      const record = await response.json()
      if (!record || ownerOf(record) !== saved.owner) throw new Error('The saved agent changed. Read its tool choices again.')
      if (!validNativeContainers(record)) throw new Error('The saved tool choices were not a valid settings record.')
      if (!current(row, saved)) return
      if (input.readState(row.id).pending || input.readState(row.id).generation !== sourceState.generation || input.readState(row.id).record !== sourceState.record || JSON.stringify(chatGridNativeSettings(input.getAgent())) !== before || takeSavedField === 'cliToolsEnabled' && (input.cliBusy?.() || JSON.stringify(input.cliSnapshot?.()) !== cliBefore)) {
        // A clean read can follow a newer accepted store copy once; it never adopts that copy
        // as a save base, retries a failed read, or replaces a held choice.
        superseded = !Object.keys(saved.drafts).length
        return
      }
      const baseline = captureTypedFileToolsBaseline('agent', row.id, record, response.headers.get(TYPED_FILE_TOOLS_REVISION_HEADER))
      if (takeSavedField || !Object.keys(saved.drafts).length) {
        if (!takeSavedField || takeSavedField === 'typedFileToolsEnabled') saved.baseline = baseline
        const native = chatGridNativeSettings(record)
        const cliPatch = takeSavedField === 'cliToolsEnabled' ? readCliDcmPair(record) : undefined
        if (cliPatch) assertCliNativeValue(native.cliToolsEnabled)
        const fields = takeSavedField ? [takeSavedField] : Object.values(FIELDS)
        input.install(row, Object.fromEntries(fields.map(field => [field, Object.hasOwn(native, field) ? native[field] : null])))
        if (cliPatch) input.installCli?.(row, cliPatch, record)
        if (!takeSavedField || takeSavedField === 'typedFileToolsEnabled') saved.observedTyped = readTypedFileToolsValue(native.typedFileToolsEnabled)
        if (takeSavedField) {
          const { [takeSavedField]: _done, ...rest } = saved.drafts
          saved.drafts = rest
        }
      }
    } catch (error) {
      const field = takeSavedField ?? 'typedFileToolsEnabled'
      if (current(row, saved)) saved.drafts = { ...saved.drafts, [field]: { value: saved.drafts[field]?.value ?? (field === 'typedFileToolsEnabled' ? readTypedFileToolsValue(chatGridNativeSettings(row)[field]) === true : bool(chatGridNativeSettings(row)[field])), notice: error instanceof Error ? error.message : 'Read the saved tool choices again.' } }
    } finally {
      saved.reading = false
      saved.loaded = !superseded
    }
  }
  async function choose(row: Agent, saved: State, field: string, value: boolean, companion?: AgentDcmDisplaySettingsSave) {
    if (!current(row, saved) || saved.pending || saved.reading || saved.drafts[field] || field === 'cliToolsEnabled' && input.cliBusy?.()) return
    const cliPatch = field === 'cliToolsEnabled' && value ? captureCliDcmWrite(row, companion) : undefined
    const cliBefore = JSON.stringify(input.cliSnapshot?.())
    const body = $state.snapshot({ provider_specific_settings: { nativeTools: { [field]: value } }, ...(cliPatch ? { dcmDisplaySettings: cliPatch } : {}) })
    let request: typeof body & { expectedTypedFileTools?: string }
    try { request = withExpectedTypedFileTools(body, saved.baseline) }
    catch (error) { saved.drafts = { ...saved.drafts, [field]: { value, notice: (error as Error).message } }; return }
    const original = saved.baseline
    const sourceState = input.readState(row.id)
    if (sourceState.pending) return
    saved.pending = true
    saved.drafts = { ...saved.drafts, [field]: { value, notice: '' } }
    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(row.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
      const payload = await response.json().catch(() => null)
      const next = field === 'typedFileToolsEnabled' ? adoptTypedFileToolsAck(original, request.expectedTypedFileTools, value, payload?.typedFileTools) : null
      const knownSaved = field === 'typedFileToolsEnabled' ? next && (response.ok || payload?.typedFileToolsSaved === true) : response.ok && payload?.success === true
      if (knownSaved) {
        if (next) saved.baseline = next
        if (next) saved.observedTyped = next.value
        // The acknowledgement belongs to this captured actor even after selection changes.
        // The caller installs only this one leaf over the latest store copy.
        if (input.readState(row.id).generation === sourceState.generation && !input.readState(row.id).pending && input.readState(row.id).record === sourceState.record && (field !== 'cliToolsEnabled' || !input.cliBusy?.() && JSON.stringify(input.cliSnapshot?.()) === cliBefore)) {
          input.install(row, { [field]: value })
          if (body.dcmDisplaySettings) input.installCli?.(row, body.dcmDisplaySettings)
        } else { input.refresh(row.id); if (field === 'cliToolsEnabled') input.refreshCli?.(row.id) }
        const { [field]: _done, ...rest } = saved.drafts
        saved.drafts = rest
      } else {
        const knownRefused = field === 'typedFileToolsEnabled' &&
          (response.status === 400 && payload?.code === 'typed_file_tools_base_required' || response.status === 409 && payload?.code === 'typed_file_tools_changed')
        saved.earlierUnknown ||= !knownRefused
        saved.drafts = { ...saved.drafts, [field]: { value, notice: knownRefused ? 'The saved choice changed or could not be changed. Your draft was not saved.' : 'This choice is unconfirmed. Your draft is kept.' } }
      }
    } catch {
      saved.earlierUnknown = true
      saved.drafts = { ...saved.drafts, [field]: { value, notice: 'This choice is unconfirmed. Your draft is kept.' } }
    } finally { saved.pending = false }
  }
  const controls: {
    readonly host: TypedFileToolsHost | null
    readonly hostFailed: boolean
    readonly cliHeld: boolean
    backend: (row: Agent) => NativeExecutionBackend
    sync: () => void
    dispose: () => void
    control: (id: string) => ToolGridEnableControl | null
  } = {
    get host() { return host },
    get hostFailed() { return hostFailed },
    get cliHeld() { const row = input.getAgent(); return !!row && !!states[row.id]?.drafts.cliToolsEnabled },
    backend,
    dispose() { alive = false },
    sync() {
      const row = input.getAgent()
      if (!row) return
      const saved = state(row)
      if (selectedOwner !== saved.owner) {
        selectedOwner = saved.owner
        if (!saved.pending && !Object.keys(saved.drafts).length) saved.loaded = false
      }
      const typedChanged = saved.observedTyped !== readTypedFileToolsValue(chatGridNativeSettings(row).typedFileToolsEnabled)
      if ((!saved.loaded || typedChanged && !Object.keys(saved.drafts).length) && !saved.reading && !saved.pending) void read(row)
      if (!hostStarted) readHost()
    },
    control(id: string): ToolGridEnableControl | null {
      const row = input.getAgent(), field = FIELDS[id]
      if (!row || !field) return null
      const saved = states[row.id], native = chatGridNativeSettings(row)
      const typed = id === 'typed_file_tools'
      if (!saved || saved.owner !== ownerOf(row)) return { checked: typed ? readTypedFileToolsValue(native[field]) === true : bool(native[field], id === 'artifact_find' ? bool(native.batshitToolsEnabled) : true), disabled: true, onChange: () => {} }
      const unavailable = typed ? hostFailed ? 'Could not check typed file tools availability. Use Saved Choice to retry.' : typedFileToolsUnavailableReason(backend(row), host) : null
      const bashDisabled = typed && !bool(native.bashEnabled)
      const held = saved.drafts[field]
      const cliSource = input.readState(row.id), cliSnapshot = JSON.stringify(input.cliSnapshot?.())
      const ownsCliSource = () => { const source = input.readState(row.id); return current(row, saved) && source.generation === cliSource.generation && source.record === cliSource.record && JSON.stringify(input.cliSnapshot?.()) === cliSnapshot }
      const notice = [saved.earlierUnknown ? 'An earlier save remains unconfirmed.' : null, held?.notice, typed && !saved.baseline && !held ? 'Read the saved choice before changing it.' : null, unavailable, bashDisabled ? 'Typed File Tools also needs Bash enabled.' : null].filter(Boolean).join(' ')
      return {
        ...(id === 'cli_tools' && held ? { draftChecked: held.value } : {}),
        checked: held?.value ?? (typed ? readTypedFileToolsValue(native[field]) === true : bool(native[field], id === 'artifact_find' ? bool(native.batshitToolsEnabled) : true)),
        disabled: !alive || saved.pending || saved.reading || !!saved.drafts.cliToolsEnabled || id === 'cli_tools' && !!input.cliBusy?.() || input.readState(row.id).pending || !!held || !!unavailable || bashDisabled || typed && !saved.baseline,
        notice,
        onChange: (value: boolean, companion?: AgentDcmDisplaySettingsSave) => { if (!controls.control(id)?.disabled && (id !== 'cli_tools' || ownsCliSource())) void choose(row, saved, field, value, companion) },
        ...(typed || held ? { onRead: () => { if (current(row, saved) && (id !== 'cli_tools' || ownsCliSource())) { if (hostFailed) readHost(); void read(row, field) } }, reading: saved.reading || saved.pending } : {})
      }
    }
  }
  return controls
}
