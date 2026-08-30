/**
 * SA-104 P3 — shared memory-control logic that must stay client-safe.
 *
 * This module owns three things used on both sides of the app:
 *  1. `resolveAgentMemoryEnabled` — THE per-agent memory gate (DL-104-16). Every surface
 *     (broker scope, prompt injection, DCM index, inline route) derives enablement from
 *     this one rule; restating it elsewhere is a Fragility-Map-class drift risk.
 *  2. `extractMemoryControls` — parses `<batshit-memory>` blocks out of a finalized
 *     message. Unlike zip control (last block wins), EVERY block is one save.
 *  3. `validateMemorySavePayload` — the semantic payload contract shared verbatim by the
 *     inline route and the `sys.memory.save` Fabric control so both paths produce
 *     identical records (P3 parity requirement).
 *
 * No `$lib/server` imports allowed here — `+page.svelte`, `AgentSettingsPanel.svelte`,
 * `MemorySettingsPanel.svelte` and `AgentMemorySettingsCard.svelte` load this module in
 * the browser. (SA-106 retired the n8n compile twin, which was the original reason; the
 * constraint stands on the surviving client consumers.)
 */

import { controlTag, pairedBlockRegexGlobal } from '$lib/utils/controlTags'

export const MEMORY_CONTROL_TAG = controlTag('memory').tag

/**
 * Mirror of the data layer's `MEMORY_LANES` (`$lib/server/services/memory/memoryTypes`),
 * which client code cannot import. A server-side unit test pins the two lists equal.
 */
export const MEMORY_CONTROL_LANES = ['awareness', 'stm', 'ltm'] as const
export type MemoryControlLane = (typeof MEMORY_CONTROL_LANES)[number]

export const MEMORY_SAVE_DEFAULT_IMPORTANCE = 5
export const MEMORY_SAVE_MAX_CONTENT_CHARS = 4_000
export const MEMORY_SAVE_MAX_GIST_CHARS = 200
export const MEMORY_SAVE_MAX_TRIGGER_TERMS = 12

/**
 * SA-104 P4 — recall-engine settings resolved from the agent record with client-safe
 * defaults. P5 binds the Settings surface to these exact fields; until then the
 * defaults govern. Budgets are house token estimates (length/4, `$lib/utils/tokens`).
 *
 * 2026-08-28: linger split into two honest knobs. `memory_linger_turns` is the STM
 * trigger linger default (per-record `linger_override` beats it); the new
 * `memory_recall_linger_turns` governs deliberately recalled inserts.
 */
export const MEMORY_DEFAULT_LINGER_TURNS = 2
export const MEMORY_MAX_LINGER_TURNS = 8

/** Per-memory linger override: a turn count, or hold for the rest of the episode. */
export type MemoryLingerOverride = number | 'episode'
export const MEMORY_MAX_LINGER_OVERRIDE_TURNS = 30

export interface MemoryLaneBudgets {
  /** System-prompt on-my-mind block budget (tokens). */
  onMyMind: number
  /** DCM trigger-insert budget (tokens), current + lingering trigger entries. */
  triggers: number
  /** DCM recalled-insert budget (tokens), current + lingering recall entries. */
  recalled: number
}

export const MEMORY_DEFAULT_LANE_BUDGETS: MemoryLaneBudgets = {
  onMyMind: 2_000,
  triggers: 1_200,
  recalled: 2_400
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0) return fallback
  return Math.min(parsed, max)
}

/**
 * STM trigger linger default: turns a trigger-inserted memory stays re-inserted after
 * its last relevance (DL-104-17). A per-memory `linger_override` beats this default.
 */
export function resolveMemoryLingerTurns(agent: unknown): number {
  if (!agent || typeof agent !== 'object') return MEMORY_DEFAULT_LINGER_TURNS
  const record = agent as Record<string, any>
  return clampPositiveInt(
    record.memory_linger_turns ?? record.memoryLingerTurns,
    MEMORY_DEFAULT_LINGER_TURNS,
    MEMORY_MAX_LINGER_TURNS
  )
}

/**
 * Recall linger: turns a deliberately recalled memory (sys.memory.recall / search
 * follow-up) stays re-inserted. Split from the trigger default 2026-08-28 so the
 * Settings label "STM Trigger Linger Default" never silently governs recalls too.
 */
export function resolveMemoryRecallLingerTurns(agent: unknown): number {
  if (!agent || typeof agent !== 'object') return MEMORY_DEFAULT_LINGER_TURNS
  const record = agent as Record<string, any>
  return clampPositiveInt(
    record.memory_recall_linger_turns ?? record.memoryRecallLingerTurns,
    MEMORY_DEFAULT_LINGER_TURNS,
    MEMORY_MAX_LINGER_TURNS
  )
}

/**
 * THE read rule for a record's linger override. Returns a clamped turn count,
 * 'episode' (hold until the current episode/conversation stretch ends), or null when
 * the record has no override and the per-source agent default applies.
 */
export function resolveMemoryLingerOverride(record: unknown): MemoryLingerOverride | null {
  if (!record || typeof record !== 'object') return null
  const value = (record as Record<string, any>).linger_override
  if (value === 'episode') return 'episode'
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(Math.max(Math.floor(value), 0), MEMORY_MAX_LINGER_OVERRIDE_TURNS)
  }
  return null
}

/** Per-lane insert budgets in tokens (DL-104-17 bounded insertion). */
export function resolveMemoryLaneBudgets(agent: unknown): MemoryLaneBudgets {
  const raw =
    agent && typeof agent === 'object'
      ? ((agent as Record<string, any>).memory_lane_budgets ??
        (agent as Record<string, any>).memoryLaneBudgets)
      : null
  const record = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {}
  return {
    onMyMind: clampPositiveInt(record.on_my_mind, MEMORY_DEFAULT_LANE_BUDGETS.onMyMind, 20_000),
    triggers: clampPositiveInt(record.triggers, MEMORY_DEFAULT_LANE_BUDGETS.triggers, 20_000),
    recalled: clampPositiveInt(record.recalled, MEMORY_DEFAULT_LANE_BUDGETS.recalled, 20_000)
  }
}

/**
 * SA-104 P5 — Infinite-Session window settings, STORED now and consumed by P6's window
 * mechanics (floor / elastic ceiling / nap). Stored snake_case on the agent record as
 * `memory_window`; resolved through this one rule with clamped defaults.
 */
export type MemoryWindowMode = 'auto' | 'custom'

/**
 * SA-104 P6 — how graduation/nap summaries pick their model (story: "configured model,
 * cheap default, explicit"). 'inherit' resolves the agent's effective Auto Compact
 * model choice (the AgentAutoCompactSettings precedent), which itself defaults to
 * 'current'; the Settings card names the resolved model so nothing is hidden.
 */
export type MemorySummaryModelMode = 'inherit' | 'current' | 'preset'

export interface MemoryWindowSettings {
  /** Guaranteed minimum of recent conversation (auto = derived from the model in P6). */
  floorMode: MemoryWindowMode
  floorTokens: number
  /** Reserved headroom below the model max (auto = derived from the model in P6). */
  ceilingHeadroomMode: MemoryWindowMode
  ceilingHeadroomTokens: number
  /** Nap trigger as percent of usable context (design default ~80). */
  napThresholdPercent: number
  /** Idle gap (hours) closing Infinite-Session episodes + gating regular-session idle graduation. */
  idleGapHours: number
  /** Graduation/nap summary model choice (P6). */
  summaryModelMode: MemorySummaryModelMode
  summaryModelPresetId: string | null
}

export const MEMORY_DEFAULT_WINDOW_SETTINGS: MemoryWindowSettings = {
  floorMode: 'auto',
  floorTokens: 100_000,
  ceilingHeadroomMode: 'auto',
  ceilingHeadroomTokens: 32_768,
  napThresholdPercent: 80,
  idleGapHours: 8,
  summaryModelMode: 'inherit',
  summaryModelPresetId: null
}

const MEMORY_WINDOW_FLOOR_MIN = 1_000
const MEMORY_WINDOW_FLOOR_MAX = 2_000_000
const MEMORY_WINDOW_HEADROOM_MIN = 4_096
const MEMORY_WINDOW_HEADROOM_MAX = 500_000
export const MEMORY_NAP_THRESHOLD_MIN = 50
export const MEMORY_NAP_THRESHOLD_MAX = 95
export const MEMORY_IDLE_GAP_MIN_HOURS = 1
export const MEMORY_IDLE_GAP_MAX_HOURS = 168

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function normalizeWindowMode(value: unknown): MemoryWindowMode {
  return value === 'custom' ? 'custom' : 'auto'
}

function normalizeSummaryModelMode(value: unknown): MemorySummaryModelMode {
  return value === 'current' || value === 'preset' ? value : 'inherit'
}

/** THE read rule for `memory_window` (P6 binds compilation to this same function). */
export function resolveMemoryWindowSettings(agent: unknown): MemoryWindowSettings {
  const raw =
    agent && typeof agent === 'object'
      ? ((agent as Record<string, any>).memory_window ?? (agent as Record<string, any>).memoryWindow)
      : null
  const record = raw && typeof raw === 'object' ? (raw as Record<string, any>) : {}
  const summaryModelMode = normalizeSummaryModelMode(record.summary_model_mode)
  const summaryModelPresetId =
    typeof record.summary_model_preset_id === 'string' && record.summary_model_preset_id.trim()
      ? record.summary_model_preset_id.trim()
      : null
  return {
    floorMode: normalizeWindowMode(record.floor_mode),
    floorTokens: clampInt(
      record.floor_tokens,
      MEMORY_DEFAULT_WINDOW_SETTINGS.floorTokens,
      MEMORY_WINDOW_FLOOR_MIN,
      MEMORY_WINDOW_FLOOR_MAX
    ),
    ceilingHeadroomMode: normalizeWindowMode(record.ceiling_headroom_mode),
    ceilingHeadroomTokens: clampInt(
      record.ceiling_headroom_tokens,
      MEMORY_DEFAULT_WINDOW_SETTINGS.ceilingHeadroomTokens,
      MEMORY_WINDOW_HEADROOM_MIN,
      MEMORY_WINDOW_HEADROOM_MAX
    ),
    napThresholdPercent: clampInt(
      record.nap_threshold_percent,
      MEMORY_DEFAULT_WINDOW_SETTINGS.napThresholdPercent,
      MEMORY_NAP_THRESHOLD_MIN,
      MEMORY_NAP_THRESHOLD_MAX
    ),
    idleGapHours: clampInt(
      record.idle_gap_hours,
      MEMORY_DEFAULT_WINDOW_SETTINGS.idleGapHours,
      MEMORY_IDLE_GAP_MIN_HOURS,
      MEMORY_IDLE_GAP_MAX_HOURS
    ),
    summaryModelMode,
    summaryModelPresetId: summaryModelMode === 'preset' ? summaryModelPresetId : null
  }
}

/** The stored snake_case record the Settings card writes (clamped through the resolver). */
export function buildMemoryWindowRecord(settings: MemoryWindowSettings): Record<string, any> {
  const normalized = resolveMemoryWindowSettings({
    memory_window: {
      floor_mode: settings.floorMode,
      floor_tokens: settings.floorTokens,
      ceiling_headroom_mode: settings.ceilingHeadroomMode,
      ceiling_headroom_tokens: settings.ceilingHeadroomTokens,
      nap_threshold_percent: settings.napThresholdPercent,
      idle_gap_hours: settings.idleGapHours,
      summary_model_mode: settings.summaryModelMode,
      summary_model_preset_id: settings.summaryModelPresetId
    }
  })
  return {
    floor_mode: normalized.floorMode,
    floor_tokens: normalized.floorTokens,
    ceiling_headroom_mode: normalized.ceilingHeadroomMode,
    ceiling_headroom_tokens: normalized.ceilingHeadroomTokens,
    nap_threshold_percent: normalized.napThresholdPercent,
    idle_gap_hours: normalized.idleGapHours,
    summary_model_mode: normalized.summaryModelMode,
    summary_model_preset_id: normalized.summaryModelPresetId
  }
}

/** Shorthand: the idle gap in hours for an agent record (P6, one knob — see packet doc §1.6). */
export function resolveMemoryIdleGapHours(agent: unknown): number {
  return resolveMemoryWindowSettings(agent).idleGapHours
}

/**
 * SA-104 P6 — the effective Infinite-Session window for a resolved model context limit
 * (DL-104-07). One client-safe rule shared by the nap trigger (browser), the nap route
 * (server), and tests. Returns null when the model registry gives no context limit —
 * the nap trigger then cannot arm (honest unknown, the budget-preflight posture).
 *
 * ceiling = contextLimit − headroom; the window may grow to the ceiling (elastic).
 * napAt   = usable × napThresholdPercent.
 * floor   = the protected recent tail graduation/naps must never eat into.
 */
export interface EffectiveMemoryWindow {
  contextLimit: number
  headroomTokens: number
  /** The elastic ceiling — also the "usable context" the nap percent applies to. */
  usableTokens: number
  floorTokens: number
  napAtTokens: number
  napThresholdPercent: number
}

const AUTO_HEADROOM_FRACTION = 0.12
const AUTO_HEADROOM_MIN = 16_384
const AUTO_HEADROOM_MAX = 128_000
const AUTO_FLOOR_FRACTION = 0.25
const AUTO_FLOOR_MIN = 20_000
const AUTO_FLOOR_MAX = 100_000
/** A custom floor may never exceed this share of usable context (the window must breathe). */
const FLOOR_MAX_USABLE_FRACTION = 0.8

export function resolveEffectiveMemoryWindow(
  settings: MemoryWindowSettings,
  contextLimit: number | null | undefined
): EffectiveMemoryWindow | null {
  const limit =
    typeof contextLimit === 'number' && Number.isFinite(contextLimit) && contextLimit > 0
      ? Math.round(contextLimit)
      : null
  if (limit === null) return null

  const autoHeadroom = Math.min(
    AUTO_HEADROOM_MAX,
    Math.max(AUTO_HEADROOM_MIN, Math.round(limit * AUTO_HEADROOM_FRACTION))
  )
  const headroomTokens = Math.min(
    settings.ceilingHeadroomMode === 'custom' ? settings.ceilingHeadroomTokens : autoHeadroom,
    Math.max(0, limit - 1_000)
  )
  const usableTokens = Math.max(1_000, limit - headroomTokens)

  const autoFloor = Math.min(
    AUTO_FLOOR_MAX,
    Math.max(AUTO_FLOOR_MIN, Math.round(usableTokens * AUTO_FLOOR_FRACTION))
  )
  const floorCap = Math.round(usableTokens * FLOOR_MAX_USABLE_FRACTION)
  const floorTokens = Math.min(
    settings.floorMode === 'custom' ? settings.floorTokens : autoFloor,
    floorCap
  )

  const napAtTokens = Math.round(usableTokens * (settings.napThresholdPercent / 100))

  return {
    contextLimit: limit,
    headroomTokens,
    usableTokens,
    floorTokens,
    napAtTokens,
    napThresholdPercent: settings.napThresholdPercent
  }
}

/**
 * SA-104 P5 — the Agent Settings memory draft: one bundle over the four stored
 * per-agent memory fields, read through THE resolvers so Settings display, compile
 * compile path, and the recall engine can never disagree about effective values.
 */
export interface AgentMemorySettingsDraft {
  enabled: boolean
  lingerTurns: number
  recallLingerTurns: number
  budgets: MemoryLaneBudgets
  window: MemoryWindowSettings
}

export function resolveAgentMemorySettingsDraft(agent: unknown): AgentMemorySettingsDraft {
  return {
    enabled: resolveAgentMemoryEnabled(agent),
    lingerTurns: resolveMemoryLingerTurns(agent),
    recallLingerTurns: resolveMemoryRecallLingerTurns(agent),
    budgets: resolveMemoryLaneBudgets(agent),
    window: resolveMemoryWindowSettings(agent)
  }
}

/** The exact agent-record fields the Settings save payload writes (snake_case). */
export function buildAgentMemoryRecordFields(draft: AgentMemorySettingsDraft): {
  memory_enabled: boolean
  memory_linger_turns: number
  memory_recall_linger_turns: number
  memory_lane_budgets: Record<string, number>
  memory_window: Record<string, any>
} {
  const normalized = resolveAgentMemorySettingsDraft({
    memory_enabled: draft.enabled === true,
    memory_linger_turns: draft.lingerTurns,
    memory_recall_linger_turns: draft.recallLingerTurns,
    memory_lane_budgets: {
      on_my_mind: draft.budgets.onMyMind,
      triggers: draft.budgets.triggers,
      recalled: draft.budgets.recalled
    },
    memory_window: buildMemoryWindowRecord(draft.window)
  })
  return {
    memory_enabled: normalized.enabled,
    memory_linger_turns: normalized.lingerTurns,
    memory_recall_linger_turns: normalized.recallLingerTurns,
    memory_lane_budgets: {
      on_my_mind: normalized.budgets.onMyMind,
      triggers: normalized.budgets.triggers,
      recalled: normalized.budgets.recalled
    },
    memory_window: buildMemoryWindowRecord(normalized.window)
  }
}

/**
 * The payload contract shared by the inline tag and `sys.memory.save`.
 * `trigger_synonyms` was retired 2026-08-29 (it always behaved identically to
 * `trigger_terms`); validation still ACCEPTS the field and folds it into terms so
 * older prompts never break.
 */
export interface MemorySavePayload {
  lane: MemoryControlLane
  content: string
  gist?: string
  trigger_terms?: string[]
  importance: number
  event_at?: string | null
  expires_at?: string | null
  links?: string[]
  clip_ids?: string[]
  /** Save-and-replace in one act: ids this new memory supersedes. */
  supersedes?: string[]
  /**
   * Per-memory linger override (stm): turns this memory stays inserted after its last
   * trigger mention, or 'episode' to hold for the rest of the current episode.
   */
  linger?: MemoryLingerOverride
}

const MEMORY_SAVE_HINT =
  'Wrap valid JSON like {"lane":"ltm","content":"the fact to remember","importance":6} inside ' +
  `<${MEMORY_CONTROL_TAG}>...</${MEMORY_CONTROL_TAG}>. Lane is required (awareness | stm | ltm); ` +
  'stm saves also require trigger_terms.'

export function memorySaveHint(): string {
  return MEMORY_SAVE_HINT
}

/**
 * SA-104 P3: THE per-agent memory enablement rule (DL-104-16). Reads the agent record's
 * `memory_enabled` field (default false — memory is opt-in; the Settings toggle ships in
 * P5). camelCase alias tolerated for API-shaped agent objects.
 */
export function resolveAgentMemoryEnabled(agent: unknown): boolean {
  if (!agent || typeof agent !== 'object') return false
  const record = agent as Record<string, any>
  if (typeof record.memory_enabled === 'boolean') return record.memory_enabled
  if (typeof record.memoryEnabled === 'boolean') return record.memoryEnabled
  return false
}

function normalizeStringList(
  value: unknown,
  field: string,
  maxEntries: number
): { ok: true; value: string[] | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (!Array.isArray(value)) {
    return { ok: false, error: `"${field}" must be an array of strings.` }
  }
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  if (normalized.length !== value.length) {
    return { ok: false, error: `"${field}" must contain only non-empty strings.` }
  }
  if (normalized.length > maxEntries) {
    return { ok: false, error: `"${field}" allows at most ${maxEntries} entries.` }
  }
  const deduped = Array.from(new Set(normalized))
  return { ok: true, value: deduped.length > 0 ? deduped : undefined }
}

function normalizeTimestamp(
  value: unknown,
  field: string
): { ok: true; value: string | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `"${field}" must be an ISO timestamp string.` }
  }
  const parsed = new Date(value).getTime()
  if (!Number.isFinite(parsed)) {
    return { ok: false, error: `"${field}" is not a valid timestamp: '${value}'.` }
  }
  return { ok: true, value }
}

export type MemorySaveValidation =
  | { ok: true; value: MemorySavePayload }
  | { ok: false; error: string; hint: string }

/**
 * Semantic validation of one memory save payload — identical for the inline tag and the
 * save tool. Lane is required and deliberate (DL-104-03: placement is the agent's save-time
 * choice); importance defaults to 5; stm requires trigger terms.
 */
export function validateMemorySavePayload(raw: unknown): MemorySaveValidation {
  const fail = (error: string): MemorySaveValidation => ({ ok: false, error, hint: MEMORY_SAVE_HINT })

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('Memory save payload must be a JSON object.')
  }
  const payload = raw as Record<string, unknown>

  const lane = typeof payload.lane === 'string' ? payload.lane.trim().toLowerCase() : ''
  if (!MEMORY_CONTROL_LANES.includes(lane as MemoryControlLane)) {
    return fail(
      `"lane" is required and must be one of: ${MEMORY_CONTROL_LANES.join(', ')}. Choose the placement deliberately.`
    )
  }

  const content = typeof payload.content === 'string' ? payload.content.trim() : ''
  if (!content) {
    return fail('"content" is required and must be a non-empty string.')
  }
  if (content.length > MEMORY_SAVE_MAX_CONTENT_CHARS) {
    return fail(
      `"content" is ${content.length} characters; memories are compact facts capped at ${MEMORY_SAVE_MAX_CONTENT_CHARS}. Split it or summarize.`
    )
  }

  let gist: string | undefined
  if (payload.gist !== undefined && payload.gist !== null) {
    if (typeof payload.gist !== 'string' || !payload.gist.trim()) {
      return fail('"gist" must be a non-empty string when provided.')
    }
    gist = payload.gist.trim()
    if (gist.length > MEMORY_SAVE_MAX_GIST_CHARS) {
      return fail(`"gist" is capped at ${MEMORY_SAVE_MAX_GIST_CHARS} characters.`)
    }
  }

  let importance = MEMORY_SAVE_DEFAULT_IMPORTANCE
  if (payload.importance !== undefined && payload.importance !== null) {
    const value = typeof payload.importance === 'number' ? payload.importance : Number.NaN
    if (!Number.isFinite(value) || value < 1 || value > 10) {
      return fail('"importance" must be a number from 1 to 10.')
    }
    importance = value
  }

  const triggerTerms = normalizeStringList(
    payload.trigger_terms,
    'trigger_terms',
    MEMORY_SAVE_MAX_TRIGGER_TERMS
  )
  if (!triggerTerms.ok) return fail(triggerTerms.error)
  // Retired field, still accepted: synonyms fold into terms (they always matched
  // identically anyway), so a save from an older prompt keeps working.
  const triggerSynonyms = normalizeStringList(
    payload.trigger_synonyms,
    'trigger_synonyms',
    MEMORY_SAVE_MAX_TRIGGER_TERMS
  )
  if (!triggerSynonyms.ok) return fail(triggerSynonyms.error)
  const mergedTriggerTerms = Array.from(
    new Set([...(triggerTerms.value ?? []), ...(triggerSynonyms.value ?? [])])
  )

  if (lane === 'stm' && mergedTriggerTerms.length === 0) {
    return fail('stm (Trigger Memory) saves require at least one entry in "trigger_terms".')
  }

  const eventAt = normalizeTimestamp(payload.event_at, 'event_at')
  if (!eventAt.ok) return fail(eventAt.error)
  const expiresAt = normalizeTimestamp(payload.expires_at, 'expires_at')
  if (!expiresAt.ok) return fail(expiresAt.error)

  const links = normalizeStringList(payload.links, 'links', 24)
  if (!links.ok) return fail(links.error)
  const clipIds = normalizeStringList(payload.clip_ids, 'clip_ids', 8)
  if (!clipIds.ok) return fail(clipIds.error)
  const supersedes = normalizeStringList(payload.supersedes, 'supersedes', 12)
  if (!supersedes.ok) return fail(supersedes.error)

  let linger: MemoryLingerOverride | undefined
  if (payload.linger !== undefined && payload.linger !== null) {
    if (payload.linger === 'episode') {
      linger = 'episode'
    } else if (
      typeof payload.linger === 'number' &&
      Number.isInteger(payload.linger) &&
      payload.linger >= 0 &&
      payload.linger <= MEMORY_MAX_LINGER_OVERRIDE_TURNS
    ) {
      linger = payload.linger
    } else {
      return fail(
        `"linger" must be an integer 0-${MEMORY_MAX_LINGER_OVERRIDE_TURNS} (turns) or "episode" (hold for the rest of the episode).`
      )
    }
    if (lane !== 'stm') {
      return fail('"linger" is only for stm (Trigger Memory) saves — other lanes use the agent defaults.')
    }
  }

  return {
    ok: true,
    value: {
      lane: lane as MemoryControlLane,
      content,
      ...(gist ? { gist } : {}),
      ...(mergedTriggerTerms.length > 0 ? { trigger_terms: mergedTriggerTerms } : {}),
      importance,
      ...(eventAt.value ? { event_at: eventAt.value } : {}),
      ...(expiresAt.value ? { expires_at: expiresAt.value } : {}),
      ...(links.value ? { links: links.value } : {}),
      ...(clipIds.value ? { clip_ids: clipIds.value } : {}),
      ...(supersedes.value ? { supersedes: supersedes.value } : {}),
      ...(linger !== undefined ? { linger } : {})
    }
  }
}

export interface ExtractedMemoryBlock {
  raw: string
  payload?: MemorySavePayload
  parseError?: string
}

export interface MemoryControlExtraction {
  cleaned: string
  blocks: ExtractedMemoryBlock[]
  hadBlock: boolean
}

const MEMORY_BLOCK_REGEX = pairedBlockRegexGlobal(MEMORY_CONTROL_TAG)
const MEMORY_UNCLOSED_OPEN_REGEX = new RegExp(`<${MEMORY_CONTROL_TAG}\\b[^>]*>`, 'i')

function memoryBlockInner(block: string): string {
  const openEnd = block.indexOf('>')
  const closeStart = block.toLowerCase().lastIndexOf(`</${MEMORY_CONTROL_TAG}`)
  if (openEnd === -1 || closeStart === -1 || closeStart <= openEnd) return ''
  return block.slice(openEnd + 1, closeStart).trim()
}

/**
 * Extract EVERY `<batshit-memory>` block from a finalized message. Each block is one
 * independent save; malformed blocks come back as `parseError` entries so the caller can
 * surface them loudly (DL-104-05 — never a silent drop). There is deliberately no
 * bare-JSON fallback: an untagged payload is not a save.
 */
export function extractMemoryControls(content: string): MemoryControlExtraction {
  if (!content) {
    return { cleaned: content, blocks: [], hadBlock: false }
  }

  const matches = Array.from(content.matchAll(MEMORY_BLOCK_REGEX))
  const blocks: ExtractedMemoryBlock[] = []

  for (const match of matches) {
    const raw = memoryBlockInner(match[0])
    if (!raw) {
      blocks.push({ raw: '', parseError: 'Memory save block is empty.' })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      blocks.push({
        raw,
        parseError: error instanceof Error ? error.message : 'Failed to parse memory save block.'
      })
      continue
    }
    const validation = validateMemorySavePayload(parsed)
    if (!validation.ok) {
      blocks.push({ raw, parseError: validation.error })
      continue
    }
    blocks.push({ raw, payload: validation.value })
  }

  let cleaned = content.replace(MEMORY_BLOCK_REGEX, '')

  // An unclosed opening tag reaching message end is a malformed save, not silent noise.
  const unclosed = MEMORY_UNCLOSED_OPEN_REGEX.exec(cleaned)
  if (unclosed && unclosed.index !== undefined) {
    blocks.push({
      raw: cleaned.slice(unclosed.index),
      parseError: `Unclosed <${MEMORY_CONTROL_TAG}> block (missing </${MEMORY_CONTROL_TAG}>).`
    })
    cleaned = cleaned.slice(0, unclosed.index)
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()

  return {
    cleaned: blocks.length > 0 ? cleaned : content,
    blocks,
    hadBlock: blocks.length > 0
  }
}

const MEMORY_FABRIC_REF_PATTERN = /^fabric:sys\.memory\./i
const MEMORY_CONTROL_ID_PATTERN = /^sys\.memory\./i

function extractCandidateRefs(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, any>
  const refs: string[] = []
  if (typeof record.ref === 'string') refs.push(record.ref)
  if (typeof record.target === 'string') refs.push(record.target)
  if (record.input && typeof record.input === 'object') {
    const inner = record.input as Record<string, any>
    if (typeof inner.ref === 'string') refs.push(inner.ref)
    if (typeof inner.target === 'string') refs.push(inner.target)
  }
  return refs
}

/**
 * True when an intermediate tool step is a broker call targeting a `sys.memory.*` Fabric
 * control. Used by the cool-tool zip adapter to exempt memory tools from zip-first
 * treatment (DL-104-17: summary-first references only; remembered content is delivered
 * through the DCM insert channel and must never be double-stored as tool-output zips).
 *
 * The `fabric:sys.memory.` / `sys.memory.` ref string in the step's args is the
 * authority: only the memory Fabric family produces those refs, on every lane. The
 * broker tool NAME alone is not required — the n8n lane's steps carry the workflow's
 * tool-node name (e.g. `Batshit_Tools`), which P8 proved evades a name-only gate and
 * re-zipped memory search results on n8n while API/CLI stayed exempt.
 * Still strict: with no matching ref, the step is NOT a memory step and zips normally.
 */
export function isMemoryControlToolStep(step: unknown): boolean {
  if (!step || typeof step !== 'object') return false
  const record = step as Record<string, any>
  for (const candidate of [record.toolInput, record.toolArgs, record.args, record.input, record.action?.toolInput]) {
    for (const ref of extractCandidateRefs(candidate)) {
      const trimmed = ref.trim()
      if (MEMORY_FABRIC_REF_PATTERN.test(trimmed) || MEMORY_CONTROL_ID_PATTERN.test(trimmed)) {
        return true
      }
    }
  }
  return false
}
