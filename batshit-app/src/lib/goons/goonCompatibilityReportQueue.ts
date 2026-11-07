import { compatibilityOwnerForBasis, type GoonCompatibilityBasis } from './goonCompatibilityBasis'
import type { GoonCompatibilityReport, GoonRecord } from '$lib/types/goons'

type PendingReport = { report: GoonCompatibilityReport; basis: GoonCompatibilityBasis; key: string; semanticKey: string; producerCurrent: () => boolean }
type WriteResult = { status: 'saved'; goon: GoonRecord } | { status: 'refused' } | { status: 'unknown'; error: unknown }

/** One in-flight derived-report write; never replay an unconfirmed outcome. */
export function createGoonCompatibilityReportQueue(owners: {
  isCurrent: (basis: GoonCompatibilityBasis) => boolean
  write: (report: GoonCompatibilityReport, basis: GoonCompatibilityBasis) => Promise<WriteResult>
  apply: (goon: GoonRecord) => void
  unavailable: (error: unknown) => void
}) {
  let pending: PendingReport | null = null
  let running = false
  let disposed = false
  let blockedAll = false
  const blocked = new Set<string>()
  const unknownOwners = new Set<string>()
  const producers = new WeakMap<() => boolean, number>()
  const basisCopies = new WeakMap<GoonCompatibilityBasis, { basis: GoonCompatibilityBasis; semanticKey: string }>()
  let nextProducer = 0
  const alwaysCurrent = () => true
  const current = (item: PendingReport) => item.producerCurrent() && owners.isCurrent(item.basis)

  function block(next: PendingReport, error: unknown, unknown: boolean) {
    if (blocked.size + unknownOwners.size >= 1024) blockedAll = true
    else if (unknown) unknownOwners.add(next.semanticKey)
    else blocked.add(next.key)
    if (current(next)) owners.unavailable(error)
  }

  async function drain() {
    if (running || disposed) return
    running = true
    try {
      while (pending && !disposed) {
        const next: PendingReport = pending
        pending = null
        if (blockedAll || blocked.has(next.key) || unknownOwners.has(next.semanticKey) || !current(next)) continue
        let result: WriteResult
        try { result = await owners.write(next.report, next.basis) }
        catch (error) { result = { status: 'unknown', error } }
        if (disposed) return
        if (result.status !== 'saved') {
          block(next, result.status === 'unknown' ? result.error : new Error('Compatibility inputs changed or are unavailable.'), result.status === 'unknown')
          continue
        }
        const expected = compatibilityOwnerForBasis(next.basis)
        const actual = result.goon.compatibility?.owner
        if (!actual || actual.contract !== expected.contract || actual.modelIdentitySha256 !== expected.modelIdentitySha256 ||
          actual.motionSourcesSha256 !== expected.motionSourcesSha256 || actual.motionPlanSha256 !== expected.motionPlanSha256) {
          block(next, new Error('Compatibility save returned a mismatched owner.'), true)
          continue
        }
        if (current(next)) owners.apply(result.goon)
      }
    } finally {
      running = false
    }
  }

  return {
    submit(report: GoonCompatibilityReport, basis: GoonCompatibilityBasis, producerCurrent = alwaysCurrent) {
      if (disposed) return
      // Capture each immutable input epoch once; deferred clips may emit many reports.
      let capturedBasis = basisCopies.get(basis)
      if (!capturedBasis) {
        const snapshot = JSON.parse(JSON.stringify(basis)) as GoonCompatibilityBasis
        const owner = compatibilityOwnerForBasis(snapshot)
        capturedBasis = { basis: snapshot, semanticKey: `${snapshot.model.id}:${owner.modelIdentitySha256}:${owner.motionSourcesSha256}:${owner.motionPlanSha256}` }
        basisCopies.set(basis, capturedBasis)
      }
      const capturedReport = JSON.parse(JSON.stringify(report)) as GoonCompatibilityReport
      let producer = producers.get(producerCurrent)
      if (producer === undefined) { producer = ++nextProducer; producers.set(producerCurrent, producer) }
      const semanticKey = capturedBasis.semanticKey
      const key = `${producer}:${semanticKey}`
      pending = { report: capturedReport, basis: capturedBasis.basis, key, semanticKey, producerCurrent }
      void drain()
    },
    dispose() { disposed = true; pending = null }
  }
}
