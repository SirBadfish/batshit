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
    defaultVersion: '2026-08-31'
  },
  {
    id: 'cli_primary',
    redisKey: 'batshit:batshit_mode4_system_prompt',
    label: 'CLI Primary Agent System Prompt',
    description: 'Core instructions for CLI-backed Batshit primary agents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_cli_system_prompt.md',
    defaultVersion: '2026-08-31'
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
    defaultVersion: '2026-09-05'
  },
  {
    id: 'tool_guidance_zip_enabled',
    redisKey: 'batshit:tool_guidance_zip_enabled_prompt',
    label: 'Tool Prompt: Zip Control Enabled',
    description: 'Injected when tool prompting is needed and Zip Control is enabled for the agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zip_control_enabled.md',
    defaultVersion: '2026-08-31'
  },
  {
    id: 'tool_guidance_zip_disabled',
    redisKey: 'batshit:tool_guidance_zip_disabled_prompt',
    label: 'Tool Prompt: Zip Control Disabled',
    description: 'Injected when tool prompting is needed and Zip Control is disabled for the agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zip_control_disabled.md',
    defaultVersion: '2026-08-31'
  },
  {
    id: 'tool_guidance_memory',
    redisKey: 'batshit:tool_guidance_memory_prompt',
    label: 'Tool Prompt: Memory',
    description: 'Injected for memory-enabled agents: lanes, inline saves, supersession discipline, and the sys.memory.* operations.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_memory.md',
    defaultVersion: '2026-09-02c'
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

async function ensurePromptValue(definition: PromptDefinition, defaultValue: string) {
  const existing = await redis.get(definition.redisKey)
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
