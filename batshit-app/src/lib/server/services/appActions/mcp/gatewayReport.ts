import { createHash, randomBytes } from 'node:crypto'
import { apiKeyService } from '$lib/services/apiKey.server'
import { mcpGatewayService, type GatewayManagementSource, type PreparedGatewaySave } from '../../mcpGatewayService'
import { prepareMcpGatewayConfiguration } from '../../mcpGatewaySave'
import { MCP_CONFIGURATION_DOMAIN, MCP_CONFIGURATION_ID, MCP_REPORT_BUDGET_MS, MCP_CONFIGURATION_STAGES, composeMcpManagementMode,
  parseMcpConfigurationQuery, parseMcpPrerequisiteTarget, type McpGatewaySaveReview, type McpPrerequisiteReview, type McpPrerequisiteTarget } from '$lib/appActions/settings/mcpConfiguration'
import { SETTINGS_REPORT_BYTE_LIMITS } from '$lib/appActions/settings/reportContract'
import { parseMcpSourceCandidate } from './sourceCandidate'
import type { GatewayRawFence } from './gatewayWriteContext'
import { AppActionsManagementRefusal } from '../settings/authority'
import { admitSettingsManagementActor, sameSettingsAuthority, nativeSettingsSignal, requireSettingsSubjectAdmission, type SettingsManagementAdmission, type SettingsManagementContext } from '../settings/managementActor'
import { assertSettingsLifecycle } from '../settings/lifecycle'
import { planMcpTarget, type ConditionalSettingsStore, type McpTargetPostimage } from '../settings/conditionalAgentSettings'

export type McpGatewayReportTicket = {
  domain: typeof MCP_CONFIGURATION_DOMAIN; id: string; boot: string; expiresAt: number
  captureDeadlineAt: number
  admission: SettingsManagementAdmission; context: SettingsManagementContext
  sources: readonly GatewayManagementSource[]
  prepared?: { plan: PreparedGatewaySave; review: McpGatewaySaveReview; keyFences: readonly GatewayRawFence[] }
  store: ConditionalSettingsStore
  prerequisite?: { intent: McpPrerequisiteTarget; postimage: McpTargetPostimage; review: McpPrerequisiteReview }
  report: { page(cursor?: string): Record<string, unknown> }
}
const revision = (source: GatewayManagementSource) => `sha256:${createHash('sha256').update(JSON.stringify(source)).digest('hex')}`
export function assertMcpReportCurrent(ticket: McpGatewayReportTicket): void {
  const { admission } = ticket
  if (!admission.fence.lifecycle) throw new AppActionsManagementRefusal('AUTHORITY_LIFECYCLE_REQUIRED', 'The original MCP authority is unavailable.', 409)
  assertSettingsLifecycle(admission.fence.lifecycle)
  if (ticket.prerequisite) assertSettingsLifecycle(ticket.prerequisite.postimage.before.lifecycle)
  if (!admission.policy.enabled || admission.policy.management.mcpManagement === 'block') throw new AppActionsManagementRefusal('MCP_MANAGEMENT_BLOCKED', 'The user blocked MCP management.')
  if (Date.now() >= (admission.expiresAt ?? Infinity)) throw new AppActionsManagementRefusal('GRANT_EXPIRED', 'The original token grant expired.')
  if (admission.actor.kind === 'native') nativeSettingsSignal(ticket.context)
}
export async function refreshMcpReport(ticket: McpGatewayReportTicket, context: SettingsManagementContext, lane: 'native' | 'portable', checkRequest: () => void = () => {}) {
  checkRequest()
  const current = await admitSettingsManagementActor(context, lane)
  checkRequest()
  if (!sameSettingsAuthority(ticket.admission, current) || ticket.admission.actor.sessionId !== current.actor.sessionId) throw new AppActionsManagementRefusal('REPORT_AUTHORITY_CHANGED', 'The original MCP report authority changed.', 409)
  const sources = await mcpGatewayService.readManagementSources(current.actor.userId)
  checkRequest()
  for (const source of ticket.sources) {
    if (!sources.some(row => row.id === source.id && row.created_at === source.created_at)) throw new AppActionsManagementRefusal('MCP_SOURCE_CHANGED', 'A held MCP source was removed or replaced.', 409)
  }
  if (ticket.prerequisite) {
    const held = ticket.prerequisite
    requireSettingsSubjectAdmission(current, held.intent.subject)
    if (!ticket.store.readMcpTarget) throw new AppActionsManagementRefusal('MCP_TARGET_OWNER_UNAVAILABLE', 'The fixed MCP target owner is unavailable.', 409)
    const target = await ticket.store.readMcpTarget(current.actor.userId, held.intent.subject, held.postimage.settingsIdentity)
    checkRequest()
    if (JSON.stringify(target.lifecycle) !== JSON.stringify(held.postimage.before.lifecycle) || JSON.stringify(target.raw) !== JSON.stringify(held.postimage.before.raw) ||
      target.globalRaw !== held.postimage.before.globalRaw) throw new AppActionsManagementRefusal('MCP_TARGET_CHANGED', 'The held Primary membership or Zip inheritance changed. Request a fresh plan.', 409)
  }
  const settled = await admitSettingsManagementActor(context, lane)
  checkRequest()
  if (!sameSettingsAuthority(current, settled)) throw new AppActionsManagementRefusal('REPORT_AUTHORITY_CHANGED', 'MCP authority changed during this read.', 409)
  ticket.admission = settled; ticket.context = context
  assertMcpReportCurrent(ticket)
  return ticket
}
/** Bounded first-action envelope, independent of the retained report/review lifetime. */
export async function mcpReportRequest<Result>(context: SettingsManagementContext, lane: 'native' | 'portable', run: (check: () => void, deadlineAt: number) => Promise<Result>): Promise<Result> {
  const requestBudget = lane === 'portable' ? 5000 : MCP_REPORT_BUDGET_MS
  const deadlineAt = Date.now() + requestBudget
  const signal = lane === 'native' ? nativeSettingsSignal(context) : undefined
  let apiOwner: typeof import('./originalTask') | undefined
  let rejectEnded: (error: unknown) => void = () => {}
  const ended = new Promise<never>((_resolve, reject) => { rejectEnded = reject })
  void ended.catch(() => {})
  const abort = () => rejectEnded(new AppActionsManagementRefusal('MCP_REPORT_ENDED', 'The MCP report stopped or expired.', 409))
  const timer = setTimeout(abort, requestBudget)
  signal?.addEventListener('abort', abort, { once: true })
  const check = () => {
    if (Date.now() >= deadlineAt || signal?.aborted) throw new AppActionsManagementRefusal('MCP_REPORT_ENDED', 'The MCP report stopped or expired.', 409)
    if (lane === 'native') nativeSettingsSignal(context)
    if (apiOwner && context.p5ApiRun) apiOwner.assertP5ApiRunCurrent(context.p5ApiRun, context)
  }
  try {
    check()
    if (context.p5ApiRun) { apiOwner = await import('./originalTask'); check() }
    const result = await Promise.race([run(check, deadlineAt), ended]); check(); return result
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
export async function captureMcpGatewayReport(input: {
  id: string; boot: string; context: SettingsManagementContext; lane: 'native' | 'portable'; query: Record<string, unknown>; detail: 'summary' | 'values' | 'choices'
  store: ConditionalSettingsStore
}): Promise<McpGatewayReportTicket> {
  return mcpReportRequest(input.context, input.lane, async (check, captureDeadlineAt) => {
    const query = parseMcpConfigurationQuery(input.query)
    const full = query.kind === 'prerequisite'
    if (full && (input.lane !== 'native' || input.context.actorType !== 'in-process' || !input.context.p5ApiRun || input.context.delegatedRun)) {
      throw new AppActionsManagementRefusal('MCP_PREREQUISITE_API_REQUIRED', 'This full prerequisite currently requires its genuine original Primary. Other cohorts remain unavailable.', 409)
    }
    const candidate = query.kind === 'candidate' || full && query.candidate !== undefined ? parseMcpSourceCandidate(query.candidate) : undefined
    if (full && candidate && candidate.kind !== 'http' && candidate.kind !== 'existing') throw new AppActionsManagementRefusal('MCP_PREREQUISITE_COHORT_UNAVAILABLE', 'This full prerequisite currently supports a custom HTTP source or an unchanged installed saved STDIO source only.', 409)
    const admission = await admitSettingsManagementActor(input.context, input.lane)
    check()
    if (admission.policy.management.mcpManagement === 'block') throw new AppActionsManagementRefusal('MCP_MANAGEMENT_BLOCKED', 'The user blocked MCP management.')
    const all = await mcpGatewayService.readManagementSources(admission.actor.userId)
    check()
    const targetQuery = full ? query.target as Record<string, unknown> : undefined
    const selectedId = query.kind === 'details' ? query.gatewayId : candidate && (candidate.kind === 'existing' || candidate.kind === 'docker') ? candidate.gatewayId :
      full && !candidate ? targetQuery?.gatewayId : undefined
    const sources = selectedId === undefined ? all : all.filter(row => row.id === selectedId)
    if (selectedId !== undefined && sources.length !== 1 && !(full && targetQuery?.membership === 'disable' && sources.length === 0)) throw new AppActionsManagementRefusal('MCP_SOURCE_UNAVAILABLE', 'That exact saved MCP source is unavailable.', 409)
    if (candidate && (candidate.kind === 'existing' || candidate.kind === 'docker') && revision(sources[0]) !== candidate.expectedRevision) {
      throw new AppActionsManagementRefusal('MCP_SOURCE_CHANGED', 'The held nonsecret MCP source metadata changed.', 409)
    }
    let prepared: McpGatewayReportTicket['prepared']
    if (candidate) {
      const captured = await prepareMcpGatewayConfiguration(admission.actor.userId, candidate, full && targetQuery?.membership === 'enable')
      check()
      const refs = [...new Set([...(captured.review.after.savedKeyRef ? [captured.review.after.savedKeyRef] : []),
        ...(captured.review.after.stdio?.envRefs.map(row => row.savedKeyRef) ?? [])])]
      const fences: GatewayRawFence[] = []
      for (const ref of refs) {
        const key = await apiKeyService.readReferenceState(ref, admission.actor.userId)
        check()
        if (!key.present || !key.shapeValid) throw new AppActionsManagementRefusal('MCP_KEY_REFERENCE_UNAVAILABLE', 'An exact saved-key reference is absent or malformed. Presence never proves readiness.', 409)
        fences.push({ key: key.key, paths: [['$', key.raw]] })
      }
      prepared = { ...captured, keyFences: fences }
    }
    let prerequisite: McpGatewayReportTicket['prerequisite']
    if (full) {
      if (!input.store.readMcpTarget) throw new AppActionsManagementRefusal('MCP_TARGET_OWNER_UNAVAILABLE', 'The fixed MCP target owner is unavailable.', 409)
      if (!prepared && targetQuery?.membership === 'enable') {
        const captured = await mcpGatewayService.prepareGatewaySave(admission.actor.userId, { mode: 'update', gatewayId: String(targetQuery.gatewayId), updates: stored => stored.type === 'stdio' ? { enabled: true } : {} })
        check()
        const fences: GatewayRawFence[] = []
        const refs = [...new Set([...(captured.review.after.savedKeyRef ? [captured.review.after.savedKeyRef] : []), ...(captured.review.after.stdio?.envRefs.map(row => row.savedKeyRef) ?? [])])]
        for (const ref of refs) {
          const key = await apiKeyService.readReferenceState(ref, admission.actor.userId)
          check()
          if (!key.present || !key.shapeValid) throw new AppActionsManagementRefusal('MCP_KEY_REFERENCE_UNAVAILABLE', 'The exact required saved-key reference is unavailable.', 409)
          fences.push({ key: key.key, paths: [['$', key.raw]] })
        }
        prepared = { ...captured, keyFences: fences }
      }
      const intent = parseMcpPrerequisiteTarget({ ...targetQuery, gatewayId: prepared?.review.resource.gatewayId ?? targetQuery?.gatewayId })
      if (targetQuery?.gatewayId !== undefined && targetQuery.gatewayId !== intent.gatewayId) throw new AppActionsManagementRefusal('MCP_SOURCE_CHANGED', 'The exact source and target membership differ.', 409)
      requireSettingsSubjectAdmission(admission, intent.subject)
      if (prepared) mcpGatewayService.assertPreparedMcpPrerequisiteCohort(prepared.plan)
      // Read selection first without inventing a Zip alias or inheritance.
      const membership = await input.store.readMcpTarget(admission.actor.userId, intent.subject)
      check()
      let settingsIdentity = intent.zip?.toolName
      if (intent.zip && intent.membership === 'enable') {
        const selected = membership.row.defaultMCPGateways ?? membership.row.default_mcp_gateways ?? []
        if (!Array.isArray(selected) || selected.some(id => typeof id !== 'string')) throw new AppActionsManagementRefusal('MCP_ZIP_IDENTITY_UNAVAILABLE', 'The actual logical tool selection is unavailable.', 409)
        const discovery = await import('../../mcpGatewayDiscovery'); check()
        const source = prepared!.review.after
        settingsIdentity = await discovery.mcpGatewayDiscovery.resolveP5ZipSettingsIdentity(input.context.p5ApiRun!, intent.subject.id,
          { ...source, created_at: '' } as import('$lib/types/database').MCPGateway, intent.zip.toolName, selected)
        check()
      }
      const before = intent.zip ? await input.store.readMcpTarget(admission.actor.userId, intent.subject, settingsIdentity) : membership
      check()
      assertSettingsLifecycle(membership.lifecycle)
      if (JSON.stringify(before.raw.slice(0, membership.raw.length)) !== JSON.stringify(membership.raw)) throw new AppActionsManagementRefusal('MCP_TARGET_CHANGED', 'The original membership changed while resolving its exact Zip identity.', 409)
      const postimage = planMcpTarget(before, intent, settingsIdentity)
      const removal = intent.membership === 'disable'
      const review: McpPrerequisiteReview = { kind: 'mcp-configuration', variant: 'prerequisite',
        planId: prepared?.review.planId ?? `mcpp_${randomBytes(16).toString('hex')}`, candidateId: prepared?.review.candidateId ?? `mcpc_${randomBytes(16).toString('hex')}`,
        mode: removal ? 'remove' : 'configure', resource: { kind: 'mcp-gateway', gatewayId: intent.gatewayId },
        sourceAction: removal ? 'absent' : candidate?.kind === 'http' || prepared!.review.after.type === 'stdio' && prepared!.review.before?.enabled === false ? 'save' : 'unchanged',
        before: removal ? null : prepared!.review.before, after: removal ? null : prepared!.review.after,
        intent, target: postimage.review, stages: [...MCP_CONFIGURATION_STAGES] }
      prerequisite = { intent, postimage, review }
    }
    const cursorKey = randomBytes(16).toString('hex'), observedAt = new Date().toISOString()
    const rows = prerequisite ? [{ kind: 'prerequisite', candidateId: prerequisite.review.candidateId, gatewayId: prerequisite.intent.gatewayId,
      target: prerequisite.intent.subject, membership: prerequisite.intent.membership, ...(prerequisite.intent.zip ? { zip: prerequisite.intent.zip } : {}),
      permission: composeMcpManagementMode(admission.policy.management.mcpManagement, admission.policy.protected.contextManagement, !!prerequisite.intent.zip),
      prerequisite: 'source-verification-target', readiness: 'unknown' }] : prepared ? [{ kind: 'candidate', candidateId: prepared.review.candidateId, gatewayId: prepared.review.resource.gatewayId,
      mode: prepared.review.mode, name: prepared.review.after.name, type: prepared.review.after.type, prerequisite: 'gateway_save_only', readiness: 'unknown' }] :
      sources.map(source => ({ ...source, revision: revision(source), readiness: 'unknown' }))
    const frozenRows = structuredClone(rows), issuedOffsets = new Set<number>([0])
    const ticket: McpGatewayReportTicket = { id: input.id, boot: input.boot, domain: MCP_CONFIGURATION_DOMAIN, captureDeadlineAt,
      expiresAt: Math.min(Date.now() + 600_000, admission.expiresAt ?? Infinity), admission, context: input.context,
      sources: structuredClone(sources), store: input.store, ...(prepared ? { prepared } : {}), ...(prerequisite ? { prerequisite } : {}), report: { page(cursor) {
        let offset = 0
        if (cursor !== undefined) {
          const match = /^mcp1:([a-f0-9]{32}):([0-9]{1,3})$/.exec(cursor)
          if (!match || match[1] !== cursorKey) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'Use this MCP report and its issued cursor.', 400)
          offset = Number(match[2])
          if (!issuedOffsets.has(offset)) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'Use only an issued MCP report cursor.', 400)
        }
        if (offset > frozenRows.length) throw new AppActionsManagementRefusal('INVALID_REPORT_PAGE', 'That MCP page is beyond the held report.', 400)
        const selected: unknown[] = []
        const build = () => ({ detail: input.detail, observedAt, rows: [...selected], total: frozenRows.length,
          next: offset + selected.length < frozenRows.length ? `mcp1:${cursorKey}:${offset + selected.length}` : null })
        for (const row of frozenRows.slice(offset)) {
          if (selected.length >= 64) break
          selected.push(row)
          // Leave fixed room for the existing four-ref wrapper metadata.
          if (Buffer.byteLength(JSON.stringify(build()), 'utf8') > SETTINGS_REPORT_BYTE_LIMITS[input.detail] - 1536) { selected.pop(); break }
        }
        if (offset < frozenRows.length && !selected.length) throw new AppActionsManagementRefusal('REPORT_BUDGET', 'The complete MCP row exceeds its report budget.', 409)
        const page = build()
        if (page.next) issuedOffsets.add(offset + selected.length)
        return structuredClone(page)
      } } }
    await refreshMcpReport(ticket, input.context, input.lane)
    check(); assertMcpReportCurrent(ticket)
    return ticket
  })
}
export function wireMcpGatewayReport(ticket: McpGatewayReportTicket, cursor?: string, readDeadlineAt = ticket.captureDeadlineAt) {
  assertMcpReportCurrent(ticket)
  if (Date.now() >= readDeadlineAt) throw new AppActionsManagementRefusal('MCP_REPORT_ENDED', 'The MCP report request expired before handoff.', 409)
  if (Date.now() >= ticket.expiresAt) throw new AppActionsManagementRefusal('REPORT_EXPIRED', 'Request a fresh MCP report.', 409)
  const result = { domain: ticket.domain, bootNamespace: ticket.boot, reportId: ticket.id, report: ticket.report.page(cursor),
    change: { ref: `fabric:sys.app_settings.${ticket.admission.actor.kind === 'native' ? 'native' : 'portable'}.change`,
      semanticId: MCP_CONFIGURATION_ID, permission: composeMcpManagementMode(ticket.admission.policy.management.mcpManagement, ticket.admission.policy.protected.contextManagement, !!ticket.prerequisite?.intent.zip),
      note: ticket.prerequisite ? 'One held source, exact owned Primary membership and explicit Zip intent. This report is not verification, tool-use or continuation authority.' :
        'Internal gateway-save prerequisite only. No installation, connection, verification, original-task use or Zip completion is implied.' } }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > SETTINGS_REPORT_BYTE_LIMITS[result.report.detail as 'summary' | 'values' | 'choices']) throw new AppActionsManagementRefusal('REPORT_BUDGET', 'The MCP report exceeds its whole page budget.', 409)
  return result
}
