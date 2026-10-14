import { getManagedAgentRootDir } from './batshitHome'
import { promises as fs, type Stats } from 'node:fs'
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
import type { AgentRow, MCPGateway } from '$lib/types/database'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import type { ClaudeConfigOverride } from '$lib/types/claude'
import { resolveMCPSelections } from '$lib/server/services/mcpSelectionResolver'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { getDockerGatewayAuthToken } from '$lib/server/services/dockerGatewayConfig'
import { apiKeyService } from '$lib/services/apiKey.server'
import {
  buildAgentProfileId,
  buildManagedGatewayId,
  resolveManagedGatewayUrl
} from '$lib/server/services/codexProfileManager'
import { migrateLegacyN8nInstanceMcpTokens } from '$lib/server/services/mcpGatewayTokenMigration'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import {
  applyClaudeRuntimeOwnershipToHandle,
  applyClaudeRuntimeOwnershipWithoutFollowing,
  resolveClaudeRunAsIdentity
} from '$lib/server/services/claudeRuntimeUser'
import {
  isMode4InternalHelperTool,
  resolveEnabledMode4InternalHelperTools,
  CLI_HELPER_MCP_SERVER_NAME,
  CLI_HELPER_TOOL_TIMEOUT_MS
} from '$lib/server/services/mode4InternalTools'
import {
  buildManagedStdioEnvironmentPlan,
  sanitizeStdioGatewayConfig
} from '$lib/server/services/mcpGatewayStdio'
import { resolveCliToolSelectionScope } from '$lib/server/services/cliToolRegistry'
import { cliHelperScriptRef, cliHelperUrlArgRef } from '$lib/server/services/cliHelperLaunch'
import { buildCliSubagentMcpServerName } from '$lib/utils/cliSubagentToolNames'
import { resolveWorkersEnabled } from '$lib/utils/delegationCapabilities'
import type { MCPToolSelections } from '$lib/types/database'
import {
  describeFsError,
  describeManagedFileLinkRefusal,
  describeUnmanagedAgentHome,
  isManagedCodexProfileId,
  isManagedFileLinkError,
  readFileWithoutLinks,
  readManagedHomeFile,
  writeFileWithoutLinks,
  type ManagedAgentHomeLayout
} from '$lib/server/services/codexManagedHome'

const CLAUDE_DIR_NAME = '.claude'
const CLAUDE_APPROVAL_TOOL = 'batshit_permission_prompt'
export const CLAUDE_APPROVAL_SERVER_ID = buildManagedGatewayId('claude-approvals', 'claude-approvals')
export const CLAUDE_APPROVAL_TOOL_NAME = `mcp__${CLAUDE_APPROVAL_SERVER_ID}__${CLAUDE_APPROVAL_TOOL}`

interface ManagedClaudeSubagentProfileParams {
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
  runtimeSettings?: ReturnType<typeof buildClaudeRuntimeSettings> | null
}

export function buildClaudeProfileId(agentId: string | null | undefined) {
  return buildAgentProfileId(agentId ?? undefined)
}

export function agentClaudeProfileResource(agentId: string | null | undefined): string {
  return hostProfileResource(buildClaudeProfileId(agentId), getManagedRootDir())
}

function getManagedRootDir() {
  return getManagedAgentRootDir(env.BATSHIT_AGENT_RUNTIME_ROOT)
}

/**
 * BL-7 review — the Claude lane's managed homes follow the Codex lane's positive rule
 * (`codexManagedHome.ts`). A profile id is a folder name, and a stored `claude_profile_id`
 * was used unchecked: `../..` made every managed path `~/.claude/…`, so the run's
 * `--settings`, `--mcp-config` and `--plugin-dir` pointed into the user's own Claude home and
 * a CLI Subagent profile write merged Batshit's keys into their `settings.json`. A folder
 * symlinked out of the agents folder reached the same files by a valid name.
 */
export const MANAGED_CLAUDE_HOME_REFUSED = 'CLAUDE_MANAGED_HOME_REFUSED'

export class ManagedClaudeHomeRefusedError extends Error {
  readonly code = MANAGED_CLAUDE_HOME_REFUSED

  constructor(message: string) {
    super(message)
    this.name = 'ManagedClaudeHomeRefusedError'
  }
}

export function isManagedClaudeHomeRefusal(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === MANAGED_CLAUDE_HOME_REFUSED
}

/**
 * Every Claude profile id Batshit builds comes from `buildAgentProfileId` (an agent's id, or a
 * CLI Subagent's or Worker's `subagent_cli_<slug>`), so the Codex lane's id rule is this one.
 */
export function assertManagedClaudeProfileId(profileId: unknown): string {
  if (isManagedCodexProfileId(profileId)) return profileId
  const shown = typeof profileId === 'string' ? JSON.stringify(profileId) : String(profileId)
  throw new ManagedClaudeHomeRefusedError(
    `Batshit refused to use ${shown} as a managed Claude profile: a managed profile id is ` +
      '"batshit_agent_" followed by lowercase letters, digits, "_" or "-", so its folder stays ' +
      `inside ${getManagedRootDir()}.`
  )
}

/** The user's own Claude home(s): `~/.claude`, and `CLAUDE_CONFIG_DIR` when it is set. */
function getUsersOwnClaudeHomes() {
  const home = process.env.HOME?.trim() || os.homedir()
  const homes = [path.join(home, CLAUDE_DIR_NAME)]
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (configured) homes.push(path.resolve(configured))
  return homes
}

/**
 * BL-270 (option A, Opie/Josh 2026-09-27): the deny rules that keep a managed Claude run from
 * writing into the user's own plans folder. In Plan mode Claude Code writes its plan to
 * `<config dir>/plans` (the user's `~/.claude/plans`), and it refuses a `plansDirectory` outside
 * the project (2.1.280: "plansDirectory must be within project root"), while moving the whole
 * config folder (`CLAUDE_CONFIG_DIR`) would need a second Claude login. So the write is denied
 * (`Edit` rules cover every file-editing tool; `//` is an absolute path) and the plan stays in
 * the reply, which Batshit keeps.
 */
export function buildUsersClaudePlansDenyRules(): string[] {
  // Docker runs Claude Code as its own user (`BATSHIT_CLAUDE_RUN_AS_HOME`, compose.yaml), with
  // that user's HOME in the child, so its plans land in that home's `.claude/plans`.
  const runAsHome = resolveClaudeRunAsIdentity().home
  const homes = Array.from(
    new Set([...getUsersOwnClaudeHomes(), ...(runAsHome ? [path.join(runAsHome, CLAUDE_DIR_NAME)] : [])])
  )
  return homes.map((home) => {
    const plans = path.join(home, 'plans')
    const posix = plans
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}`)
      // `--disallowedTools` is one comma- or space-separated list, so a space or comma in the
      // path becomes `?` (one character, never `/`, in the rule's gitignore syntax).
      .replace(/[ ,]/g, '?')
    return `Edit(/${posix.startsWith('/') ? posix : `/${posix}`}/**)`
  })
}

function refuseClaudeHome(candidate: string, reason: string): never {
  throw new ManagedClaudeHomeRefusedError(
    `Batshit refused to use ${candidate} as a managed Claude home: ${reason}. A managed Claude ` +
      `run uses only its own folder under ${getManagedRootDir()}, never your own ` +
      `${getUsersOwnClaudeHomes().join(' or ')}.`
  )
}

function getManagedClaudeHomeLayout(): ManagedAgentHomeLayout {
  return {
    root: getManagedRootDir(),
    dirName: CLAUDE_DIR_NAME,
    cliName: 'Claude',
    userHomes: getUsersOwnClaudeHomes()
  }
}

/** The home must resolve (every symlink followed) to `<agents>/<profile id>/.claude`. */
async function assertBatshitManagedClaudeHome(candidate: string) {
  const reason = await describeUnmanagedAgentHome(candidate, getManagedClaudeHomeLayout())
  if (reason !== null) refuseClaudeHome(candidate, reason)
}

/**
 * Reads a managed Claude file to SHOW it (the managed-config viewers): the home must pass the
 * managed-home check and the file is never read through a link. Null when it does not exist.
 */
export function readManagedClaudeHomeFile(filePath: string) {
  return readManagedHomeFile(filePath, getManagedClaudeHomeLayout())
}

/**
 * The profile folder itself must be `<agents>/<profile id>` once resolved, checked BEFORE
 * `.claude` is made in it: a profile folder that is a symlink would otherwise get a new
 * `.claude` (and its `plugins`) created wherever it points.
 */
async function assertProfileFolderInsideRoot(profileDir: string, profileId: string) {
  let realRoot: string
  let realProfile: string
  try {
    realRoot = await fs.realpath(getManagedRootDir())
    realProfile = await fs.realpath(profileDir)
  } catch (error) {
    refuseClaudeHome(profileDir, `the folder cannot be resolved (${describeFsError(error)})`)
  }
  if (realProfile !== path.join(realRoot, profileId)) {
    refuseClaudeHome(profileDir, `it resolves to ${realProfile}, outside ${realRoot}`)
  }
}

function getAgentClaudeDir(profileId: string) {
  return path.join(getManagedRootDir(), assertManagedClaudeProfileId(profileId), CLAUDE_DIR_NAME)
}

export function getManagedClaudePaths(profileId: string) {
  const dir = getAgentClaudeDir(profileId)
  return {
    dir,
    settingsPath: path.join(dir, 'settings.json'),
    mcpPath: path.join(dir, 'mcp.json'),
    pluginsDir: path.join(dir, 'plugins')
  }
}

async function ensureAgentClaudeDir(profileId: string) {
  // BL-7 review: the id is refused before it becomes a path, the profile folder before
  // anything is made in it, and the home before anything is written, owned, or linked to.
  const profileDir = path.join(getManagedRootDir(), assertManagedClaudeProfileId(profileId))
  await fs.mkdir(profileDir, { recursive: true })
  await assertProfileFolderInsideRoot(profileDir, profileId)
  const dir = path.join(profileDir, CLAUDE_DIR_NAME)
  await fs.mkdir(dir, { recursive: true })
  await assertBatshitManagedClaudeHome(dir)
  const pluginsDir = path.join(dir, 'plugins')
  // BL-7 review: a `plugins` that is a symlink is replaced with Batshit's own folder, so
  // `--plugin-dir` never points at, and ownership never reaches, what the link pointed at.
  const plugins = await fs.lstat(pluginsDir).catch(() => null)
  if (plugins?.isSymbolicLink()) {
    console.warn("[ClaudeProfileManager] Replaced a symlinked plugins folder with Batshit's own", {
      pluginsDir
    })
    await fs.unlink(pluginsDir)
  }
  await fs.mkdir(pluginsDir, { recursive: true })
  // BL-7 review: `lchown` never follows a link, so a folder swapped for one after these
  // checks cannot redirect the run-as ownership.
  await applyClaudeRuntimeOwnershipWithoutFollowing(dir)
  await applyClaudeRuntimeOwnershipWithoutFollowing(pluginsDir)
  return dir
}

/**
 * The paths a managed Claude run hands the CLI (`--settings`, `--mcp-config`,
 * `--plugin-dir`), for a home that exists and passed the check above. Throws
 * `ManagedClaudeHomeRefusedError` otherwise; no flag is ever built from an unchecked id.
 */
export async function ensureManagedClaudeHome(profileId: string, owner: ManagedProfileRunOwner) {
  return withManagedProfileRunWrite(owner, profileId, async () => {
    await ensureAgentClaudeDir(profileId)
    return getManagedClaudePaths(profileId)
  })
}

function mapPermissionMode(mode: string) {
  if (mode === 'bypassPermissions') return 'bypassPermissions'
  if (mode === 'acceptEdits') return 'acceptEdits'
  if (mode === 'plan') return 'plan'
  if (mode === 'default') return 'default'
  if (mode === 'agent_full') return 'bypassPermissions'
  if (mode === 'agent') return 'acceptEdits'
  if (mode === 'chat') return 'default'
  return 'default'
}

function buildSettingsFile(settings: ReturnType<typeof buildClaudeRuntimeSettings>) {
  const payload: Record<string, any> = {
    permissions: {
      defaultMode: mapPermissionMode(settings.permissionMode),
      ...(settings.addDirs.length > 0
        ? { additionalDirectories: settings.addDirs }
        : {})
    },
    alwaysThinkingEnabled: settings.alwaysThinkingEnabled === true
  }

  if (
    settings.alwaysThinkingEnabled === true &&
    typeof settings.maxThinkingTokens === 'number' &&
    settings.maxThinkingTokens > 0
  ) {
    payload.env = {
      MAX_THINKING_TOKENS: String(settings.maxThinkingTokens)
    }
  }

  return payload
}

// Header names that indicate secret-bearing values. Secret headers are written into managed
// mcp.json as ${BATSHIT_MCP_HEADER_*} placeholders (Claude Code expands env vars in `headers`),
// and ClaudeBridge injects the real values into the CLI child environment at spawn time.
const SECRET_HEADER_NAME_PATTERN = /auth|token|secret|key|password|credential|cookie|signature|bearer/i

export function buildManagedClaudeHeaderPlaceholderName(gatewayId: string, headerKey: string): string {
  const gatewayPart = gatewayId.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const headerPart = headerKey.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const base = `BATSHIT_MCP_HEADER_${gatewayPart}_${headerPart}`.replace(/_{2,}/g, '_')
  return base.slice(0, 120)
}

function buildGatewayHeaders(params: {
  gateway: MCPGateway
  dockerAuthToken?: string | null
  n8nInstanceToken?: string | null
}): { headers: Record<string, string> | undefined; secretEnv: Record<string, string> } {
  const { gateway, dockerAuthToken, n8nInstanceToken } = params
  // Ordered header plan: later entries override earlier ones for the same header key.
  const plan = new Map<string, { value: string; secret: boolean }>()

  // Legacy metadata.authToken is the lowest-precedence fallback: migrated docker/n8n tokens
  // and explicit custom headers below must win over it.
  const legacyToken = typeof gateway.metadata?.authToken === 'string' ? gateway.metadata.authToken.trim() : ''
  if (legacyToken) {
    plan.set('Authorization', { value: `Bearer ${legacyToken}`, secret: true })
  }

  if (gateway.type === 'docker-catalog' && dockerAuthToken) {
    plan.set('Authorization', { value: `Bearer ${dockerAuthToken}`, secret: true })
  }

  if (gateway.type === 'n8n-instance-mcp' && n8nInstanceToken) {
    plan.set('Authorization', { value: `Bearer ${n8nInstanceToken}`, secret: true })
  }

  if (gateway.metadata?.headers && typeof gateway.metadata.headers === 'object') {
    for (const [key, value] of Object.entries(gateway.metadata.headers as Record<string, any>)) {
      if (typeof value === 'string' && value.trim().length > 0) {
        plan.set(key, { value, secret: SECRET_HEADER_NAME_PATTERN.test(key) })
      }
    }
  }

  const headers: Record<string, string> = {}
  const secretEnv: Record<string, string> = {}
  for (const [key, entry] of plan) {
    if (!entry.secret) {
      headers[key] = entry.value
      continue
    }
    const envVarName = buildManagedClaudeHeaderPlaceholderName(gateway.id, key)
    headers[key] = `\${${envVarName}}`
    secretEnv[envVarName] = entry.value
  }

  return {
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    secretEnv
  }
}

function collectGatewayHeaderSecretEnv(params: {
  gateways: MCPGateway[]
  dockerAuthToken?: string | null
  n8nInstanceToken?: string | null
}): Record<string, string> {
  const secretEnv: Record<string, string> = {}
  for (const gateway of params.gateways) {
    if (gateway.type === 'stdio' || gateway.type === 'n8n-mcp-client') continue
    const built = buildGatewayHeaders({
      gateway,
      dockerAuthToken: params.dockerAuthToken,
      n8nInstanceToken: params.n8nInstanceToken
    })
    Object.assign(secretEnv, built.secretEnv)
  }
  return secretEnv
}

/**
 * Resolves the env var name -> secret value map backing the ${BATSHIT_MCP_HEADER_*} placeholders
 * written into managed Claude mcp.json files. Placeholder names are deterministic per
 * gateway + header key, so this user-global map covers agent and subagent profiles alike.
 */
export async function collectManagedClaudeGatewayHeaderEnv(userId: string): Promise<Record<string, string>> {
  const gateways = await mcpGatewayService.list(userId)
  let n8nInstanceToken: string | null = null
  try {
    n8nInstanceToken = await apiKeyService.retrieve('n8n_instance_mcp_token', userId)
  } catch (error) {
    console.warn('[ClaudeProfileManager] Failed to load n8n instance MCP token for header env', error)
  }
  return collectGatewayHeaderSecretEnv({
    gateways,
    dockerAuthToken: getDockerGatewayAuthToken() ?? null,
    n8nInstanceToken
  })
}

async function buildManagedMcpServers(params: {
  gateways: MCPGateway[]
  agent: AgentRow
  userId: string
  gatewayToolMap: Record<string, string[]>
  resolvedGateways?: string[]
  dockerAuthToken?: string | null
  n8nInstanceToken?: string | null
  selectedCliToolIds?: string[] | null
  /**
   * SA-111 P4 (DL-111-12): whether this profile may advertise `spawn_workers`. Explicit and
   * false by default — the subagent-profile path passes a synthesized `virtualAgent`, and
   * `resolveWorkersEnabled` on that record would default to ON.
   */
  allowWorkerTools?: boolean
}) {
  const { gateways, gatewayToolMap } = params
  const enabledGatewaysSet = Array.isArray(params.resolvedGateways)
    ? new Set(params.resolvedGateways)
    : null
  const servers: Record<string, any> = {}

  for (const gateway of gateways) {
    if (gateway.type === 'n8n-mcp-client') continue
    if (enabledGatewaysSet && !enabledGatewaysSet.has(gateway.id)) continue

    const enabledTools = (gatewayToolMap[gateway.id] ?? []).filter(
      (toolName) => !isMode4InternalHelperTool(toolName)
    )
    if (enabledTools.length === 0) continue

    const managedId = buildManagedGatewayId(gateway.id, gateway.slug)
    const stdioConfig = sanitizeStdioGatewayConfig(gateway.stdioConfig)
    // BL-310: a Docker gateway at the address the app itself uses, not its saved URL.
    const gatewayUrl = gateway.type === 'stdio' ? null : resolveManagedGatewayUrl(gateway)
    if (gateway.type === 'stdio' && !stdioConfig?.command) continue
    if (gateway.type !== 'stdio' && !gatewayUrl) continue
    const fixedCwd =
      gateway.type === 'stdio' && stdioConfig?.cwdPolicy === 'fixed'
        ? stdioConfig.cwdValue
        : undefined
    const entry: Record<string, any> =
      gateway.type === 'stdio'
        ? {
            type: 'stdio',
            command: stdioConfig?.command,
            args: stdioConfig?.args ?? [],
            ...(fixedCwd ? { cwd: fixedCwd } : {}),
            ...(() => {
              const plan = buildManagedStdioEnvironmentPlan(gateway)
              return Object.keys(plan.env).length > 0 ? { env: plan.env } : {}
            })()
          }
        : {
            type: 'http',
            url: gatewayUrl
          }

    if (gateway.type !== 'stdio') {
      const { headers } = buildGatewayHeaders({
        gateway,
        dockerAuthToken: params.dockerAuthToken,
        n8nInstanceToken: params.n8nInstanceToken
      })
      if (headers) {
        entry.headers = headers
      }
    }

    servers[managedId] = entry
  }

  const assigned = Array.from(
    new Set([
      ...(Array.isArray(params.agent.assignedSubagents)
        ? params.agent.assignedSubagents
        : []),
      ...(Array.isArray((params.agent as any).assigned_subagent_ids)
        ? (params.agent as any).assigned_subagent_ids
        : []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0))
  )

  // SA-111 P4: the same bridge carries `spawn_workers`, so a workers-only agent with no
  // assigned subagents still needs it registered.
  if (assigned.length > 0 || params.allowWorkerTools === true) {
    // SA-111 P1 (AMD-111-01): same length-bounded subagent server name as the Codex profile,
    // so both managed CLI lanes and the DCM roster agree on one string.
    const managedId = buildCliSubagentMcpServerName(params.agent)
    if (!managedId) {
      throw new Error('Cannot register the subagent MCP bridge without a primary agent id.')
    }
    // BL-152: script folder and URL by reference; Claude Code expands them from the run's env.
    servers[managedId] = {
      type: 'stdio',
      command: 'node',
      args: [
        cliHelperScriptRef('codex-subagent-mcp.cjs'),
        `--agent=${params.agent.id}`,
        `--user=${params.userId}`,
        cliHelperUrlArgRef()
      ]
    }
  }

  if (typeof params.userId === 'string' && params.userId.trim().length > 0) {
    const nativeToolSettings = resolveNativeToolSettings(params.agent.provider_specific_settings ?? null)
    const cliToolScope = await resolveCliToolSelectionScope({
      userId: params.userId,
      agentId: params.agent.id,
      // The run's server-resolved list (BL-686); absent reads the agent's saved list.
      cliToolScope: params.selectedCliToolIds ?? undefined
    })
    const hasCliTools = cliToolScope.toolIds.length > 0
    const enabledMode4HelperTools = resolveEnabledMode4InternalHelperTools(nativeToolSettings, {
      hasCliTools
    })

    if (enabledMode4HelperTools.length > 0) {
      // BL-5: one fixed name in every profile; `ClaudeBridge` scopes the tools under it.
      // BL-152: script folder and URL by reference; Claude Code expands them from the run's env.
      servers[CLI_HELPER_MCP_SERVER_NAME] = {
        type: 'stdio',
        command: 'node',
        args: [
          cliHelperScriptRef('mode4-controls-mcp.cjs'),
          `--agent=${params.agent.id}`,
          `--user=${params.userId}`,
          cliHelperUrlArgRef(),
          // SA-105 P3 (AMD-105-09): the symmetric half of the Codex flag. Claude
          // Code stores MCP ImageContent as text at 10-20x the token cost
          // (anthropic/claude-code#31208, closed not-planned), so this runtime
          // deliberately receives no image blocks — the recall plan says
          // `next_message` and the note tells the agent so honestly.
          '--runtime=claude'
        ],
        env: {
          // SA-117 DL-117-06: the helper presents THIS run's credential. `BATSHIT_TOKEN` is
          // gone from the map because `claudeBridge.ts` now deletes it from the child
          // environment entirely, so a `${BATSHIT_TOKEN}` reference would expand to nothing.
          BATSHIT_AGENT_TOKEN: '${BATSHIT_AGENT_TOKEN}',
          BATSHIT_SESSION_ID: '${BATSHIT_SESSION_ID}',
          // SA-116 DL-116-07: the assistant message a risky-control refusal pins its
          // approval card onto. Without it the pause is recorded with no card to click.
          BATSHIT_MESSAGE_ID: '${BATSHIT_MESSAGE_ID}',
          BATSHIT_PROJECT_PATH: '${BATSHIT_PROJECT_PATH}',
          BATSHIT_FRONTEND_URL: '${BATSHIT_FRONTEND_URL}',
          PUBLIC_BASE_URL: '${PUBLIC_BASE_URL}',
          ORIGIN: '${ORIGIN}'
        },
        // BL-318: a per-server tool timeout in milliseconds (Claude Code's MCP docs), longer
        // than the helper's own longest wait, so a slow artifact run ends with Batshit's
        // answer. Without it the user's own `MCP_TOOL_TIMEOUT` would decide.
        timeout: CLI_HELPER_TOOL_TIMEOUT_MS
      }
    }
  }

  servers[CLAUDE_APPROVAL_SERVER_ID] = {
    type: 'stdio',
    command: 'node',
    args: [cliHelperScriptRef('claude-permission-mcp.cjs')],
    // BL-496 (A5): the approval helper waits up to 10 minutes for the user, and the card says
    // so (`expiresAt`). Eleven here, so a user's own `MCP_TOOL_TIMEOUT` in the app's
    // environment cannot end the call before the card does.
    timeout: CLI_HELPER_TOOL_TIMEOUT_MS
  }

  return servers
}

export async function prepareManagedClaudeSubagentProfile(
  params: ManagedClaudeSubagentProfileParams
): Promise<{
  profileId: string
  gatewayToolMap: Record<string, string[]>
  resolvedGateways: string[]
}> {
  const runtimeSettings =
    params.runtimeSettings ?? buildClaudeRuntimeSettings(params.providerSettings ?? null)
  const gateways = await mcpGatewayService.list(params.userId)
  const n8nInstanceToken = await migrateLegacyN8nInstanceMcpTokens({
    userId: params.userId,
    gateways,
    logPrefix: 'ClaudeProfileManager'
  })

  const dockerAuthToken = getDockerGatewayAuthToken() ?? null
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
    updated_at: new Date().toISOString()
  } as AgentRow

  const resolution = await resolveMCPSelections({
    userId: params.userId,
    agent: virtualAgent,
    selectedGateways: undefined,
    toolSelections: undefined,
    includeGatewayToolMap: true,
    isCodexMode: true
  })

  const servers = await buildManagedMcpServers({
    gateways,
    agent: virtualAgent,
    userId: params.userId,
    gatewayToolMap: resolution.gatewayToolMap ?? {},
    resolvedGateways: resolution.resolvedGateways,
    dockerAuthToken,
    n8nInstanceToken,
    selectedCliToolIds: params.defaultCliToolIds ?? null,
    // SA-111 P4 (DL-111-12): a CLI Subagent or Worker profile never gets worker spawning.
    allowWorkerTools: false
  })

  const { settingsPath, mcpPath } = getManagedClaudePaths(params.profileId)
  const settingsPayload = buildSettingsFile(runtimeSettings)
  const mcpPayload = { mcpServers: servers }

  await ensureAgentClaudeDir(params.profileId)
  await writeManagedSettingsFile(settingsPath, settingsPayload, runtimeSettings.configOverrides)
  await writeJsonFile(mcpPath, mcpPayload)

  return {
    profileId: params.profileId,
    gatewayToolMap: resolution.gatewayToolMap,
    resolvedGateways: resolution.resolvedGateways
  }
}

function isClaudeAgent(agent: AgentRow) {
  const provider = agent.primary_model_provider?.toLowerCase() ?? ''
  const connectionId = agent.primary_model_connection?.id?.toLowerCase() ?? ''
  const connectionType = agent.primary_model_connection?.type?.toLowerCase() ?? ''
  const connectionService = agent.primary_model_connection?.service?.toLowerCase() ?? ''

  return (
    provider.includes('claude-cli') ||
    connectionId === 'claude-cli' ||
    connectionService.includes('claude-cli') ||
    connectionType === 'claude-cli'
  )
}

async function writeJsonFile(filePath: string, payload: Record<string, any>) {
  const contents = JSON.stringify(payload, null, 2)
  // Managed mcp.json carries gateway auth plumbing; keep it owner-only. BL-7 review: written as
  // a new owner-only file renamed over the old one, so a symlink there is replaced, never
  // written through (and its target is never chmod-ed or chown-ed).
  await writeManagedClaudeFile(filePath, contents)
}

async function writeManagedClaudeFile(filePath: string, contents: string) {
  await writeFileWithoutLinks(filePath, contents, getManagedRootDir(), {
    mode: 0o600,
    prepareHandle: applyClaudeRuntimeOwnershipToHandle
  })
}

function splitConfigPath(key: string) {
  return key
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
}

function parseConfigOverrideValue(raw: string | undefined) {
  if (raw === undefined) return ''
  const trimmed = raw.trim()
  if (!trimmed.length) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null

  const numeric = Number(trimmed)
  if (!Number.isNaN(numeric) && trimmed === numeric.toString()) {
    return numeric
  }

  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Fall through to plain string handling.
    }
  }

  return trimmed
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMergeJson(
  base: Record<string, unknown>,
  addition: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }

  for (const [key, value] of Object.entries(addition)) {
    const existing = result[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMergeJson(existing, value)
      continue
    }

    result[key] = value
  }

  return result
}

function deleteNestedValue(target: Record<string, unknown>, pathSegments: string[]) {
  if (pathSegments.length === 0) return

  const [head, ...tail] = pathSegments
  if (!head) return

  if (tail.length === 0) {
    delete target[head]
    return
  }

  const next = target[head]
  if (!isPlainObject(next)) return

  deleteNestedValue(next, tail)
  if (Object.keys(next).length === 0) {
    delete target[head]
  }
}

function setNestedValue(target: Record<string, unknown>, pathSegments: string[], value: unknown) {
  if (pathSegments.length === 0) return

  let current: Record<string, unknown> = target
  for (let index = 0; index < pathSegments.length; index += 1) {
    const segment = pathSegments[index]
    const atLeaf = index === pathSegments.length - 1

    if (atLeaf) {
      current[segment] = value
      return
    }

    const existing = current[segment]
    if (!isPlainObject(existing)) {
      const next: Record<string, unknown> = {}
      current[segment] = next
      current = next
      continue
    }

    current = existing
  }
}

function applyConfigOverrides(
  base: Record<string, unknown>,
  overrides: ClaudeConfigOverride[]
) {
  const next = structuredClone(base)
  for (const override of overrides) {
    const pathSegments = splitConfigPath(override.key)
    if (pathSegments.length === 0) continue
    setNestedValue(next, pathSegments, parseConfigOverrideValue(override.value))
  }
  return next
}

function removeManagedSettingsPaths(payload: Record<string, unknown>) {
  const next = structuredClone(payload)
  deleteNestedValue(next, ['alwaysThinkingEnabled'])
  deleteNestedValue(next, ['permissions', 'defaultMode'])
  deleteNestedValue(next, ['permissions', 'additionalDirectories'])
  deleteNestedValue(next, ['env', 'MAX_THINKING_TOKENS'])
  return next
}

async function readExistingJsonFile(filePath: string) {
  try {
    // BL-7 review: never read through a link. A managed file that is a symlink is rebuilt
    // from Batshit's settings (the write replaces the link); its target is never merged.
    const contents = await readFileWithoutLinks(filePath, getManagedRootDir())
    if (contents === null) return {}
    const parsed = JSON.parse(contents)
    return isPlainObject(parsed) ? parsed : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    if (isManagedFileLinkError(error)) {
      console.warn(`[ClaudeProfileManager] Did not read a managed file: ${describeManagedFileLinkRefusal(error)}`, {
        filePath,
        reason: (error as Error).message
      })
      return {}
    }

    console.warn('[ClaudeProfileManager] Failed to parse existing managed JSON file; rebuilding from Batshit settings', {
      filePath,
      error
    })
    return {}
  }
}

async function writeManagedSettingsFile(
  filePath: string,
  payload: Record<string, unknown>,
  configOverrides: ClaudeConfigOverride[]
) {
  const existing = await readExistingJsonFile(filePath)
  const preserved = removeManagedSettingsPaths(existing)
  const merged = deepMergeJson(preserved, payload)
  const withOverrides = applyConfigOverrides(merged, configOverrides)
  const contents = JSON.stringify(withOverrides, null, 2)
  await writeManagedClaudeFile(filePath, contents)
}

export async function syncAgentClaudeProfiles(userId: string, requiredProfileId?: string): Promise<Record<string, string>> {
  if (env.BATSHIT_CLAUDE_PROVIDER_ENABLED === 'false') return {}
  let requiredProfileFailed = false

  const agents = await redis.getAgents(userId)
  const gateways = await mcpGatewayService.list(userId)
  const n8nInstanceToken = await migrateLegacyN8nInstanceMcpTokens({
    userId,
    gateways,
    logPrefix: 'ClaudeProfileManager'
  })

  const dockerAuthToken = getDockerGatewayAuthToken() ?? null
  // Secrets backing the ${BATSHIT_MCP_HEADER_*} placeholders written below. Returned so
  // ClaudeBridge can inject them into the CLI child environment at spawn time.
  const gatewayHeaderEnv = collectGatewayHeaderSecretEnv({ gateways, dockerAuthToken, n8nInstanceToken })

  for (const agent of agents) {
    if (!isClaudeAgent(agent)) continue

    const runtimeSettings = buildClaudeRuntimeSettings(agent.claude_settings ?? agent.provider_specific_settings ?? null)
    const configScope = runtimeSettings.configScope ?? 'managed'
    const profileId = buildClaudeProfileId(agent.id)

    if (configScope !== 'managed') {
      continue
    }

    let gatewayToolMap: Record<string, string[]> = {}
    let resolvedGateways: string[] | undefined

    try {
      const resolution = await resolveMCPSelections({
        userId,
        agentId: agent.id,
        agent,
        selectedGateways: undefined,
        toolSelections: undefined,
        includeGatewayToolMap: true,
        isCodexMode: true
      })
      gatewayToolMap = resolution.gatewayToolMap ?? {}
      resolvedGateways = resolution.resolvedGateways
    } catch (error) {
      console.error('[ClaudeProfileManager] Failed to resolve MCP selections for agent', agent.id, error)
      if (profileId === requiredProfileId) requiredProfileFailed = true
    }

    const servers = await buildManagedMcpServers({
      gateways,
      agent,
      userId,
      gatewayToolMap,
      resolvedGateways,
      dockerAuthToken,
      n8nInstanceToken,
      // SA-111 P4: the PRIMARY profile is the only one allowed to advertise workers.
      allowWorkerTools: resolveWorkersEnabled(agent)
    })

    const { settingsPath, mcpPath } = getManagedClaudePaths(profileId)
    const settingsPayload = buildSettingsFile(runtimeSettings)
    const mcpPayload = { mcpServers: servers }

    // BL-745: `agents` was read before the awaits above; an agent deleted since then must not
    // get its folder back. Its home is made and written in the folder's turn, only while its
    // record still exists.
    try {
      const written = await writeAgentProfileFolderIfAgentExists(agent.id, profileId, async () => {
        try {
          await ensureAgentClaudeDir(profileId)
        } catch (error) {
          // BL-7 review: a refused home is skipped loudly; nothing is written through it, and
          // that agent's own run still fails when it prepares its home.
          if (isManagedClaudeHomeRefusal(error)) {
            console.error('[ClaudeProfileManager] Skipped a Claude profile whose home was refused', {
              profileId,
              error: (error as Error).message
            })
          } else {
            console.warn('[ClaudeProfileManager] Failed to create managed Claude directory', { profileId, error })
          }
          if (profileId === requiredProfileId) requiredProfileFailed = true
          return
        }

        try {
          await writeManagedSettingsFile(settingsPath, settingsPayload, runtimeSettings.configOverrides)
          await writeJsonFile(mcpPath, mcpPayload)
        } catch (error) {
          console.warn('[ClaudeProfileManager] Failed to write managed Claude config', { profileId, error })
          if (profileId === requiredProfileId) requiredProfileFailed = true
        }
      })
      if (!written && profileId === requiredProfileId) requiredProfileFailed = true
    } catch (error) {
      // A failed fresh read for one agent must not stop unrelated profiles from syncing.
      // Run admission checks the current run's owner separately and fails closed.
      console.error('[ClaudeProfileManager] Failed to sync agent profile', { agentId: agent.id, profileId, error })
      if (profileId === requiredProfileId) requiredProfileFailed = true
    }
  }

  if (requiredProfileFailed) {
    throw new ManagedProfileRunRefusedError('The managed Claude profile could not be synced for this run.')
  }

  return gatewayHeaderEnv
}

export async function deleteAgentClaudeConfig(agentId: string | null | undefined) {
  const profileId = buildClaudeProfileId(agentId ?? undefined)
  const removeHome = async () => {
    // BL-7 review: `rm -rf` of `<profile>/.claude` resolves THROUGH a profile folder that is a
    // symlink, so it deleted whatever `.claude` the link reached (the user's own, for a link to
    // their home), and an unlink there removed a link outside the agents folder. The profile
    // folder is checked first; then a `.claude` that is itself a symlink loses only the link,
    // and a real folder goes only when it is a managed home.
    const profileDir = path.join(getManagedRootDir(), assertManagedClaudeProfileId(profileId))
    try {
      await fs.lstat(profileDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    await assertProfileFolderInsideRoot(profileDir, profileId)
    const dir = path.join(profileDir, CLAUDE_DIR_NAME)
    let entry: Stats
    try {
      entry = await fs.lstat(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (entry.isSymbolicLink()) {
      await fs.unlink(dir)
      return
    }
    await assertBatshitManagedClaudeHome(dir)
    await fs.rm(dir, { recursive: true, force: true })
  }
  // BL-745: after any profile sync write already under way for this folder.
  const remove = () => withAgentProfileFolder(profileId, removeHome)
  if (process.platform === 'win32') return remove() // BL-364: no supported host identity proof yet.
  return withHostCommandDeletion([agentClaudeProfileResource(agentId)], async () => remove())
}
