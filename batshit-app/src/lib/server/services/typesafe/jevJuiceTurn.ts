/**
 * SA-120 P1 — the route-side glue for one send's Jev Juice lanes.
 *
 * `send-routed` creates one collector per turn, hands the compiler a hint provider
 * (or nothing), then merges what the collector gathered into the Execution Viewer
 * snapshot (`executionMetadata.typesafeCalls`) and the finalized assistant message
 * (`metadata.jevJuice.notes` / `.gaps`). Gates applied here, in order:
 *   - the agent's own switch (`resolveAgentJevSkillToolHintsEnabled`) — OFF means no
 *     provider and no record at all, so the 99% of agents with it off pay nothing;
 *   - PRIMARY lanes only: a group turn gets no provider (P3 owns group judgments);
 *   - a real user turn: approval resumes and context continuations carry no message.
 * The master switch and the key are checked inside `runTypesafeJudgment`, so an agent
 * whose switch is ON while the master is OFF gets a visible `master_off` note.
 *
 * SA-120 P4b adds a second seam of the same shape, `buildSemanticRecallTurn`: a provider the
 * compiler hands to the recall engine, whose one answer the route also gives to the memory
 * commit. Its records and notes ride this same collector.
 *
 * SA-120 P5 adds `buildSmartZipTurn` (gated on the ONE global switch in
 * `global_zip_settings`, not on an agent field): an open provider the compiler calls after its
 * first history pass, a tail provider that only replays the decided lines, and the opened
 * results for the accepted-send commit. `composeJevJuiceHintProviders` exists because the
 * compiler takes a single tail provider: lanes start side by side and print in a fixed order.
 *
 * SA-120 P6 adds `buildPostTurnCheckTurn` (gated on two per-agent switches): a tail provider
 * that only REPLAYS what the after-reply check stored about the previous reply (a Redis read,
 * never a Jev call before a reply), the id to mark as told at the accepted-send boundary, and
 * the after-reply step itself, which runs beside smart zip's on the ONE after-reply site.
 *
 * SA-120 P7 adds `buildUntrustedTextHintProvider`: on a WOKEN turn only, a tail provider that
 * replays what the incoming-text screen stored on the DM that started the turn (one DM read,
 * never a Jev call: the DM was screened when it arrived). Ordinary sends get no provider.
 *
 * SA-120 P9 adds `buildQuickActionTellProvider`: a tail provider that tells the agent about the
 * quick actions Batshit ran for the user since the agent's last reply, ONLY for actions that
 * involve the agent (Josh, 2026-09-18: none of the six v1 actions does; the Goon's instant
 * expressions will be the first). It reads the marks the browser stored on the user messages in
 * the request's own history: no Redis key, no Jev call. A mark before the agent's last reply was
 * told already. A swallowed turn is also dropped from the agent's history by
 * `prepareManagedHistoryMessages`, so the agent is never bothered with "open the voice settings".
 */

import type {
  JevJuiceGap,
  JevJuiceNote,
  JevJuicePostTurnFinding,
  JevJuicePostTurnRecord,
  JevJuiceZipChanges,
  TypesafeCallRecord
} from '$lib/types/typesafe'
import {
  resolveAgentJevMemoryRecallEnabled,
  resolveAgentJevReplyCheckEnabled,
  resolveAgentJevSkillToolHintsEnabled,
  resolveAgentJevStyleCoachEnabled,
  resolveJevSmartZipEnabled
} from '$lib/utils/jevJuiceControl'
import { quickActionInvolvesAgent, quickActionTellLine, readQuickActionMark } from '$lib/utils/jevJuiceQuickActions'
import { extractMemoryControls, memoryControlIdsOfToolStep, resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import type { MemoryInferredRecall, MemoryInferredRecallProvider } from '../memory/memoryRecall'
import { computeSemanticRecall } from '../memory/semanticRecall.jev'
import { computeSkillToolHints } from '../skillToolHints.jev'
import type { ZipExposed } from '$lib/services/messageCompiler'
import { CONTROL_TAGS, pairedBlockRegexGlobal, renderHiddenTagNames } from '$lib/utils/controlTags'
import { calculateZipActivation } from '$lib/utils/zipActivation'
import { stripZipControlBlocks } from '$lib/utils/zipControl'
import { redis } from '$lib/server/redis'
import { publishUserEvent } from '$lib/server/ssePublisher'
import {
  buildSmartZipClosedDcmLines,
  computeSmartZipHints,
  computeSmartZipRezips,
  type SmartZipNewResult,
  type SmartZipOpen,
  type SmartZipRezip
} from '../smartZip.jev'
import { loadUntoldInferredRezips, writeInferredRezips, type InferredRezipMarker } from '../zipStateInferred'
import {
  buildPostTurnCheckDcmLines,
  computeReplyCheck,
  computeStyleCoach,
  STYLE_COACH_THRESHOLDS,
  POST_TURN_CHECK_LIMITS,
  type PostTurnToolFact
} from '../postTurnCheck.jev'
import { loadPostTurnRecord, writePostTurnRecord } from '../postTurnCheckState'
import { buildUntrustedTextDcmLines } from '../untrustedText.jev'
import { getDm } from '../dm/dmStore'
import type { DmRecord } from '$lib/types/dm'
import type { JevJuiceHintProvider, JevJuiceSmartZipProvider } from './jevJuiceHintContext'
import { appendTypesafeCallRecords } from './typesafeEvidence'
import type { TypesafeClient } from './typesafeClient'

export interface JevJuiceTurnCollector {
  records: TypesafeCallRecord[]
  notes: JevJuiceNote[]
  gaps: JevJuiceGap[]
  /** SA-120 P5: zip state Batshit itself changed for this send, as STORED at the accepted-send boundary. */
  zips: JevJuiceZipChanges
}

export function createJevJuiceTurnCollector(): JevJuiceTurnCollector {
  return { records: [], notes: [], gaps: [], zips: { opened: [] } }
}

export interface SkillToolHintProviderInput {
  userId: string
  agent: Record<string, any> | null | undefined
  message: string
  isGroupTurn: boolean
  collector: JevJuiceTurnCollector
  /** Test seam. */
  client?: TypesafeClient
}

/** Returns a provider for eligible primary turns, else `undefined` (no provider, no record). */
export function buildSkillToolHintProvider(input: SkillToolHintProviderInput): JevJuiceHintProvider | undefined {
  if (!input.agent || !resolveAgentJevSkillToolHintsEnabled(input.agent)) return undefined
  if (input.isGroupTurn) return undefined
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message) return undefined

  return async (context) => {
    try {
      const outcome = await computeSkillToolHints({
        userId: input.userId,
        agent: input.agent as Record<string, any>,
        message,
        skills: context.skills,
        discoverable: context.discoverable,
        resolvedGatewayIds: context.resolvedGatewayIds,
        client: input.client
      })
      if (outcome.record) input.collector.records.push(outcome.record)
      if (outcome.note) input.collector.notes.push(outcome.note)
      if (outcome.gap) input.collector.gaps.push(outcome.gap)
      return outcome.lines
    } catch (error) {
      // `computeSkillToolHints` is written not to throw; this is the last net so a
      // bug in the lane can never fail a send. Loud, not silent.
      console.error('[Jev Juice] skill/tool hint lane threw; no hints this turn:', error)
      return []
    }
  }
}

export interface SmartZipTurnInput {
  userId: string
  sessionId: string
  agent: Record<string, any> | null | undefined
  /** The user's `global_zip_settings`, freshly read for this send; the ONE switch lives there. */
  globalZipSettings: Record<string, any> | null | undefined
  message: string
  isGroupTurn: boolean
  collector: JevJuiceTurnCollector
  /** Test seams. */
  client?: TypesafeClient
  loadUntoldRezips?: (sessionId: string) => Promise<InferredRezipMarker[]>
  postTurnDeps?: Partial<SmartZipPostTurnDeps>
}

/** What the after-reply step touches outside this module; injectable so its tests need no Redis and no network. */
export interface SmartZipPostTurnDeps {
  loadZip: (zipId: string) => Promise<Record<string, any> | null>
  writeRezips: typeof writeInferredRezips
  appendRecords: typeof appendTypesafeCallRecords
  publish: typeof publishUserEvent
}

export interface SmartZipPostTurnInput {
  /** The assistant message this reply was written to: where the Execution Viewer row lands. */
  messageId: string
  /** The finished reply as the user sees it. */
  reply: string
  /** The zips this reply created (its tool results). */
  newZipIds: string[]
}

export interface SmartZipTurn {
  /** Handed to the compiler: makes the ONE Jev call and answers with the results to open for this compile. */
  openProvider: JevJuiceSmartZipProvider
  /** Composed into the tail provider: replays the decided lines. No network, no second call. */
  hintProvider: JevJuiceHintProvider
  /** What this send's compile opened ([] before it ran, on a miss, or on a quiet turn), for the accepted-send commit. */
  getOpens: () => SmartZipOpen[]
  /** The earlier inferred rezips this send's DCM told the agent about, for the same commit to mark as told. */
  getToldRezipIds: () => string[]
  /** Handed to the compiler beside the open provider: what the final history pass left expanded. */
  exposedObserver: (exposed: ZipExposed[]) => void
  /**
   * After the reply is complete: asks Jev which still-open results the agent is done with,
   * zips those (`source: 'inferred'`), tells every tab, and appends the Execution Viewer row.
   * Never throws and never delays the reply; a miss zips nothing.
   */
  runPostTurn: (input: SmartZipPostTurnInput) => Promise<SmartZipRezip[]>
}

/**
 * The finished reply as prose for Jev: hidden control blocks are gone (the shared registry
 * names them all), and each inline zip reference reads as the tool result it stands for, so
 * the judgment is about what the agent SAID, never about Batshit's record marks.
 */
export function replyProseForJudgment(raw: string): string {
  let text = stripZipControlBlocks(typeof raw === 'string' ? raw : '')
  for (const tag of renderHiddenTagNames()) text = text.replace(pairedBlockRegexGlobal(tag), '')
  return text
    .replace(/\{\{batshit-zip:[^:}]+(?::::([^}]*))?\}\}/g, (_match, description: string | undefined) =>
      description && description.trim() ? `[tool result: ${description.trim()}]` : '[tool result]'
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A stored zip record as the after-reply step needs it. `null` when it is not a tool result worth asking about. */
function describeNewResult(
  zipId: string,
  zip: Record<string, any> | null,
  agent: Record<string, any>,
  globalZipSettings: Record<string, any> | null | undefined
): SmartZipNewResult | null {
  if (!zip || typeof zip !== 'object') return null
  const metadata = (zip.metadata && typeof zip.metadata === 'object' ? zip.metadata : {}) as Record<string, any>
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const tokens = [metadata.promptTokens, metadata.aiTokens, zip.tokens, metadata.tokens].find(
    (value) => typeof value === 'number' && Number.isFinite(value)
  ) as number | undefined
  // Today's zip rules, asked about a result zero replies old: would the NEXT compile leave it expanded?
  const activation = calculateZipActivation({
    zipType: text(zip.type) || 'cool_tool',
    messagesFromEnd: 0,
    zipData: { type: zip.type, tokens: zip.tokens, metadata, name: zip.name },
    agentSettings: agent,
    globalSettings: globalZipSettings ?? undefined,
    toolName: text(metadata.operationKind) || text(metadata.toolName) || text(zip.name) || undefined,
    fallbackTokens: tokens ?? 0
  })
  const label = text(metadata.zipDescriptionLabel)
  const target = text(metadata.zipDescriptionTarget)
  return {
    zipId,
    zipType: text(zip.type),
    description: text(zip.description),
    ...(label || target ? { descriptionParts: { label, target, status: text(metadata.zipDescriptionStatus) } } : {}),
    tokens: tokens ?? 0,
    operationKind: text(metadata.operationKind) || undefined,
    toolName: activation.toolName,
    expandedNextTurn: !activation.shouldCompress && !activation.zipDisabled
  }
}

/**
 * SA-120 P5: smart zip for one send. Same gates as the skill/tool lane except that the
 * switch is GLOBAL. Returns `undefined` for every ineligible turn (no providers, no record),
 * so with the switch OFF the compile is today's bytes and nothing is ever written.
 *
 * The closure answers ONCE per send (a second compile of the same send gets the same
 * answer), the tail lines are a replay of that one decision, and the route commits exactly
 * what the compile used — the same shape as recall by meaning.
 */
export function buildSmartZipTurn(input: SmartZipTurnInput): SmartZipTurn | undefined {
  if (!input.agent || !resolveJevSmartZipEnabled(input.globalZipSettings)) return undefined
  if (input.isGroupTurn) return undefined
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message || !input.sessionId) return undefined

  let answer: Promise<{ opens: SmartZipOpen[]; lines: string[] }> | null = null
  let settledOpens: SmartZipOpen[] = []
  let toldRezipIds: string[] = []
  let exposedByCompile: ZipExposed[] = []
  const deps: SmartZipPostTurnDeps = {
    loadZip: (zipId) => redis.getZip(zipId) as Promise<Record<string, any> | null>,
    writeRezips: writeInferredRezips,
    appendRecords: appendTypesafeCallRecords,
    publish: publishUserEvent,
    ...(input.postTurnDeps ?? {})
  }

  const decide = (zippedItems: Parameters<JevJuiceSmartZipProvider>[0]['zippedItems']) => {
    answer ??= (async () => {
      // What Batshit zipped after the last reply is told first, Jev or no Jev: it already happened.
      let closedLines: string[] = []
      try {
        const untold = await (input.loadUntoldRezips ?? loadUntoldInferredRezips)(input.sessionId)
        closedLines = buildSmartZipClosedDcmLines(untold)
        toldRezipIds = untold.map((marker) => marker.zipId)
      } catch (error) {
        console.error('[Jev Juice] smart zip could not read its earlier rezips; the notice is skipped this turn:', error)
      }
      try {
        const outcome = await computeSmartZipHints({
          userId: input.userId,
          agent: input.agent as Record<string, any>,
          globalZipSettings: input.globalZipSettings,
          message,
          zippedItems,
          client: input.client
        })
        if (outcome.record) input.collector.records.push(outcome.record)
        if (outcome.note) input.collector.notes.push(outcome.note)
        settledOpens = outcome.opens
        const lines =
          closedLines.length > 0 && outcome.lines.length > 0
            ? [...closedLines, '', ...outcome.lines]
            : [...closedLines, ...outcome.lines]
        return { opens: outcome.opens, lines }
      } catch (error) {
        // `computeSmartZipHints` is written not to throw; this is the last net so a bug in the
        // lane can never fail a send. Loud, not silent.
        console.error('[Jev Juice] smart zip lane threw; nothing opened and no zip hints this turn:', error)
        return { opens: [], lines: closedLines }
      }
    })()
    return answer
  }

  return {
    openProvider: async (context) => (await decide(context.zippedItems)).opens,
    // The compiler calls this after the history passes, so the decision is already made. A
    // compile that never asked (no history pass here) has nothing zipped to judge.
    hintProvider: async () => (await decide([])).lines,
    getOpens: () => settledOpens,
    getToldRezipIds: () => toldRezipIds,
    exposedObserver: (exposed) => {
      exposedByCompile = Array.isArray(exposed) ? [...exposed] : []
    },
    runPostTurn: async (postTurn) => {
      try {
        const reply = replyProseForJudgment(postTurn.reply)
        if (!reply) return []
        const newResults: SmartZipNewResult[] = []
        for (const zipId of Array.from(new Set(postTurn.newZipIds.filter(Boolean)))) {
          const described = describeNewResult(
            zipId,
            await deps.loadZip(zipId),
            input.agent as Record<string, any>,
            input.globalZipSettings
          )
          if (described) newResults.push(described)
        }
        const outcome = await computeSmartZipRezips({
          userId: input.userId,
          globalZipSettings: input.globalZipSettings,
          userRequest: message,
          reply,
          exposed: exposedByCompile,
          newResults,
          client: input.client
        })
        if (!outcome.record) return []

        let zipped: SmartZipRezip[] = []
        if (outcome.rezips.length > 0) {
          const stored = await deps.writeRezips(
            input.sessionId,
            outcome.rezips.map((rezip) => ({
              zipId: rezip.zipId,
              description: rezip.description,
              done: rezip.done,
              again: rezip.again
            }))
          )
          zipped = outcome.rezips.filter((rezip) => stored.includes(rezip.zipId))
          if (zipped.length < outcome.rezips.length) {
            // The user or the agent acted on one between the judgment and the write: they win.
            outcome.record.detail = `${outcome.record.detail ? `${outcome.record.detail}; ` : ''}${outcome.rezips.length - zipped.length} left alone: the user or the agent changed it first`
          }
          if (zipped.length > 0) {
            await deps.publish(input.userId, {
              type: 'zip_state_changed',
              sessionId: input.sessionId,
              source: 'inferred',
              opened: [],
              rezipped: zipped.map((rezip) => rezip.zipId)
            })
          }
        }
        // The reply's snapshot already exists, so the row is appended to it (DL-120-07).
        const attached = await deps.appendRecords(input.sessionId, postTurn.messageId, [outcome.record])
        if (!attached) {
          console.warn('[Jev Juice] smart zip after-reply row could not be attached to a snapshot:', {
            sessionId: input.sessionId,
            messageId: postTurn.messageId
          })
        }
        return zipped
      } catch (error) {
        // Loud, not silent, and never the user's problem: the reply is already complete.
        console.error('[Jev Juice] smart zip after-reply step threw; nothing was zipped:', error)
        return []
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SA-120 P6: the after-reply check (reply check + style coach)
// ---------------------------------------------------------------------------

/** A chat message as the route holds it: the browser's copy from the request body, oldest first. */
export interface PostTurnHistoryMessage {
  id?: string
  role?: string
  content?: unknown
  agent_id?: string | null
  metadata?: Record<string, any> | null
}

export interface PostTurnCheckTurnInput {
  userId: string
  sessionId: string
  agent: Record<string, any> | null | undefined
  /** The user message this turn answers. */
  message: string
  isGroupTurn: boolean
  /** The chat BEFORE this turn, as the compiler gets it. */
  history: PostTurnHistoryMessage[]
  /** Test seams. */
  client?: TypesafeClient
  deps?: Partial<PostTurnCheckDeps>
}

/** What the lane touches outside this module; injectable so its tests need no Redis and no network. */
export interface PostTurnCheckDeps {
  loadZip: (zipId: string) => Promise<Record<string, any> | null>
  loadRecord: typeof loadPostTurnRecord
  writeRecord: typeof writePostTurnRecord
  appendRecords: typeof appendTypesafeCallRecords
  publish: typeof publishUserEvent
}

export interface PostTurnCheckPostTurnInput {
  /** The assistant message this reply was written to: where the record and the Execution Viewer rows land. */
  messageId: string
  /** The finished reply exactly as the model wrote it (control blocks included: a memory block is a fact). */
  reply: string
  /** The zips this reply created (its tool results). */
  newZipIds: string[]
  /** The turn's tool steps, for the calls that leave no zip (memory controls, DL-104-17). */
  toolSteps: unknown[]
  /** The reply stopped to wait for an approval: it is not finished, so there is nothing to check yet. */
  awaitingApproval: boolean
  /**
   * Another after-reply step that appends rows to the SAME snapshot (smart zip's). Appending is
   * a read-modify-write, so two steps that run side by side would each overwrite the other's
   * rows; this one judges beside it and appends only once that one has settled.
   */
  appendRowsAfter?: Promise<unknown>
}

export interface PostTurnCheckTurn {
  /** Composed into the tail provider: replays what was noticed about the PREVIOUS reply. No Jev call. */
  hintProvider: JevJuiceHintProvider
  /** The reply whose lines this send's prompt carried (`null` when it carried none), for the accepted-send commit. */
  getToldMessageId: () => string | null
  /**
   * After the reply is complete: checks it, stores what was noticed, tells every tab, and
   * appends the Execution Viewer rows. Never throws, never delays the reply, never edits it.
   */
  runPostTurn: (input: PostTurnCheckPostTurnInput) => Promise<JevJuicePostTurnRecord | null>
}

const MEMORY_WRITE_CONTROLS = new Set(['sys.memory.save', 'sys.memory.update', 'sys.memory.supersede', 'sys.memory.whiteboard'])
const ZIP_REFERENCE_DESCRIPTION = /\{\{batshit-zip:[^:}]+:::([^}]*)\}\}/g

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isFinishedReply(message: PostTurnHistoryMessage): boolean {
  if (message.role !== 'assistant') return false
  const metadata = message.metadata ?? {}
  return metadata.response_failed !== true && metadata.interrupted !== true && Boolean(textOf(message.content).trim())
}

/** The one-line labels of tool results from earlier replies, oldest first (they sit inside each zip reference). */
export function collectEarlierToolLabels(history: PostTurnHistoryMessage[]): string[] {
  const labels: string[] = []
  for (const message of history) {
    if (message.role !== 'assistant') continue
    for (const match of textOf(message.content).matchAll(ZIP_REFERENCE_DESCRIPTION)) {
      const label = (match[1] ?? '').trim()
      if (label && !labels.includes(label)) labels.push(label)
    }
  }
  return labels.slice(-POST_TURN_CHECK_LIMITS.maxEarlierToolLabels)
}

/** What each inline control block DOES, in the words a tool label would use. */
const INLINE_CONTROL_LABELS: Record<string, string> = {
  memory: 'memory: save (inline block)',
  'zip-control': 'zip control: zip or unzip tool results (inline block)',
  'tool-notes': 'tool notes (inline block)',
  cue: 'goon cue (inline block)'
}

/**
 * An inline control block is an ACTION the turn took, and it leaves no tool-result zip: the
 * prose for Jev has the block stripped, so "Saving that now" beside a `<batshit-memory>` block
 * read as a claim nothing accounts for (found live: 0.78, and the agent then saved it twice).
 * Each block present in the raw reply is listed as a fact, through the one control-tag registry.
 */
export function inlineControlLabels(rawReply: string): string[] {
  const raw = typeof rawReply === 'string' ? rawReply : ''
  return CONTROL_TAGS.filter((spec) => spec.id in INLINE_CONTROL_LABELS && pairedBlockRegexGlobal(spec.tag).test(raw)).map(
    (spec) => INLINE_CONTROL_LABELS[spec.id]
  )
}

/** A stored tool-result zip as a fact about the turn. `null` for anything that is not a tool result. */
function toolFactOf(zip: Record<string, any> | null): PostTurnToolFact | null {
  if (!zip || typeof zip !== 'object' || textOf(zip.type) !== 'cool_tool') return null
  const metadata = (zip.metadata && typeof zip.metadata === 'object' ? zip.metadata : {}) as Record<string, any>
  const description = textOf(zip.description).trim()
  if (!description) return null
  const operationKind = textOf(metadata.operationKind).trim()
  const label = textOf(metadata.zipDescriptionLabel).trim()
  return {
    description,
    // An MCP or other unclassified tool is its own kind; the built-in kinds are shared (`bash`, `read_file`…).
    kind: (operationKind && operationKind !== 'unknown_tool' ? operationKind : textOf(metadata.toolName).trim() || label || textOf(zip.name).trim()) || 'tool',
    target: textOf(metadata.zipDescriptionTarget).trim(),
    status: textOf(metadata.zipDescriptionStatus).trim()
  }
}

function roundFinding(finding: JevJuicePostTurnFinding): JevJuicePostTurnFinding {
  return typeof finding.probability === 'number'
    ? { ...finding, probability: Math.round(finding.probability * 100) / 100 }
    : finding
}

/**
 * SA-120 P6: the after-reply check for one send. Returns `undefined` for every ineligible turn
 * (both switches off, a group turn, a resume with no user message), so with the switches OFF
 * the compile is today's bytes, nothing is read, and nothing is ever written.
 */
export function buildPostTurnCheckTurn(input: PostTurnCheckTurnInput): PostTurnCheckTurn | undefined {
  if (!input.agent) return undefined
  const replyCheck = resolveAgentJevReplyCheckEnabled(input.agent)
  const styleCoach = resolveAgentJevStyleCoachEnabled(input.agent)
  if (!replyCheck && !styleCoach) return undefined
  if (input.isGroupTurn) return undefined
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message || !input.sessionId) return undefined

  const agent = input.agent
  const history = Array.isArray(input.history) ? input.history : []
  const deps: PostTurnCheckDeps = {
    loadZip: (zipId) => redis.getZip(zipId) as Promise<Record<string, any> | null>,
    loadRecord: loadPostTurnRecord,
    writeRecord: writePostTurnRecord,
    appendRecords: appendTypesafeCallRecords,
    publish: publishUserEvent,
    ...(input.deps ?? {})
  }

  let told: Promise<string[]> | null = null
  let toldMessageId: string | null = null

  return {
    // One-turn semantics, like `control_errors`: only the MOST RECENT assistant message counts,
    // and only until the agent has been told once.
    hintProvider: () => {
      told ??= (async () => {
        try {
          const previous = [...history].reverse().find((entry) => entry.role === 'assistant' && entry.id)
          if (!previous?.id) return []
          const record = await deps.loadRecord(input.sessionId, previous.id)
          if (!record || record.toldAgent) return []
          const lines = buildPostTurnCheckDcmLines(record, { replyCheck, styleCoach })
          if (lines.length > 0) toldMessageId = previous.id
          return lines
        } catch (error) {
          console.error('[Jev Juice] the after-reply notes could not be read; the agent is not told this turn:', error)
          return []
        }
      })()
      return told
    },
    getToldMessageId: () => toldMessageId,
    runPostTurn: async (postTurn) => {
      try {
        if (postTurn.awaitingApproval || !postTurn.messageId) return null
        const prose = replyProseForJudgment(postTurn.reply)
        if (!prose) return null

        const tools: PostTurnToolFact[] = []
        for (const zipId of Array.from(new Set(postTurn.newZipIds.filter(Boolean)))) {
          const fact = toolFactOf(await deps.loadZip(zipId))
          if (fact) tools.push(fact)
        }
        const memoryControls = (Array.isArray(postTurn.toolSteps) ? postTurn.toolSteps : []).flatMap((step) =>
          memoryControlIdsOfToolStep(step)
        )
        const agentId = typeof agent.id === 'string' ? agent.id : null
        const replies = history
          .filter((entry) => isFinishedReply(entry) && (!entry.agent_id || !agentId || entry.agent_id === agentId))
          .map((entry) => replyProseForJudgment(textOf(entry.content)))
          .filter(Boolean)
          .slice(-STYLE_COACH_THRESHOLDS.phraseWindow)
        const userMessages = [
          ...history.filter((entry) => entry.role === 'user').map((entry) => textOf(entry.content)),
          message
        ].slice(-6)

        const [check, style] = await Promise.all([
          computeReplyCheck({
            userId: input.userId,
            agent,
            userRequest: message,
            reply: prose,
            tools,
            extraToolLabels: [
              ...Array.from(new Set(memoryControls)).map((id) => `memory: ${id.replace(/^sys\.memory\./, '')}`),
              ...inlineControlLabels(postTurn.reply)
            ],
            earlierToolLabels: collectEarlierToolLabels(history),
            memoryEnabled: resolveAgentMemoryEnabled(agent),
            memorySaveAttempted:
              extractMemoryControls(postTurn.reply).hadBlock || memoryControls.some((id) => MEMORY_WRITE_CONTROLS.has(id)),
            client: input.client
          }),
          computeStyleCoach({
            userId: input.userId,
            agent,
            reply: prose,
            recentReplies: replies,
            userMessages,
            client: input.client
          })
        ])

        const record: JevJuicePostTurnRecord = {
          messageId: postTurn.messageId,
          sessionId: input.sessionId,
          agentId,
          at: new Date().toISOString(),
          findings: [...check.findings, ...style.findings].map(roundFinding),
          notes: [check.note, style.note].filter((note): note is JevJuiceNote => Boolean(note)),
          toldAgent: false
        }
        let stored: JevJuicePostTurnRecord | null = null
        if (record.findings.length > 0 || record.notes.length > 0) {
          if (await deps.writeRecord(record)) {
            stored = record
            // The session stream already ended, so every tab learns through the USER channel.
            await deps.publish(input.userId, {
              type: 'jev_juice_post_turn',
              sessionId: input.sessionId,
              messageId: postTurn.messageId
            })
          }
        }

        // The reply's snapshot already exists, so the rows are appended to it (DL-120-07), one
        // writer at a time.
        const rows = [check.record, style.record].filter((row): row is TypesafeCallRecord => Boolean(row))
        if (postTurn.appendRowsAfter) await postTurn.appendRowsAfter.catch(() => undefined)
        if (rows.length > 0 && !(await deps.appendRecords(input.sessionId, postTurn.messageId, rows))) {
          console.warn('[Jev Juice] after-reply check rows could not be attached to a snapshot:', {
            sessionId: input.sessionId,
            messageId: postTurn.messageId
          })
        }
        return stored
      } catch (error) {
        // Loud, not silent, and never the user's problem: the reply is already complete.
        console.error('[Jev Juice] the after-reply check threw; nothing was stored:', error)
        return null
      }
    }
  }
}

export interface UntrustedTextHintProviderInput {
  userId: string
  agentId: string | null | undefined
  /**
   * The DM that started THIS running turn, as the wake registry recorded it
   * (`getWakeRun(sessionId)?.origin.dmId`). Server-owned on purpose: `metadata.wake` in a
   * request body is the caller's word, and this lane must never print a flag about a DM the
   * caller merely named.
   */
  wakeDmId: string | null | undefined
  message: string
  isGroupTurn: boolean
  collector: JevJuiceTurnCollector
  /** Test seam. */
  loadDm?: (dmId: string) => Promise<DmRecord | null>
}

/**
 * SA-120 P7: the woken turn's closing DCM section. The message that started a woken turn IS the
 * DM's text, so this is where the agent that reads it is told about a flag (DL-120-04), in the
 * very prompt that carries the text.
 *
 * A REPLAY, never a call: every DM is screened once, when it arrives and before it is delivered
 * (`screenIncomingDms` in `dmTools.ts`), so the answer is already on the record. One DM read per
 * woken send; an ordinary send (no wake run) gets no provider, no read, and no bytes.
 *
 *   - `flagged`  → the `jev_juice_screen` lines.
 *   - `no_flag`  → NOTHING. A missing flag proves nothing, and "screened, clean" in a prompt
 *                  would lower the agent's guard toward text it must keep treating as data.
 *   - `skipped`  → no lines, and the quiet Jev Juice note under the woken reply (DL-120-02).
 *
 * Evidence: a webhook is received with no turn running, so its call's Execution Viewer row has
 * had no snapshot to live in; this turn is the one that call was made for, so the row is
 * replayed into it. An agent's DM was screened inside the SENDER's turn and its row is already
 * on that reply: one call, one row.
 */
export function buildUntrustedTextHintProvider(
  input: UntrustedTextHintProviderInput
): JevJuiceHintProvider | undefined {
  const dmId = typeof input.wakeDmId === 'string' ? input.wakeDmId.trim() : ''
  if (!dmId || input.isGroupTurn) return undefined
  // A real woken user turn only: a continuation or an approval resume carries no message, and
  // the DM's text is not what it is reading.
  if (typeof input.message !== 'string' || !input.message.trim()) return undefined

  const loadDm = input.loadDm ?? getDm
  let answer: Promise<string[]> | null = null
  return () => {
    // Once per send: a second compile of the same send must not add the row or the note twice.
    answer ??= (async () => {
      try {
        const record = await loadDm(dmId)
        if (!record || record.userId !== input.userId || record.to !== input.agentId) return []
        const screen = record.screen
        if (!screen) return []
        if (record.from.kind === 'webhook' && screen.record) input.collector.records.push(screen.record)
        if (screen.status === 'skipped') {
          input.collector.notes.push({
            feature: screen.record?.feature ?? 'untrusted_text',
            status: screen.record?.status === 'error' ? 'error' : 'unavailable',
            reason: screen.reason ?? 'master_off',
            at: screen.at
          })
        }
        return buildUntrustedTextDcmLines(screen)
      } catch (error) {
        console.error('[Jev Juice] could not replay the incoming-text screen of a woken turn:', error)
        return []
      }
    })()
    return answer
  }
}

/**
 * The compiler calls ONE tail provider. This runs the given lanes side by side (each already
 * owns its own deadline, evidence, and last-net catch) and joins their lines in the order
 * given, so which lane answers first never changes the prompt. No lanes, no provider.
 */
export function composeJevJuiceHintProviders(
  providers: Array<JevJuiceHintProvider | undefined>
): JevJuiceHintProvider | undefined {
  const active = providers.filter((provider): provider is JevJuiceHintProvider => typeof provider === 'function')
  if (active.length === 0) return undefined
  if (active.length === 1) return active[0]
  return async (context) => {
    const settled = await Promise.allSettled(active.map((provider) => provider(context)))
    const lines: string[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
        if (lines.length > 0) lines.push('')
        lines.push(...result.value)
      } else if (result.status === 'rejected') {
        console.error('[Jev Juice] a hint lane rejected; its lines are omitted this turn:', result.reason)
      }
    }
    return lines
  }
}

export interface GroupSpeakerProviderInput {
  /** The `jev_juice_group` lines for the agent that ended up speaking (may be empty). */
  lines: string[]
  record: TypesafeCallRecord
  note: JevJuiceNote | null
}

/**
 * SA-120 P3: the group scheduler already made its one Jev call BEFORE choosing the speaker,
 * so the speaker's compile gets a provider that only replays the decided lines (no network,
 * no deadline) and its record and any miss note ride the same collector as P1's — the EV
 * row lands on the speaker's snapshot and the note beside its memory chips.
 */
export function buildGroupSpeakerProvider(
  input: GroupSpeakerProviderInput,
  collector: JevJuiceTurnCollector
): JevJuiceHintProvider {
  collector.records.push(input.record)
  if (input.note) collector.notes.push(input.note)
  const lines = [...input.lines]
  return async () => lines
}

export interface SemanticRecallTurnInput {
  userId: string
  agent: Record<string, any> | null | undefined
  message: string
  isGroupTurn: boolean
  collector: JevJuiceTurnCollector
  /** Test seam. */
  client?: TypesafeClient
}

export interface SemanticRecallTurn {
  /** Handed to the compiler, which hands it to the recall engine. */
  provider: MemoryInferredRecallProvider
  /** What the provider answered during this send's compile ([] before it ran or on a miss), for `commitMemoryTurnState`. */
  getRecalls: () => MemoryInferredRecall[]
}

/**
 * SA-120 P4b: recall by meaning. Same gates as the hint lane plus Agent Memory itself
 * (memory off means the recall engine never runs, so there is nothing to feed). The
 * closure answers ONCE per send: a second compile of the same send gets the same answer,
 * and the commit reads that answer instead of asking again, so compile and commit select
 * identically. Returns `undefined` for every ineligible turn (no provider, no record).
 */
export function buildSemanticRecallTurn(input: SemanticRecallTurnInput): SemanticRecallTurn | undefined {
  if (!input.agent || !resolveAgentJevMemoryRecallEnabled(input.agent)) return undefined
  if (!resolveAgentMemoryEnabled(input.agent)) return undefined
  if (input.isGroupTurn) return undefined
  const message = typeof input.message === 'string' ? input.message.trim() : ''
  if (!message) return undefined

  let answer: Promise<MemoryInferredRecall[]> | null = null
  let settled: MemoryInferredRecall[] = []
  const provider: MemoryInferredRecallProvider = (request) => {
    answer ??= (async () => {
      try {
        const outcome = await computeSemanticRecall({
          userId: input.userId,
          agent: input.agent as Record<string, any>,
          message,
          excludeIds: request.excludeIds,
          client: input.client
        })
        if (outcome.record) input.collector.records.push(outcome.record)
        if (outcome.note) input.collector.notes.push(outcome.note)
        settled = outcome.recalls
        return outcome.recalls
      } catch (error) {
        // `computeSemanticRecall` is written not to throw; this is the last net so a bug in
        // the lane can never fail a send. Loud, not silent.
        console.error('[Jev Juice] recall by meaning threw; no inferred recalls this turn:', error)
        return []
      }
    })()
    return answer
  }
  return { provider, getRecalls: () => settled }
}

/** Merges the collector's records into the in-memory execution metadata before the snapshot is recorded. */
export function attachJevJuiceRecords(executionMetadata: Record<string, any>, collector: JevJuiceTurnCollector) {
  if (collector.records.length === 0) return
  const existing = Array.isArray(executionMetadata.typesafeCalls) ? executionMetadata.typesafeCalls : []
  executionMetadata.typesafeCalls = [...existing, ...collector.records]
}

/** The `metadata.jevJuice` block for the finalized assistant message, or `null` when there is nothing to show. */
export function buildJevJuiceMessageMetadata(collector: JevJuiceTurnCollector) {
  const zipsChanged = collector.zips.opened.length > 0
  if (collector.notes.length === 0 && collector.gaps.length === 0 && !zipsChanged) return null
  return {
    notes: collector.notes,
    ...(collector.gaps.length > 0 ? { gaps: collector.gaps } : {}),
    // The tab reads this to know it must re-read zip state from Redis (the server wrote it).
    ...(zipsChanged ? { zips: collector.zips } : {})
  }
}

export interface QuickActionTellProviderInput {
  /** The request's history, oldest first, as `send-routed` received it (the current user message last). */
  messages: Array<{ role?: unknown; content?: unknown; metadata?: unknown }> | null | undefined
  isGroupTurn: boolean
}

/**
 * SA-120 P9: the agent is told what Batshit did for the user by voice since its last reply,
 * for the actions that involve the agent (DL-120-15; design record rule 4; Josh, 2026-09-18:
 * only those). Replay only: the marks are on the user messages the browser stored, so this
 * reads the request's history and never calls Jev. Nothing to tell means no provider, so an
 * ordinary send is byte-identical (compile contract S22).
 */
export function buildQuickActionTellProvider(input: QuickActionTellProviderInput): JevJuiceHintProvider | undefined {
  if (input.isGroupTurn || !Array.isArray(input.messages) || input.messages.length === 0) return undefined
  const lines: string[] = []
  // Walk back from the newest message to the agent's last reply: only what it has not seen.
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]
    if (message?.role === 'assistant') break
    if (message?.role !== 'user') continue
    const mark = readQuickActionMark(message.metadata)
    if (!mark || !quickActionInvolvesAgent(mark.id)) continue
    const said = typeof message.content === 'string' ? message.content : ''
    lines.unshift(`- ${quickActionTellLine(mark, said)}`)
  }
  if (lines.length === 0) return undefined
  const dcm = [
    'jev_juice_quick_actions (Batshit acted on what your user said in Voice Mode, judged by a fast judgment model; your user saw a mark for each one):',
    ...lines
  ]
  return async () => dcm
}
