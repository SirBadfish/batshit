import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redis } from '$lib/server/redis'
import { getRuntimeEnv } from '$lib/server/services/runtimeEnv'

export type CoreSystemPromptId =
  | 'n8n_primary'
  | 'api_primary'
  | 'cli_primary'
  | 'subagent_base'
  | 'subagent_addon'
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
    id: 'n8n_primary',
    redisKey: 'batshit:n8n_mode2_system_prompt',
    label: 'n8n Primary Agent System Prompt',
    description: 'Baseline instructions for the live n8n primary-agent path.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_n8n_system_prompt.md',
    defaultVersion: '2026-07-14'
  },
  {
    id: 'api_primary',
    redisKey: 'batshit:batshit_mode3_system_prompt',
    label: 'API Primary Agent System Prompt',
    description: 'Core instructions for API-backed Batshit primary agents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_api_system_prompt.md',
    defaultVersion: '2026-08-13'
  },
  {
    id: 'cli_primary',
    redisKey: 'batshit:batshit_mode4_system_prompt',
    label: 'CLI Primary Agent System Prompt',
    description: 'Core instructions for CLI-backed Batshit primary agents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_primary_agent_cli_system_prompt.md',
    defaultVersion: '2026-07-14'
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
    id: 'subagent_addon',
    redisKey: 'batshit:subagent_instructions',
    label: 'Subagent Addon',
    description: 'Text shown to primary agents explaining when and how to use subagents.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_subagent_addon.md',
    defaultVersion: '2026-05-22'
  },
  {
    id: 'tool_guidance_zip_enabled',
    redisKey: 'batshit:tool_guidance_zip_enabled_prompt',
    label: 'Tool Prompt: Zip Control Enabled',
    description: 'Injected when tool prompting is needed and Zip Control is enabled for the agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zip_control_enabled.md',
    defaultVersion: '2026-08-13'
  },
  {
    id: 'tool_guidance_zip_disabled',
    redisKey: 'batshit:tool_guidance_zip_disabled_prompt',
    label: 'Tool Prompt: Zip Control Disabled',
    description: 'Injected when tool prompting is needed and Zip Control is disabled for the agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_zip_control_disabled.md',
    defaultVersion: '2026-08-13'
  },
  {
    id: 'tool_guidance_memory',
    redisKey: 'batshit:tool_guidance_memory_prompt',
    label: 'Tool Prompt: Memory',
    description: 'Injected for memory-enabled agents: lanes, inline saves, supersession discipline, and the sys.memory.* operations.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_tool_prompt_memory.md',
    defaultVersion: '2026-08-25'
  },
  {
    id: 'dynamic_mcp',
    redisKey: 'batshit:dynamic_mcp_prompt',
    label: 'Dynamic MCP Prompt',
    description: 'Injected when Dynamic MCP capability is enabled for the current agent.',
    warning: COMMON_CORE_PROMPT_WARNING,
    defaultFile: 'batshit_dynamic_mcp.md',
    defaultVersion: '2026-08-13'
  }
]

const definitionById = new Map(CORE_SYSTEM_PROMPTS.map((definition) => [definition.id, definition]))
const PROMPT_DEFAULTS_DIRNAME = 'batshit_System_Prompts'

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
