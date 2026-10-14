/**
 * The ONE list of paused plans (plan "Get Batshit approved for the sellers'
 * flat-fee plans", section 3, 2026-09-27).
 *
 * A plan here is switched off, not deleted: a user cannot add it, and a saved
 * one does not route a chat or speech call. Its code, catalog rows, and saved
 * key stay. A plan comes back with one change (removing its row here) when its
 * seller says yes in writing; the written yes is kept under `_local/shared/`.
 *
 * Each row names the seller's rule, its link, and the date it was read. A
 * seller changes its rules without notice: read the page again before relying
 * on a row.
 *
 * Not paused: Kimi Code (its rule allows another tool that keeps its true
 * identity, BL-684), MiniMax's plans (not paused until its rule is read).
 * Alibaba's Coding Plan has the same rule as its Token Plan; Batshit does not
 * offer an Alibaba Coding Plan connection, so only the Token Plan is listed.
 *
 * Client-safe: the Settings rows read the same words the server refuses with.
 */
export interface PausedPlan {
  /** The saved-key service id and the `direct:<service>` connection. */
  service: string
  /** What the user calls the plan in Batshit. */
  label: string
  seller: string
  /** The seller's rule, in short. */
  rule: string
  ruleUrl: string
  /** The date the rule was read (YYYY-MM-DD). */
  readOn: string
  /** The seller's normal pay-as-you-go connection in Batshit, which works. */
  payAsYouGoLabel: string
  /**
   * The date Josh's letter went out to this seller (YYYY-MM-DD), or null when
   * it has not gone out yet. Only when this is set does the row say Batshit
   * asked for approval (Faye, 2026-09-28): the row must say only what is true
   * today, never a standing claim of an in-flight ask.
   */
  letterSentOn: string | null
}

export const PAUSED_PLANS: readonly PausedPlan[] = [
  {
    service: 'zai_coding',
    label: 'Z.ai Coding Plan',
    seller: 'Z.ai',
    rule: 'Only inside tools that Z.ai supports; use outside them can limit or freeze the account.',
    ruleUrl: 'https://docs.z.ai/devpack/usage-policy',
    readOn: '2026-09-27',
    payAsYouGoLabel: 'Z.ai',
    letterSentOn: null
  },
  {
    service: 'qwen_token_plan',
    label: 'Qwen Token Plan',
    seller: 'Alibaba Cloud',
    rule: 'Only AI programming tools and agents; custom applications and automated scripts are not allowed.',
    ruleUrl: 'https://www.alibabacloud.com/help/en/model-studio/more-tools',
    readOn: '2026-09-27',
    payAsYouGoLabel: 'Qwen Cloud',
    letterSentOn: null
  },
  {
    service: 'mimo_token_plan',
    label: 'MiMo Token Plan',
    seller: 'Xiaomi MiMo',
    rule: 'Only in programming tools; no automated scripts and no custom application backends.',
    ruleUrl: 'https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription',
    readOn: '2026-09-27',
    payAsYouGoLabel: 'MiMo',
    letterSentOn: null
  }
]

const BY_SERVICE = new Map(PAUSED_PLANS.map((plan) => [plan.service, plan]))

/** The paused plan for a service id or a `direct:<service>` connection id. */
export function findPausedPlan(serviceOrConnection?: string | null): PausedPlan | null {
  if (typeof serviceOrConnection !== 'string') return null
  const trimmed = serviceOrConnection.trim().toLowerCase()
  const service = trimmed.startsWith('direct:') ? trimmed.slice('direct:'.length) : trimmed
  return BY_SERVICE.get(service) ?? null
}

/** The plain words a user reads where a paused plan was, and the refusal. */
export function pausedPlanSentence(plan: PausedPlan): string {
  const asked = plan.letterSentOn
    ? ` Batshit asked ${plan.seller} for approval on ${plan.letterSentOn}.`
    : ''
  return (
    `${plan.label} is paused: ${plan.seller} does not list Batshit as an allowed tool yet. ` +
    `${plan.seller}'s normal pay-as-you-go connection (${plan.payAsYouGoLabel}) works.` +
    asked
  )
}

/** The row's words on a Dev copy whose "Use paused plans on this copy" switch is on. */
export function pausedPlanDevOnSentence(plan: PausedPlan): string {
  return (
    `${plan.label} is paused for other copies of Batshit ` +
    `(${plan.seller} does not list Batshit yet) and on for this Dev copy.`
  )
}
