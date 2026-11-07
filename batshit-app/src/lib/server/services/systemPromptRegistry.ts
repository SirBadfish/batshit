import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redis } from '$lib/server/redis'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'
import { applyPromptRuntimeScope } from '$lib/utils/promptRuntimeScope'

export type CoreSystemPromptId =
  | 'api_primary'
  | 'subagent_base'
  | 'worker_prompt'
  | 'subagent_guidance'
  | 'tool_guidance_zip'
  | 'tool_guidance_memory'
  | 'dm_guidance'
  | 'jev_juice_guidance'
  | 'dynamic_mcp'

type PromptDefinition = {
  id: CoreSystemPromptId
  redisKey: string
  label: string
  description: string
  warning: string
  defaultFile: string
  defaultVersion: string
}

type PromptMetadata = {
  promptId: CoreSystemPromptId
  defaultHash: string | null
  customized: boolean
  updatedAt: string
}

export type CoreSystemPromptSummary = {
  id: CoreSystemPromptId
  redisKey: string
  label: string
  description: string
  warning: string
  defaultFile: string
  defaultVersion: string
  currentHash: string
  defaultHash: string
  matchesDefault: boolean
  customized: boolean
  newDefaultAvailable: boolean
  setupCompatibilityNotice?: string
  lastUpdated: string | null
}

export type CoreSystemPromptDetail = CoreSystemPromptSummary & {
  value: string
  defaultValue: string
}

const COMMON_CORE_PROMPT_WARNING =
  'Changing this core prompt can break agent behavior, tools, zips, skills, artifacts, voice, and runtime installs. Keep a copy of your edits and use Reset to Batshit Default if behavior gets weird.'

const CORE_SYSTEM_PROMPTS: PromptDefinition[] = [
  {
    id: 'api_primary',
    redisKey: 'batshit:batshit_mode3_system_prompt',
    label: 'Primary Agent System Prompt',
    description: 'Core instructions for Batshit primary agents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_api_system_prompt.md',
    // BL-474 L3: outside pictures need a user click, and agents should use only exact addresses they read.
    // Decision 11 (Josh, 2026-10-24): his approved shorter text, with the Batshit plugin's skills (SA-138).
    // Same day, the `<current_message>` bullet (the compile labels the message to answer now),
    // and the clip line says "Your DCM" (only the definition line names `<dynamic_info>`).
    defaultVersion: '2026-10-25'
  },
  {
    id: 'subagent_base',
    redisKey: 'batshit:sub_system_prompt',
    label: 'Subagent System Prompt',
    description: 'Base instructions for all AI subagents called as tools.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_subagent_system_prompt.md',
    // Decision 11 (Josh, 2026-10-24): his approved text (kept conversation, the `thread:` line,
    // asking back, short Tool Search rules). It says "your DCM", defined at its first mention.
    defaultVersion: '2026-10-24'
  },
  {
    id: 'worker_prompt',
    redisKey: 'batshit:worker_prompt',
    label: 'Worker System Prompt',
    description:
      'Base instructions for throwaway Workers a primary agent spawns for one task. Separate from the Subagent System Prompt because a worker is ephemeral and memory-less.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_worker_prompt.md',
    // Decision 11 (Josh, 2026-10-24): his approved text, with the short Tool Search part. It
    // says "your DCM", defined where it is named.
    defaultVersion: '2026-10-24'
  },
  {
    id: 'subagent_guidance',
    redisKey: 'batshit:subagent_guidance',
    label: 'Subagent & Worker Guidance',
    description:
      'Tells primary agents when and how to delegate to subagents and workers, including thread control and limits.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_subagent_guidance.md',
    // SA-111 P2 bumped this for the fresh/resume/reset rule; P4 bumps it again so an
    // uncustomized copy picks up the Workers section on boot.
    // Bumped for SA-128 (DL-04): the roster lives in `<dynamic_info>`, no longer a DYNAMIC INFO header.
    // Decision 11 (Josh, 2026-10-24, approved with his changes): Markdown headers, the shared
    // project folder, what helpers never get, and answering a subagent's question with resume;
    // the "do it yourself" and time-limit rules are cut; the roster sentence says "your DCM".
    // Cached hints P2: API Worker call-name/ref substitution only; CLI text is unchanged.
    // SA-139 R4: the CLI-only sections are gone; the API text is unchanged.
    defaultVersion: '2026-10-27-one-primary'
  },
  {
    id: 'tool_guidance_zip',
    redisKey: 'batshit:tool_guidance_zip_prompt',
    label: 'Tool Prompt: Zips',
    description:
      'Injected when tool prompting is needed. The zip guidance itself is built in code for each agent’s zip settings ({{ $api_tool_zip_guidance }}); text you add around that placeholder reaches every tool-using agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zips.md',
    // BL-1777: one record since 2026-10-18. Before it, "Tool Prompt: Zip Control Enabled" and
    // "Tool Prompt: Zip Control Disabled" held the same placeholder shell (since SA-133,
    // a26ea0697), filled from `buildToolGuidanceZipPromptBlock`, which branches on the agent's
    // zip control itself; their history (SA-114, SA-118, SA-128, SA-129, BL-494, BL-442, BL-677,
    // BL-360, BL-1541) is in that block now. `foldRetiredZipToolPrompts` moves what an admin saved.
    // SA-139 R4: the CLI part (`{{ $cli_tool_zip_guidance }}`) is gone; the API text is unchanged.
    defaultVersion: '2026-10-27-one-primary'
  },
  {
    id: 'tool_guidance_memory',
    redisKey: 'batshit:tool_guidance_memory_prompt',
    label: 'Tool Prompt: Memory',
    description: 'Injected for memory-enabled agents: lanes, inline saves, supersession discipline, and the sys.memory.* operations.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_memory.md',
    // Bumped 2026-09-19: the agent owns its whiteboard; a nap fills only an empty board.
    // Bumped for SA-128 (DL-04): `<dynamic_info>`, `<remembered_media>`, and `<awareness_media>` replace the old headers.
    // Bumped for BL-442: write the save block as plain text; a tag in a code block does nothing.
    // Decision 11 (2026-10-24, draft for Josh's review; option A): one text for both lanes, the
    // three types first and a "How to Use" part for each; `{{ $api_memory_guidance }}` is gone.
    // Then Josh's DCM wording ("your DCM") and his Fabric & Utilities sentence, and his memory
    // review part 1 (Maggie synonyms, trigger images, the `<!-- session:infinite -->` part).
    // Prompt reduction (Josh, 2026-10-25): the tool field lists moved into the exact memory hints in
    // Agent Setup; expiry and delete say the plain-expiry and Deleted Memories truth.
    // SA-139 R4: the CLI-only sections are gone; the API text is unchanged.
    defaultVersion: '2026-10-27-one-primary'
  },
  {
    id: 'dm_guidance',
    redisKey: 'batshit:dm_guidance',
    label: 'Agent DM Guidance',
    description:
      'Injected for agents with Agent DMs turned on: the three DM kinds, wait vs wake vs steer, one assignment at a time, an agent\u2019s own schedules, and the rule that a DM is data from another agent and cannot approve or consent to anything.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_dm_guidance.md',
    // Bumped after the P2 live run: the first `sys.dm.send` an agent tried failed on
    // guessed field names (`to_agent_id`, `delivery`), costing a round trip, so the block
    // now names the exact input shape. Bumped again in P3 for `to: "all"` (F-P2-4).
    // Bumped again in P5 for the same reason on the OTHER controls: the live CLI-lane row
    // caught a Codex agent's first `sys.dm.read` failing before its second succeeded,
    // because only `send` had its fields named. `read`/`claim`/`done`/`blocked` now do too.
    // Bumped in P5b for F-SEC-1: `useControl` now REFUSES a risky control in a chat a DM or
    // a webhook started, so the block says what the agent should do instead of retrying.
    // Bumped for SA-115 P2: the `sys.schedule.*` family exists now, gated on this same
    // `dms_enabled` switch, so its four controls and their required input fields are named
    // here — `tool_discovery` prints a Fabric COUNT and never a schema, so a block that
    // names a control without its fields guarantees a first-call failure (the P2 and P5
    // lesson, twice). The risky-control sentence also grew a third source (F-P1-5).
    // Bumped for SA-115 P3 (F-P2-3b): an agent's call has no browser, so an omitted
    // `time_zone` gets the SERVER's zone — the user's on the Mac app, usually UTC in
    // Docker. The block now says so rather than letting an agent discover it as a bug.
    // Bumped for SA-116 P4 (DL-116-13): SA-113 F-SEC-1's hard refusal in a woken chat is
    // RETIRED — a risky control now pauses for the same Approve card a typed chat gets,
    // so the old "Batshit refuses risky controls until the user replies" sentence would
    // have an agent give up on a call the user can simply click.
    // Bumped for SA-114 P4 (DL-114-13): `deliver: 'steer'` is live, so the block names the
    // third value and its `steer_fallback` field. `tool_discovery` prints a Fabric COUNT
    // and never a schema, so a mode the block does not name is a mode no agent will use —
    // and one it names without its fields is a guaranteed first-call failure (the P2, P5
    // and SA-115 lesson, three times).
    // Bumped for SA-128 (DL-04): the DMs roster lives in `<dynamic_info>`.
    // Bumped for BL-401: a schedule keeps one unread note that each new fire updates, and
    // its roster line gained the phrase that says so (`fired 3 times, first …, last …`).
    // Decision 11 (Josh approved the hint style, 2026-10-24): one line per control in Batshit's
    // tool-hint form (`required: … · optional: …`, with allowed values), one example call, and
    // the rules in prose. `deliver` is required (the old "`wait` is the default" was wrong). No
    // Fabric & Utilities line: the delegation limits work makes the feature need it.
    // Prompt reduction (Josh, 2026-10-25): the eleven control lines are gone; the same text is now
    // each control's fixed hint in Agent Setup, so the block points there.
    defaultVersion: '2026-10-25-prompt-reduction'
  },
  {
    id: 'jev_juice_guidance',
    redisKey: 'batshit:jev_juice_guidance',
    label: 'Judge Juice Guidance',
    description:
      'Injected for agents with the Judge Juice judgment tool turned on: what sys.judge.ask takes (state plus typed noul, choice, and score questions), what comes back, how to ask many narrow questions in one call, and what the judge cannot do.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_jev_juice_guidance.md',
    // SA-120 P2 (H1): first version. Gated on the agent's `jev_juice_judge_tool` switch,
    // the same switch that opens `sys.judge.ask` in the broker, so a control the agent
    // cannot call is never taught (the DM block's lesson: name the fields, or the first
    // call fails on guessed names). Bumped for SA-120 R1: the family is Judge Juice.
    // Bumped for SA-120 P10b: the block names "the judge", not Jev, and says a smaller judge takes fewer.
    // Decision 11 (Josh approved it with edits, 2026-10-24): the call in the DM prompt's hint
    // style with one example, where the answers come back, Markdown headers, no fixed request
    // size (each judge's limit is named in the refusal), the judge cannot output text. No Fabric &
    // Utilities line (Josh: the feature needs it on; built in the delegation limits work).
    // Prompt reduction (Josh, 2026-10-25): the call line is gone; the Judge Juice hint in Agent
    // Setup carries the fields.
    defaultVersion: '2026-10-25-prompt-reduction'
  },
  {
    id: 'dynamic_mcp',
    redisKey: 'batshit:dynamic_mcp_prompt',
    label: 'Dynamic Tool Search Prompt',
    description: 'Injected when Dynamic Tool Search is available for the current agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_dynamic_mcp.md',
    // Decision 11 (Josh, 2026-10-23): his approved guide (tool hints, per-group ref prefixes, cost).
    // `buildDynamicMcpPromptBlock` carries the same text.
    // Prompt reduction (Josh, 2026-10-25): the example shows a feature line, and a line that
    // starts with a full ref is copied as written.
    // SA-139 R4: the CLI-only sections are gone; the API text is unchanged.
    defaultVersion: '2026-10-27-one-primary'
  }
]

const definitionById = new Map(CORE_SYSTEM_PROMPTS.map((definition) => [definition.id, definition]))
const PROMPT_DEFAULTS_DIRNAME = 'batshit_System_Prompts'

/**
 * SA-111 P1 (DL-111-02) — keys retired with their registry entry. `subagent_addon`
 * ("Subagent Addon", `batshit:subagent_instructions`) claimed in Admin to tell primary
 * agents when and how to use subagents, but no compiler had read it since SA-008
 * (2025-12-04); its only live reader was the CLI bridge, which handed the whole ~5 KB
 * document to one MCP tool as its description. Delegation guidance now has its own
 * `subagent_guidance` block. Clean break: the stale value, its timestamp, and its
 * metadata are deleted on startup with a visible log line — no compatibility shim.
 *
 * SA-139 R4 (D14): `cli_primary` ("CLI Primary Agent System Prompt",
 * `batshit:batshit_mode4_system_prompt`) went with the Claude Code CLI Primary lane; no
 * compile reads it. An older backup that carries its keys still restores and drops them
 * (`backupRestoreService.ts`).
 */
const RETIRED_SYSTEM_PROMPT_KEYS: Array<{ label: string; keys: string[] }> = [
  {
    label: 'subagent_addon (batshit:subagent_instructions)',
    keys: [
      'batshit:subagent_instructions',
      'batshit:subagent_instructions:last_updated',
      'batshit:system_prompt_meta:subagent_addon'
    ]
  },
  {
    label: 'cli_primary (batshit:batshit_mode4_system_prompt)',
    keys: [
      'batshit:batshit_mode4_system_prompt',
      'batshit:batshit_mode4_system_prompt:last_updated',
      'batshit:system_prompt_meta:cli_primary'
    ]
  }
]

function promptMetaKey(id: CoreSystemPromptId | RetiredZipToolPromptId) {
  return `batshit:system_prompt_meta:${id}`
}

/**
 * BL-372: the Redis key of one core prompt's metadata (which default its text was, and
 * whether the user edited it). Backup carries it beside the prompt text, so a restore into a
 * newer Batshit can still tell an older default (refreshed) from an edit (kept).
 */
export function corePromptMetadataKey(id: CoreSystemPromptId) {
  return promptMetaKey(id)
}

function hashPrompt(value: string) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

async function getConfiguredPromptDefaultsDir() {
  const configured = await getRuntimeEnv('BATSHIT_SYSTEM_PROMPTS_DIR')
  if (configured?.trim()) {
    return configured.trim()
  }

  return null
}

function getBundledPromptDefaultDirCandidates() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const cwd = process.cwd()

  return Array.from(
    new Set([
      path.resolve(cwd, '../docs', PROMPT_DEFAULTS_DIRNAME),
      path.resolve(cwd, 'docs', PROMPT_DEFAULTS_DIRNAME),
      path.resolve(cwd, PROMPT_DEFAULTS_DIRNAME),
      path.resolve(moduleDir, 'docs', PROMPT_DEFAULTS_DIRNAME),
      path.resolve(moduleDir, '..', 'docs', PROMPT_DEFAULTS_DIRNAME),
      path.resolve(moduleDir, '..', '..', 'docs', PROMPT_DEFAULTS_DIRNAME),
      path.resolve(moduleDir, '..', '..', '..', 'docs', PROMPT_DEFAULTS_DIRNAME)
    ])
  )
}

async function readDefaultPrompt(definition: PromptDefinition) {
  const configuredDir = await getConfiguredPromptDefaultsDir()
  const candidateDirs = configuredDir ? [configuredDir] : getBundledPromptDefaultDirCandidates()
  const attemptedFiles: string[] = []

  for (const defaultsDir of candidateDirs) {
    const filePath = path.join(defaultsDir, definition.defaultFile)
    attemptedFiles.push(filePath)

    try {
      return await fs.readFile(filePath, 'utf8')
    } catch {
      // Try the next bundled location; explicit BATSHIT_SYSTEM_PROMPTS_DIR still has no fallback.
    }
  }

  throw new Error(
    `Packaged Batshit default prompt is unavailable: ${definition.defaultFile}. ` +
      `Set BATSHIT_SYSTEM_PROMPTS_DIR or restore docs/${PROMPT_DEFAULTS_DIRNAME}. ` +
      `Looked in: ${attemptedFiles.join(', ')}`
  )
}

function isPromptMetadata(value: unknown): value is PromptMetadata {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof (value as PromptMetadata).promptId === 'string' &&
      typeof (value as PromptMetadata).customized === 'boolean'
  )
}

async function loadPromptMetadata(id: CoreSystemPromptId): Promise<PromptMetadata | null> {
  return readStoredPromptMetadata(id)
}

async function savePromptMetadata(
  id: CoreSystemPromptId,
  metadata: Pick<PromptMetadata, 'defaultHash' | 'customized'>
) {
  await redis.set(promptMetaKey(id), {
    promptId: id,
    defaultHash: metadata.defaultHash,
    customized: metadata.customized,
    updatedAt: new Date().toISOString()
  } satisfies PromptMetadata)
}

function buildSummary(
  definition: PromptDefinition,
  value: string,
  defaultValue: string,
  metadata: PromptMetadata | null,
  lastUpdated: string | null
): CoreSystemPromptSummary {
  const currentHash = hashPrompt(value)
  const defaultHash = hashPrompt(defaultValue)
  const matchesDefault = currentHash === defaultHash
  const matchesPreviousDefault = Boolean(metadata?.defaultHash && currentHash === metadata.defaultHash)
  const customized = metadata
    ? metadata.customized || (!matchesDefault && !matchesPreviousDefault)
    : !matchesDefault
  const newDefaultAvailable = Boolean(
    metadata?.defaultHash && metadata.defaultHash !== defaultHash && customized
  )
  const oldSetupPointer = /tool_discovery`?\s+section\s+of\s+your\s+DCM|DCM[^\n]{0,100}\bagent_id\b[^\n]{0,100}\bproject_path\b|native_bash:?`?\s+line\s+in\s+the\s+DCM/i.test(value)
  let apiText = '', runtimeSyntaxNotice: string | undefined
  if (customized) {
    try {
      apiText = applyPromptRuntimeScope(value, 'api')
    } catch (error) {
      // Admin is the repair surface. This diagnostic must not make existing
      // saved text unreadable, or report failure after a successful save.
      // The actual compiler continues to apply the strict parser independently.
      runtimeSyntaxNotice = `This custom prompt has invalid runtime markers: ${error instanceof Error ? error.message : String(error)} Review and repair its markers before use. Your saved text is unchanged.`
    }
  }
  const oldUtilityPointer = /\bnative_web_search\b|\bnative_spawn_workers\b|\bnative_skill`?[^\n]{0,100}\baction\s*[:=]?\s*["']?(?:invoke|list|read)\b|Call a subagent by its own tool, directly/i.test(apiText)
  const oldSubagentPointer = /subagents:`?\s+roster\s+in\s+your\s+DCM/i.test(apiText)
  const compatibilityNotice = runtimeSyntaxNotice ?? (oldSetupPointer || oldSubagentPointer
    ? 'This custom prompt still places setup fields in the DCM. Review it against the current Batshit default: Agent Setup and setup_changes now carry those fields. Your saved text is unchanged.'
    : oldUtilityPointer ? 'This custom prompt references API tool calls that moved behind Tool Use. Review it against the current Batshit default and exact Agent Setup refs. Your saved text is unchanged.' : undefined)

  return {
    id: definition.id,
    redisKey: definition.redisKey,
    label: definition.label,
    description: definition.description,
    warning: definition.warning,
    defaultFile: definition.defaultFile,
    defaultVersion: definition.defaultVersion,
    currentHash,
    defaultHash,
    matchesDefault,
    customized,
    newDefaultAvailable,
    ...(customized && compatibilityNotice ? { setupCompatibilityNotice: compatibilityNotice } : {}),
    lastUpdated
  }
}

/**
 * A stored prompt's text, or `null` only when the key is absent. A read that FAILS throws: the
 * facade's `redis.get` answers null for any error (BL-230), and here a null means "store the
 * default", so a failed read would write the default over a user's edit or a restored prompt.
 * It reads the raw string, so text that starts with `{` is never parsed as JSON.
 */
async function readStoredPromptText(key: string): Promise<string | null> {
  const value = await redis.execute((client) => client.get(key))
  return value === null || value === undefined ? null : String(value)
}

async function ensurePromptValue(definition: PromptDefinition, defaultValue: string) {
  const existing = await readStoredPromptText(definition.redisKey)
  const defaultHash = hashPrompt(defaultValue)

  if (existing !== null && existing !== undefined) {
    const value = typeof existing === 'string' ? existing : String(existing)
    const metadata = await loadPromptMetadata(definition.id)
    const currentHash = hashPrompt(value)
    const previousDefaultHash = metadata?.defaultHash ?? null

    const shouldRefreshUncustomizedDefault = Boolean(
      metadata?.customized === false &&
        previousDefaultHash &&
        previousDefaultHash !== defaultHash &&
        currentHash === previousDefaultHash
    )

    if (shouldRefreshUncustomizedDefault) {
      await redis.set(definition.redisKey, defaultValue)
      await redis.set(`${definition.redisKey}:last_updated`, new Date().toISOString())
      await savePromptMetadata(definition.id, {
        defaultHash,
        customized: false
      })
      return defaultValue
    }

    if (metadata?.customized === false && currentHash === defaultHash && previousDefaultHash !== defaultHash) {
      await savePromptMetadata(definition.id, {
        defaultHash,
        customized: false
      })
    }

    // BL-372: no metadata (a restore of a backup made before backups carried it) and the
    // text IS today's default: record that, so the next update can refresh it. Text that
    // differs stays without metadata, which reads as customized: it may be the user's edit,
    // so it is never overwritten on a guess.
    if (!metadata && currentHash === defaultHash) {
      await savePromptMetadata(definition.id, {
        defaultHash,
        customized: false
      })
    }

    return value
  }

  await redis.set(definition.redisKey, defaultValue)
  await redis.set(`${definition.redisKey}:last_updated`, new Date().toISOString())
  await savePromptMetadata(definition.id, {
    defaultHash,
    customized: false
  })
  return defaultValue
}

export function listCoreSystemPromptDefinitions() {
  return [...CORE_SYSTEM_PROMPTS]
}

/**
 * BL-230: the packaged default of a core prompt, named by its Redis key. The compiler uses it
 * when the stored Primary Agent prompt is absent or blank (the boot seed is fire-and-forget,
 * so a failed seed or a restore without the key leaves nothing stored). It only reads: the
 * compile writes nothing, and the next boot seed or an Admin visit stores the key. Throws for
 * a key that is not a core prompt and for a packaged file that cannot be read.
 */
export async function readPackagedCoreSystemPromptDefault(redisKey: string): Promise<string> {
  const definition = CORE_SYSTEM_PROMPTS.find((entry) => entry.redisKey === redisKey)
  if (!definition) {
    throw new Error(`Not a core system prompt key: ${redisKey}`)
  }
  return readDefaultPrompt(definition)
}

/**
 * Startup sweep for prompt keys whose registry entry was retired (DL-111-02). Runs beside
 * the retired-system-clip sweep in `hooks.server.ts`. Deleting is deliberate: a stale
 * Redis value with no registry entry is unreachable from Admin and unreadable by any
 * compiler, so leaving it behind is dead data that looks live in a Redis dump.
 */
export async function removeRetiredSystemPrompts() {
  const removed: string[] = []

  for (const entry of RETIRED_SYSTEM_PROMPT_KEYS) {
    let removedForEntry = 0
    for (const key of entry.keys) {
      if (!(await redis.exists(key))) continue
      await redis.del(key)
      removedForEntry += 1
    }
    if (removedForEntry > 0) {
      removed.push(`${entry.label} (${removedForEntry} key${removedForEntry === 1 ? '' : 's'})`)
    }
  }

  if (removed.length > 0) {
    console.info(`[SystemPrompts] Removed retired core system prompt(s): ${removed.join(', ')}`)
  }

  return { removed }
}

/**
 * BL-1777: the two zip tool prompts that became one record, "Tool Prompt: Zips"
 * (`tool_guidance_zip`). In carry order: every agent compiled the Disabled record unless the
 * hidden zip-control experiment was on (BL-1484), so its edit is the one the one record takes
 * first.
 */
const RETIRED_ZIP_TOOL_PROMPTS = [
  {
    id: 'tool_guidance_zip_disabled',
    label: 'Tool Prompt: Zip Control Disabled',
    redisKey: 'batshit:tool_guidance_zip_disabled_prompt'
  },
  {
    id: 'tool_guidance_zip_enabled',
    label: 'Tool Prompt: Zip Control Enabled',
    redisKey: 'batshit:tool_guidance_zip_enabled_prompt'
  }
] as const

type RetiredZipToolPromptId = (typeof RETIRED_ZIP_TOOL_PROMPTS)[number]['id']

/**
 * The Redis keys of the two retired zip tool prompts (text, `:last_updated`, metadata). Backup
 * keeps them restorable, so a backup made before BL-1777 still restores and its edit is folded,
 * and exports one that is still kept (an edit the one record could not take).
 */
export function retiredZipToolPromptKeys(): string[] {
  return RETIRED_ZIP_TOOL_PROMPTS.flatMap((old) => [
    old.redisKey,
    `${old.redisKey}:last_updated`,
    promptMetaKey(old.id)
  ])
}

export type ZipToolPromptFold = {
  /** The old record whose edit "Tool Prompt: Zips" took, or null. */
  carried: string | null
  /** Old records whose edit was not taken: left where they are, read by nothing. */
  kept: string[]
  /** Old records deleted (a default, or an edit "Tool Prompt: Zips" now holds). */
  removed: string[]
}

const warnedKeptZipToolPrompts = new Set<string>()

/** Whether stored core prompt text is the user's edit, by the rules `buildSummary` uses. */
function isEditedPromptText(
  text: string,
  defaultValue: string,
  metadata: Pick<PromptMetadata, 'defaultHash' | 'customized'> | null
) {
  // A blank record compiles as the built block, the same as the default.
  if (!text.trim() || text === defaultValue) return false
  const textHash = hashPrompt(text)
  if (metadata?.customized === false && metadata.defaultHash && textHash === metadata.defaultHash) {
    // An older packaged default that was never edited (the boot seed refreshes these).
    return false
  }
  // BL-372: other text, or text with no metadata, may be an edit and is never replaced on a guess.
  return true
}

/**
 * A core prompt's metadata through the raw client (`JSON.GET`): a failed read
 * throws. The facade's `redis.get` answers null for a failed read, which would read an untouched
 * older default as an edit and carry it as customized, where the boot seed never refreshes it.
 */
async function readStoredPromptMetadata(
  id: CoreSystemPromptId | RetiredZipToolPromptId
): Promise<PromptMetadata | null> {
  const value = await redis.execute((client) => client.json.get(promptMetaKey(id)))
  if (value === null) return null
  if (!isPromptMetadata(value)) {
    throw new Error(`Stored core prompt metadata is unreadable or unsupported: ${id}.`)
  }
  return value
}

/**
 * BL-1777: moves the two retired zip tool prompts into "Tool Prompt: Zips". Runs at startup
 * before any compile (`hooks.server.ts`) and right after a restore (an older backup carries the
 * old records). Idempotent.
 *
 * - An old record that holds a default (the packaged shell, an older packaged default never
 *   edited, or a blank) is deleted with its time and metadata.
 * - An admin's edit is carried into "Tool Prompt: Zips" as its customized text, keeping the old
 *   record's default hash (so Admin says "New default available" for an edit made against an
 *   older default), only while "Tool Prompt: Zips" is absent or still its default: the Disabled
 *   record's edit first, else the Enabled one's. The one record is written before the old one is
 *   deleted, so a stop part way never loses the edit.
 * - An old edit that is not carried (a different second edit, or "Tool Prompt: Zips" already
 *   holds an edit) is never deleted: it stays at its key, read by nothing, is named in a warning,
 *   travels in backups, and goes once "Tool Prompt: Zips" holds the same text. An admin reads it
 *   with `GET /api/redis/get/<key>`.
 * - When it ends with "Tool Prompt: Zips" absent (nothing was carried and nothing was stored),
 *   it seeds the record from its default itself, so no compile after the fold reads the absent
 *   key (the boot seed that follows it is not awaited).
 *
 * Every read (texts, times, metadata) goes through the raw client: a failed read throws and
 * changes nothing.
 */
export async function foldRetiredZipToolPrompts(): Promise<ZipToolPromptFold> {
  const merged = definitionById.get('tool_guidance_zip')!
  const defaultValue = await readDefaultPrompt(merged)
  const result: ZipToolPromptFold = { carried: null, kept: [], removed: [] }

  const olds = []
  for (const old of RETIRED_ZIP_TOOL_PROMPTS) {
    const text = await readStoredPromptText(old.redisKey)
    const metadata = await readStoredPromptMetadata(old.id)
    olds.push({ ...old, text, metadata, edited: text !== null && isEditedPromptText(text, defaultValue, metadata) })
  }

  let mergedText = await readStoredPromptText(merged.redisKey)
  const mergedEdited =
    mergedText !== null && isEditedPromptText(mergedText, defaultValue, await readStoredPromptMetadata(merged.id))

  const chosen = mergedEdited ? undefined : olds.find((old) => old.edited)
  if (chosen && chosen.text !== null) {
    await redis.set(merged.redisKey, chosen.text)
    const lastUpdated = await readStoredPromptText(`${chosen.redisKey}:last_updated`)
    await redis.set(`${merged.redisKey}:last_updated`, lastUpdated || new Date().toISOString())
    await savePromptMetadata(merged.id, {
      defaultHash: chosen.metadata?.defaultHash ?? null,
      customized: true
    })
    mergedText = chosen.text
    result.carried = chosen.label
  }

  for (const old of olds) {
    const keys = [old.redisKey, `${old.redisKey}:last_updated`, promptMetaKey(old.id)]
    if (old.text === null) {
      // A time or metadata with no text is left from an earlier sweep step; nothing reads it.
      for (const key of keys) if (await redis.exists(key)) await redis.del(key)
      continue
    }
    if (old.edited && old.text !== mergedText) {
      result.kept.push(old.label)
      if (!warnedKeptZipToolPrompts.has(old.redisKey)) {
        warnedKeptZipToolPrompts.add(old.redisKey)
        console.warn(
          `[SystemPrompts] BL-1777: "${old.label}" holds an edit that "${merged.label}" did not take ` +
            `(it already holds ${result.carried && result.carried !== old.label ? `the edit of "${result.carried}"` : 'an edit of its own'}). ` +
            `Batshit keeps it at ${old.redisKey}, where no agent reads it; an admin can read it with GET /api/redis/get/${old.redisKey} ` +
            `and copy what they want into "${merged.label}" in Settings -> Admin. It is removed once "${merged.label}" holds the same text.`
        )
      }
      continue
    }
    for (const key of keys) await redis.del(key)
    result.removed.push(old.label)
  }

  // Review N-a: the boot seed after the fold is not awaited, so seed this one record here.
  if (mergedText === null) await ensurePromptValue(merged, defaultValue)

  if (result.carried || result.removed.length > 0) {
    console.info(
      `[SystemPrompts] BL-1777: the zip tool prompts are one record, "${merged.label}".` +
        (result.carried ? ` It took the edit of "${result.carried}".` : '') +
        (result.removed.length > 0 ? ` Removed: ${result.removed.join(', ')}.` : '')
    )
  }
  return result
}

export async function checkCoreSystemPromptDefaults() {
  const missing: string[] = []

  for (const definition of CORE_SYSTEM_PROMPTS) {
    try {
      await readDefaultPrompt(definition)
    } catch {
      missing.push(definition.defaultFile)
    }
  }

  return {
    ready: missing.length === 0,
    count: CORE_SYSTEM_PROMPTS.length,
    missing
  }
}

export async function listCoreSystemPrompts(): Promise<CoreSystemPromptSummary[]> {
  const summaries: CoreSystemPromptSummary[] = []

  for (const definition of CORE_SYSTEM_PROMPTS) {
    const defaultValue = await readDefaultPrompt(definition)
    const value = await ensurePromptValue(definition, defaultValue)
    const metadata = await loadPromptMetadata(definition.id)
    const lastUpdated = await readStoredPromptText(`${definition.redisKey}:last_updated`)
    summaries.push(buildSummary(definition, value, defaultValue, metadata, lastUpdated))
  }

  return summaries
}

/**
 * BL-372: run the boot seed's default check right after a backup restore. The restore wrote
 * prompt text and metadata from another point in time, and agents compile from the stored text
 * directly, so an uncustomized older default must be refreshed now, not at the next app start.
 */
export async function reconcileCoreSystemPromptsAfterRestore(): Promise<void> {
  // BL-1777: a backup made before the zip tool prompts were one record carries the two old ones.
  // Fold them first, so the check below seeds "Tool Prompt: Zips" only when nothing was carried.
  // A failure leaves every old record as restored; the startup fold runs again.
  try {
    await foldRetiredZipToolPrompts()
  } catch (error) {
    console.warn(
      '[SystemPrompts] After the restore, Batshit could not move the older zip tool prompts into "Tool Prompt: Zips"; it tries again at the next start:',
      error instanceof Error ? error.message : error
    )
  }
  // One prompt that cannot be checked (an unreadable packaged default, a failed read) is skipped
  // with a warning and never written; the others are still checked.
  for (const definition of CORE_SYSTEM_PROMPTS) {
    try {
      const defaultValue = await readDefaultPrompt(definition)
      await ensurePromptValue(definition, defaultValue)
    } catch (error) {
      console.warn(
        `[SystemPrompts] After the restore, Batshit could not check "${definition.label}" against its default and left it as restored:`,
        error instanceof Error ? error.message : error
      )
    }
  }
}

export async function getCoreSystemPrompt(id: string): Promise<CoreSystemPromptDetail> {
  const definition = definitionById.get(id as CoreSystemPromptId)
  if (!definition) {
    throw new Error(`Unknown core system prompt: ${id}`)
  }

  const defaultValue = await readDefaultPrompt(definition)
  const value = await ensurePromptValue(definition, defaultValue)
  const metadata = await loadPromptMetadata(definition.id)
  const lastUpdated = await readStoredPromptText(`${definition.redisKey}:last_updated`)

  return {
    ...buildSummary(definition, value, defaultValue, metadata, lastUpdated),
    value,
    defaultValue
  }
}

export async function saveCoreSystemPrompt(id: string, value: string) {
  const definition = definitionById.get(id as CoreSystemPromptId)
  if (!definition) {
    throw new Error(`Unknown core system prompt: ${id}`)
  }
  if (typeof value !== 'string') {
    throw new Error('Prompt value must be a string')
  }

  const defaultValue = await readDefaultPrompt(definition)
  const now = new Date().toISOString()
  await redis.set(definition.redisKey, value)
  await redis.set(`${definition.redisKey}:last_updated`, now)
  await savePromptMetadata(definition.id, {
    defaultHash: hashPrompt(defaultValue),
    customized: hashPrompt(value) !== hashPrompt(defaultValue)
  })

  return getCoreSystemPrompt(definition.id)
}

export async function resetCoreSystemPrompt(id: string) {
  const definition = definitionById.get(id as CoreSystemPromptId)
  if (!definition) {
    throw new Error(`Unknown core system prompt: ${id}`)
  }

  const defaultValue = await readDefaultPrompt(definition)
  const now = new Date().toISOString()
  await redis.set(definition.redisKey, defaultValue)
  await redis.set(`${definition.redisKey}:last_updated`, now)
  await savePromptMetadata(definition.id, {
    defaultHash: hashPrompt(defaultValue),
    customized: false
  })

  return getCoreSystemPrompt(definition.id)
}
