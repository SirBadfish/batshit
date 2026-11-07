import type { CatalogModel, CatalogModelIdVariant, CatalogReasoningEvidence, CatalogReasoningLastGood, CatalogReasoningProjection } from '$lib/types/modelCatalog'
import { resolveCatalogConnectionLimits, resolveCatalogConnectionPricing } from './catalogConnectionLimits'
import { isReasoningBudgetValue } from './modelReasoningBudget'
import { HOSTED_CATALOG_DIRECT_PROVIDER_IDS } from '$lib/data/hostedCatalogConnections'

type Identity = { connectionId: string; effectiveId: string }
const PUBLIC_DIRECT = new Set<string>(HOSTED_CATALOG_DIRECT_PROVIDER_IDS)
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value)
const date = (value: unknown) => text(value) && Number.isFinite(Date.parse(value as string))

export function isPublicReasoningConnection(id: string): boolean {
  return id === 'vercel-gateway' || id === 'openrouter' || id.startsWith('direct:') && PUBLIC_DIRECT.has(id.slice(7))
}

function validControl(control: unknown): boolean {
  if (!object(control)) return false
  const allowed = control.kind === 'toggle' ? ['id', 'kind', 'defaultValue']
    : control.kind === 'budget' ? ['id', 'kind', 'min', 'max', 'specialValues', 'defaultValue']
      : control.kind === 'effort' || control.kind === 'mode' ? ['id', 'kind', 'values', 'defaultValue'] : []
  if (!allowed.length || Object.keys(control).some(key => !allowed.includes(key))) return false
  if (control.id === 'thinking' && control.kind === 'toggle') return control.defaultValue === undefined || typeof control.defaultValue === 'boolean'
  if ((control.id === 'effort' && control.kind === 'effort') || (control.id === 'mode' && control.kind === 'mode')) {
    return Array.isArray(control.values) && control.values.length > 0 && control.values.length <= 64 &&
      control.values.every(text) && new Set(control.values).size === control.values.length &&
      (control.defaultValue === undefined || control.values.includes(control.defaultValue))
  }
  if (control.id !== 'budget' || control.kind !== 'budget') return false
  const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value)
  return integer(control.min) && control.min >= 0 && (control.max === undefined || integer(control.max) && control.max >= control.min) &&
    (control.specialValues === undefined || Array.isArray(control.specialValues) && control.specialValues.length <= 16 &&
      control.specialValues.every(integer) && new Set(control.specialValues).size === control.specialValues.length) &&
    (control.defaultValue === undefined || isReasoningBudgetValue({ id: 'budget', kind: 'budget', min: control.min, max: control.max, specialValues: control.specialValues }, control.defaultValue))
}

/** Remote evidence is data only. Unknown executable/adapter properties never become mappings. */
export function readCatalogReasoningEvidence(value: unknown, identity: Identity): CatalogReasoningEvidence | null {
  if (!isPublicReasoningConnection(identity.connectionId) || !object(value) || !object(value.lastAttempt)) return null
  if (Object.keys(value).some(key => !['lastGood', 'lastAttempt'].includes(key))) return null
  const attempt = value.lastAttempt
  if (Object.keys(attempt).some(key => !['at', 'outcome', 'reason'].includes(key))) return null
  if (!date(attempt.at) || !['verified', 'unavailable', 'conflict'].includes(attempt.outcome) ||
    (attempt.reason !== undefined && !text(attempt.reason))) return null
  const good = value.lastGood
  if (good !== undefined) {
    if (!object(good) || good.version !== 1 || good.scope !== 'public' ||
      good.connection !== identity.connectionId || good.effectiveModelId !== identity.effectiveId ||
      !['supported', 'unsupported'].includes(good.support) || !text(good.endpoint) || !date(good.lastVerified) ||
      !Array.isArray(good.controls) || good.controls.length > 16 || !good.controls.every(validControl) ||
      new Set(good.controls.map((control: any) => control.id)).size !== good.controls.length ||
      (good.support === 'supported') !== (good.controls.length > 0) ||
      !Array.isArray(good.evidence) || good.evidence.length === 0 || good.evidence.length > 16 ||
      !good.evidence.every((source: unknown) => {
        if (!object(source) || Object.keys(source).some(key => !['url', 'checkedAt'].includes(key)) || !date(source.checkedAt) || !text(source.url)) return false
        try { const url = new URL(source.url); return url.protocol === 'https:' && !url.username && !url.password }
        catch { return false }
      }) || good.runtime !== undefined && (!object(good.runtime) || Object.keys(good.runtime).some(key => !['id', 'version'].includes(key)) || !text(good.runtime.id) || !text(good.runtime.version))) return null
    if (Object.keys(good).some(key => !['version', 'scope', 'support', 'connection', 'effectiveModelId', 'endpoint', 'controls', 'evidence', 'lastVerified', 'runtime'].includes(key))) return null
  } else if (attempt.outcome === 'verified') return null
  return structuredClone(value) as CatalogReasoningEvidence
}

function preservesChoices(previous: CatalogReasoningLastGood, next: CatalogReasoningLastGood): boolean {
  if (previous.endpoint !== next.endpoint || JSON.stringify(previous.runtime) !== JSON.stringify(next.runtime)) return false
  return previous.controls.every(old => {
    const current = next.controls.find(control => control.id === old.id)
    if (!current || old.kind !== current.kind || JSON.stringify(old.defaultValue) !== JSON.stringify(current.defaultValue)) return false
    if ('values' in old && 'values' in current) return old.values.every(value => current.values.includes(value))
    if (old.kind === 'budget' && current.kind === 'budget') return current.min <= old.min &&
      (old.max === undefined ? current.max === undefined : current.max === undefined || current.max >= old.max) &&
      (old.specialValues ?? []).every(value => isReasoningBudgetValue(current, value))
    return true
  })
}

/** Missing metadata is no reasoning refresh. A failed attempt can update health, never facts. */
export function mergeCatalogReasoningEvidence(previous: unknown, incoming: unknown, identity: Identity): CatalogReasoningEvidence | undefined {
  if (previous === undefined && incoming === undefined) return undefined
  if (!isPublicReasoningConnection(identity.connectionId)) throw new Error('Non-public reasoning evidence cannot enter the hosted catalog.')
  const old = previous === undefined ? undefined : readCatalogReasoningEvidence(previous, identity)
  if (previous !== undefined && !old) throw new Error('Cannot replace malformed or non-public saved reasoning evidence; the prior catalog was kept.')
  if (incoming === undefined) return old ?? undefined
  const next = readCatalogReasoningEvidence(incoming, identity)
  const conflict = (reason: string): CatalogReasoningEvidence => ({
    ...(old?.lastGood ? { lastGood: old.lastGood } : {}),
    lastAttempt: { at: object(incoming) && object(incoming.lastAttempt) && date(incoming.lastAttempt.at)
      ? incoming.lastAttempt.at : new Date().toISOString(), outcome: 'conflict', reason }
  })
  if (!next) return conflict('Malformed, mismatched or non-public reasoning evidence was not admitted; last-good facts were kept.')
  if (!old) return next
  if (old && Date.parse(next.lastAttempt.at) < Date.parse(old.lastAttempt.at)) return old
  if (next.lastAttempt.outcome !== 'verified' || !next.lastGood) return {
    ...(old?.lastGood ? { lastGood: old.lastGood } : {}), lastAttempt: next.lastAttempt
  }
  if (old?.lastGood) {
    if (Date.parse(next.lastGood.lastVerified) < Date.parse(old.lastGood.lastVerified)) return { ...old, lastAttempt: next.lastAttempt }
    if (!preservesChoices(old.lastGood, next.lastGood)) return conflict('Reasoning defaults, available controls or applicability changed; bounded review is required before replacing last-good facts.')
  }
  return next
}

/**
 * Explicit trusted admission, never selected by a payload property. Used by authoritative
 * registry consumers; a reviewed producer can use the same operation when connected later.
 */
export function admitReviewedCatalogReasoningEvidence(previous: unknown, incoming: unknown, identity: Identity): CatalogReasoningEvidence | undefined {
  const retained = mergeCatalogReasoningEvidence(previous, incoming, identity)
  const old = previous === undefined ? null : readCatalogReasoningEvidence(previous, identity)
  const next = incoming === undefined ? null : readCatalogReasoningEvidence(incoming, identity)
  if (!old?.lastGood || !next?.lastGood || next.lastAttempt.outcome !== 'verified') return retained
  const newerFact = Date.parse(next.lastGood.lastVerified) > Date.parse(old.lastGood.lastVerified) ||
    next.lastGood.lastVerified === old.lastGood.lastVerified && Date.parse(next.lastAttempt.at) > Date.parse(old.lastAttempt.at)
  return newerFact && Date.parse(next.lastAttempt.at) >= Date.parse(old.lastAttempt.at) ? next : retained
}

export function mergeCatalogVariantEvidence(previous: CatalogModelIdVariant | undefined, incoming: CatalogModelIdVariant, connectionId: string, authoritative = false): CatalogModelIdVariant {
  const prior = previous?.effectiveId === incoming.effectiveId ? previous.reasoningEvidence : undefined
  const merge = authoritative ? admitReviewedCatalogReasoningEvidence : mergeCatalogReasoningEvidence
  const reasoningEvidence = merge(prior, incoming.reasoningEvidence, { connectionId, effectiveId: incoming.effectiveId })
  return { ...incoming, ...(reasoningEvidence ? { reasoningEvidence } : {}) }
}

export function projectCatalogReasoningEvidence(model: Pick<CatalogModel, 'idVariants'> | null | undefined,
  connectionId: string | null | undefined, effectiveId: string | null | undefined): CatalogReasoningProjection {
  if (!connectionId || !effectiveId) return { status: 'unknown', reason: 'An exact connection and model identity are required.' }
  const variant = model?.idVariants?.[connectionId]
  if (!variant || variant.effectiveId !== effectiveId || variant.reasoningEvidence === undefined) return { status: 'unknown' }
  const evidence = readCatalogReasoningEvidence(variant.reasoningEvidence, { connectionId, effectiveId })
  if (!evidence) return { status: 'unknown', reason: 'Reasoning evidence is malformed, mismatched or outside the public catalog scope.' }
  return { status: evidence.lastGood?.support ?? 'unknown', evidence }
}

/** Cache refreshes retain matching facts. A raw gateway fallback cannot retire other identities. */
export function retainCatalogReasoningRows<T extends CatalogModel>(previous: T[], incoming: T[], options: { retainMissing?: boolean; authoritative?: boolean } = {}): T[] {
  const oldVariants = new Map(previous.flatMap(row => Object.entries(row.idVariants ?? {}).map(([connection, variant]) =>
    [JSON.stringify([connection, variant.effectiveId]), variant] as const)))
  const rows = incoming.map(row => ({ ...row, idVariants: row.idVariants ? Object.fromEntries(
    Object.entries(row.idVariants).map(([connection, variant]) => [connection, mergeCatalogVariantEvidence(
      oldVariants.get(JSON.stringify([connection, variant.effectiveId])), variant, connection, options.authoritative)])) : row.idVariants })) as T[]
  if (!options.retainMissing) return rows
  const seen = new Set(rows.flatMap(row => Object.entries(row.idVariants ?? {}).map(([connection, variant]) => JSON.stringify([connection, variant.effectiveId]))))
  for (const old of previous) {
    const missing = Object.entries(old.idVariants ?? {}).filter(([connection, variant]) => !seen.has(JSON.stringify([connection, variant.effectiveId])))
    if (!missing.length) continue
    const row = rows.find(row => (row.canonicalId ?? row.id) === (old.canonicalId ?? old.id))
    if (!row) { rows.push(structuredClone(old)); continue }
    const idVariants = { ...row.idVariants }
    for (const [connection, variant] of missing) {
      if (idVariants[connection]) throw new Error('Raw catalog fallback would replace a retained provider identity.')
      idVariants[connection] = { ...variant,
        limits: variant.limits ?? { contextWindow: resolveCatalogConnectionLimits(old, connection).contextWindow ?? null,
          maxOutputTokens: resolveCatalogConnectionLimits(old, connection).maxOutputTokens ?? null },
        pricing: variant.pricing ?? resolveCatalogConnectionPricing(old, connection).pricing ?? {} }
    }
    row.idVariants = idVariants
    row.availableConnections = [...new Set([...(row.availableConnections ?? []), ...Object.keys(idVariants)])]
  }
  return rows
}

export function assertCatalogReasoningConservation(previous: CatalogModel[], incoming: CatalogModel[]): void {
  for (const row of incoming) for (const [connectionId, variant] of Object.entries(row.idVariants ?? {})) {
    if (variant.reasoningEvidence !== undefined && !readCatalogReasoningEvidence(variant.reasoningEvidence, { connectionId, effectiveId: variant.effectiveId })) {
      throw new Error('Cannot publish malformed, future or non-public reasoning evidence.')
    }
  }
  const variants = new Map(incoming.flatMap(row => Object.entries(row.idVariants ?? {}).map(([connection, variant]) =>
    [JSON.stringify([connection, variant.effectiveId]), variant] as const)))
  for (const row of previous) for (const [connectionId, variant] of Object.entries(row.idVariants ?? {})) {
    if (variant.reasoningEvidence === undefined) continue
    if (!readCatalogReasoningEvidence(variant.reasoningEvidence, { connectionId, effectiveId: variant.effectiveId })) {
      throw new Error('Cannot conserve malformed or future saved reasoning evidence; the prior catalog was kept.')
    }
    const next = variants.get(JSON.stringify([connectionId, variant.effectiveId]))
    // Whole-identity retirement remains the existing exact-ID conservation gate's decision.
    if (!next) continue
    const expected = mergeCatalogReasoningEvidence(variant.reasoningEvidence, next.reasoningEvidence, { connectionId, effectiveId: variant.effectiveId })
    if (JSON.stringify([expected?.lastGood, expected?.lastAttempt]) !== JSON.stringify([next.reasoningEvidence?.lastGood, next.reasoningEvidence?.lastAttempt])) {
      throw new Error('Cannot publish catalog: last-good reasoning evidence was lost or changed without admission.')
    }
  }
}
