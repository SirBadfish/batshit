import { redis } from '$lib/server/redis'
import type { AppActionsTargetOutcome } from '$lib/appActions/settings/managementContract'
import { parseSkillAccessChange, type SkillAccessChange } from '$lib/appActions/skillAccess'
import { settingsSubjectKey } from '$lib/appActions/settings/reportContract'
import type { AdapterCommitContext, AdapterContext } from '../managementTypes'
import { readSlashCommandRevision } from '../../slashCommandRevision'
import { assertSettingsLifecycle } from './lifecycle'
import {
  freezeSkillAccess, readSkillAccess, READ_SKILL_METADATA_SCRIPT, refuseSkillAccess, SKILL_SUBJECT_PATHS,
  skillAccessSnapshot, type SkillAccessReportHandle
} from './skillAccessReport'
import { planSkillAccessChange, writeSkillAccessPlan, type SkillAccessPlan, type SkillAccessEffectClosure, type SkillAccessPreview } from './conditionalSkillAccess'
export type { SkillAccessChange } from '$lib/appActions/skillAccess'

export type SkillAccessPlanHandle = Readonly<{ kind: 'skill-access-plan' }>
export type PreparedSkillAccessChange = Readonly<{
  plan: SkillAccessPlanHandle; preview: SkillAccessPreview; closure: SkillAccessEffectClosure; preimages: unknown
  initialOutcomes: readonly AppActionsTargetOutcome[]
  refresh(ctx: AdapterContext): Promise<void>
}>
type HeldPlan = { plan: SkillAccessPlan; read: SkillAccessReportHandle; flight?: Promise<readonly AppActionsTargetOutcome[]> }
const plans = new WeakMap<SkillAccessPlanHandle, HeldPlan>()

async function refreshPlan(ctx: AdapterContext, held: HeldPlan) {
  await ctx.refreshAuthority()
  const saved = skillAccessSnapshot(ctx, held.read)
  if (saved !== held.plan.snapshot) refuseSkillAccess('SKILL_PLAN_NOT_HELD', 'Request a new exact access change.')
  if (await readSlashCommandRevision(saved.owner) !== saved.revision) refuseSkillAccess('SKILL_CATALOGUE_CHANGED', 'Skill access changed; request a fresh report and review.')
  await redis.execute(async client => {
    for (const subject of [...saved.subjects, ...saved.namespace]) {
      ctx.assertCurrent()
      const answer = await client.eval(READ_SKILL_METADATA_SCRIPT, { keys: [subject.key], arguments: [JSON.stringify(SKILL_SUBJECT_PATHS)] })
      ctx.assertCurrent()
      if (Array.isArray(answer) && answer[0] === 'MISSING' && subject.raw.every(value => value === '')) continue
      if (!Array.isArray(answer) || answer[0] !== 'OK' || JSON.stringify(answer.slice(1)) !== JSON.stringify(subject.raw)) {
        refuseSkillAccess('SKILL_SUBJECT_CHANGED', 'A captured subject changed; request a fresh report and review.')
      }
    }
  })
  await ctx.refreshAuthority()
  if (await readSlashCommandRevision(saved.owner) !== saved.revision) refuseSkillAccess('SKILL_CATALOGUE_CHANGED', 'Skill access changed; request a fresh report and review.')
  ctx.assertCurrent()
  assertSettingsLifecycle(saved.lifecycle)
}

export async function prepareSkillAccessChange(
  ctx: AdapterContext, read: SkillAccessReportHandle, change: SkillAccessChange
): Promise<PreparedSkillAccessChange> {
  await ctx.refreshAuthority()
  const saved = skillAccessSnapshot(ctx, read)
  const plan = planSkillAccessChange(ctx, saved, parseSkillAccessChange(change))
  const held: HeldPlan = { plan, read }
  await refreshPlan(ctx, held)
  const handle = Object.freeze({ kind: 'skill-access-plan' as const })
  plans.set(handle, held)
  return Object.freeze({ plan: handle, preview: plan.preview, closure: plan.closure, preimages: plan.preimages,
    initialOutcomes: plan.initialOutcomes, refresh: (currentCtx: AdapterContext) => refreshPlan(currentCtx, held) })
}

export async function commitSkillAccessChange(ctx: AdapterCommitContext, handle: SkillAccessPlanHandle): Promise<readonly AppActionsTargetOutcome[]> {
  const held = plans.get(handle)
  if (!held) refuseSkillAccess('SKILL_PLAN_NOT_HELD', 'Request a new exact access change.')
  // The exact operation/actor owns this handle. Same-handle calls share one effect attempt.
  skillAccessSnapshot(ctx, held.read)
  if (held.flight) return held.flight
  held.flight = (async () => {
    const changed = await writeSkillAccessPlan(ctx, held.plan)
    for (const outcome of changed) ctx.execution.recordOutcome(outcome)
    const outcomes: AppActionsTargetOutcome[] = [...held.plan.initialOutcomes.map(item => ({ ...item })), ...changed]
    if (!changed.some(outcome => outcome.saved === 'saved')) return freezeSkillAccess(outcomes)
    try {
      const current = await readSkillAccess(ctx, { skillIds: held.plan.change.assignments.map(item => item.skillId) }, held.plan.snapshot.manifest)
      for (const outcome of changed) {
        if (outcome.saved !== 'saved') continue
        const same = held.plan.change.assignments.every(assignment => current.rows.some(row => row.skillId === assignment.skillId &&
          settingsSubjectKey(row.subject) === settingsSubjectKey(outcome.subject) && row.effective === assignment.enabled))
        outcome.readback = same ? 'verified' : 'changed'
        ctx.execution.recordOutcome(outcome)
      }
    } catch {
      for (const outcome of changed) if (outcome.saved === 'saved') {
        outcome.readback = 'unavailable'
        ctx.execution.recordOutcome(outcome)
      }
    }
    return freezeSkillAccess(outcomes)
  })()
  return held.flight
}
