import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { env } from '$env/dynamic/private'
import { redis } from '$lib/server/redis'
import type { AgentRow, MCPGateway } from '$lib/types/database'
import { buildClaudeRuntimeSettings } from '$lib/server/services/claudeSettings'
import type { ClaudeConfigOverride } from '$lib/types/claude'
import { resolveMCPSelections } from '$lib/server/services/mcpSelectionResolver'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { getDockerGatewayAuthToken } from '$lib/server/services/dockerGatewayConfig'
import { apiKeyService } from '$lib/services/apiKey.server'
import { buildAgentProfileId, buildManagedGatewayId } from '$lib/server/services/codexProfileManager'
import { migrateLegacyN8nInstanceMcpTokens } from '$lib/server/services/mcpGatewayTokenMigration'
import { resolveNativeToolSettings } from '$lib/server/services/nativeTools'
import { applyClaudeRuntimeOwnership } from '$lib/server/services/claudeRuntimeUser'
import {
  isMode4InternalHelperTool,
  resolveEnabledMode4InternalHelperTools,
  buildMode4InternalHelpersGatewayId,
  buildMode4InternalHelpersGatewaySlug
} from '$lib/server/services/mode4InternalTools'
import {
  buildManagedStdioEnvironmentPlan,
  sanitizeStdioGatewayConfig
} from '$lib/server/services/mcpGatewayStdio'
import { resolveCliToolSelectionScope } from '$lib/server/services/cliToolRegistry'
import { resolveCliHelperBatshitBaseUrl } from '$lib/server/services/cliHelperBaseUrl'
import type { MCPToolSelections } from '$lib/types/database'

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

function getManagedRootDir() {
  const configuredRoot = env.BATSHIT_AGENT_RUNTIME_ROOT?.trim()
  const home = process.env.HOME?.trim() || os.homedir()
  const runtimeRoot = configuredRoot ? path.resolve(configuredRoot) : path.join(home, '.batshit')
  return path.join(runtimeRoot, 'agents')
}

function getAgentClaudeDir(profileId: string) {
  return path.join(getManagedRootDir(), profileId, CLAUDE_DIR_NAME)
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
  const dir = getAgentClaudeDir(profileId)
  const pluginsDir = path.join(dir, 'plugins')
  await fs.mkdir(dir, { recursive: true })
  await fs.mkdir(pluginsDir, { recursive: true })
  await applyClaudeRuntimeOwnership(dir)
  await applyClaudeRuntimeOwnership(pluginsDir)
  return dir
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
    if (gateway.type === 'stdio' && !stdioConfig?.command) continue
    if (gateway.type !== 'stdio' && !gateway.url) continue
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
            url: gateway.url
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

  if (assigned.length > 0) {
    const managedId = buildManagedGatewayId(`${params.agent.id}-subagents`, `${params.agent.slug ?? params.agent.id}-subagents`)
    const scriptPath = path.join(process.cwd(), 'scripts', 'codex-subagent-mcp.cjs')
    servers[managedId] = {
      type: 'stdio',
      command: 'node',
      args: [
        scriptPath,
        `--agent=${params.agent.id}`,
        `--user=${params.userId}`,
        `--url=${resolveCliHelperBatshitBaseUrl()}`
      ]
    }
  }

  if (typeof params.userId === 'string' && params.userId.trim().length > 0) {
    const nativeToolSettings = resolveNativeToolSettings(params.agent.provider_specific_settings ?? null)
    const cliToolScope = await resolveCliToolSelectionScope({
      userId: params.userId,
      agentId: params.agent.id,
      selectedToolIds: params.selectedCliToolIds
    })
    const hasCliTools = cliToolScope.toolIds.length > 0
    const enabledMode4HelperTools = resolveEnabledMode4InternalHelperTools(nativeToolSettings, {
      hasCliTools
    })

    if (enabledMode4HelperTools.length > 0) {
      const slugSource = params.agent.slug ?? params.agent.id
      const managedId = buildManagedGatewayId(
        buildMode4InternalHelpersGatewayId(params.agent.id),
        buildMode4InternalHelpersGatewaySlug(slugSource)
      )
      const scriptPath = path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs')
      servers[managedId] = {
        type: 'stdio',
        command: 'node',
        args: [
          scriptPath,
          `--agent=${params.agent.id}`,
          `--user=${params.userId}`,
          `--url=${resolveCliHelperBatshitBaseUrl()}`,
          // SA-105 P3 (AMD-105-09): the symmetric half of the Codex flag. Claude
          // Code stores MCP ImageContent as text at 10-20x the token cost
          // (anthropic/claude-code#31208, closed not-planned), so this runtime
          // deliberately receives no image blocks — the recall plan says
          // `next_message` and the note tells the agent so honestly.
          '--runtime=claude'
        ],
        env: {
          BATSHIT_TOKEN: '${BATSHIT_TOKEN}',
          BATSHIT_SESSION_ID: '${BATSHIT_SESSION_ID}',
          BATSHIT_PROJECT_PATH: '${BATSHIT_PROJECT_PATH}',
          BATSHIT_FRONTEND_URL: '${BATSHIT_FRONTEND_URL}',
          PUBLIC_BASE_URL: '${PUBLIC_BASE_URL}',
          ORIGIN: '${ORIGIN}'
        }
      }
    }
  }

  const approvalScriptPath = path.join(process.cwd(), 'scripts', 'claude-permission-mcp.cjs')
  servers[CLAUDE_APPROVAL_SERVER_ID] = {
    type: 'stdio',
    command: 'node',
    args: [approvalScriptPath]
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
    selectedCliToolIds: params.defaultCliToolIds ?? null
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
  // Managed mcp.json carries gateway auth plumbing; keep it owner-only. `mode` only applies
  // when the file is created, so chmod explicitly to tighten pre-existing files on rewrite.
  await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(filePath, 0o600)
  await applyClaudeRuntimeOwnership(filePath)
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
    const contents = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(contents)
    return isPlainObject(parsed) ? parsed : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
  await fs.writeFile(filePath, contents, 'utf8')
  await fs.chmod(filePath, 0o600)
  await applyClaudeRuntimeOwnership(filePath)
}

export async function syncAgentClaudeProfiles(userId: string): Promise<Record<string, string>> {
  if (env.BATSHIT_CLAUDE_PROVIDER_ENABLED === 'false') return {}

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

    try {
      await ensureAgentClaudeDir(profileId)
    } catch (error) {
      console.warn('[ClaudeProfileManager] Failed to create managed Claude directory', { profileId, error })
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
    }

    const servers = await buildManagedMcpServers({
      gateways,
      agent,
      userId,
      gatewayToolMap,
      resolvedGateways,
      dockerAuthToken,
      n8nInstanceToken
    })

    const { settingsPath, mcpPath } = getManagedClaudePaths(profileId)
    const settingsPayload = buildSettingsFile(runtimeSettings)
    const mcpPayload = { mcpServers: servers }

    try {
      await writeManagedSettingsFile(settingsPath, settingsPayload, runtimeSettings.configOverrides)
      await writeJsonFile(mcpPath, mcpPayload)
    } catch (error) {
      console.warn('[ClaudeProfileManager] Failed to write managed Claude config', { profileId, error })
    }
  }

  return gatewayHeaderEnv
}

export async function deleteAgentClaudeConfig(agentId: string | null | undefined) {
  const profileId = buildClaudeProfileId(agentId ?? undefined)
  const dir = path.join(getManagedRootDir(), profileId, CLAUDE_DIR_NAME)
  await fs.rm(dir, { recursive: true, force: true })
}
