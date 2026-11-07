import type { AutoCompactSnapshot } from '$lib/server/autoCompactGuard'
import { isConfiguredFishAccountCursor, type ConfiguredFishAccountQuery, type ConfiguredFishAccountReportPage } from '$lib/appActions/settings/configuredTtsPreferences'
import { createConfiguredFishAccountPages } from './configuredTtsAccountPaging'
import { checkConfiguredTtsAccountSource } from './configuredTtsAccountCatalog'
import { configuredTtsChoices, type ConfiguredTtsTarget } from './configuredTtsSources'
import type { MemoryEnableReadinessSnapshot } from '../../memory/memoryEnableReadiness'
import { ADOPTED_SETTINGS_DEFINITIONS } from '$lib/appActions/settings/definitions'
import { parseManagedSettingsReportInput } from '$lib/appActions/settings/managementInput'
import type { SkillAccessQuery } from '$lib/appActions/skillAccess'
import { MANAGEMENT_ADAPTER_BINDINGS } from '../managementAdapters'
import { createManagementAdapterContext } from '../adapterContext'
import { createSkillAccessPages } from './skillAccessPaging'
import type { SkillAccessRead } from './skillAccessReport'
import { createHash, randomBytes } from 'node:crypto'
import { redis } from '$lib/server/redis'
import {
  parseSettingsSubjectSelector, SETTINGS_REPORT_BYTE_LIMITS, settingsSubjectKey,
  type SettingsSubjectRef
} from '$lib/appActions/settings/reportContract'
import { createSettingsSubjectResolver, type SettingsReportReadContext, type SettingsSubjectManifest } from './subjects'
import { createSettingsReportSnapshot, settingsReportSerializedBytes, type SettingsReportPage } from './report'
import { SETTINGS_SNAPSHOT_PATHS, type ConditionalSettingsStore, type SettingsSnapshot } from './conditionalAgentSettings'
import {
  admitSettingsManagementActor, nativeSettingsSignal, sameSettingsAuthority, SETTINGS_MANAGEMENT_CONTROL_IDS,
  type SettingsManagementAdmission, type SettingsManagementContext
} from './managementActor'
import { AppActionsManagementRefusal, policyContainsSubject } from './authority'
import { assertSettingsLifecycle, SettingsLifecycleRefusal } from './lifecycle'
import type { ModelSelectionSnapshot } from '$lib/server/modelSelectionGuard'
import { captureModelPresetCopySource, modelPresetCopyChoices, type PresetCopySource, readModelPresetSelectionChoices } from '$lib/server/services/modelPresetSelectionOwner'
import { createInstructionTextPages, type InstructionTextPage, type InstructionTextRead } from './instructionTextSnapshot'
import { MCP_CONFIGURATION_DOMAIN } from '$lib/appActions/settings/mcpConfiguration'
import { assertMcpReportCurrent, captureMcpGatewayReport, refreshMcpReport, wireMcpGatewayReport, mcpReportRequest, type McpGatewayReportTicket } from '../mcp/gatewayReport'

type ManagementReportPage = SettingsReportPage | ReturnType<ReturnType<typeof createSkillAccessPages>['page']> | InstructionTextPage | ConfiguredFishAccountReportPage
export type ManagementReportTicket = {
  domain: 'agent-settings' | 'skill-access'; skillAccess?: SkillAccessRead
  id: string; expiresAt: number; admission: SettingsManagementAdmission; context: SettingsManagementContext
  manifest: SettingsSubjectManifest; snapshots: Map<string, SettingsSnapshot>
  presetCopySource?: PresetCopySource
  modelSelections: Map<string, ModelSelectionSnapshot>
  instructions: Map<string, InstructionTextRead>
  autoCompact: Map<string, AutoCompactSnapshot>
  configuredTts: Map<string, ConfiguredTtsTarget>
  configuredTtsAccount?: ReturnType<typeof createConfiguredFishAccountPages>
  report: { page(cursor?: string): ManagementReportPage }
}
export type AnyManagementReportTicket = ManagementReportTicket | McpGatewayReportTicket
function recordFromSnapshot(subject: SettingsSubjectRef, snapshot: SettingsSnapshot): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  SETTINGS_SNAPSHOT_PATHS.forEach((path, index) => {
    const values = JSON.parse(snapshot.raw[index] || '[]')
    if (index < 16 && values.length) record[index === 2 && subject.kind === 'subagent' ? 'subagentType' : path.slice(2)] = values[0]
  })
  if (snapshot.memoryWindowParents) {
    for (const [offset, field] of ['memory_window', 'memoryWindow'].entries()) {
      const type = snapshot.memoryWindowParents[offset]
      if (!type) continue
      record[field] = type === 'null' ? null : type === 'object' ? Object.fromEntries(['floor_mode', 'ceiling_headroom_mode'].flatMap((leaf, index) => {
        const values = JSON.parse(snapshot.raw[16 + offset * 2 + index] || '[]')
        return values.length ? [[leaf, values[0]]] : []
      })) : 'invalid_memory_window_container'
    }
  }
  return record
}
function actorMatches(left: SettingsManagementAdmission, right: SettingsManagementAdmission) {
  return sameSettingsAuthority(left, right) && left.actor.sessionId === right.actor.sessionId
}
export function createSettingsManagementReports(boot: string, store: ConditionalSettingsStore) {
  const tickets = new Map<string, AnyManagementReportTicket>()
  function assertCurrent(ticket: AnyManagementReportTicket) {
    if (ticket.domain === MCP_CONFIGURATION_DOMAIN) return assertMcpReportCurrent(ticket)
    try {
      for (const entry of ticket.manifest.entries) {
        if (entry.status !== 'available') continue
        const lifecycle = ticket.snapshots.get(settingsSubjectKey(entry.subject))?.lifecycle
        if (!lifecycle) throw new Error('Missing captured subject lifecycle')
        assertSettingsLifecycle(lifecycle)
        const model = ticket.modelSelections.get(settingsSubjectKey(entry.subject))
        if (model) assertSettingsLifecycle(model.lifecycle)
        const instructions = ticket.instructions.get(settingsSubjectKey(entry.subject))
        if (instructions) assertSettingsLifecycle(instructions.lifecycle)
        const compact = ticket.autoCompact.get(settingsSubjectKey(entry.subject))
        if (compact) assertSettingsLifecycle(compact.lifecycle)
        const voice = ticket.configuredTts.get(settingsSubjectKey(entry.subject))
        if (voice) { assertSettingsLifecycle(voice.snapshot.lifecycle); voice.checkEnvironment() }
      }
    } catch { throw new AppActionsManagementRefusal('REPORT_SUBJECT_CHANGED', 'A report subject changed identity or ownership. Request a fresh report.', 409) }
  }
  async function refreshCaptured<T extends AnyManagementReportTicket>(ticket: T, context: SettingsManagementContext, lane: 'native' | 'portable', checkMcpRequest?: () => void): Promise<T> {
    if (ticket.domain === MCP_CONFIGURATION_DOMAIN) { await refreshMcpReport(ticket, context, lane, checkMcpRequest); return ticket }
    const current = await admitSettingsManagementActor(context, lane)
    if (!actorMatches(ticket.admission, current)) throw new AppActionsManagementRefusal('REPORT_AUTHORITY_CHANGED', 'The report authority changed. Request a fresh report.', 409)
    for (const entry of ticket.manifest.entries) {
      if (entry.status !== 'available') continue
      const saved = ticket.snapshots.get(settingsSubjectKey(entry.subject))!
      const fresh = await store.read(entry.subject.id, entry.subject.kind === 'subagent' ? 'subagent' : 'primary')
      if (fresh.raw[0] !== saved.raw[0] || fresh.raw[1] !== saved.raw[1] || fresh.raw[2] !== saved.raw[2] || fresh.incarnationRaw !== saved.incarnationRaw || JSON.stringify(fresh.lifecycle) !== JSON.stringify(saved.lifecycle)) {
        throw new AppActionsManagementRefusal('REPORT_SUBJECT_CHANGED', 'A report subject changed identity or ownership. Request a fresh report.', 409)
      }
    }
    // Refresh async authority again after ownership reads, before emitting a retained snapshot.
    const settled = await admitSettingsManagementActor(context, lane)
    if (!actorMatches(ticket.admission, settled)) throw new AppActionsManagementRefusal('REPORT_AUTHORITY_CHANGED', 'The report authority changed.', 409)
    assertCurrent(ticket)
    ticket.admission = settled; ticket.context = context
    return ticket
  }
  async function refresh(id: string, context: SettingsManagementContext, lane: 'native' | 'portable', checkMcpRequest?: () => void) {
    const ticket = tickets.get(id)
    if (!ticket || ticket.expiresAt <= Date.now()) throw new AppActionsManagementRefusal('REPORT_EXPIRED', 'Request a fresh Settings report.', 409)
    return refreshCaptured(ticket, context, lane, checkMcpRequest)
  }
  function wireMetadata(ticket: Pick<ManagementReportTicket, 'id' | 'domain' | 'admission'>) {
    const ref = ticket.admission.actor.kind === 'native' ? SETTINGS_MANAGEMENT_CONTROL_IDS.nativeChange : SETTINGS_MANAGEMENT_CONTROL_IDS.portableChange
    const alias = ticket.domain === 'skill-access'
    return { domain: ticket.domain, bootNamespace: boot, reportId: ticket.id, change: {
      ref: `fabric:${ref}`, input: { op: 'change', requestId: `${boot}:<unique-request-id>`, reportId: ticket.id,
        semanticId: '<reported semantic ID>', changes: '<admitted fields only>' },
      fields: alias ? { 'agent.skills.access': ['assignments', 'universalConversion'] } : Object.fromEntries(ADOPTED_SETTINGS_DEFINITIONS.map(definition => [definition.id, definition.fields.filter(field => field.change === 'scoped-adapter').map(field => field.id)])),
      permission: { skillAccess: ticket.admission.policy.management.skillAccess, ordinaryChanges: ticket.admission.policy.ordinaryChanges, instructions: ticket.admission.policy.protected.instructions, memorySettings: ticket.admission.policy.protected.memorySettings, contextManagement: ticket.admission.policy.protected.contextManagement }
    } }
  }
  function wire(ticket: ManagementReportTicket, page: ManagementReportPage) {
    assertCurrent(ticket)
    const { change, ...metadata } = wireMetadata(ticket)
    const result = { ...metadata, report: page, change }
    if (settingsReportSerializedBytes(result) > SETTINGS_REPORT_BYTE_LIMITS[page.detail]) throw new AppActionsManagementRefusal('REPORT_BUDGET', 'Report metadata exceeded the bounded page budget.', 409)
    // A retained page can finish async admission after its read lifetime ends.
    // Captured operations keep their separate review clock; do not put this in assertCurrent.
    if (Date.now() >= ticket.expiresAt) throw new AppActionsManagementRefusal('REPORT_EXPIRED', 'Request a fresh Settings report.', 409)
    if (ticket.admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
    else if (Date.now() >= (ticket.admission.expiresAt ?? 0)) throw new AppActionsManagementRefusal('GRANT_EXPIRED', 'The token grant expired.')
    return result
  }
  type FishRequest = Readonly<{
    wait<T>(read: () => Promise<T>): Promise<T>
    check(): void; deadlineAt: number; finish(check: () => void): void
  }>
  /** Only explicit Fish report requests use this entry-to-handoff clock. */
  async function fishRequest<Result>(context: SettingsManagementContext, lane: 'native' | 'portable', run: (request: FishRequest) => Promise<Result>): Promise<Result> {
    const deadlineAt = Date.now() + 10_000
    const signal = lane === 'native' ? nativeSettingsSignal(context) : undefined
    let finalCheck = () => {}, rejectEnded: (error: unknown) => void = () => {}
    const ended = new Promise<never>((_resolve, reject) => { rejectEnded = reject })
    void ended.catch(() => {})
    const abort = () => rejectEnded(new AppActionsManagementRefusal('OPERATION_ENDED', 'The exact account read stopped or expired.', 409))
    const timer = setTimeout(abort, 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    function check() {
      if (lane === 'native') nativeSettingsSignal(context)
      if (Date.now() >= deadlineAt) throw new AppActionsManagementRefusal('OPERATION_ENDED', 'The account read expired.', 409)
    }
    async function wait<T>(read: () => Promise<T>): Promise<T> {
      check(); const result = await Promise.race([read(), ended]); check(); return result
    }
    try {
      const result = await wait(() => run({ wait, check, deadlineAt, finish(value) { finalCheck = value } }))
      check(); finalCheck()
      return result
    } catch (error) {
      if (error instanceof AppActionsManagementRefusal || error instanceof SettingsLifecycleRefusal) throw error
      throw new AppActionsManagementRefusal('TTS_ACCOUNT_REPORT_UNAVAILABLE', 'This account page is unavailable. Local configured choices remain independent.', 409)
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
  }
  async function accountPage(ticket: ManagementReportTicket, context: SettingsManagementContext, lane: 'native' | 'portable', request: FishRequest, cursor?: string) {
    const account = ticket.configuredTtsAccount!
    if (cursor !== undefined && !isConfiguredFishAccountCursor(cursor)) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'Use only this Fish report and its issued cursor.', 400)
    await request.wait(() => refreshCaptured(ticket, context, lane))
    const target = ticket.configuredTts.get(settingsSubjectKey(account.subject))!
    const adapter = () => createManagementAdapterContext(ticket.admission, () => context, Math.min(request.deadlineAt, ticket.expiresAt, ticket.admission.expiresAt ?? Infinity), {
      assertCurrent: () => { request.check(); assertCurrent(ticket) }
    })
    let page = await request.wait(() => account.page(adapter(), cursor))
    await request.wait(() => refreshCaptured(ticket, context, lane))
    const final = adapter(), source = account.source()
    let current = true
    if (source) {
      const checked = await request.wait(() => checkConfiguredTtsAccountSource(final, target, source))
      current = checked.status === 'current'
      if (checked.status !== 'current') page = account.unavailable(checked.reason)
    }
    const check = () => { final.assertCurrent(); assertCurrent(ticket); if (source && current) account.checkSource() }
    // Also closes the async return boundary in fishRequest before the DTO leaves this owner.
    request.finish(check); check()
    return wire(ticket, page)
  }
  async function newAccountReport(context: SettingsManagementContext, lane: 'native' | 'portable', args: Record<string, unknown>) {
    const selector = parseSettingsSubjectSelector(args.targets), query = args.query as ConfiguredFishAccountQuery
    let ownedTicket: string | undefined, completed = false, handoffCheck = () => {}
    try {
      const result = await fishRequest(context, lane, async request => {
        const admission = await request.wait(() => admitSettingsManagementActor(context, lane))
        const readContext: SettingsReportReadContext = { userId: context.userId,
          canRead: subject => policyContainsSubject(admission.policy, subject, admission.actor.kind === 'native' ? admission.actor.id : undefined),
          check() { request.check(); if (Date.now() >= (admission.expiresAt ?? Infinity)) throw new AppActionsManagementRefusal('GRANT_EXPIRED', 'The token grant expired.') } }
        const snapshots = new Map<string, SettingsSnapshot>()
        const manifest = await request.wait(() => createSettingsSubjectResolver({
          async listIds() { throw new AppActionsManagementRefusal('TTS_CHOICES_ONE_SUBJECT', 'Account choices never enumerate agents.', 400) },
          async read(_userId, subject) {
            const snapshot = await request.wait(() => store.read(subject.id, 'primary'))
            snapshots.set(settingsSubjectKey(subject), snapshot)
            return recordFromSnapshot(subject, snapshot)
          }
        })(selector, readContext))
        const entry = manifest.entries[0]
        if (manifest.entries.length !== 1 || manifest.excluded.length || entry.status !== 'available' || entry.subject.kind !== 'primary' || entry.type !== 'api' || !store.readConfiguredTts) {
          throw new AppActionsManagementRefusal('TTS_SUBJECT_UNAVAILABLE', 'This exact reply-voice subject is unavailable.', 409)
        }
        const target = await request.wait(() => store.readConfiguredTts!(context.userId, entry.subject.id))
        const snapshot = snapshots.get(settingsSubjectKey(entry.subject))!
        if (target.snapshot.record.id !== entry.subject.id || target.snapshot.record.user_id !== context.userId || JSON.stringify(target.snapshot.lifecycle) !== JSON.stringify(snapshot.lifecycle)) throw new AppActionsManagementRefusal('REPORT_SUBJECT_CHANGED', 'The reply-voice subject changed.', 409)
        for (const [id, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(id)
        if (tickets.size >= 2048) throw new AppActionsManagementRefusal('REPORT_CAPACITY', 'The read-report capacity is full.', 503)
        const id = `asr_${boot}_${randomBytes(16).toString('hex')}`, expiresAt = Math.min(Date.now() + 10 * 60_000, admission.expiresAt ?? Infinity)
        const account = createConfiguredFishAccountPages({ subject: { kind: 'primary', id: entry.subject.id }, target, admission,
          modelId: query.ttsModelId ?? null, manifestDigest: manifest.digest, expiresAt })
        const ticket: ManagementReportTicket = { id, domain: 'agent-settings', expiresAt, admission, context, manifest, snapshots,
          modelSelections: new Map(), instructions: new Map(), autoCompact: new Map(), configuredTts: new Map([[settingsSubjectKey(entry.subject), target]]),
          configuredTtsAccount: account, report: { page: account.peek } }
        ownedTicket = id; tickets.set(id, ticket)
        return accountPage(ticket, context, lane, { ...request, finish(check) { handoffCheck = check; request.finish(check) } })
      })
      handoffCheck()
      completed = true
      return result
    } finally { if (!completed && ownedTicket) tickets.delete(ownedTicket) }
  }
  const api = {
    async report(context: SettingsManagementContext, lane: 'native' | 'portable', input: unknown, inherited?: ManagementReportTicket) {
      const args = parseManagedSettingsReportInput(input)
      if (args.domain === MCP_CONFIGURATION_DOMAIN) {
        if (inherited) throw new AppActionsManagementRefusal('MCP_REPORT_OWNER_REQUIRED', 'MCP resources retain their own report snapshot.', 409)
        for (const [id, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(id)
        if (tickets.size >= 2048) throw new AppActionsManagementRefusal('REPORT_CAPACITY', 'The read-report capacity is full.', 503)
        const id = `asr_${boot}_mcp_${randomBytes(16).toString('hex')}`
        const ticket = await captureMcpGatewayReport({ id, boot, context, lane, store, query: args.query as Record<string, unknown>,
          detail: args.detail as 'summary' | 'values' | 'choices' ?? 'summary' })
        // No awaited handoff after the leaf's final current/Stop/deadline check.
        const result = wireMcpGatewayReport(ticket)
        if (tickets.size >= 2048) throw new AppActionsManagementRefusal('REPORT_CAPACITY', 'The read-report capacity is full.', 503)
        tickets.set(id, ticket)
        return result
      }
      if (args.domain === 'runtime-inspection') throw new AppActionsManagementRefusal('INSTANCE_REPORT_OWNER_REQUIRED', 'Runtime inspection uses the instance read owner.', 400)
      if (args.reportId !== undefined) {
        if (typeof args.reportId !== 'string' || args.targets !== undefined || args.focus !== undefined || args.detail !== undefined) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'Continue using only reportId and its cursor.', 400)
        const id = args.reportId, cursor = args.cursor as string | undefined, captured = tickets.get(id)
        if (captured?.domain === MCP_CONFIGURATION_DOMAIN) return mcpReportRequest(context, lane, async (check, deadlineAt) => {
          await refreshMcpReport(captured, context, lane); check(); return wireMcpGatewayReport(captured, cursor, deadlineAt)
        })
        if (captured?.configuredTtsAccount) return fishRequest(context, lane, request => accountPage(captured, context, lane, request, cursor))
        if (isConfiguredFishAccountCursor(cursor)) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'That report has no Fish account cursor.', 400)
        const ticket = await refresh(id, context, lane)
        if (ticket.domain === MCP_CONFIGURATION_DOMAIN) throw new AppActionsManagementRefusal('MCP_REPORT_OWNER_REQUIRED', 'Use the exact held resource report.', 409)
        return wire(ticket, ticket.report.page(args.cursor as string | undefined))
      }
      if (args.cursor !== undefined) throw new AppActionsManagementRefusal('REPORT_ID_REQUIRED', 'Continue a report using its reportId.', 400)
      if ((args.query as { ttsCatalog?: unknown } | undefined)?.ttsCatalog === 'account') {
        if (inherited) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'Fresh account reads require their own explicit query.', 400)
        return newAccountReport(context, lane, args)
      }
      const admission = await admitSettingsManagementActor(context, lane)
      const domain = args.domain === 'skill-access' ? 'skill-access' as const : 'agent-settings' as const
      if (domain === 'skill-access' && admission.policy.management.skillAccess === 'block') throw new AppActionsManagementRefusal('SKILL_ACCESS_BLOCKED', 'The user blocked skill access management.')
      const selector = inherited ? undefined : parseSettingsSubjectSelector(args.targets ?? (lane === 'native' ? { subjects: [{ kind: 'primary', id: admission.actor.id }] } :
        admission.policy.scope.mode === 'all' ? { allAgents: true } : { subjects: admission.policy.scope.subjects }))
      if (selector && 'allAgents' in selector && admission.policy.scope.mode !== 'all') throw new AppActionsManagementRefusal('ALL_SUBJECTS_NOT_GRANTED', 'All-agent reporting requires an all-agent grant; choose explicit granted subjects.')
      for (const [id, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(id) // Read-only snapshots confer no replayable write authority.
      if (tickets.size >= 2048) throw new AppActionsManagementRefusal('REPORT_CAPACITY', 'The read-report capacity is full.', 503)
      const snapshots = new Map<string, SettingsSnapshot>()
      const modelSelections = new Map<string, ModelSelectionSnapshot>()
      const instructions = new Map<string, InstructionTextRead>()
      const copySourceId = (args.query as { sourcePresetId?: string } | undefined)?.sourcePresetId
      const presetCopySource = copySourceId ? await captureModelPresetCopySource(context.userId, copySourceId) : undefined
      const includesModels = args.focus === undefined || (args.focus as string[]).some(id => id === 'agent.model.selection' || id === 'agent.model.preset-copy')
      const autoCompact = new Map<string, AutoCompactSnapshot>()
      const configuredTts = new Map<string, ConfiguredTtsTarget>()
      const includesTts = args.focus === undefined || (args.focus as string[]).includes('agent.voice.tts-selection')
      const voiceOnlyChoices = args.detail === 'choices' && Array.isArray(args.focus) && args.focus.length === 1 && args.focus[0] === 'agent.voice.tts-selection'
      let sharedVoiceCatalog: ConfiguredTtsTarget['catalog'] | undefined
      const includesAutoCompact = args.focus === undefined || (args.focus as string[]).includes('agent.context.auto-compact')
      const includesInstructions = args.focus === undefined || (args.focus as string[]).includes('agent.instructions')
      const includesMemory = args.focus === undefined || (args.focus as string[]).includes('agent.memory.preferences')
      let memoryReadiness: MemoryEnableReadinessSnapshot | undefined
      if (includesMemory && store.readMemoryReadiness) {
        try { memoryReadiness = await store.readMemoryReadiness() } catch { /* Other Memory preferences remain independently usable. */ }
      }
      const explicitInstructions = (args.query as { instructionText?: boolean } | undefined)?.instructionText === true
      const id = `asr_${boot}_${randomBytes(16).toString('hex')}`
      let ticket: ManagementReportTicket | undefined
      const readContext: SettingsReportReadContext = { userId: context.userId,
        canRead: subject => policyContainsSubject((ticket?.admission ?? admission).policy, subject, admission.actor.kind === 'native' ? admission.actor.id : undefined),
        check() {
          const current = ticket?.admission ?? admission
          if (current.actor.kind === 'native') nativeSettingsSignal(ticket?.context ?? context)
          else if (Date.now() >= (current.expiresAt ?? 0)) throw new AppActionsManagementRefusal('GRANT_EXPIRED', 'The token grant expired.')
        } }
      const sources = {
        async listIds(userId: string, kind: 'primary' | 'subagent') { return redis.execute(client => client.sMembers(`user:${userId}:${kind === 'primary' ? 'agents' : 'subagents'}`)) },
        async read(_userId: string, subject: SettingsSubjectRef) {
          const key = settingsSubjectKey(subject)
          let snapshot = snapshots.get(key)
          if (!snapshot) { snapshot = await store.read(subject.id, subject.kind === 'subagent' ? 'subagent' : 'primary'); snapshots.set(key, snapshot) }
          const record = recordFromSnapshot(subject, snapshot)
          if (includesTts && subject.kind === 'primary' && store.readConfiguredTts) {
            let voice = configuredTts.get(key)
            if (!voice) { try { voice = await store.readConfiguredTts(context.userId, subject.id, (args.query as { ttsProfileId?: string } | undefined)?.ttsProfileId, sharedVoiceCatalog); sharedVoiceCatalog ??= voice.catalog; configuredTts.set(key, voice) } catch (error) {
              record.__configuredTtsUnavailable = error instanceof Error && ['tts_model_selection_unavailable', 'tts_model_lock_ambiguous', 'tts_legacy_setup_not_migrated', 'tts_global_source_unavailable'].includes(error.message) ? error.message : 'tts_source_unavailable'
            } }
            if (voice) {
              if (voice.snapshot.record.id !== record.id || voice.snapshot.record.user_id !== record.user_id || JSON.stringify(voice.snapshot.lifecycle) !== JSON.stringify(snapshot.lifecycle)) throw new Error('Reply voice subject changed during report.')
              record.__configuredTts = voice
            }
          }
          if (includesMemory && subject.kind === 'primary') record.__memoryReadiness = memoryReadiness
            ? { status: memoryReadiness.status, reason: memoryReadiness.reason }
            : { status: 'configuration-unavailable', reason: 'memory_readiness_unavailable' }
          if (includesAutoCompact && subject.kind === 'primary' && store.readAutoCompact) {
            let compact = autoCompact.get(key)
            if (!compact) { compact = await store.readAutoCompact(context.userId, subject.id); autoCompact.set(key, compact) }
            if (compact.record.id !== record.id || compact.record.user_id !== record.user_id || compact.record.agentType !== record.agentType || JSON.stringify(compact.lifecycle) !== JSON.stringify(snapshot.lifecycle)) throw new Error('Auto Compact subject changed during report.')
            record.auto_compact_settings = compact.record.auto_compact_settings
            record.__autoCompactGlobal = compact.record.__autoCompactGlobal
          }
          if (includesInstructions && store.readInstructions) {
            let read = instructions.get(key)
            if (!read) { read = await store.readInstructions(context.userId, subject.id, subject.kind === 'subagent' ? 'subagent' : 'primary', { includeText: explicitInstructions }); instructions.set(key, read) }
            if (read.record.id !== record.id || read.record.user_id !== record.user_id || read.record[subject.kind === 'subagent' ? 'subagentType' : 'agentType'] !== record[subject.kind === 'subagent' ? 'subagentType' : 'agentType'] || JSON.stringify(read.lifecycle) !== JSON.stringify(snapshot.lifecycle)) throw new Error('Instructions subject changed during report.')
            record.__instructionMetadata = read.customPrompt
            if (Object.hasOwn(read.record, 'include_global_prompt')) record.include_global_prompt = read.record.include_global_prompt
          }
          if (includesModels && store.readSelection) {
            let model = modelSelections.get(key)
            if (!model) { model = await store.readSelection(subject.id, subject.kind === 'subagent' ? 'subagent' : 'primary'); modelSelections.set(key, model) }
            if (model.record.user_id !== record.user_id || model.record.id !== record.id || model.record[subject.kind === 'subagent' ? 'subagentType' : 'agentType'] !== record[subject.kind === 'subagent' ? 'subagentType' : 'agentType']) throw new Error('Model selection subject changed during report.')
            record.primary_model_preset_id = model.record.primary_model_preset_id
            record.__apiSubagentInherits = subject.kind === 'subagent' && model.record.subagentType === 'api' &&
              [model.record.primary_model_name, model.record.model].every(value => value == null || typeof value === 'string' && !value.trim())
          }
          return record
        }
      }
      const resolved = await createSettingsSubjectResolver(sources, inherited?.manifest)(selector, readContext)
      const manifest = inherited ? Object.freeze({ ...resolved, excluded: inherited.manifest.excluded,
        digest: createHash('sha256').update(JSON.stringify([resolved.digest, inherited.manifest.excluded])).digest('hex') }) : resolved
      const adapter = createManagementAdapterContext(admission, () => ticket?.context ?? context, Math.min(Date.now() + 30_000, admission.expiresAt ?? Infinity), {
        assertCurrent: () => { if (ticket) assertCurrent(ticket) },
        assertPermission: () => { if (domain === 'skill-access' && admission.policy.management.skillAccess === 'block') throw new AppActionsManagementRefusal('SKILL_ACCESS_BLOCKED', 'The user blocked skill access management.') }
      })
      const skillAccess = domain === 'skill-access' ? await MANAGEMENT_ADAPTER_BINDINGS['agent.skills.access'].read(adapter, args.query as SkillAccessQuery, manifest) : undefined
      const query = args.query as { presetText?: string; presetOffset?: number } | undefined
      const modelChoices = presetCopySource ? modelPresetCopyChoices(presetCopySource) : !skillAccess && includesModels && args.detail === 'choices' ? await readModelPresetSelectionChoices(context.userId,
        { text: query?.presetText, offset: query?.presetOffset }, manifest.entries.filter(entry => entry.status === 'available' && entry.type === 'api').map(entry => ({
          kind: entry.subject.kind === 'subagent' ? 'subagent' as const : 'agent' as const, id: entry.subject.id, type: 'api' as const }))) : undefined
      if (!skillAccess && voiceOnlyChoices && manifest.entries.filter(entry => entry.status === 'available').length !== 1) throw new AppActionsManagementRefusal('TTS_CHOICES_ONE_SUBJECT', 'Read reply voice choices for one explicit subject; batch changes can use the shared saved/static choice.', 400)
      const voiceChoices = !skillAccess && voiceOnlyChoices && configuredTts.size
        ? configuredTtsChoices(configuredTts.values().next().value!, args.query as Parameters<typeof configuredTtsChoices>[1]) : undefined
      const reservedBytes = settingsReportSerializedBytes({ ...wireMetadata({ id, domain, admission }), report: null }) - 4
      let textPages: ReturnType<typeof createInstructionTextPages> | undefined
      if (explicitInstructions) {
        const entry = manifest.entries[0]
        const read = entry && instructions.get(settingsSubjectKey(entry.subject))
        if (manifest.entries.length !== 1 || manifest.excluded.length || entry.status !== 'available' || !read) throw new AppActionsManagementRefusal('INSTRUCTIONS_READ_UNAVAILABLE', 'This exact granted instruction text is unavailable.', 409)
        textPages = createInstructionTextPages(read, { reservedBytes })
      }
      const report = textPages ?? (skillAccess ? createSkillAccessPages(skillAccess, manifest, args.detail as 'summary' | 'values' | 'choices' ?? 'summary') :
        await createSettingsReportSnapshot(manifest, { ...(args.focus !== undefined ? { focus: args.focus } : {}), ...(args.detail !== undefined ? { detail: args.detail } : {}) }, readContext,
          { read: sources.read, changeAvailability: 'admitted', reservedBytes, ...(modelChoices ? { modelChoices } : {}), ...(voiceChoices ? { voiceChoices } : {}) }))
      ticket = { id, domain, ...(presetCopySource ? { presetCopySource } : {}), ...(skillAccess ? { skillAccess } : {}), expiresAt: Math.min(Date.now() + 10 * 60_000, admission.expiresAt ?? Infinity), admission, context, manifest, snapshots, modelSelections, instructions, autoCompact, configuredTts, report }
      tickets.set(id, ticket)
      await refresh(id, context, lane)
      if (inherited) assertCurrent(inherited)
      return wire(ticket, report.page())
    },
    async continuation(ticket: ManagementReportTicket, context: SettingsManagementContext, lane: 'native' | 'portable') {
      await refreshCaptured(ticket, context, lane)
      // Resolve the same explicit IDs only. Never rerun allAgents or drop exclusions.
      const fresh = await api.report(context, lane, { ...(ticket.domain === 'skill-access' ? { domain: 'skill-access', ...(ticket.skillAccess!.rows.length ? { query: { skillIds: ticket.skillAccess!.choices.map(choice => choice.skillId) } } : {}) } : {}), detail: 'summary' }, ticket)
      const summary = fresh.report as SettingsReportPage // This call explicitly requests a summary, never text pages.
      return { reportId: fresh.reportId, bootNamespace: boot, observedAt: summary.observedAt, manifest: summary.manifest,
        changeRef: fresh.change.ref, requestId: `${boot}:<new-unique-request-id>`,
        reportRef: `fabric:${lane === 'native' ? SETTINGS_MANAGEMENT_CONTROL_IDS.nativeReport : SETTINGS_MANAGEMENT_CONTROL_IDS.portableReport}`,
        note: 'Fresh preconditions retain these exact subjects and exclusions. You can use reportId directly for the next admitted change; read its report page when more values are needed.' }
    },
    forOperation: refresh,
    forCapturedOperation: refreshCaptured,
    assertCurrent
  }
  return api
}
