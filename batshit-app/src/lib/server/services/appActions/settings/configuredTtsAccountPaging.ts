import { randomBytes } from 'node:crypto'
import {
  CONFIGURED_FISH_ACCOUNT_LIMITS as LIMIT, isConfiguredFishAccountCursor, validTtsId,
  type ConfiguredFishAccountChoice, type ConfiguredFishAccountPage, type ConfiguredFishAccountReportPage,
  type ConfiguredTtsAccountReadFailure
} from '$lib/appActions/settings/configuredTtsPreferences'
import type { AdapterContext, SettingsManagementAdmission } from '../managementTypes'
import type { ConfiguredTtsTarget } from './configuredTtsSources'
import { AppActionsManagementRefusal } from './authority'
import { sameSettingsAuthority, requireSettingsSubjectAdmission } from './managementActor'
import { assertSettingsLifecycle, SettingsLifecycleRefusal } from './lifecycle'
import { readConfiguredTtsAccountCatalog, assertConfiguredTtsAccountEnvironment, type ConfiguredTtsAccountSource } from './configuredTtsAccountCatalog'

/** This type is constructed only by the private report ticket, never parsed from tool input. */
export type HeldConfiguredFishChoice = Readonly<{
  subject: Readonly<{ kind: 'primary'; id: string }>
  choice: ConfiguredFishAccountChoice; source: ConfiguredTtsAccountSource
  observedAt: string; extent: 'credential-workspace'; queryModelId: string | null
}>
type Action = Readonly<{ providerPage: number; offset: number }>
type StoredPage = Readonly<{ page: ConfiguredFishAccountPage; choices: readonly ConfiguredFishAccountChoice[] }>
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
const refuse = (code: string, message: string, status = 409): never => { throw new AppActionsManagementRefusal(code, message, status) }

/** One ticket's finite Fish observation/cache. No registry, endpoint, secret or writable grant. */
export function createConfiguredFishAccountPages(options: Readonly<{
  subject: Readonly<{ kind: 'primary'; id: string }>; target: ConfiguredTtsTarget; admission: SettingsManagementAdmission
  modelId: string | null; manifestDigest: string; expiresAt: number
}>) {
  const subject = Object.freeze({ ...options.subject }), snapshotId = randomBytes(32).toString('hex'), observedAt = new Date().toISOString()
  const { target, admission, modelId, manifestDigest, expiresAt } = options
  const originalActor = admission.actor
  const issued = new Map<number, Action>(), settled = new Map<number, Promise<ConfiguredFishAccountReportPage>>()
  const peeked = new Map<number, ConfiguredFishAccountReportPage>(), providerPages = new Map<number, StoredPage>()
  const held = new Map<string, HeldConfiguredFishChoice>()
  let sequence = 0, source: ConfiguredTtsAccountSource | undefined, rawCount = 0, filteredCount = 0, rejectedCount = 0, duplicateCount = 0
  let firstTotal: number | null | undefined, consistentTotal = true
  const initial: Action = Object.freeze({ providerPage: 1, offset: 0 })
  function check(ctx: AdapterContext) {
    ctx.assertCurrent()
    if (!sameSettingsAuthority(admission, ctx.admission) || originalActor.sessionId !== ctx.admission.actor.sessionId) refuse('REPORT_AUTHORITY_CHANGED', 'The account report authority changed.')
    requireSettingsSubjectAdmission(ctx.admission, subject)
    assertSettingsLifecycle(target.snapshot.lifecycle); target.checkEnvironment()
    if (Date.now() >= expiresAt) refuse('REPORT_EXPIRED', 'Request a fresh reply-voice report.')
  }
  function position(cursor?: string): number {
    if (cursor === undefined) return 0
    if (!isConfiguredFishAccountCursor(cursor)) refuse('INVALID_REPORT_PAGE', 'Use an issued Fish account cursor.', 400)
    const [, id, raw] = cursor.split(':'), value = Number(raw)
    if (id !== snapshotId || !issued.has(value)) refuse('INVALID_REPORT_PAGE', 'That account position was not issued by this report.')
    return value
  }
  function issue(action: Action) {
    if (sequence >= LIMIT.heldRows + LIMIT.providerPages) refuse('TTS_ACCOUNT_SOURCE_LIMIT', 'This account report reached its finite cursor limit.')
    const id = ++sequence; issued.set(id, Object.freeze({ ...action })); return `sv1:${snapshotId}:${id}`
  }
  function pageDto(input: Readonly<{
    status: 'listed' | 'unavailable'; reason?: ConfiguredTtsAccountReadFailure; page?: ConfiguredFishAccountPage
    choices?: readonly ConfiguredFishAccountChoice[]; remaining?: number; nextCursor?: string | null; complete?: boolean
  }>): ConfiguredFishAccountReportPage {
    const page = input.page, choices = input.choices ?? []
    return Object.freeze({ schemaVersion: 1, basis: 'internal-read-snapshot', domain: 'agent-settings', detail: 'choices', change: 'admitted', snapshotId, observedAt, subject,
      manifest: Object.freeze({ digest: manifestDigest, targets: 1, excluded: 0, unavailable: 0 }), providerId: 'fish', modelId,
      speechToSpeechLocked: target.locked, localChoices: 'independent-configured-query', account: Object.freeze({ status: input.status,
        ...(input.reason ? { reason: input.reason } : {}), extent: 'credential-workspace', modelScope: 'unknown', observedAt: page?.observedAt ?? null,
        choices: Object.freeze([...choices]), observedCount: held.size, rawCount, filteredCount, rejectedCount,
        reportedTotal: page?.reportedTotal ?? null, totalExact: page?.totalExact ?? null, windowLimited: page?.windowLimited ?? null,
        accessibleUpperBound: page?.accessibleUpperBound ?? null, maxOffset: page?.maxOffset ?? null, hasMore: page?.hasMore ?? null, providerPages: providerPages.size, complete: input.complete === true }),
      continuation: Object.freeze({ totalRows: held.size, returned: choices.length, remaining: input.remaining ?? 0, nextCursor: input.nextCursor ?? null }) })
  }
  if (bytes(pageDto({ status: 'unavailable', reason: 'list_unavailable' })) > LIMIT.pageBytes) refuse('REPORT_BUDGET', 'The account report identity exceeds its bounded page budget.')
  function sourceMatches(next: ConfiguredTtsAccountSource) {
    if (!source) return true
    return source.providerId === next.providerId && source.environmentStamp === next.environmentStamp && source.credential.key === next.credential.key && source.credential.raw === next.credential.raw
  }
  async function load(number: number, ctx: AdapterContext): Promise<StoredPage | ConfiguredTtsAccountReadFailure> {
    const cached = providerPages.get(number)
    if (cached) return cached
    if (number !== providerPages.size + 1 || number > LIMIT.providerPages) return 'source_limit'
    check(ctx)
    const read = await readConfiguredTtsAccountCatalog(ctx, target, { providerId: 'fish', page: number, modelId }, source)
    check(ctx)
    if (read.status !== 'listed') return read.reason
    if (read.page.providerId !== 'fish' || read.page.page !== number || read.page.pageSize !== 100 || read.page.choices.length > 100 ||
        read.page.nextPage !== null && read.page.nextPage !== number + 1) return 'invalid_payload'
    const keyGuard = target.providers.find(provider => provider.id === 'fish')?.guards.find(guard => 'raw' in guard && guard.key === read.source.credential.key && guard.path === '$')
    if (!keyGuard || !('raw' in keyGuard) || keyGuard.raw !== read.source.credential.raw || !sourceMatches(read.source)) return 'source_changed'
    const capturedSource: ConfiguredTtsAccountSource = source ?? Object.freeze({ providerId: 'fish', environmentStamp: read.source.environmentStamp,
      credential: Object.freeze({ key: read.source.credential.key, path: '$', raw: read.source.credential.raw }), observedAt: read.source.observedAt, modelScope: 'unknown' })
    const safe: ConfiguredFishAccountChoice[] = [], additions: HeldConfiguredFishChoice[] = []
    for (const row of read.page.choices) {
      if (row.source !== 'provider-list' || row.providerId !== 'fish' || row.modelId !== null || row.profileId !== null || row.modelScope !== 'unknown' ||
          !validTtsId(row.voiceId) || !row.label.isWellFormed() || Buffer.byteLength(row.label, 'utf8') > 200 || /[\u0000-\u001f\u007f]/.test(row.label)) return 'invalid_payload'
      const choice: ConfiguredFishAccountChoice = Object.freeze({ source: 'provider-list', providerId: 'fish', voiceId: row.voiceId, profileId: null, modelId: null,
        label: row.label, labelTruncated: row.labelTruncated, modelScope: 'unknown' })
      const existing = held.get(choice.voiceId)
      if (existing) { if (JSON.stringify(existing.choice) !== JSON.stringify(choice)) return 'invalid_payload'; duplicateCount++; continue }
      additions.push(Object.freeze({ subject, choice, source: capturedSource, observedAt: read.page.observedAt, extent: 'credential-workspace', queryModelId: modelId }))
      safe.push(choice)
    }
    if (held.size + additions.length > LIMIT.heldRows || bytes([...held.values(), ...additions].map(fact => ({ choice: fact.choice, observedAt: fact.observedAt }))) > LIMIT.heldBytes) return 'source_limit'
    source ??= capturedSource
    additions.forEach(fact => held.set(fact.choice.voiceId, fact))
    rawCount += read.page.rawCount; filteredCount += read.page.filteredCount; rejectedCount += read.page.rejectedCount
    if (firstTotal === undefined) firstTotal = read.page.reportedTotal
    else if (firstTotal !== read.page.reportedTotal) consistentTotal = false
    const stored = Object.freeze({ page: read.page, choices: Object.freeze(safe) }); providerPages.set(number, stored)
    return stored
  }
  async function build(action: Action, ctx: AdapterContext) {
    const read = await load(action.providerPage, ctx)
    check(ctx)
    if (typeof read === 'string') return pageDto({ status: 'unavailable', reason: read })
    const selected: ConfiguredFishAccountChoice[] = [], page = read.page
    const remaining = () => read.choices.length - action.offset - selected.length
    const complete = page.hasMore === false && page.windowLimited === false && page.totalExact === true && page.reportedTotal !== null &&
      consistentTotal && rawCount === page.reportedTotal && !rejectedCount && !duplicateCount && !page.limitReached
    for (const row of read.choices.slice(action.offset, action.offset + LIMIT.pageRows)) {
      selected.push(row)
      if (bytes(pageDto({ status: 'listed', page, choices: selected, remaining: remaining(), nextCursor: `sv1:${snapshotId}:1010`, complete })) > LIMIT.pageBytes) { selected.pop(); break }
    }
    if (!selected.length && action.offset < read.choices.length) refuse('REPORT_BUDGET', 'A Fish choice exceeds the bounded report page.')
    const next = remaining() > 0 ? issue({ providerPage: action.providerPage, offset: action.offset + selected.length }) :
      page.nextPage !== null ? issue({ providerPage: page.nextPage, offset: 0 }) : null
    return pageDto({ status: 'listed', page, choices: selected, remaining: remaining(), nextCursor: next, complete,
      ...(page.limitReached || page.windowLimited === true ? { reason: 'source_limit' as const } : page.hasMore === null ? { reason: 'continuation_unavailable' as const } : {}) })
  }
  return Object.freeze({
    subject, snapshotId,
    async page(ctx: AdapterContext, cursor?: string): Promise<ConfiguredFishAccountReportPage> {
      check(ctx)
      const id = position(cursor)
      let pending = settled.get(id)
      if (!pending) {
        const action = id === 0 ? initial : issued.get(id)!
        pending = build(action, ctx).catch(error => {
          if (error instanceof AppActionsManagementRefusal || error instanceof SettingsLifecycleRefusal) throw error
          return pageDto({ status: 'unavailable', reason: 'list_unavailable' })
        }).then(value => { peeked.set(id, value); return value })
        settled.set(id, pending); void pending.catch(() => {})
      }
      const result = await pending
      check(ctx)
      return result
    },
    peek(cursor?: string) { const page = peeked.get(position(cursor)); if (!page) return refuse('ACCOUNT_PAGE_PENDING', 'This exact account page has not settled.'); return page },
    source() { return source },
    checkSource() { if (source) assertConfiguredTtsAccountEnvironment(source); assertSettingsLifecycle(target.snapshot.lifecycle); target.checkEnvironment() },
    unavailable(reason: ConfiguredTtsAccountReadFailure) { return pageDto({ status: 'unavailable', reason }) },
    find(voiceId: string): HeldConfiguredFishChoice | undefined { if (Date.now() >= expiresAt) return refuse('REPORT_EXPIRED', 'Request a fresh reply-voice report.'); return held.get(voiceId) }
  })
}
