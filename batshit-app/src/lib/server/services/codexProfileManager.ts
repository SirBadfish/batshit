import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { hostProfileResource, withHostCommandDeletion } from '$lib/server/services/hostCommandOwnership'
import {
  withAgentProfileFolder,
  withManagedProfileRunWrite,
  writeAgentProfileFolderIfAgentExists,
  ManagedProfileRunRefusedError,
  type ManagedProfileRunOwner
} from '$lib/server/services/agentProfileFolderGate'

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import { logger } from '$lib/utils/logger'
import {
  buildCodexRuntimeSettings,
  resolveCodexWebSearchMode
} from '$lib/server/services/codexSettings'
import type { CodexRuntimeSettings, CodexConfigOverride } from '$lib/types/codex'
import {
  MODE4_CODEX_MANAGED_INSTRUCTIONS_FILENAME
} from '$lib/server/constants/mode4Policy'
import type { AgentRow, MCPGateway, MCPToolGrouping, MCPToolSelections, ProjectRow } from '$lib/types/database'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { resolveMCPSelections } from '$lib/server/services/mcpSelectionResolver'
import type { GatewayMetadata } from '$lib/server/services/mcpGatewayTypes'
import type { MCPSelectionResolution } from '$lib/server/services/mcpSelectionResolver'
import { getDockerGatewayAuthToken } from '$lib/server/services/dockerGatewayConfig'
import { AGENT_RUN_CREDENTIAL_ENV_VAR } from '$lib/server/services/agentRunCredentials'
import { migrateLegacyN8nInstanceMcpTokens } from '$lib/server/services/mcpGatewayTokenMigration'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import {
  MODE4_INTERNAL_HELPER_TOOL_NAMES,
  resolveEnabledMode4InternalHelperTools,
  isMode4InternalHelperTool,
  CLI_HELPER_MCP_SERVER_NAME,
  CLI_HELPER_TOOL_TIMEOUT_MS
} from '$lib/server/services/mode4InternalTools'
import {
  buildManagedStdioEnvironmentPlan,
  sanitizeStdioGatewayConfig
} from '$lib/server/services/mcpGatewayStdio'
import { resolveCliToolSelectionScope } from '$lib/server/services/cliToolRegistry'
import {
  cliHelperScriptRef,
  cliHelperUrlArgRef,
  cliDockerGatewayUrlRef,
  fillCliHelperLaunchRefs,
  hasCliHelperLaunchRef,
  resolveCliHelperLaunchValues,
  type CliHelperLaunchValues
} from '$lib/server/services/cliHelperLaunch'
import {
  buildSubagentSlugCollisionError,
  normalizeSubagentSlugValue
} from '$lib/utils/subagentSlug'
import {
  CLI_WORKER_SPAWN_TOOL_NAME,
  buildCliSubagentMcpServerName,
  buildCliSubagentMcpToolNameForKey
} from '$lib/utils/cliSubagentToolNames'
import { resolveWorkersEnabled } from '$lib/utils/delegationCapabilities'
import {
  CODEX_HOME_DIR_NAME,
  MANAGED_CODEX_ROOT_DIR,
  USER_CODEX_HOME,
  assertBatshitManagedCodexHome,
  assertCodexProfileFolderInsideRoot,
  assertManagedCodexProfileId,
  describeManagedFileLinkRefusal,
  isBatshitManagedCodexHome,
  isManagedCodexHomeRefusal,
  isManagedFileLinkError,
  readFileWithoutLinks,
  replaceLinkedCodexFolders,
  writeFileWithoutLinks
} from '$lib/server/services/codexManagedHome'
import toml from '@iarna/toml'
const { parse: parseToml, stringify: stringifyToml } = toml

const MANAGED_START = '# >>> Batshit codex config (managed) >>>'
const MANAGED_END = '# <<< Batshit codex config (managed) <<<'
const PROFILE_PREFIX = 'batshit_agent_'
const MANAGED_GATEWAY_PREFIX = 'batshit_gateway_'
// BL-7 review: `codexManagedHome.ts` owns where managed homes live and what counts as one.
const MANAGED_ROOT_DIR = MANAGED_CODEX_ROOT_DIR
const LEGACY_ROOT_DIR = path.join(os.homedir(), 'batshit-codex')
const CODEX_DIR_NAME = CODEX_HOME_DIR_NAME
const REAL_CODEX_HOME = USER_CODEX_HOME
export const DOCKER_AUTH_ENV_VAR = 'BATSHIT_DOCKER_MCP_TOKEN'
export const N8N_INSTANCE_MCP_TOKEN_ENV = 'BATSHIT_N8N_INSTANCE_MCP_TOKEN'
const UNGROUPED_GROUP_SLUG = 'ungrouped'
const UNGROUPED_GROUP_LABEL = 'Ungrouped Tools'
const MANAGED_CONFIG_OVERRIDE_KEYS = new Set([
  'approval_policy',
  'experimental_instructions_file',
  'model',
  'model_instructions_file',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_supports_reasoning_summaries',
  'default_tools_enabled',
  'sandbox_mode',
  'service_tier',
  'skills.config',
  'web_search'
])
const MANAGED_CONFIG_OVERRIDE_PREFIXES = [
  'features.',
  'history.',
  'mcp_servers.',
  'projects.',
  'sandbox_workspace_write.',
  // BL-7 review: Codex's bundled-skills switch (`skills.bundled` and every key under it) is
  // Batshit's for a managed home. The prefix also covers `skills.bundled` itself.
  'skills.bundled.'
]

export interface CodexConfigOverrideIssue {
  key: string
  reason: string
}

// Best-effort boot-time cleanup: trim Codex rollout/session logs when history is not persisted
void scheduleCodexSessionCleanupOnBoot()

async function ensureAgentCodexDir(profileId: string) {
  // BL-7 review: a profile id is refused before it becomes a path (a stored `../..` was the
  // user's own `~/.codex`), the profile folder before `.codex` is made in it, and the home
  // after it exists and before anything is linked into it (an agent folder whose `.codex` is a
  // symlink to `~/.codex` passes the id rule). Everything that writes a managed home comes
  // through here.
  const profileDir = path.join(MANAGED_ROOT_DIR, assertManagedCodexProfileId(profileId))
  await fs.mkdir(profileDir, { recursive: true })
  await assertCodexProfileFolderInsideRoot(profileDir)
  const dir = path.join(profileDir, CODEX_DIR_NAME)
  await fs.mkdir(dir, { recursive: true })
  await assertBatshitManagedCodexHome(dir)
  await replaceLinkedCodexFolders(dir)
  await ensureCredentialSymlinks(dir)
  return dir
}

export async function cleanupCodexSessionDirs(options?: { respectPersistence?: boolean }) {
  if (env.BATSHIT_CODEX_PROVIDER_ENABLED === 'false') return

  const respectPersistence = options?.respectPersistence !== false
  let cleaned = 0

  let entries: Array<string>
  try {
    entries = await fs.readdir(MANAGED_ROOT_DIR)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.warn('[CodexProfileManager] Failed to read managed Codex root for cleanup', error)
    return
  }

  for (const entry of entries) {
    const profileId = entry.trim()
    if (!profileId || !profileId.startsWith(PROFILE_PREFIX)) continue

    // BL-7 review: this deletes inside the agent's `.codex`, so that folder must be a
    // Batshit-managed home. An agent folder whose `.codex` is a symlink to the user's own
    // `~/.codex` (an in-app agent can plant one: sandboxes mount `~/.batshit`) made this
    // delete the user's own Codex session history. A folder with no `.codex` is quietly
    // passed over, as before; one that fails the check is passed over and logged.
    const codexHome = path.join(MANAGED_ROOT_DIR, profileId, CODEX_DIR_NAME)
    try {
      await fs.lstat(codexHome)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[CodexProfileManager] Failed to read a Codex home for cleanup', { codexHome, error })
      }
      continue
    }
    if (!(await isBatshitManagedCodexHome(codexHome))) {
      console.warn(
        '[CodexProfileManager] Skipped session cleanup for a Codex home that is not Batshit-managed',
        { profileId, codexHome }
      )
      continue
    }

    const sessionsDir = path.join(codexHome, 'sessions')
    let hasSessions = false
    try {
      const stat = await fs.stat(sessionsDir)
      hasSessions = stat.isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }
      console.warn('[CodexProfileManager] Failed to stat Codex sessions dir', { sessionsDir, error })
      continue
    }

    if (!hasSessions) continue

    if (respectPersistence) {
      try {
        const config = await readAgentToml(profileId)
        if ((config as any).__batshit_invalid_config === true) {
          continue
        }
        const persistenceValue = (config as any)?.history?.persistence
        const persistence = typeof persistenceValue === 'string' ? persistenceValue.trim().toLowerCase() : undefined
        if (persistence && persistence !== 'none') {
          continue
        }
      } catch (error) {
        console.warn('[CodexProfileManager] Failed to read Codex config for cleanup', { profileId, error })
        continue
      }
    }

    try {
      if (process.platform === 'win32') {
        await fs.rm(sessionsDir, { recursive: true, force: true }) // BL-364: no host identity proof yet.
      } else {
        await withHostCommandDeletion([hostProfileResource(profileId)], async () => {
          await fs.rm(sessionsDir, { recursive: true, force: true })
        })
      }
      cleaned += 1
    } catch (error) {
      console.warn('[CodexProfileManager] Failed to delete Codex sessions dir', { sessionsDir, error })
    }
  }

  if (cleaned > 0) {
    logger.debug(`[CodexProfileManager] Cleaned ${cleaned} Codex session director${cleaned === 1 ? 'y' : 'ies'} (history persistence = none).`)
  }
}

/**
 * Links the user's Codex credentials into a managed home. Only `ensureAgentCodexDir` calls
 * it, after the home passed the managed-home check; it is exported for its safety test.
 */
export async function ensureCredentialSymlinks(codexDir: string) {
  await Promise.all([
    ensureCredentialSymlink(codexDir, 'auth.json'),
    ensureCredentialSymlink(codexDir, 'credentials.json')
  ])
}

async function ensureCredentialSymlink(codexDir: string, filename: string) {
  const source = path.join(REAL_CODEX_HOME, filename)
  try {
    await fs.access(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    throw error
  }

  const linkPath = path.join(codexDir, filename)
  // BL-7 review: never remove anything that already IS the source file. When the link path
  // resolves to the user's real credential (the user's own home, a home that is a symlink
  // to it, or a hard link), the `rm` below deleted the real `auth.json` and the `symlink`
  // after it pointed the file at itself.
  if (await isSameFile(linkPath, source)) {
    return
  }
  try {
    const stat = await fs.lstat(linkPath)
    if (stat.isSymbolicLink()) {
      const currentTarget = await fs.readlink(linkPath)
      if (currentTarget === source) {
        return
      }
    }
    await fs.rm(linkPath, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[CodexProfileManager] Failed to remove existing ${filename} link`, error)
    }
  }

  try {
    await fs.symlink(source, linkPath)
  } catch (error) {
    // BL-7: runs of one agent that start together both find the link missing on a fresh
    // home and both create it, so one of them gets EEXIST for the link it wanted. That is
    // not a failure; a link pointing anywhere else still is.
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' &&
      (await symlinkPointsAt(linkPath, source))
    ) {
      return
    }
    console.warn(`[CodexProfileManager] Failed to create symlink for ${filename}`, error)
  }
}

async function symlinkPointsAt(linkPath: string, target: string) {
  try {
    const stat = await fs.lstat(linkPath)
    return stat.isSymbolicLink() && (await fs.readlink(linkPath)) === target
  } catch {
    return false
  }
}

/** Both paths name one file on disk (every symlink followed). False when either is missing. */
async function isSameFile(first: string, second: string) {
  try {
    const [a, b] = await Promise.all([fs.stat(first), fs.stat(second)])
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

interface ManagedGroupEntry {
  id: string
  label: string
  enabled: boolean
  tools: Array<{ id: string; label: string; enabled: boolean }>
}

interface ManagedServerEntry {
  gatewayId: string
  name: string
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  envVars?: string[]
  cwd?: string
  slug?: string
  managedId: string
  enabled: boolean
  enabledTools: string[]
  disabledTools: string[]
  groups: ManagedGroupEntry[]
  authTokenEnvVar?: string
  bearerToken?: string
  startupTimeoutSec?: number
  toolTimeoutSec?: number
  defaultToolsApprovalMode?: 'auto' | 'prompt' | 'approve'
}

interface CodexProfileEntry {
  profileId: string
  label: string
  settings: ReturnType<typeof buildCodexRuntimeSettings>
  workingDirectory?: string | null
  instructionsFilePath?: string | null
  gateways: ManagedServerEntry[]
}

type ProjectPathCandidate = ProjectRow & {
  root_path?: string | null
  full_path?: string | null
}

interface ManagedCodexSubagentProfileParams {
  userId: string
  profileId: string
  runtimeId: string
  label: string
  displayName: string
  slug?: string | null
  providerSettings?: Record<string, any> | null
  defaultMCPGateways?: string[] | null
  defaultMCPToolSelections?: MCPToolSelections | null
  defaultCliToolIds?: string[] | null
  workingDirectory?: string | null
  runtimeSettings?: CodexRuntimeSettings | null
}

interface ManagedBlockMergeTables {
  features: Record<string, unknown>
  history: Record<string, unknown>
  sandboxWorkspaceWrite: Record<string, unknown>
}

interface SanitizedCustomConfigResult {
  contents: string
  mergeTables: ManagedBlockMergeTables
}

export function buildAgentProfileId(agentId: string | null | undefined) {
  const slug = (agentId ?? 'unknown').toLowerCase().replace(/[^a-z0-9_-]/g, '_')
  return `${PROFILE_PREFIX}${slug}`
}

export function buildManagedGatewayId(gatewayId: string | null | undefined, slug?: string | null) {
  const source = slug?.trim()?.toLowerCase() || (gatewayId ?? 'gateway')
  const sanitized = source.replace(/[^a-z0-9_-]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '') || 'gateway'
  return `${MANAGED_GATEWAY_PREFIX}${sanitized}`
}

/**
 * BL-310: the `url` a managed profile writes for a gateway. A Docker gateway is reached at the
 * address the app itself uses for it (`buildDockerGatewayUrl`: this lane's
 * `DOCKER_MCP_GATEWAY_PORT` or URL, and the in-app proxy in Docker Batshit), never the URL
 * saved with the record, which names whatever gateway Settings saw when the record was added.
 * That address differs between Batshit processes, and every Batshit on the Mac rewrites the
 * shared profile files, so they carry a reference that each run fills with its own process's
 * address (`cliHelperLaunch.ts`, the BL-152 rule). Every other gateway keeps its saved URL.
 * Both profile managers call this.
 */
export function resolveManagedGatewayUrl(
  gateway: Pick<MCPGateway, 'type' | 'url'>
): string | null {
  if (gateway.type === 'docker-catalog') return cliDockerGatewayUrlRef()
  const saved = typeof gateway.url === 'string' ? gateway.url.trim() : ''
  return saved.length > 0 ? saved : null
}

export async function syncAgentCodexProfiles(userId: string, requiredProfileId?: string) {
  if (env.BATSHIT_CODEX_PROVIDER_ENABLED === 'false') return
  let requiredProfileFailed = false
  const agents = await redis.getAgents(userId)
  const gateways = await mcpGatewayService.list(userId)
  const n8nInstanceToken = await migrateLegacyN8nInstanceMcpTokens({
    userId,
    gateways,
    logPrefix: 'CodexProfileManager'
  })
  let defaultWorkspace: string | null = null
  try {
    const prefs = await redis.getProjectPreferences(userId)
    if (prefs?.default_workspace_path?.trim()) {
      defaultWorkspace = prefs.default_workspace_path.trim()
    }
  } catch (error) {
    console.warn('[CodexProfileManager] Failed to read project preferences', error)
  }
  if (!defaultWorkspace) {
    defaultWorkspace = env.BATSHIT_CODEX_WORKDIR || os.homedir()
  }
  let projects: ProjectPathCandidate[] = []
  try {
    projects = (await redis.getProjects(userId)) as ProjectPathCandidate[]
  } catch (error) {
    console.warn('[CodexProfileManager] Failed to read projects for Codex working directory sync', error)
  }

  for (const agent of agents) {
    const profileId = buildAgentProfileId(agent.id)
    if (!isCodexAgent(agent)) {
      continue
    }

    const runtimeSettings = buildCodexRuntimeSettings(
      agent.codex_settings ?? agent.provider_specific_settings ?? null
    )
    runtimeSettings.profileId = profileId
    const workingDirectory = resolveManagedProfileWorkingDirectory({
      agent,
      projects,
      runtimeSettings,
      defaultWorkspace
    })

    let gatewaysData: ManagedServerEntry[] = []
    try {
      // SA-009: Pass isCodexMode: true for Codex agents.
      // Edit mode injection still applies, but internal Mode 4 helper tools are
      // now provided by the managed STDIO bridge instead of gateway MCP exposure.
      const resolution = await resolveMCPSelections({
        userId,
        agentId: agent.id,
        agent,
        selectedGateways: undefined,
        toolSelections: undefined,
        includeGatewayToolMap: true,
        isCodexMode: true
      })
      gatewaysData = await buildManagedServers({
        gateways,
        resolution,
        agent,
        userId,
        n8nInstanceToken,
        // SA-111 P4: the PRIMARY profile is the only one allowed to advertise workers.
        allowWorkerTools: resolveWorkersEnabled(agent)
      })
    } catch (error) {
      console.error('[CodexProfileManager] Failed to resolve MCP selections for agent', agent.id, error)
      if (profileId === requiredProfileId) requiredProfileFailed = true
    }

    const entry: CodexProfileEntry = {
      profileId,
      label: agent.displayName || agent.id,
      settings: runtimeSettings,
      workingDirectory,
      instructionsFilePath: null,
      gateways: gatewaysData
    }

    // BL-745: `agents` was read before the awaits above; an agent deleted since then must not
    // get its folder back. Written in the folder's turn, only while its record still exists.
    try {
      const written = await writeAgentProfileFolderIfAgentExists(agent.id, profileId, async () => {
        try {
          await deleteManagedCodexInstructionsFile(profileId)
        } catch (error) {
          console.warn('[CodexProfileManager] Failed to remove stale managed Codex instructions file', {
            profileId,
            error
          })
          if (profileId === requiredProfileId) requiredProfileFailed = true
        }

        try {
          await writeAgentManagedBlock(entry)
        } catch (error) {
          // BL-7 review: one agent's refused home (its folder resolves outside Batshit's agents
          // folder, or to the user's own `~/.codex`) must not stop every other agent's profile.
          // Nothing was written through it, and that agent's own run still fails loudly when it
          // prepares its home.
          if (!isManagedCodexHomeRefusal(error)) throw error
          console.error('[CodexProfileManager] Skipped a Codex profile whose home was refused', {
            profileId,
            error: (error as Error).message
          })
          if (profileId === requiredProfileId) requiredProfileFailed = true
        }
      })
      if (!written && profileId === requiredProfileId) requiredProfileFailed = true
    } catch (error) {
      // A failed fresh owner read must not prevent other agents' profiles from syncing.
      // This is not run admission: ensureManagedCodexHome checks its own owner separately.
      console.error('[CodexProfileManager] Failed to sync agent profile', { agentId: agent.id, profileId, error })
      if (profileId === requiredProfileId) requiredProfileFailed = true
    }
  }
  if (requiredProfileFailed) {
    throw new ManagedProfileRunRefusedError('The managed Codex profile could not be synced for this run.')
  }
}

export async function ensureAgentCodexProfile(userId: string) {
  await syncAgentCodexProfiles(userId)
}

function normalizePathCandidate(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function resolveProjectWorkingDirectory(project: ProjectPathCandidate | null | undefined) {
  if (!project) return null
  return normalizePathCandidate(project.root_path) ?? normalizePathCandidate(project.full_path)
}

function resolveAgentDefaultProjectWorkingDirectory(params: {
  agent: AgentRow
  projects: ProjectPathCandidate[]
}) {
  const defaultProjectId = normalizePathCandidate((params.agent as any).default_project_id)
  if (!defaultProjectId) return null

  const project = params.projects.find((candidate) => candidate?.id === defaultProjectId)
  return resolveProjectWorkingDirectory(project)
}

function resolveManagedProfileWorkingDirectory(params: {
  agent: AgentRow
  projects: ProjectPathCandidate[]
  runtimeSettings: ReturnType<typeof buildCodexRuntimeSettings>
  defaultWorkspace: string | null
}) {
  const customWorkingDirectory =
    params.runtimeSettings.workingDirectoryMode === 'custom'
      ? normalizePathCandidate(params.runtimeSettings.customWorkingDirectory)
      : null
  if (customWorkingDirectory) return customWorkingDirectory

  return (
    resolveAgentDefaultProjectWorkingDirectory({
      agent: params.agent,
      projects: params.projects
    }) ??
    normalizePathCandidate(params.defaultWorkspace)
  )
}

async function buildManagedServers(params: {
  gateways: MCPGateway[]
  resolution: MCPSelectionResolution
  agent?: AgentRow
  userId?: string
  n8nInstanceToken?: string | null
  selectedCliToolIds?: string[] | null
  /**
   * SA-111 P4 (DL-111-12): whether this profile may advertise `spawn_workers`. Passed
   * EXPLICITLY and defaulting to false because the subagent-profile path builds a
   * synthesized `virtualAgent` — reading `resolveWorkersEnabled` off that record would
   * default to ON and hand a CLI Subagent the ability to spawn workers.
   */
  allowWorkerTools?: boolean
}): Promise<ManagedServerEntry[]> {
  const { gateways, resolution } = params
  const dockerAuthTokenPresent = Boolean(getDockerGatewayAuthToken())
  const metadata = resolution.toolMetadata ?? new Map()
  // SA-009: resolvedToolSelections is now a flat string[]
  const enabledToolsSet = new Set(Array.isArray(resolution.resolvedToolSelections) ? resolution.resolvedToolSelections : [])
  const gatewayToolMap = resolution.gatewayToolMap ?? {}
  const enabledGatewaysSet = Array.isArray(resolution.resolvedGateways)
    ? new Set(resolution.resolvedGateways)
    : null

  const servers: ManagedServerEntry[] = []

  for (const gateway of gateways) {
    if (gateway.type === 'n8n-mcp-client') continue

    const managedId = buildManagedGatewayId(gateway.id, gateway.slug)
    const gatewayEnabled = enabledGatewaysSet ? enabledGatewaysSet.has(gateway.id) : true

    const sanitizedTools = collectSanitizedTools(gateway, gatewayToolMap).filter(
      (toolName) => !isMode4InternalHelperTool(toolName)
    )
    if (!sanitizedTools.length) continue

    const manualGroups = buildManualGroups(gateway.toolGroupings || [])
    const toolToGroupSlug = mapToolsToGroups(gateway.toolGroupings || [])
    const groupsMap = new Map<string, ManagedGroupEntry>(manualGroups)
    const enabledTools: string[] = []
    const disabledTools: string[] = []

    for (const toolName of sanitizedTools) {
      const groupSlug = toolToGroupSlug.get(toolName) || UNGROUPED_GROUP_SLUG
      const manualGroup = manualGroups.get(groupSlug)
      const groupLabel = manualGroup?.label || UNGROUPED_GROUP_LABEL

      // SA-009: Simple flat list check - tool is enabled if it's in the enabledToolsSet
      const toolEnabled = gatewayEnabled && enabledToolsSet.has(toolName)

      if (toolEnabled) {
        enabledTools.push(toolName)
      } else {
        disabledTools.push(toolName)
      }

      let groupEntry = groupsMap.get(groupSlug)
      if (!groupEntry) {
        groupEntry = {
          id: groupSlug,
          label: groupLabel,
          enabled: false,
          tools: []
        }
        groupsMap.set(groupSlug, groupEntry)
      }

      groupEntry.tools.push({
        id: toolName,
        label: prettifyToolName(toolName),
        enabled: toolEnabled
      })

      if (toolEnabled) {
        groupEntry.enabled = true
      }
    }

    // SA-009: Groups without tools are disabled (no need for legacy selection lookup)
    for (const [slug, entry] of groupsMap.entries()) {
      if (entry.tools.length > 0) continue
      // Empty group - mark as disabled
      groupsMap.set(slug, {
        ...entry,
        enabled: false
      })
    }

    const hasN8nInstanceToken = gateway.type === 'n8n-instance-mcp' && Boolean(params.n8nInstanceToken)
    const stdioConfig = sanitizeStdioGatewayConfig(gateway.stdioConfig)
    const managedStdioEnv = gateway.type === 'stdio' ? buildManagedStdioEnvironmentPlan(gateway) : null
    const fixedCwd =
      gateway.type === 'stdio' && stdioConfig?.cwdPolicy === 'fixed'
        ? stdioConfig.cwdValue
        : undefined

    const gatewayUrl = gateway.type === 'stdio' ? null : resolveManagedGatewayUrl(gateway)
    if (gateway.type === 'stdio' && !stdioConfig?.command) continue
    if (gateway.type !== 'stdio' && !gatewayUrl) continue

    servers.push({
      gatewayId: gateway.id,
      name: gateway.name,
      ...(gateway.type === 'stdio'
        ? {
            command: stdioConfig?.command,
            args: stdioConfig?.args ?? [],
            ...(managedStdioEnv && Object.keys(managedStdioEnv.env).length > 0
              ? { env: managedStdioEnv.env }
              : {}),
            ...(fixedCwd ? { cwd: fixedCwd } : {}),
            startupTimeoutSec:
              typeof stdioConfig?.startupTimeoutMs === 'number'
                ? Math.ceil(stdioConfig.startupTimeoutMs / 1000)
                : undefined,
            toolTimeoutSec:
              typeof stdioConfig?.toolCallTimeoutMs === 'number'
                ? Math.ceil(stdioConfig.toolCallTimeoutMs / 1000)
                : undefined
          }
        : {
            url: gatewayUrl ?? undefined
          }),
      slug: gateway.slug,
      managedId,
      enabled: gatewayEnabled,
      enabledTools: Array.from(new Set(enabledTools)).sort(),
      disabledTools: Array.from(new Set(disabledTools)).sort(),
      groups: Array.from(groupsMap.values()).sort((a, b) => a.label.localeCompare(b.label)),
      authTokenEnvVar:
        gateway.type === 'docker-catalog' && dockerAuthTokenPresent
          ? DOCKER_AUTH_ENV_VAR
          : hasN8nInstanceToken
            ? N8N_INSTANCE_MCP_TOKEN_ENV
            : undefined,
      bearerToken: undefined
    })
  }

  // Add an embedded stdio MCP server that exposes the agent's Batshit subagents as tools
  const assigned = params.agent
    ? Array.from(
        new Set([
          ...(Array.isArray(params.agent.assignedSubagents)
            ? params.agent.assignedSubagents
            : []),
          ...(Array.isArray((params.agent as any).assigned_subagent_ids)
            ? (params.agent as any).assigned_subagent_ids
            : []),
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
      )
    : []

  // SA-111 P4: the same bridge now also carries `spawn_workers`, so it registers when the
  // agent has assigned subagents OR workers enabled — a workers-only agent still needs it.
  const workerToolsAllowed = params.allowWorkerTools === true
  if (params.agent && (assigned.length > 0 || workerToolsAllowed)) {
    // SA-111 P1 (AMD-111-01): the subagent bridge gets its own length-bounded server name
    // so `mcp__<server>__<tool>` never exceeds Codex's 64-character function-name limit and
    // the DCM roster can print the exact name the CLI exposes. Other managed gateways keep
    // `buildManagedGatewayId` unchanged.
    const managedId = buildCliSubagentMcpServerName(params.agent)
    if (!managedId) {
      throw new Error('Cannot register the subagent MCP bridge without a primary agent id.')
    }
    const enabledTools = [
      ...buildSubagentBridgeEnabledTools(assigned),
      ...(workerToolsAllowed ? [CLI_WORKER_SPAWN_TOOL_NAME] : []),
    ]

    servers.push({
      gatewayId: `${params.agent.id}-subagents`,
      name: `${params.agent.displayName || params.agent.id} · subagents`,
      url: undefined,
      command: 'node',
      // BL-152: this Batshit's script folder and URL are filled in by each run.
      args: [
        cliHelperScriptRef('codex-subagent-mcp.cjs'),
        `--agent=${params.agent.id}`,
        `--user=${params.userId ?? ''}`,
        cliHelperUrlArgRef()
      ],
      envVars: [
        // SA-117 DL-117-06/08: the subagent bridge authenticates with THIS run's credential.
        // `BATSHIT_TOKEN` is gone from the list because the bridge no longer reads it, and
        // `MCP_GATEWAY_AUTH_TOKEN` is gone because it was only ever that token's fallback
        // spelling here — the bridge never talked to the Docker gateway.
        AGENT_RUN_CREDENTIAL_ENV_VAR,
        'REDIS_URL',
        'REDIS_CONNECTION_STRING',
        'REDIS_PASSWORD',
        'BATSHIT_FRONTEND_URL',
	        'PUBLIC_BASE_URL',
	        'ORIGIN',
	        'BATSHIT_SESSION_ID',
	        // SA-111 P4: the parent turn id, so the bridge can pass it to the Workers cap.
	        'BATSHIT_MESSAGE_ID',
	      ],
      managedId,
      slug: `${params.agent.slug ?? params.agent.id}_subagents`,
      enabled: true,
      enabledTools,
      disabledTools: [],
      groups: [],
      authTokenEnvVar: undefined,
      defaultToolsApprovalMode: 'approve'
    })
  }

  if (params.agent && typeof params.userId === 'string' && params.userId.trim().length > 0) {
    // BL-5: one fixed name in every profile, so `mcp__<server>__<tool>` stays inside Codex's
    // 64-byte limit for every helper and every agent (see `cliHelperToolNames.ts`).
    const managedId = CLI_HELPER_MCP_SERVER_NAME
    const nativeToolSettings = resolveNativeToolSettings(
      params.agent.provider_specific_settings ?? null
    )
    const cliToolScope = await resolveCliToolSelectionScope({
      userId: params.userId,
      agentId: params.agent.id,
      // The run's server-resolved list (BL-686); absent reads the agent's saved list.
      cliToolScope: params.selectedCliToolIds ?? undefined
    })
    const hasCliTools = cliToolScope.toolIds.length > 0
    const enabledMode4HelperTools = resolveEnabledMode4InternalHelperTools(nativeToolSettings, {
      hasCliTools
    }).sort()
    const enabledMode4HelperToolSet = new Set(enabledMode4HelperTools)
    const disabledMode4HelperTools = MODE4_INTERNAL_HELPER_TOOL_NAMES
      .filter((toolName) => !enabledMode4HelperToolSet.has(toolName))
      .sort()
    servers.push({
      gatewayId: managedId,
      name: `${params.agent.displayName || params.agent.id} · Batshit helpers`,
      url: undefined,
      command: 'node',
      // BL-152: this Batshit's script folder and URL are filled in by each run.
      args: [
        cliHelperScriptRef('mode4-controls-mcp.cjs'),
        `--agent=${params.agent.id}`,
        `--user=${params.userId}`,
        cliHelperUrlArgRef(),
        // SA-105 P3 (AMD-105-09): tells the bridge which CLI is consuming its
        // results, which is what decides whether a recalled memory image can
        // ride back as MCP image content this turn. Codex renders those blocks;
        // Claude stores them as text, so the flag is symmetric and explicit
        // rather than inferred.
        '--runtime=codex'
      ],
      envVars: [
        // SA-117 DL-117-06: the helper presents this run's credential instead of the
        // instance token, which `codexBridge.ts` now deletes from the child environment.
        AGENT_RUN_CREDENTIAL_ENV_VAR,
        'BATSHIT_SESSION_ID',
        // SA-116 DL-116-07: the assistant message a risky-control refusal pins its
        // approval card onto. Without it the pause is recorded with no card to click.
        'BATSHIT_MESSAGE_ID',
        'BATSHIT_PROJECT_PATH',
        'BATSHIT_FRONTEND_URL',
        'PUBLIC_BASE_URL',
        'ORIGIN'
      ],
      // BL-318: Codex cuts a tool call after `tool_timeout_sec` (60 s unless set), and an
      // artifact run may take its own run limit (up to 10 minutes).
      toolTimeoutSec: Math.ceil(CLI_HELPER_TOOL_TIMEOUT_MS / 1000),
      managedId,
      slug: managedId,
      enabled: enabledMode4HelperTools.length > 0,
      enabledTools: enabledMode4HelperTools,
      disabledTools: disabledMode4HelperTools,
      groups: [],
      authTokenEnvVar: undefined,
      defaultToolsApprovalMode: 'approve'
    })
  }

  return servers.sort((a, b) => a.name.localeCompare(b.name))
}

export async function prepareManagedCodexSubagentProfile(
  params: ManagedCodexSubagentProfileParams
): Promise<{
  profileId: string
  managedConfigHome: string
  gatewayToolMap: Record<string, string[]>
  resolvedGateways: string[]
}> {
  const runtimeSettings =
    params.runtimeSettings ?? buildCodexRuntimeSettings(params.providerSettings ?? null)
  const gateways = await mcpGatewayService.list(params.userId)
  const n8nInstanceToken = await migrateLegacyN8nInstanceMcpTokens({
    userId: params.userId,
    gateways,
    logPrefix: 'CodexProfileManager'
  })

  const virtualAgent = {
    id: params.runtimeId,
    user_id: params.userId,
    displayName: params.displayName,
    slug: params.slug ?? params.runtimeId,
    agentType: 'cli',
    provider_specific_settings: params.providerSettings ?? null,
    defaultMCPGateways: params.defaultMCPGateways ?? undefined,
    defaultMCPToolSelections: params.defaultMCPToolSelections ?? undefined,
    defaultTools: params.defaultCliToolIds ?? undefined,
    assignedSubagents: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as AgentRow

  const resolution = await resolveMCPSelections({
    userId: params.userId,
    agent: virtualAgent,
    selectedGateways: undefined,
    toolSelections: undefined,
    includeGatewayToolMap: true,
    isCodexMode: true
  })

  const gatewaysData = await buildManagedServers({
    gateways,
    resolution,
    agent: virtualAgent,
    userId: params.userId,
    n8nInstanceToken,
    selectedCliToolIds: params.defaultCliToolIds ?? null,
    // SA-111 P4 (DL-111-12): a CLI Subagent or Worker profile never gets worker spawning.
    allowWorkerTools: false
  })

  try {
    await deleteManagedCodexInstructionsFile(params.profileId)
  } catch (error) {
    console.warn('[CodexProfileManager] Failed to remove stale managed Codex instructions file for subagent profile', {
      profileId: params.profileId,
      error
    })
  }

  await writeAgentManagedBlock({
    profileId: params.profileId,
    label: params.label,
    settings: runtimeSettings,
    workingDirectory: params.workingDirectory ?? null,
    instructionsFilePath: null,
    gateways: gatewaysData
  })

  return {
    profileId: params.profileId,
    managedConfigHome: await ensureAgentCodexDir(params.profileId),
    gatewayToolMap: resolution.gatewayToolMap,
    resolvedGateways: resolution.resolvedGateways
  }
}

function isCodexAgent(agent: AgentRow) {
  const provider = agent.primary_model_provider?.toLowerCase() ?? ''
  const connectionId = agent.primary_model_connection?.id?.toLowerCase() ?? ''
  const connectionType = agent.primary_model_connection?.type?.toLowerCase() ?? ''
  const connectionService = agent.primary_model_connection?.service?.toLowerCase() ?? ''

  return (
    provider.includes('codex') ||
    connectionId === 'codex-cli' ||
    connectionService.includes('codex') ||
    connectionType === 'codex'
  )
}

function sanitizeCustomConfigForManagedBlock(
  contents: string,
  entry: CodexProfileEntry
): SanitizedCustomConfigResult {
  const trimmed = contents.trim()
  const emptyMergeTables: ManagedBlockMergeTables = {
    features: {},
    history: {},
    sandboxWorkspaceWrite: {}
  }

  if (!trimmed.length) {
    return {
      contents: '',
      mergeTables: emptyMergeTables
    }
  }

  try {
    const parsed = parseToml(trimmed) as Record<string, unknown>
    const mutable = isPlainTomlTable(parsed) ? cloneTomlTable(parsed) : {}
    const managedFeatureFlags = buildManagedFeatureFlagMap(entry.settings)

    const featureEntries = takeTomlTable(mutable, 'features')
    const historyEntries = takeTomlTable(mutable, 'history')
    const sandboxEntries = takeTomlTable(mutable, 'sandbox_workspace_write')

    const mergeTables: ManagedBlockMergeTables = {
      features: filterTomlTableEntries(featureEntries, (key) => !managedFeatureFlags.has(key)),
      history: filterTomlTableEntries(historyEntries, (key) => key !== 'persistence'),
      sandboxWorkspaceWrite: filterTomlTableEntries(sandboxEntries, (key) => key !== 'writable_roots')
    }

    for (const key of MANAGED_CONFIG_OVERRIDE_KEYS) {
      delete mutable[key]
    }

    if (entry.workingDirectory) {
      removeNestedTomlTableEntry(mutable, 'projects', entry.workingDirectory)
    }

    for (const server of entry.gateways) {
      removeNestedTomlTableEntry(mutable, 'mcp_servers', server.managedId)
    }

    return {
      contents: buildSanitizedCustomConfigContents(mutable),
      mergeTables
    }
  } catch (error) {
    console.warn('[CodexProfileManager] Failed to sanitize custom Codex config outside managed block', {
      profileId: entry.profileId,
      error
    })
    return {
      contents: trimmed,
      mergeTables: emptyMergeTables
    }
  }
}

async function writeAgentManagedBlock(entry: CodexProfileEntry) {
  const codexDir = await ensureAgentCodexDir(entry.profileId)
  const configPath = path.join(codexDir, 'config.toml')

  // BL-7 review: the managed config is read and written without following a link. A
  // `config.toml` that is a symlink is never read, so it counts as missing (its target is
  // never merged), and the write below replaces the link with Batshit's own file (see
  // codexManagedHome.ts). The legacy configs are read the same way.
  let existing = await readManagedConfigWithoutLinks(configPath, MANAGED_ROOT_DIR)
  if (existing === null) {
    existing = ''
    for (const [legacyPath, legacyRoot] of [
      [getLegacyAgentConfigPath(entry.profileId), MANAGED_ROOT_DIR],
      [path.join(LEGACY_ROOT_DIR, entry.profileId, 'config.toml'), LEGACY_ROOT_DIR]
    ] as const) {
      const legacyContents = await readManagedConfigWithoutLinks(legacyPath, legacyRoot)
      if (legacyContents === null) continue
      existing = legacyContents
      await writeFileWithoutLinks(configPath, legacyContents, MANAGED_ROOT_DIR)
      break
    }
  }

  const sanitizedCustomConfig = sanitizeCustomConfigForManagedBlock(removeManagedBlock(existing), entry)
  const withoutManaged = sanitizedCustomConfig.contents
  const managedBlock = renderManagedBlock(entry, sanitizedCustomConfig.mergeTables)
  const nextContents = managedBlock
    ? `${withoutManaged}${withoutManaged.trimEnd().length ? '\n\n' : ''}${managedBlock}\n`
    : withoutManaged

  if (nextContents.trim().length > 0) {
    parseToml(nextContents)
  }

  await writeFileWithoutLinks(configPath, nextContents || '', MANAGED_ROOT_DIR)
}

/**
 * A managed or legacy Codex config, read without following a link. Null when it does not
 * exist, and ALSO when it (or a folder on its way) is a link: a linked file's content is
 * never read.
 */
async function readManagedConfigWithoutLinks(filePath: string, root: string) {
  try {
    return await readFileWithoutLinks(filePath, root)
  } catch (error) {
    if (!isManagedFileLinkError(error)) throw error
    console.warn(`[CodexProfileManager] Did not read a managed config: ${describeManagedFileLinkRefusal(error)}`, {
      filePath,
      reason: (error as Error).message
    })
    return null
  }
}

async function deleteManagedCodexInstructionsFile(profileId: string) {
  const codexDir = await ensureAgentCodexDir(profileId)
  const instructionsPath = path.join(codexDir, MODE4_CODEX_MANAGED_INSTRUCTIONS_FILENAME)
  await fs.rm(instructionsPath, { force: true })
}

export function getManagedCodexPaths(profileId: string) {
  const dir = path.join(MANAGED_ROOT_DIR, profileId, CODEX_DIR_NAME)
  return {
    dir,
    configPath: path.join(dir, 'config.toml')
  }
}

function getAgentConfigPath(profileId: string) {
  return getManagedCodexPaths(profileId).configPath
}

function getLegacyAgentConfigPath(profileId: string) {
  return path.join(MANAGED_ROOT_DIR, profileId, 'codex', 'config.toml')
}

export async function deleteAgentCodexConfig(agentId: string | null | undefined) {
  const profileId = buildAgentProfileId(agentId ?? undefined)
  const dir = path.join(MANAGED_ROOT_DIR, profileId)
  // BL-745: after any profile sync write already under way for this folder.
  const remove = async () => withAgentProfileFolder(profileId, () => fs.rm(dir, { recursive: true, force: true }))
  if (process.platform === 'win32') return remove() // BL-364: no supported host identity proof yet.
  return withHostCommandDeletion([hostProfileResource(profileId)], async () => remove())
}

function removeManagedBlock(contents: string) {
  const start = contents.indexOf(MANAGED_START)
  const end = contents.indexOf(MANAGED_END)

  if (start === -1 || end === -1 || end < start) {
    return contents.trimEnd()
  }

  const before = contents.slice(0, start).trimEnd()
  const after = contents.slice(end + MANAGED_END.length).trimStart()
  if (before && after) {
    return `${before}\n\n${after}`.trimEnd()
  }
  if (before) return before
  return after
}

function renderManagedBlock(entry: CodexProfileEntry, mergeTables?: ManagedBlockMergeTables) {
  const blocks: string[] = [
    MANAGED_START,
    `# Managed by Batshit for ${entry.label} (${entry.profileId}). Edit outside this block to keep manual changes.`
  ]

  const defaults: string[] = []
  const settings = entry.settings

  if (settings.model) {
    defaults.push(`model = ${formatValue(settings.model)}`)
  }
  if (entry.instructionsFilePath) {
    defaults.push(`model_instructions_file = ${formatValue(entry.instructionsFilePath)}`)
  }
  defaults.push(`approval_policy = ${formatValue(settings.approval)}`)
  defaults.push(`sandbox_mode = ${formatValue(settings.sandbox)}`)
  defaults.push(`web_search = ${formatValue(resolveCodexWebSearchMode(settings.search))}`)
  defaults.push('default_tools_enabled = false')
  if (settings.reasoningEffort) {
    defaults.push(`model_reasoning_effort = ${formatValue(settings.reasoningEffort)}`)
  }
  if (settings.reasoningSummary) {
    defaults.push(`model_reasoning_summary = ${formatValue(settings.reasoningSummary)}`)
  }
  if (typeof settings.modelSupportsReasoningSummaries === 'boolean') {
    defaults.push(`model_supports_reasoning_summaries = ${formatValue(settings.modelSupportsReasoningSummaries)}`)
  }
  if (settings.serviceTier === 'fast') {
    defaults.push(`service_tier = ${formatValue('fast')}`)
  }
  if (defaults.length) {
    blocks.push('')
    blocks.push('# Managed agent defaults')
    blocks.push(...defaults)
  }

  const { lines: overrideLines, issues: overrideIssues } = buildOverrideLines(settings.configOverrides)
  if (overrideLines.length || overrideIssues.length) {
    blocks.push('')
    blocks.push('# Custom config overrides')
    blocks.push(...overrideLines)
    blocks.push(...overrideIssues.map((issue) => `# Ignored ${issue.key}: ${issue.reason}`))
  }

  const featureLines = buildFeatureLines(settings, mergeTables?.features)
  if (featureLines.length) {
    blocks.push('')
    blocks.push('[features]')
    blocks.push(...featureLines)
  }

  const historyEntries = Object.entries(mergeTables?.history ?? {}).sort((a, b) => a[0].localeCompare(b[0]))
  if (settings.historyPersistence || historyEntries.length) {
    blocks.push('')
    blocks.push('[history]')
    if (settings.historyPersistence) {
      blocks.push(`persistence = ${formatValue(settings.historyPersistence)}`)
    }
    for (const [key, value] of historyEntries) {
      blocks.push(`${formatTomlKey(key)} = ${formatValue(value)}`)
    }
  }

  const sandboxEntries = Object.entries(mergeTables?.sandboxWorkspaceWrite ?? {}).sort((a, b) => a[0].localeCompare(b[0]))
  if (settings.addDirs.length || sandboxEntries.length) {
    blocks.push('')
    blocks.push('[sandbox_workspace_write]')
    if (settings.addDirs.length) {
      blocks.push(`writable_roots = ${formatValue(settings.addDirs)}`)
    }
    for (const [key, value] of sandboxEntries) {
      blocks.push(`${formatTomlKey(key)} = ${formatValue(value as any)}`)
    }
  }

  if (entry.workingDirectory) {
    blocks.push('')
    blocks.push('# Working directory trust')
    blocks.push(`${formatProjectHeader(entry.workingDirectory)}`)
    blocks.push(`trust_level = "trusted"`)
  }

  const servers = entry.gateways
  if (!servers.length) {
    blocks.push('')
    blocks.push('# No managed MCP servers discovered for this agent.')
  } else {
    blocks.push('')
    blocks.push('# Managed MCP servers')
    for (const server of servers) {
      blocks.push('')
      blocks.push(
        `# Gateway: ${server.name} (${server.gatewayId}) → ${server.enabled ? 'enabled' : 'disabled'}`
      )
      blocks.push(`[mcp_servers.${server.managedId}]`)
      if (server.command) {
        blocks.push(`command = ${formatValue(server.command)}`)
        if (Array.isArray(server.args) && server.args.length) {
          blocks.push(`args = ${formatValue(server.args)}`)
        }
        if (server.env && Object.keys(server.env).length > 0) {
          blocks.push(`env = ${formatValue(server.env)}`)
        }
        if (Array.isArray(server.envVars) && server.envVars.length > 0) {
          const envVars = Array.from(new Set(server.envVars.map((value) => value.trim()).filter(Boolean)))
          if (envVars.length > 0) {
            blocks.push(`env_vars = ${formatValue(envVars)}`)
          }
        }
        if (server.cwd) {
          blocks.push(`cwd = ${formatValue(server.cwd)}`)
        }
        if (typeof server.startupTimeoutSec === 'number' && Number.isFinite(server.startupTimeoutSec)) {
          blocks.push(`startup_timeout_sec = ${formatValue(server.startupTimeoutSec)}`)
        }
        if (typeof server.toolTimeoutSec === 'number' && Number.isFinite(server.toolTimeoutSec)) {
          blocks.push(`tool_timeout_sec = ${formatValue(server.toolTimeoutSec)}`)
        }
      } else if (server.url) {
        blocks.push(`url = ${formatValue(server.url)}`)
      }
      blocks.push(`enabled = ${server.enabled ? 'true' : 'false'}`)
      if (server.authTokenEnvVar) {
        blocks.push(`bearer_token_env_var = ${formatValue(server.authTokenEnvVar)}`)
      } else if (server.bearerToken) {
        blocks.push(`bearer_token = ${formatValue(server.bearerToken)}`)
      }
      if (server.defaultToolsApprovalMode) {
        blocks.push(`default_tools_approval_mode = ${formatValue(server.defaultToolsApprovalMode)}`)
      }
      if (server.enabledTools.length) {
        blocks.push(`enabled_tools = ${formatValue(server.enabledTools)}`)
      }
      if (server.disabledTools.length) {
        blocks.push(`disabled_tools = ${formatValue(server.disabledTools)}`)
      }
    }
  }

  blocks.push(MANAGED_END)
  return blocks.join('\n')
}

function buildFeatureLines(settings: CodexRuntimeSettings, customFeatureEntries?: Record<string, unknown>) {
  const flags = buildManagedFeatureFlagMap(settings)
  for (const [key, value] of Object.entries(customFeatureEntries ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (flags.has(key)) continue
    flags.set(key, value)
  }

  const lines: string[] = []
  for (const [flag, value] of flags.entries()) {
    lines.push(`${formatTomlKey(flag)} = ${formatValue(value)}`)
  }
  return lines
}

function buildManagedFeatureFlagMap(settings: CodexRuntimeSettings) {
  const flags = new Map<string, unknown>()
  flags.set('apps', false)

  if (settings.unifiedExec) {
    flags.set('unified_exec', true)
  }

  for (const name of settings.enableFeatures) {
    const key = name.trim()
    if (!key) continue
    flags.set(key, true)
  }

  for (const name of settings.disableFeatures) {
    const key = name.trim()
    if (!key) continue
    flags.set(key, false)
  }

  if (settings.serviceTier === 'fast') {
    flags.set('fast_mode', true)
  }
  return flags
}

function sanitizeOverrideEntries(overrides: CodexConfigOverride[] | null | undefined) {
  const sanitizedOverrides: CodexConfigOverride[] = []
  const issues: CodexConfigOverrideIssue[] = []

  for (const override of overrides ?? []) {
    const key = normalizeConfigKey(override.key)
    if (!key) continue
    if (isManagedConfigOverrideKey(key)) {
      issues.push({
        key,
        reason: 'Batshit already manages this key'
      })
      continue
    }

    const value = override.value ?? ''
    const candidateOverride = { key, value }
    const candidateLines = [...sanitizedOverrides, candidateOverride].map(
      (entry) => `${entry.key} = ${formatValue(parseOverrideValue(entry.value))}`
    )
    try {
      parseToml(candidateLines.join('\n'))
      sanitizedOverrides.push(candidateOverride)
    } catch (error) {
      issues.push({
        key,
        reason: describeTomlConflict(error)
      })
    }
  }

  return {
    overrides: sanitizedOverrides,
    issues
  }
}

function buildOverrideLines(overrides: CodexConfigOverride[]) {
  const { overrides: sanitizedOverrides, issues } = sanitizeOverrideEntries(overrides)
  const lines = sanitizedOverrides.map((override) => `${override.key} = ${formatValue(parseOverrideValue(override.value))}`)
  return {
    lines,
    issues
  }
}

function formatProjectHeader(pathValue: string) {
  const escaped = pathValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `[projects."${escaped}"]`
}

function formatTomlKey(value: string) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

// SA-009: normalizeSelectionMap is no longer needed - MCPToolSelections is now a flat string[]

function buildManualGroups(groupings: MCPToolGrouping[]) {
  const map = new Map<string, ManagedGroupEntry>()
  for (const grouping of groupings) {
    const label = grouping.mcpName || 'Group'
    const slug = slugifyLabel(label)
    if (!map.has(slug)) {
      map.set(slug, {
        id: slug,
        label,
        enabled: false,
        tools: []
      })
    }
  }
  return map
}

function mapToolsToGroups(groupings: MCPToolGrouping[]) {
  const map = new Map<string, string>()
  for (const grouping of groupings) {
    const slug = slugifyLabel(grouping.mcpName || 'group')
    for (const toolId of grouping.toolIds ?? []) {
      if (typeof toolId === 'string' && toolId.trim().length) {
        map.set(toolId.trim(), slug)
      }
    }
  }
  return map
}

function collectSanitizedTools(
  gateway: MCPGateway,
  gatewayToolMap: Record<string, string[]>
) {
  const canonical = gatewayToolMap[gateway.id]
  if (!Array.isArray(canonical) || canonical.length === 0) {
    return []
  }

  const names = new Set<string>()
  for (const value of canonical) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      names.add(trimmed)
    }
  }
  return Array.from(names).sort()
}

function extractGroupKey(toolName: string) {
  const parts = toolName.split('_')
  return parts.length > 1 ? parts[0] : 'default'
}

function extractToolShortName(toolName: string) {
  const parts = toolName.split('_')
  return parts.length > 1 ? parts.slice(1).join('_') : toolName
}

function prettifyGroupName(value: string) {
  if (!value || value === 'default') return 'Default'
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function prettifyToolName(value: string) {
  if (!value) return 'Tool'
  return value
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function slugifyLabel(value: string) {
  if (!value) return 'default'
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '') || 'default'
}

function buildSubagentBridgeEnabledTools(assignedSubagentIds: string[]) {
  const usedKeys = new Map<string, string>()
  const tools: string[] = []

  for (const id of assignedSubagentIds) {
    const key = normalizeSubagentSlugValue(id)
    const existing = usedKeys.get(key)
    if (existing) {
      throw buildSubagentSlugCollisionError(key, existing, id)
    }
    usedKeys.set(key, id)
    tools.push(buildCliSubagentMcpToolNameForKey(key))
  }

  return tools.sort()
}

function formatValue(value: any): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatValue(item)).join(', ')}]`
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (value === null || value === undefined) {
    return '""'
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
    const inner = entries.map(([key, val]) => `${key} = ${formatValue(val)}`).join(', ')
    return `{ ${inner} }`
  }
  return JSON.stringify(String(value))
}

function extractHistoryPersistenceFromRawToml(contents: string) {
  const dottedKeyMatches = Array.from(
    contents.matchAll(
      /^\s*history\.persistence\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*$/gm
    )
  )

  const historyHeaderMatch = contents.match(/^\[history\]\s*$/m)
  let historyBlockMatches: RegExpMatchArray[] = []
  if (historyHeaderMatch?.index !== undefined) {
    const headerEnd = historyHeaderMatch.index + historyHeaderMatch[0].length
    const remainder = contents.slice(headerEnd)
    const nextHeaderIndex = remainder.search(/^\[[^\]]+\]\s*$/m)
    const historyBody =
      nextHeaderIndex === -1 ? remainder : remainder.slice(0, nextHeaderIndex)

    historyBlockMatches = Array.from(
      historyBody.matchAll(/^\s*persistence\s*=\s*["']?([A-Za-z0-9_-]+)["']?\s*$/gm)
    )
  }

  const totalMatches = dottedKeyMatches.length + historyBlockMatches.length
  if (totalMatches !== 1) {
    return null
  }

  const persistenceMatch = dottedKeyMatches[0] ?? historyBlockMatches[0]
  return persistenceMatch?.[1]?.trim().toLowerCase() ?? null
}

async function readAgentToml(profileId: string) {
  for (const [candidate, root] of [
    [getAgentConfigPath(profileId), MANAGED_ROOT_DIR],
    [getLegacyAgentConfigPath(profileId), MANAGED_ROOT_DIR],
    [path.join(LEGACY_ROOT_DIR, profileId, 'config.toml'), LEGACY_ROOT_DIR]
  ] as const) {
    try {
      // BL-7 review: never read a config through a link; one that is a link is treated as
      // unreadable, so the session cleanup leaves that agent alone.
      const contents = await readFileWithoutLinks(candidate, root)
      if (contents === null) continue
      if (!contents.trim().length) {
        return {}
      }
      try {
        return parseToml(contents) as Record<string, any>
      } catch (error) {
        console.warn('[CodexProfileManager] Failed to parse managed config:', error)
        const fallbackHistoryPersistence = extractHistoryPersistenceFromRawToml(contents)
        if (fallbackHistoryPersistence) {
          return {
            history: {
              persistence: fallbackHistoryPersistence
            }
          }
        }
        return {
          __batshit_invalid_config: true
        }
      }
    } catch (error) {
      if (isManagedFileLinkError(error)) {
        console.warn(
          `[CodexProfileManager] Did not read a managed config: ${describeManagedFileLinkRefusal(error)}`,
          { candidate, reason: (error as Error).message }
        )
        return { __batshit_invalid_config: true }
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[CodexProfileManager] Failed to read managed config:', error)
        return {}
      }
    }
  }
  return {}
}

function normalizeConfigKey(key: string | null | undefined) {
  return (key ?? '').trim().toLowerCase()
}

function isManagedConfigOverrideKey(key: string) {
  if (MANAGED_CONFIG_OVERRIDE_KEYS.has(key)) {
    return true
  }

  return MANAGED_CONFIG_OVERRIDE_PREFIXES.some((prefix) => key === prefix.slice(0, -1) || key.startsWith(prefix))
}

function isPlainTomlTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneTomlTable(table: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(table)) as Record<string, unknown>
}

function takeTomlTable(source: Record<string, unknown>, key: string) {
  const value = source[key]
  delete source[key]
  return isPlainTomlTable(value) ? value : {}
}

function filterTomlTableEntries(
  table: Record<string, unknown>,
  predicate: (key: string) => boolean
) {
  const filtered: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(table)) {
    if (!predicate(key)) continue
    filtered[key] = value
  }
  return filtered
}

function removeNestedTomlTableEntry(
  source: Record<string, unknown>,
  parentKey: string,
  childKey: string
) {
  const parent = source[parentKey]
  if (!isPlainTomlTable(parent)) return
  delete parent[childKey]
  if (Object.keys(parent).length === 0) {
    delete source[parentKey]
  }
}

function buildSanitizedCustomConfigContents(table: Record<string, unknown>) {
  if (Object.keys(table).length === 0) {
    return ''
  }
  return stringifyToml(table as any).trim()
}

function describeTomlConflict(error: unknown) {
  const message = error instanceof Error ? error.message.trim() : 'Invalid TOML'
  if (message.includes("Can't redefine existing key")) {
    return 'duplicates another override or a Batshit-managed setting'
  }
  return message.split('\n')[0] || 'invalid TOML'
}

function extractTomlTableName(line: string): string | null {
  const arrayMatch = /^\[\[\s*([^\]]+?)\s*\]\](?:\s+#.*)?$/.exec(line)
  if (arrayMatch) {
    return arrayMatch[1]
  }

  const tableMatch = /^\[\s*([^\]]+?)\s*\](?:\s+#.*)?$/.exec(line)
  return tableMatch ? tableMatch[1] : null
}

/** Read the user's actual managed setting; never write or increase the vendor limit. */
export async function readManagedCodexToolOutputTokenLimit(configHome: string): Promise<number | null> {
  const contents = await readFileWithoutLinks(path.join(configHome, 'config.toml'), MANAGED_ROOT_DIR)
  if (contents === null) return null
  const parsed = parseToml(contents) as Record<string, unknown>
  const value = parsed.tool_output_token_limit
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * BL-152 — the `--config` overrides that launch this managed home's helper servers with THIS
 * process's script folder and URL. The shared `config.toml` writes each helper's args with
 * references (`cliHelperLaunch.ts`), because every Batshit on the Mac rewrites it; Codex does
 * not expand them, so each run replaces the args of every server whose args carry one, and
 * (BL-310) the `url` of a Docker gateway, which names this process's gateway address the same
 * way.
 *
 * The bridge reads it right before the spawn (after the start gate), from the file Codex will
 * read, so the overrides name exactly the servers in those bytes: an override for a server the
 * file lacks is an invalid server table and Codex refuses to start (`invalid transport`,
 * measured on codex-cli 0.139.0). A missing file gives no overrides (Codex then has no config
 * and no helpers either). A file that is a link or has a second name (BL-117, BL-163), that
 * does not parse, or that names a server whose id cannot be passed as a `--config` key throws,
 * and the run fails, instead of starting helpers with a literal reference.
 */

export async function readManagedCodexHelperLaunchOverrides(
  configHome: string,
  values: CliHelperLaunchValues = resolveCliHelperLaunchValues()
): Promise<string[]> {
  const configPath = path.join(configHome, 'config.toml')
  const contents = await readFileWithoutLinks(configPath, MANAGED_ROOT_DIR)
  if (contents === null) return []
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(contents) as Record<string, unknown>
  } catch (error) {
    throw new Error(
      `Batshit could not read ${configPath} to start this run's helper servers (${(error as Error).message}).`,
      { cause: error }
    )
  }
  const servers = parsed.mcp_servers
  if (!servers || typeof servers !== 'object') return []

  const overrides: string[] = []
  for (const [serverId, server] of Object.entries(servers as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const args = (server as { args?: unknown } | null)?.args
    const url = (server as { url?: unknown } | null)?.url
    const argsCarryRef = Array.isArray(args) && args.some(hasCliHelperLaunchRef)
    // BL-310: a Docker gateway's address is a reference too.
    const urlCarriesRef = hasCliHelperLaunchRef(url)
    if (!argsCarryRef && !urlCarriesRef) continue
    // Codex splits a `--config` key at every dot and takes no quoted segment.
    if (!/^[A-Za-z0-9_-]+$/.test(serverId)) {
      throw new Error(`Batshit cannot pass this run's helper launch for the MCP server "${serverId}" in ${configPath}.`)
    }
    if (argsCarryRef) {
      const filled = (args as unknown[]).map((arg) =>
        typeof arg === 'string' ? fillCliHelperLaunchRefs(arg, values) : String(arg)
      )
      overrides.push(`mcp_servers.${serverId}.args=[${filled.map((arg) => JSON.stringify(arg)).join(', ')}]`)
    }
    if (urlCarriesRef) {
      overrides.push(`mcp_servers.${serverId}.url=${JSON.stringify(fillCliHelperLaunchRefs(url as string, values))}`)
    }
  }
  return overrides
}

export async function ensureManagedCodexHome(options: {
  userId: string
  profileId?: string | null
  owner: ManagedProfileRunOwner
  historyPersistence?: CodexRuntimeSettings['historyPersistence'] | null
}) {
  if (!options.profileId || !options.userId) return null
  if (options.owner?.userId !== options.userId) {
    throw new ManagedProfileRunRefusedError('The managed Codex profile owner does not match this user.')
  }
  // The first turn retains the early positive home check: a refused home fails before any
  // whole-user sync. The second turn checks this run's owner again after that sync's awaits.
  const codexDir = await withManagedProfileRunWrite(options.owner, options.profileId, () =>
    ensureAgentCodexDir(options.profileId!)
  )
  try {
    await syncAgentCodexProfiles(options.userId, options.profileId)
  } catch (error) {
    throw new ManagedProfileRunRefusedError('The managed Codex profile could not be synced for this run.', { cause: error })
  }
  return withManagedProfileRunWrite(options.owner, options.profileId, async () => {
    await assertBatshitManagedCodexHome(codexDir)
    const configPath = path.join(codexDir, 'config.toml')
    if (!(await pathExists(configPath))) {
      console.warn('[CodexProfileManager] Managed Codex config missing after sync', {
        profileId: options.profileId
      })
      return null
    }
    return codexDir
  })
}

function parseOverrideValue(raw: string | undefined) {
  if (raw === undefined) return ''
  const trimmed = raw.trim()
  if (!trimmed.length) return ''
  if (trimmed === 'true' || trimmed === 'false') {
    return trimmed === 'true'
  }
  const numeric = Number(trimmed)
  if (!Number.isNaN(numeric) && trimmed === numeric.toString()) {
    return numeric
  }
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // ignore parse error, fall through to string
    }
  }
  return trimmed
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function scheduleCodexSessionCleanupOnBoot() {
  try {
    await cleanupCodexSessionDirs({ respectPersistence: true })
  } catch (error) {
    console.warn('[CodexProfileManager] Boot cleanup for Codex sessions failed', error)
  }
}
