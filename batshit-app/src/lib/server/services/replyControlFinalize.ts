/**
 * SA-129 P2 (DL-08, closes BL-234): the reply-end control step, on the server, once per reply.
 *
 * `send-routed` calls this for every finished reply of every lane (API, managed Codex, managed
 * Claude) and every caller (an open chat page, a woken or scheduled turn, isolated test driver, the benchmark
 * driver), BEFORE it emits `end` and saves the message:
 *
 *   1. the Tool Notes block: the notes (kept when Tool Notes are on for the agent), and the files
 *      the agent holds or releases (DL-02, `zipHolds.ts`);
 *   2. the memory save blocks, through the same op as `sys.memory.save` (SA-104 P3);
 *   3. the parked zip-control block, applied only when the hidden permission is ON (DL-06);
 *   4. the countdown of temporary holds: this reply is one more message in the chat;
 *   5. every malformed or refused part as a `controlErrors` record (DL-104-05).
 *
 * Each step fails on its own (SA-129 P2b, BL-353): an error in one (a Redis failure) becomes
 * that step's own `controlErrors` line, saying what it had applied before it stopped and what it
 * had not, and the steps after it still run. So an agent is never told "nothing was applied"
 * about saves that landed, and asked to make them again. The function itself does not throw.
 *
 * It returns the cleaned content, which is what `end` carries and what is stored, and the
 * metadata the reply keeps. The chat page only renders; `/api/sse`'s `end` strips the same blocks
 * from the content it rebuilds from the stream (`stripReplyControlBlocks`), so no save can bring a
 * block back.
 */

import { processInlineMemorySaves } from '$lib/server/services/memory/memoryTools'
import { buildControlErrorRecord, type ControlErrorRecord } from '$lib/utils/controlTags'
import { memorySaveHint, resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import {
  REPLY_CONTROL_FINALIZED_FLAG,
  buildReplyControlMetadata,
  extractReplyControl,
  resolveZipToolNotesEnabled
} from '$lib/utils/replyControl'
import { resolveZipAgentControlPermission } from '$lib/utils/zipAgentControlPermission'
import { scanLooseZipReferences } from '$lib/utils/zipReferenceSafety'
import {
  advanceZipCountdowns,
  applyAgentHoldChanges,
  applyLegacyAgentZipActions,
  type AgentHoldChanges
} from './zipHolds'

/** The most memory save blocks one message may carry (the old inline-saves route's cap). */
export const MAX_INLINE_MEMORY_SAVE_BLOCKS = 12

export interface ReplyControlFinalizeInput {
  userId: string
  sessionId: string
  messageId: string
  /** The agent that wrote the reply (a server-owned record, never a body field). */
  agent: { id: string; readonly [field: string]: unknown }
  globalZipSettings: Record<string, any> | null | undefined
  /** The finished reply as the stream built it, control blocks included. */
  content: string
  /** This reply's trusted zip ids, in order. */
  replyZipIds: string[]
  /** The project path the compile resolved relative file paths against. */
  projectPath: string | null
  /** False for an approval resume, which continues a message the chat already counted. */
  countsAsMessage: boolean
}

export interface ReplyControlFinalizeResult {
  content: string
  /** Joins the reply's metadata: `zipControl`, `controlErrors`, `memorySaves`, `zipHolds`, the flag. */
  metadata: Record<string, any>
  /** The chat's zip state changed (a hold, a release, a zip action, a countdown); tabs re-read it. */
  zipStateChanged: 'agent' | 'countdown' | null
  /** The reply carried at least one memory save block (the Judge Juice after-reply check asks). */
  hadMemoryBlock: boolean
}

/**
 * The reply's own zip ids, then every `cool_tool_` zip its words reference, in order. The words
 * are read once (BL-707): the old pattern searched to the first `}` again from every opener, at
 * the reply end, so a reply of openers that never close held the one Node process for seconds.
 */
function currentToolZipIds(replyZipIds: string[], content: string): string[] {
  const ids: string[] = []
  const add = (value: string | undefined) => {
    const id = typeof value === 'string' ? value.trim() : ''
    if (id && id.toLowerCase().startsWith('cool_tool_') && !ids.includes(id)) ids.push(id)
  }
  replyZipIds.forEach(add)
  for (const reference of scanLooseZipReferences(content)) add(reference.id)
  return ids
}

async function processMemoryBlocks(
  input: ReplyControlFinalizeInput,
  blocks: ReturnType<typeof extractReplyControl>['memoryBlocks'],
  errors: ControlErrorRecord[]
): Promise<any[]> {
  const memoryError = (error: string, hint?: string) =>
    errors.push(buildControlErrorRecord('batshit-memory', error, hint ?? memorySaveHint()))

  if (!resolveAgentMemoryEnabled(input.agent)) {
    memoryError(
      'Memory is not enabled for this agent; the memory save block(s) were not stored.',
      'Do not emit <batshit-memory> blocks unless memory is enabled for you.'
    )
    return []
  }
  for (const block of blocks) {
    if (block.parseError) memoryError(block.parseError)
  }
  const payloads = blocks.filter((block) => block.payload).map((block) => block.payload)
  if (payloads.length === 0) return []
  if (payloads.length > MAX_INLINE_MEMORY_SAVE_BLOCKS) {
    memoryError(
      `Memory save failed: at most ${MAX_INLINE_MEMORY_SAVE_BLOCKS} memory save blocks are processed per message.`,
      'The saves were not stored. Save fewer memories per message.'
    )
    return []
  }

  const saves: any[] = []
  try {
    const results = await processInlineMemorySaves({
      userId: input.userId,
      agentId: input.agent.id,
      sessionId: input.sessionId,
      messageId: input.messageId,
      payloads
    })
    for (const result of results) {
      if (result.error) {
        memoryError(result.error, result.hint)
      } else if (result.saved) {
        const saved = result.saved as Record<string, any>
        saves.push({
          id: saved.id,
          lane: saved.lane,
          gist: saved.gist,
          ...(Array.isArray(saved.trigger_terms) && saved.trigger_terms.length > 0
            ? { trigger_terms: saved.trigger_terms }
            : {}),
          ...(result.superseded ? { superseded: result.superseded } : {}),
          ...(result.nearDuplicates?.length ? { nearDuplicates: result.nearDuplicates } : {})
        })
      }
    }
  } catch (error) {
    memoryError(
      `Memory save request failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      'The save was not stored; retry the save in your next message.'
    )
  }
  return saves
}

function hasHoldChanges(changes: AgentHoldChanges): boolean {
  return changes.held.length > 0 || changes.released.length > 0 || changes.moved.length > 0
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function listPaths(entries: Array<{ path: string }>): string {
  return entries.map((entry) => entry.path).join(', ')
}

/** What a hold step that stopped part way had written, in words the agent can act on. */
function describeAppliedHolds(changes: AgentHoldChanges): string {
  const parts = [
    changes.released.length > 0 ? `released ${listPaths(changes.released)}` : '',
    changes.held.length > 0 ? `held ${listPaths(changes.held)}` : '',
    changes.moved.length > 0 ? `moved your hold of ${listPaths(changes.moved)} to the newest read` : ''
  ].filter(Boolean)
  return parts.length > 0 ? `Applied before it stopped: ${parts.join('; ')}.` : 'Nothing was applied.'
}

export async function finalizeReplyControl(input: ReplyControlFinalizeInput): Promise<ReplyControlFinalizeResult> {
  const content = typeof input.content === 'string' ? input.content : ''
  const extraction = extractReplyControl(content)
  const toolNotesEnabled = resolveZipToolNotesEnabled(input.agent, input.globalZipSettings)
  const replyMetadata = buildReplyControlMetadata(extraction, { toolNotesEnabled })
  const errors: ControlErrorRecord[] = [...replyMetadata.controlErrors]
  const metadata: Record<string, any> = { [REPLY_CONTROL_FINALIZED_FLAG]: true }
  if (replyMetadata.zipControl) metadata.zipControl = replyMetadata.zipControl
  let zipStateChanged: ReplyControlFinalizeResult['zipStateChanged'] = null
  const currentReply = { messageId: input.messageId, content, zipIds: input.replyZipIds }

  // Hold and release (DL-02); the hold follows the file at every reply end, asked or not.
  const holdChanges = await applyAgentHoldChanges({
    sessionId: input.sessionId,
    agentId: input.agent.id,
    projectPath: input.projectPath,
    blocks: extraction.holdBlocks,
    currentReply
  })
  errors.push(...holdChanges.errors)
  if (holdChanges.failure) {
    // BL-537: a step that failed may have changed zip state whatever its lists say (the write
    // that failed is not in them), so every tab is told to read it again.
    zipStateChanged = 'agent'
    console.error('[ReplyControl] The hold step stopped part way:', holdChanges.failure)
    errors.push(
      buildControlErrorRecord(
        'batshit-tool-notes',
        `Batshit could not finish this reply's holds and releases (${holdChanges.failure}). ${describeAppliedHolds(holdChanges)}`,
        'Check Current Zip State, then hold or release again in your next reply what is still not the way you want it.'
      )
    )
  }
  if (hasHoldChanges(holdChanges)) {
    zipStateChanged = 'agent'
    metadata.zipHolds = {
      ...(holdChanges.held.length > 0 ? { held: holdChanges.held } : {}),
      ...(holdChanges.released.length > 0 ? { released: holdChanges.released } : {}),
      ...(holdChanges.moved.length > 0 ? { moved: holdChanges.moved } : {})
    }
  }

  // The parked zip-control actions (DL-06): only with the hidden permission ON, and never silent.
  if (extraction.unzip.length > 0 || extraction.zip.length > 0) {
    if (resolveZipAgentControlPermission(input.agent, input.globalZipSettings)) {
      const outcome = await applyLegacyAgentZipActions({
        sessionId: input.sessionId,
        agentId: input.agent.id,
        unzip: extraction.unzip,
        zip: extraction.zip,
        currentReply,
        currentToolZipIds: currentToolZipIds(input.replyZipIds, content)
      })
      if (outcome.errors) errors.push(...outcome.errors)
      if (outcome.unzipped.length > 0 || outcome.zipped.length > 0) zipStateChanged = 'agent'
      if (outcome.failure) {
        zipStateChanged = 'agent'
        console.error('[ReplyControl] The zip-control step stopped part way:', outcome.failure)
        const applied = [
          outcome.unzipped.length > 0 ? `unzipped ${outcome.unzipped.join(', ')}` : '',
          outcome.zipped.length > 0 ? `zipped ${outcome.zipped.join(', ')}` : ''
        ].filter(Boolean)
        errors.push(
          buildControlErrorRecord(
            'batshit-zip-control',
            `Batshit could not finish this reply's zip actions (${outcome.failure}). ${
              applied.length > 0 ? `Applied before it stopped: ${applied.join('; ')}.` : 'Nothing was applied.'
            }`,
            'Check Current Zip State before you ask again.'
          )
        )
      }
    } else {
      errors.push(
        buildControlErrorRecord(
          'batshit-zip-control',
          'Zip control is off for you, so the unzip and zip actions were ignored.',
          'To keep a file you read open, hold it: <batshit-tool-notes>{"hold":["path/to/file"]}</batshit-tool-notes>. Use Fetch Zip to read an earlier result.'
        )
      )
    }
  }

  let hadMemoryBlock = false
  if (extraction.memoryBlocks.length > 0) {
    hadMemoryBlock = true
    const saves = await processMemoryBlocks(input, extraction.memoryBlocks, errors)
    if (saves.length > 0) metadata.memorySaves = saves
  }

  // This reply is one more message in the chat (the user's message counted when it was accepted).
  if (input.countsAsMessage) {
    try {
      const countdown = await advanceZipCountdowns(input.sessionId)
      if (!zipStateChanged && (countdown.counted.length > 0 || countdown.ended.length > 0)) {
        zipStateChanged = 'countdown'
      }
    } catch (error) {
      // Not the agent's doing, and nothing for it to redo; loud on the message all the same. It
      // may have ended a hold before it failed, so tabs read the state again (BL-537).
      if (!zipStateChanged) zipStateChanged = 'countdown'
      console.error('[ReplyControl] The countdown step failed:', error)
      errors.push(
        buildControlErrorRecord(
          'batshit-tool-notes',
          `Batshit could not count this reply toward the results held for a number of messages (${errorText(error)}); they stay open one message longer.`,
          'Nothing for you to do.'
        )
      )
    }
  }

  if (errors.length > 0) metadata.controlErrors = errors
  return { content: extraction.cleaned, metadata, zipStateChanged, hadMemoryBlock }
}
