import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redis } from '$lib/server/redis'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'

export type CoreSystemPromptId =
  | 'api_primary'
  | 'cli_primary'
  | 'subagent_base'
  | 'worker_prompt'
  | 'subagent_guidance'
  | 'tool_guidance_zip_enabled'
  | 'tool_guidance_zip_disabled'
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
    label: 'API Primary Agent System Prompt',
    description: 'Core instructions for API-backed Batshit primary agents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_api_system_prompt.md',
    // BL-474 L3: outside pictures need a user click, and agents should use only exact addresses they read.
    defaultVersion: '2026-09-30'
  },
  {
    id: 'cli_primary',
    redisKey: 'batshit:batshit_mode4_system_prompt',
    label: 'CLI Primary Agent System Prompt',
    description: 'Core instructions for CLI-backed Batshit primary agents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_cli_system_prompt.md',
    // BL-474 L3: outside pictures need a user click, and agents should use only exact addresses they read.
    defaultVersion: '2026-09-30'
  },
  {
    id: 'subagent_base',
    redisKey: 'batshit:sub_system_prompt',
    label: 'Subagent System Prompt',
    description: 'Base instructions for all AI subagents called as tools.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_subagent_system_prompt.md',
    defaultVersion: '2026-05-22'
  },
  {
    id: 'worker_prompt',
    redisKey: 'batshit:worker_prompt',
    label: 'Worker System Prompt',
    description:
      'Base instructions for throwaway Workers a primary agent spawns for one task. Separate from the Subagent System Prompt because a worker is ephemeral and memory-less.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_worker_prompt.md',
    defaultVersion: '2026-09-04'
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
    defaultVersion: '2026-09-22'
  },
  {
    id: 'tool_guidance_zip_enabled',
    redisKey: 'batshit:tool_guidance_zip_enabled_prompt',
    label: 'Tool Prompt: Zip Control Enabled',
    description: 'Injected when tool prompting is needed and Zip Control is enabled for the agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zip_control_enabled.md',
    // Bumped for SA-114 P4 (DL-114-16): a steer arrives as an ordinary injected user
    // message at a tool boundary, so without this sentence nothing tells an agent that
    // `[The user said, mid-reply: ...]` is the user and `[Agent DM — ... not from the
    // user ...]` is not. Bumped again for SA-118 (DL-118-07): the DM bracket was taught
    // with a hyphen and emitted with an em dash, so the taught spelling never matched.
    // Bumped for SA-128's follow-up sweep: the appended index is `<zip_index>`, no longer an
    // UNZIP INDEX header, so the two lines that name it now say so.
    // Bumped for SA-129 P1: dead copies compress at once, the compression hint, and Fetch Zip for exact old results.
    // Bumped for SA-129 P2: hold and release by file path in the Tool Notes block, and the held lines.
    // BL-494 P1: explain the live 10k/25k Cool Tool guard and Hold refusal.
    // BL-442: a tag in a code block does nothing; that is how to show one as an example.
    // BL-677: on the Codex lane a result is cut at the run's own tool output limit.
    // BL-360 (SA-129 DL-06): "keep this file open" is a hold; the parked `unzip` is only for a
    // result that is not a file; the user wins both ways and a refusal is said.
    defaultVersion: '2026-10-13'
  },
  {
    id: 'tool_guidance_zip_disabled',
    redisKey: 'batshit:tool_guidance_zip_disabled_prompt',
    label: 'Tool Prompt: Zip Control Disabled',
    description: 'Injected when tool prompting is needed and Zip Control is disabled for the agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zip_control_disabled.md',
    // Bumped for SA-114 P4 (DL-114-16) and again for SA-118 (DL-118-07), same sentence
    // as the enabled variant. Bumped for SA-129 P1, the same dead-copy paragraph as the enabled variant.
    // Bumped for SA-129 P2: hold and release (the same paragraph as the enabled variant).
    // BL-494 P1: explain the live 10k/25k Cool Tool guard and Hold refusal.
    // BL-442: a tag in a code block does nothing (the same sentence as the enabled variant).
    // BL-677: the same Codex clause as the enabled variant.
    defaultVersion: '2026-09-27e'
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
    defaultVersion: '2026-09-27'
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
    defaultVersion: '2026-09-27'
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
    // the same switch that opens `sys.judge.*` in the broker, so a control the agent
    // cannot call is never taught (the DM block's lesson: name the fields, or the first
    // call fails on guessed names). Bumped for SA-120 R1: the family is Judge Juice.
    // Bumped for SA-120 P10b: the block names "the judge", not Jev, and says a smaller judge takes fewer.
    defaultVersion: '2026-10-12'
  },
  {
    id: 'dynamic_mcp',
    redisKey: 'batshit:dynamic_mcp_prompt',
    label: 'Dynamic Tool Search Prompt',
    description: 'Injected when Dynamic Tool Search is available for the current agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_dynamic_mcp.md',
    defaultVersion: '2026-09-01'
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
 */
const RETIRED_SYSTEM_PROMPT_KEYS: Array<{ label: string; keys: string[] }> = [
  {
    label: 'subagent_addon (batshit:subagent_instructions)',
    keys: [
      'batshit:subagent_instructions',
      'batshit:subagent_instructions:last_updated',
      'batshit:system_prompt_meta:subagent_addon'
    ]
  }
]

function promptMetaKey(id: CoreSystemPromptId) {
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
  const value = await redis.get(promptMetaKey(id))
  return isPromptMetadata(value) ? value : null
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
    const lastUpdated = (await redis.get(`${definition.redisKey}:last_updated`)) as string | null
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
  const lastUpdated = (await redis.get(`${definition.redisKey}:last_updated`)) as string | null

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
