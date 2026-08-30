import { tool } from 'ai'
import { load as loadHtml } from 'cheerio'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { env } from '$env/dynamic/private'
import { z } from 'zod'
import type { AgentDcmDisplaySettings, MCPToolSelections } from '$lib/types/database'
import type { ToolApprovalMode } from '$lib/types/tool-approvals'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerUrl,
  getInternalBatshitServerAuthHeaders
} from './batshitServerUrls'
import { apiKeyService } from '$lib/services/apiKey.server'
import { resolveDynamicMcpGatewayScope } from './mcpSelectionResolver'
import {
  executeCliTool,
  findCliTools,
  resolveCliToolSelectionScope
} from './cliToolRegistry'
import { mapBashCommandToRendererTool } from './bashCommandMapper'
import { resolveDefaultNativeExecutionBackend } from './nativeExecutionDefaults'
import {
  BROKER_FABRIC_FETCH_ZIP_CONTROL_ID,
  BROKER_TOOL_FAMILIES,
  isControlIdAllowedByList,
  resolveBrokerFabricAllowedControlIds,
  resolveBrokerFamilies,
  resolveBrokerToolToggles
} from '$lib/utils/brokerAvailability'
import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
import { NATIVE_FABRIC_HELPER_CONTROL_META } from './nativeFabricHelperCatalog'
import { findControls, useControl, type ControlRuntimeMode, type ControlUseErrorCode } from './fabricRegistry'
import {
  DEFAULT_DYNAMIC_MCP_RESULTS,
  MAX_DYNAMIC_MCP_RESULTS,
  executeDynamicMcpFind as executeSharedDynamicMcpFind,
  executeDynamicMcpUse as executeSharedDynamicMcpUse,
  type GatewayToolsCache
} from './dynamicMcpTools'
import {
  RUNTIME_ADDON_IDS,
  controlRuntimeAddon,
  getRuntimeAddonStatus,
  listRuntimeAddons,
  prepareRuntimeAddon
} from './runtimeAddons'
import {
  buildSkillScriptCommand,
  executeSkillRuntimeAction,
  findBundleFileByPath,
  normalizeBundleFiles,
  readSkillBundleFileText,
  resolveBundleFileAbsolutePath,
  resolveSkillRuntimeForTool
} from './skillRuntimeToolService'
import {
  resolveScreenshotUploadModelUrl,
  resolveUploadConfigForScreenshot
} from './clipUrlResolver'
import {
  buildRuntimeUrlAliasMap,
  resolveRuntimeUrlAlias
} from '$lib/utils/runtimeUrlAliases'
import {
  cleanupAppleContainerSandboxesForSession,
  ensureBatshitHomeSandboxMountPath,
  executeAppleContainerSandboxCommand,
  getAppleContainerSandboxStatus,
  isPathInsideSandboxRoot,
  recoverAppleContainerSandbox
} from './appleContainerSandbox'
import { bytesToBlob } from '$lib/utils/binary'
import {
  APPLY_PATCH_BEGIN_MARKER,
  APPLY_PATCH_END_MARKER,
  applyManagedPatchHunks,
  extractManagedApplyPatchDocument,
  isManagedApplyPatchCommand,
  parseManagedApplyPatchDocument,
  type ManagedApplyPatchOperation
} from './managedApplyPatch'
import {
  normalizeNativeExecutionBackend,
  type NativeExecutionBackend
} from '$lib/utils/nativeExecutionBackend'

type LegacyNativeToolPolicyMode = 'workspace' | 'read_only'
type NativeBashAccessMode = 'plan' | 'agent' | 'dangerous'
type DockerSandboxCliKind = 'sbx' | 'docker-sandbox'
type NativeWebSearchProvider = 'duckduckgo-html' | 'exa' | 'perplexity'
type ExaSearchType = 'auto' | 'fast' | 'neural' | 'deep'
type AgentBrowserRuntimeMode = 'chromium' | 'chrome-cdp'
type AgentBrowserProvider = 'local' | 'browserbase' | 'browseruse' | 'kernel'
type AgentBrowserSupportLevel = 'native-cli' | 'docker-sidecar' | 'docker-deferred'
type AgentBrowserBashSettings = {
  enabled: boolean
  liveViewEnabled: boolean
  runtimeMode: AgentBrowserRuntimeMode
  cdpPort: number
  provider: AgentBrowserProvider
  session?: string
  profilePath?: string
  executablePath?: string
  extraFlags?: string[]
  timeoutMs?: number
}

// SA-096: the family list and the rules deciding which families the broker serves live in
// $lib/utils/brokerAvailability so the compile twins can gate their broker guidance on the
// same truth this file registers tools from.
export const BATSHIT_TOOL_FAMILIES = BROKER_TOOL_FAMILIES
export type BatshitToolFamily = (typeof BATSHIT_TOOL_FAMILIES)[number]
type BatshitToolSchemaMode = 'compact' | 'full' | 'none'

type BatshitToolSearchInput = {
  query?: string
  family?: BatshitToolFamily
  families?: BatshitToolFamily[]
  limit?: number
  schemaMode?: BatshitToolSchemaMode
  includeSchema?: boolean
  selectedGateways?: string[]
  selectedToolIds?: string[]
}

type BatshitToolUseInput = {
  ref: string
  input?: Record<string, any>
  params?: Record<string, any>
  allowRisky?: boolean
  dryRun?: boolean
  selectedGateways?: string[]
  selectedToolIds?: string[]
  [key: string]: any
}

type BatshitToolSearchResult = {
  ref: string
  family: BatshitToolFamily
  title: string
  description: string
  hint?: string
  useExample?: string
  riskLevel?: 'safe' | 'confirm' | 'restricted'
  source?: string
  inputSchema?: Record<string, any>
  raw?: Record<string, any>
}

type BatshitToolSearchResponse = {
  results: BatshitToolSearchResult[]
  totalMatches: number
  query: string
  limit: number
  schemaMode: BatshitToolSchemaMode
  families: BatshitToolFamily[]
  unavailableFamilies?: Array<{ family: BatshitToolFamily; reason: string }>
  operationKind: 'tool_find'
  rendererFamily: 'tool_find'
}

type BatshitToolUseResponse = Record<string, any> & {
  ref: string
  family: BatshitToolFamily
  target: string
  operationKind:
    | 'dynamic_use'
    | 'cli_tool'
    | 'artifact_use'
    | 'fabric_use'
    | 'agent_browser_use'
    | 'fetch_zip'
  rendererFamily: 'generic_tool' | 'cli_tool'
}

export interface NativeToolContext {
  userId: string
  agentId?: string | null
  sessionId?: string
  selectedGateways?: string[]
  toolSelections?: MCPToolSelections
  selectedCliToolIds?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  allowArtifactRuntimeTools?: boolean
  allowFabricControlTools?: boolean
  /** SA-104 P3: PRIMARY actor + agent `memory_enabled`. Default false (memory is opt-in). */
  memoryControlsEnabled?: boolean
  projectPath?: string | null
  providerSettings?: Record<string, any> | null
  toolApprovalMode?: ToolApprovalMode
}

export interface NativeToolExecutionResult {
  success: boolean
  blocked?: boolean
  reason?: string
  [key: string]: any
}

const NATIVE_AUTOMATION_ACTIONS = [
  'bash_execute',
  'native_skill',
  'batshit_tool_search',
  'batshit_tool_use',
  'cli_tool_find',
  'cli_tool_use',
  'agent_browser_find',
  'agent_browser_use',
  'artifact_find',
  'artifact_use',
  'runtime_addon_list',
  'runtime_addon_status',
  'runtime_addon_prepare',
  'runtime_addon_start',
  'runtime_addon_stop',
  'web_search',
  'fetch_zip'
] as const
type NativeAutomationAction = (typeof NATIVE_AUTOMATION_ACTIONS)[number]
type NativeAutomationMode = 'mode1' | 'mode2' | 'mode3' | 'mode4'
type PublicPrimaryAgentType = 'n8n' | 'api' | 'cli'
type NativeAutomationActorType = 'primary' | 'subagent'

const PUBLIC_PRIMARY_AGENT_TYPE_TO_NATIVE_MODE: Record<PublicPrimaryAgentType, NativeAutomationMode> = {
  n8n: 'mode2',
  api: 'mode3',
  cli: 'mode4'
}

const NATIVE_AUTOMATION_ERROR_CODES = [
  'ACTION_DISABLED',
  'INVALID_ACTION',
  'INVALID_INPUT',
  'INVALID_CONTEXT',
  'BACKEND_UNAVAILABLE',
  'SANDBOX_UNAVAILABLE',
  'POLICY_BLOCKED'
] as const
type NativeAutomationErrorCode = (typeof NATIVE_AUTOMATION_ERROR_CODES)[number]

interface NativeAutomationDispatchContext {
  session_id: string
  agent_id: string
  mode: NativeAutomationMode
  actor_type: NativeAutomationActorType
  parent_agent_id?: string
}

interface NativeAutomationDispatchResult {
  success: boolean
  action: NativeAutomationAction
  backend: NativeExecutionBackend
  context: {
    mode: NativeAutomationMode
    actor_type: NativeAutomationActorType
    agent_id: string
    parent_agent_id?: string
  }
  data?: Record<string, any>
  error?: {
    code: NativeAutomationErrorCode
    message: string
    details?: Record<string, any>
  }
}

const ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS = ['use.artifact.*'] as const

const CONTROL_FIND_INPUT_SCHEMA = z.object({
  query: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sourceType: z
    .union([
      z.enum(['core', 'artifact', 'workflow', 'plugin']),
      z.array(z.enum(['core', 'artifact', 'workflow', 'plugin']))
    ])
    .optional(),
  riskLevel: z
    .union([
      z.enum(['safe', 'confirm', 'restricted']),
      z.array(z.enum(['safe', 'confirm', 'restricted']))
    ])
    .optional(),
  includeSchema: z.boolean().optional(),
  includeDraft: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional()
})

const CONTROL_USE_INPUT_SCHEMA = z
  .object({
    controlId: z.string().min(1),
    input: z.record(z.string(), z.any()).optional(),
    dryRun: z.boolean().optional(),
    allowRisky: z.boolean().optional(),
    zone: z.string().min(1).optional(),
    target_zone: z.string().min(1).optional(),
    targetZone: z.string().min(1).optional(),
    zone_name: z.string().min(1).optional(),
    zoneName: z.string().min(1).optional(),
    placement: z.string().min(1).optional(),
    location: z.string().min(1).optional()
  })
  .passthrough()

type ControlFindInput = z.infer<typeof CONTROL_FIND_INPUT_SCHEMA>
type ControlUseInput = z.infer<typeof CONTROL_USE_INPUT_SCHEMA>

const BATSHIT_TOOL_FAMILY_SCHEMA = z.enum(BATSHIT_TOOL_FAMILIES)
const BATSHIT_TOOL_SCHEMA_MODE_SCHEMA = z.enum(['compact', 'full', 'none'])

const BATSHIT_TOOL_SEARCH_INPUT_SCHEMA = z.object({
  query: z.string().optional(),
  family: BATSHIT_TOOL_FAMILY_SCHEMA.optional(),
  families: z.array(BATSHIT_TOOL_FAMILY_SCHEMA).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  schemaMode: BATSHIT_TOOL_SCHEMA_MODE_SCHEMA.optional(),
  includeSchema: z.boolean().optional(),
  selectedGateways: z.array(z.string()).optional(),
  selectedToolIds: z.array(z.string()).optional()
})

const BATSHIT_TOOL_USE_INPUT_SCHEMA = z
  .object({
    ref: z.string().trim().min(1),
    input: z.record(z.string(), z.any()).optional(),
    params: z.record(z.string(), z.any()).optional(),
    allowRisky: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    selectedGateways: z.array(z.string()).optional(),
    selectedToolIds: z.array(z.string()).optional()
  })
  .passthrough()

const BATSHIT_TOOL_FAMILY_LABELS: Record<BatshitToolFamily, string> = {
  mcp: 'MCP',
  cli: 'CLI',
  artifact: 'Artifact',
  fabric: 'Fabric',
  agent_browser: 'Agent Browser'
}

const BATSHIT_TOOL_OPERATION_KIND_BY_FAMILY: Record<
  Exclude<BatshitToolFamily, 'mcp'> | 'mcp',
  Exclude<BatshitToolUseResponse['operationKind'], 'fetch_zip'>
> = {
  mcp: 'dynamic_use',
  cli: 'cli_tool',
  artifact: 'artifact_use',
  fabric: 'fabric_use',
  agent_browser: 'agent_browser_use'
}

const MAX_BASH_OUTPUT_CHARS = 120_000
const MAX_BASH_EDIT_SNAPSHOT_BYTES = 24_000
const DEFAULT_BASH_TIMEOUT_MS = 30_000
const MIN_BASH_TIMEOUT_MS = 1_000
const MAX_BASH_TIMEOUT_MS = 120_000
const DEFAULT_NATIVE_BASH_BACKEND: NativeExecutionBackend = 'local'
const NATIVE_EXECUTION_BACKEND_LABELS: Record<NativeExecutionBackend, string> = {
  local: 'Local shell',
  docker_sandbox: 'Docker Sandbox',
  apple_container: 'Apple Container Sandbox'
}
const CONTAINERIZED_DOCKER_SANDBOX_DISABLED_REASON =
  'Docker Sandbox is disabled for this Docker instance. Configure the Batshit host operator to enable isolated sandbox execution; Batshit will not mount the host Docker socket into the core app container.'
const MAX_SEARCH_RESULTS = 10
const DEFAULT_SEARCH_RESULTS = 5
const MAX_DYNAMIC_RESULTS = MAX_DYNAMIC_MCP_RESULTS
const DEFAULT_DYNAMIC_RESULTS = DEFAULT_DYNAMIC_MCP_RESULTS
const MAX_ZIP_CHARS = 250_000
const DEFAULT_ZIP_CHARS = 16_000
const MAX_SKILL_REFERENCE_CHARS = 50_000
const DEFAULT_SKILL_REFERENCE_CHARS = 12_000
const MAX_SKILL_SCRIPT_CHARS = 30_000
const DEFAULT_SKILL_SCRIPT_CHARS = 8_000
const MAX_SKILL_SCRIPT_ARGS = 32
const MAX_SKILL_PREVIEW_ITEMS = 25
const DEFAULT_WEB_SEARCH_TIMEOUT_MS = 8_000
const MAX_WEB_SEARCH_TIMEOUT_MS = 20_000
const DEFAULT_COMFYUI_OBJECT_INFO_TIMEOUT_MS = 8_000
const MAX_COMFYUI_OBJECT_INFO_TIMEOUT_MS = 20_000
const DEFAULT_COMFYUI_OBJECT_INFO_MAX_NODES = 120
const MAX_COMFYUI_OBJECT_INFO_MAX_NODES = 500
const MAX_COMFYUI_OBJECT_INFO_CLASS_TYPES = 200
const DEFAULT_COMFYUI_WORKFLOW_TIMEOUT_MS = 8_000
const MAX_COMFYUI_WORKFLOW_TIMEOUT_MS = 20_000
const DEFAULT_COMFYUI_WORKFLOW_LIST_LIMIT = 200
const MAX_COMFYUI_WORKFLOW_LIST_LIMIT = 1_000
const FABRIC_FETCH_ZIP_CONTROL_ID = BROKER_FABRIC_FETCH_ZIP_CONTROL_ID
const FABRIC_COMFYUI_WORKFLOWS_CONTROL_ID = 'sys.comfyui.workflows'
const FABRIC_COMFYUI_OBJECT_INFO_CONTROL_ID = 'sys.comfyui.object_info'
const FABRIC_COMFYUI_ALLOWED_CONTROL_ID = 'sys.comfyui.*'
const ZIP_FETCH_INPUT_SCHEMA_JSON = {
  type: 'object',
  properties: {
    zipId: { type: 'string' },
    includeContent: { type: 'boolean' },
    maxChars: { type: 'integer', minimum: 64, maximum: MAX_ZIP_CHARS }
  },
  required: ['zipId']
}
const COMFYUI_WORKFLOWS_INPUT_SCHEMA_JSON = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'get'] },
    baseUrl: { type: 'string' },
    workflowName: { type: 'string' },
    includeWorkflow: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_COMFYUI_WORKFLOW_LIST_LIMIT },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_COMFYUI_WORKFLOW_TIMEOUT_MS }
  }
}
const COMFYUI_OBJECT_INFO_INPUT_SCHEMA_JSON = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string' },
    includeSchema: { type: 'boolean' },
    classTypes: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_COMFYUI_OBJECT_INFO_CLASS_TYPES
    },
    maxNodes: { type: 'integer', minimum: 1, maximum: MAX_COMFYUI_OBJECT_INFO_MAX_NODES },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: MAX_COMFYUI_OBJECT_INFO_TIMEOUT_MS }
  }
}
const DEFAULT_EXA_SEARCH_TYPE: ExaSearchType = 'auto'
const DEFAULT_PERPLEXITY_MAX_TOKENS_PER_PAGE = 1024
const MIN_PERPLEXITY_MAX_TOKENS_PER_PAGE = 64
const MAX_PERPLEXITY_MAX_TOKENS_PER_PAGE = 4096
const DEFAULT_AGENT_BROWSER_TIMEOUT_MS = 45_000
const MIN_AGENT_BROWSER_TIMEOUT_MS = 1_000
const MAX_AGENT_BROWSER_TIMEOUT_MS = 120_000
const MAX_AGENT_BROWSER_SCREENSHOT_BYTES = 15 * 1024 * 1024
const AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS = 24 * 60 * 60
const MAX_AGENT_BROWSER_RESULTS = 25
const DEFAULT_AGENT_BROWSER_RESULTS = 8
const MAX_AGENT_BROWSER_OUTPUT_CHARS = 200_000
const DEFAULT_AGENT_BROWSER_CDP_PORT = 9222
const DEFAULT_AGENT_BROWSER_RUNTIME_MODE: AgentBrowserRuntimeMode = 'chromium'
const DEFAULT_AGENT_BROWSER_PROVIDER: AgentBrowserProvider = 'local'
const AGENT_BROWSER_TESTED_VERSION = '0.24.1'

function getDefaultNativeExecutionBackend(): NativeExecutionBackend {
  return resolveDefaultNativeExecutionBackend()
}
const AGENT_BROWSER_TESTED_PACKAGE_SPEC = `agent-browser@${AGENT_BROWSER_TESTED_VERSION}`
const AGENT_BROWSER_TESTED_TARBALL_URL =
  'https://registry.npmjs.org/agent-browser/-/agent-browser-0.24.1.tgz'
const AGENT_BROWSER_TESTED_INTEGRITY =
  'sha512-csWJtYEQow52b+p93zVZfNrcNBwbxGCZDXDMNWl2ij2i0MFKubIzN+icUeX2/NrkZe5iIau8px+HQlxata2oPw=='
const AGENT_BROWSER_INSTALL_COMMAND =
  `npm install -g ${AGENT_BROWSER_TESTED_PACKAGE_SPEC} && agent-browser install`
const AGENT_BROWSER_INSTALL_TIMEOUT_MS = 10 * 60_000
const AGENT_BROWSER_INSTALL_MAX_OUTPUT_CHARS = 400_000
const AGENT_BROWSER_UNINSTALL_COMMAND = 'npm uninstall -g agent-browser'
const AGENT_BROWSER_DOCKER_SIDECAR_DEFAULT_URL = 'http://agent-browser:8091'
const DOCKER_AGENT_BROWSER_UNSUPPORTED_REASON =
  'Docker Agent Browser sidecar is not running yet. Start it from Batshit when the host operator is configured, or run the agent-browser Compose profile from the host.'
const DOCKER_AGENT_BROWSER_INSTALL_HELP =
  'Docker Agent Browser is managed by the optional agent-browser Compose sidecar, not by downloading a binary into the core app container.'
const DOCKER_AGENT_BROWSER_BASH_HELP =
  'Docker Agent Browser commands run through Batshit Agent Browser tools, not raw app-container Bash. Use agent_browser_find / agent_browser_use or Settings -> Admin -> Agent Browser Runtime.'

async function readFileWithinLimit(filePath: string, maxBytes: number): Promise<Buffer | null> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0)
    if (bytesRead <= 0 || bytesRead > maxBytes) return null
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function isBatshitContainerizedRuntime() {
  return (
    env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    env.BATSHIT_RUNTIME_ENV === 'docker' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

function getDockerAgentBrowserRawBashBlockReason(): string | null {
  return isBatshitContainerizedRuntime() ? DOCKER_AGENT_BROWSER_BASH_HELP : null
}

function containerizedDockerSandboxLocalCliExplicitlyAllowed() {
  return resolveContainerizedDockerSandboxDriver() === 'local-cli'
}

type ContainerizedDockerSandboxDriver = 'operator' | 'local-cli' | 'disabled'

function resolveContainerizedDockerSandboxDriver(): ContainerizedDockerSandboxDriver {
  const raw = (
    env.BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER ??
    process.env.BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER ??
    ''
  )
    .trim()
    .toLowerCase()

  if (raw === 'local-cli') return 'local-cli'
  if (['disabled', 'disable', 'off', 'none', 'unavailable'].includes(raw)) return 'disabled'

  // Dockerized Batshit treats Docker Sandbox as core infrastructure. The app
  // still cannot run host Docker/Sandbox commands directly, so the built-in
  // route is the authenticated host operator unless explicitly disabled.
  return 'operator'
}

function containerizedDockerSandboxOperatorEnabled() {
  return resolveContainerizedDockerSandboxDriver() === 'operator'
}

function normalizeSandboxOperatorUrl(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return null
  }
}

function resolveDockerSandboxOperatorConfig():
  | { ok: true; url: string; token: string; timeoutMs: number }
  | { ok: false; reason: string } {
  const rawUrl =
    env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL?.trim() ||
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL?.trim() ||
    env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL?.trim() ||
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_URL?.trim() ||
    ''
  const url = normalizeSandboxOperatorUrl(rawUrl)
  if (!url) {
    return {
      ok: false,
      reason: rawUrl
        ? 'BATSHIT_DOCKER_SANDBOX_OPERATOR_URL must be an http(s) URL.'
        : 'Docker Sandbox operator is not configured.'
    }
  }

  const token =
    env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN?.trim() ||
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN?.trim() ||
    env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN?.trim() ||
    process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN?.trim() ||
    ''
  if (!token) {
    return {
      ok: false,
      reason: 'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN is required when the Docker Sandbox operator is configured.'
    }
  }

  const timeoutMs =
    parseInteger(
      env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TIMEOUT_MS ??
        process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TIMEOUT_MS ??
        env.BATSHIT_RUNTIME_ADDON_OPERATOR_TIMEOUT_MS ??
        process.env.BATSHIT_RUNTIME_ADDON_OPERATOR_TIMEOUT_MS
    ) ?? DOCKER_SANDBOX_STATUS_TIMEOUT_MS

  return {
    ok: true,
    url,
    token,
    timeoutMs: clamp(timeoutMs, 1_000, 120_000)
  }
}

function resolvePreferredDockerSandboxCliKind(): DockerSandboxCliKind | null {
  const raw =
    env.BATSHIT_DOCKER_SANDBOX_CLI?.trim().toLowerCase() ||
    process.env.BATSHIT_DOCKER_SANDBOX_CLI?.trim().toLowerCase() ||
    ''
  if (raw === 'sbx') return 'sbx'
  if (raw === 'docker-sandbox' || raw === 'docker_sandbox' || raw === 'docker sandbox') {
    return 'docker-sandbox'
  }
  return null
}
const AGENT_BROWSER_UNINSTALL_TIMEOUT_MS = 5 * 60_000
const AGENT_BROWSER_UNINSTALL_MAX_OUTPUT_CHARS = 400_000
const AGENT_BROWSER_INSTALL_HELP =
  `Install with exact tested version: ${AGENT_BROWSER_INSTALL_COMMAND}`
const AGENT_BROWSER_TESTED_VERSION_NOTE =
  `Batshit pins Agent Browser ${AGENT_BROWSER_TESTED_VERSION} as the current tested runtime.`
function resolveBatshitRuntimeTmpRoot(): string {
  const configured =
    env.BATSHIT_AGENT_BROWSER_TMP_DIR?.trim() ||
    process.env.BATSHIT_AGENT_BROWSER_TMP_DIR?.trim()
  return configured || path.join(os.tmpdir(), 'batshit-runtime', 'tmp')
}
const DOCKER_SANDBOX_NAME_PREFIX = 'batshit-'
const DOCKER_SANDBOX_CLEANUP_TIMEOUT_MS = 15_000
const AGENT_BROWSER_TMP_FILE_PREFIX = 'batshit-agent-browser-'
const MIN_AGENT_BROWSER_SCREENSHOT_WAIT_MS = 0
const DEFAULT_AGENT_BROWSER_SCREENSHOT_WAIT_MS = 1_500
const MAX_AGENT_BROWSER_SCREENSHOT_WAIT_MS = 15_000
const AGENT_BROWSER_IMAGE_EXT_TO_MEDIA: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}
const AGENT_BROWSER_RUNTIME_MODE_ALIASES: Record<string, AgentBrowserRuntimeMode> = {
  chromium: 'chromium',
  'separate-chromium': 'chromium',
  separate_chromium: 'chromium',
  'chrome-cdp': 'chrome-cdp',
  chrome_cdp: 'chrome-cdp',
  cdp: 'chrome-cdp',
  chrome: 'chrome-cdp'
}
const AGENT_BROWSER_PROVIDER_ALIASES: Record<string, AgentBrowserProvider> = {
  local: 'local',
  browserbase: 'browserbase',
  browser_use: 'browseruse',
  'browser-use': 'browseruse',
  browseruse: 'browseruse',
  kernel: 'kernel'
}
const AGENT_BROWSER_TOOL_NAME_ALIASES: Record<string, string> = {
  goto: 'open',
  navigate: 'open',
  launch: 'tab_new',
  start: 'tab_new',
  init: 'tab_new',
  new: 'tab_new',
  key: 'press',
  scrollinto: 'scrollintoview',
  quit: 'close',
  exit: 'close',
  gettitle: 'get_title',
  geturl: 'get_url',
  gettext: 'get_text',
  gethtml: 'get_html',
  isvisible: 'is_visible',
  isenabled: 'is_enabled',
  ischecked: 'is_checked',
  isdisabled: 'is_disabled',
  iseditable: 'is_editable',
  isempty: 'is_empty'
}

const DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT: 'allow' | 'deny' = 'deny'
const DOCKER_SANDBOX_STATUS_TIMEOUT_MS = 5_000
const DOCKER_SANDBOX_STATUS_MAX_OUTPUT_CHARS = 8_192

interface AgentBrowserCommandSpec {
  id: string
  cli: string[]
  summary: string
  argsHint: string
  paramsHint: string
  examples: string[]
}

const AGENT_BROWSER_COMMANDS: AgentBrowserCommandSpec[] = [
  {
    id: 'open',
    cli: ['open'],
    summary: 'Navigate to a URL.',
    argsHint: '<url>',
    paramsHint: '{ url, autoPrepareLivePreview? }',
    examples: ['open https://example.com']
  },
  {
    id: 'snapshot',
    cli: ['snapshot'],
    summary: 'Capture accessibility tree refs (best for AI interaction loops).',
    argsHint: '[optional args]',
    paramsHint: '{ args?: ["-i"] }',
    examples: ['snapshot', 'snapshot -i']
  },
  {
    id: 'click',
    cli: ['click'],
    summary: 'Click an element by ref or selector.',
    argsHint: '<ref|selector>',
    paramsHint: '{ selector }',
    examples: ['click @e2', 'click "#submit"']
  },
  {
    id: 'fill',
    cli: ['fill'],
    summary: 'Clear and fill an input.',
    argsHint: '<ref|selector> <text>',
    paramsHint: '{ selector, text }',
    examples: ['fill @e3 "test@example.com"']
  },
  {
    id: 'type',
    cli: ['type'],
    summary: 'Type into an input (without clearing first).',
    argsHint: '<ref|selector> <text>',
    paramsHint: '{ selector, text }',
    examples: ['type @e3 "hello"']
  },
  {
    id: 'press',
    cli: ['press'],
    summary: 'Press a keyboard key.',
    argsHint: '<key>',
    paramsHint: '{ key }',
    examples: ['press Enter', 'press Tab']
  },
  {
    id: 'wait',
    cli: ['wait'],
    summary: 'Wait for selector/text/url/load-state/time.',
    argsHint: '<selector|ms> or --text/--url/--load',
    paramsHint: '{ waitFor } or { args, flags }',
    examples: ['wait @e4', 'wait 1000', 'wait --text Welcome']
  },
  {
    id: 'get_text',
    cli: ['get', 'text'],
    summary: 'Read text from an element.',
    argsHint: '<ref|selector>',
    paramsHint: '{ selector }',
    examples: ['get_text @e1']
  },
  {
    id: 'get_html',
    cli: ['get', 'html'],
    summary: 'Read HTML from an element or page.',
    argsHint: '[ref|selector]',
    paramsHint: '{ selector? }',
    examples: ['get_html', 'get_html @e1']
  },
  {
    id: 'get_title',
    cli: ['get', 'title'],
    summary: 'Read current page title.',
    argsHint: '(none)',
    paramsHint: '{}',
    examples: ['get_title']
  },
  {
    id: 'get_url',
    cli: ['get', 'url'],
    summary: 'Read current page URL.',
    argsHint: '(none)',
    paramsHint: '{}',
    examples: ['get_url']
  },
  {
    id: 'scroll',
    cli: ['scroll'],
    summary: 'Scroll viewport.',
    argsHint: '<up|down|left|right> [pixels]',
    paramsHint: '{ direction, pixels? }',
    examples: ['scroll down 800']
  },
  {
    id: 'screenshot',
    cli: ['screenshot'],
    summary: 'Capture screenshot.',
    argsHint: '[path]',
    paramsHint: '{ path?, flags?, screenshotWaitMs?, autoWaitBeforeScreenshot? }',
    examples: ['screenshot', 'screenshot page.png']
  },
  {
    id: 'eval',
    cli: ['eval'],
    summary: 'Execute JavaScript in the page context.',
    argsHint: '<javascript>',
    paramsHint: '{ javascript }',
    examples: ['eval "document.title"']
  },
  {
    id: 'close',
    cli: ['close'],
    summary: 'Close current browser session.',
    argsHint: '(none)',
    paramsHint: '{}',
    examples: ['close']
  },
  {
    id: 'tab_new',
    cli: ['tab', 'new'],
    summary: 'Open a new tab (and recover stale sessions when needed).',
    argsHint: '(none)',
    paramsHint: '{}',
    examples: ['tab_new']
  }
]

const AGENT_BROWSER_COMMAND_INDEX: Map<string, AgentBrowserCommandSpec> = new Map(
  AGENT_BROWSER_COMMANDS.map((command) => [command.id, command])
)

type AgentBrowserFlagValue = string | number | boolean

interface AgentBrowserUseParams {
  args?: Array<string | number | boolean>
  flags?: Record<string, AgentBrowserFlagValue>
  timeoutMs?: number
  autoPrepareLivePreview?: boolean
  json?: boolean
  session?: string
  headed?: boolean
  url?: string
  selector?: string
  text?: string
  key?: string
  direction?: string
  pixels?: number
  path?: string
  screenshotWaitMs?: number
  autoWaitBeforeScreenshot?: boolean
  javascript?: string
  waitFor?: string | number
  value?: string
  runtimeMode?: AgentBrowserRuntimeMode | string
  liveView?: boolean
  cdpPort?: number
  provider?: AgentBrowserProvider | string
  executablePath?: string
  extraFlags?: Array<string | number | boolean>
}

type AgentBrowserCliRunRequest = {
  command: string
  args: string[]
  timeoutMs: number
  maxOutputChars?: number
  cwd?: string
  env?: Record<string, string>
}

type AgentBrowserCliRunResult = {
  command: string
  args: string[]
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  truncated: boolean
}

let agentBrowserCliRunnerOverride:
  | ((request: AgentBrowserCliRunRequest) => Promise<AgentBrowserCliRunResult>)
  | null = null
const WEB_SEARCH_PROVIDER_ALIASES: Record<string, NativeWebSearchProvider> = {
  duckduckgo: 'duckduckgo-html',
  ddg: 'duckduckgo-html',
  'duckduckgo-html': 'duckduckgo-html',
  exa: 'exa',
  perplexity: 'perplexity'
}
const EXA_SEARCH_TYPE_ALIASES: Record<string, ExaSearchType> = {
  auto: 'auto',
  fast: 'fast',
  neural: 'neural',
  deep: 'deep'
}
const API_KEY_SERVICE_BY_WEB_SEARCH_PROVIDER: Partial<Record<NativeWebSearchProvider, string>> = {
  exa: 'exa',
  perplexity: 'perplexity'
}
type WebSearchProviderResolution = {
  requestedProvider: NativeWebSearchProvider | null
  agentDefaultProvider: NativeWebSearchProvider | null
  adminDefaultProvider: NativeWebSearchProvider | null
  resolvedProvider: NativeWebSearchProvider
  fallbackReason?: string
}

const DANGEROUS_BASH_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(\s|$)/i, reason: 'Destructive root deletion is blocked.' },
  { pattern: /\bmkfs(\.| )/i, reason: 'Disk formatting commands are blocked.' },
  { pattern: /\bdd\s+if=.*of=\/dev\//i, reason: 'Raw disk write commands are blocked.' },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: 'Host power commands are blocked.' },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\};:/, reason: 'Fork bomb patterns are blocked.' },
  { pattern: /\b(sudo|doas)\b/i, reason: 'Privilege escalation commands are blocked.' },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i, reason: 'Piped remote shell execution is blocked.' }
]
const PYTHON_VERSION_MUTATION_REGEXES = [
  /\bbrew\s+(?:install|upgrade|reinstall)\s+python(?:@[\d.]+)?\b/i,
  /\bpyenv\s+global\b/i,
  /\basdf\s+global\s+python\b/i
]
const PYTHON_PACKAGE_MUTATION_REGEXES = [
  /\bpip3?\s+(?:install|uninstall)\b/i,
  /\bpython(?:3(?:\.\d+)?)?\s+-m\s+pip\s+(?:install|uninstall)\b/i
]
const ISOLATED_PYTHON_PACKAGE_HINT_REGEXES = [
  /(?:^|\s)(?:source\s+\S*\/(?:\.venv|venv)\/bin\/activate)(?:\s|$)/i,
  /\/(?:\.venv|venv)\/bin\/(?:pip|python)\b/i,
  /\buv\s+pip\b[\s\S]*\s--python\s+\S+/i,
  /\bpip3?\b[\s\S]*\s--target\s+\S+/i,
  /\bpip3?\b[\s\S]*\s--prefix\s+\S+/i,
  /\bpython(?:3(?:\.\d+)?)?\s+-m\s+pip\b[\s\S]*\s--target\s+\S+/i,
  /\bpython(?:3(?:\.\d+)?)?\s+-m\s+pip\b[\s\S]*\s--prefix\s+\S+/i
]

const SAFE_BASH_COMMAND_ALLOW_LIST = [
  /^\s*(pwd|ls|find|tree|cat|sed|head|tail|rg|grep|diff|wc|stat|file|echo|printf|which|whereis|git\s+status|git\s+diff|git\s+show|git\s+log)(\s|$)/i
]
const AGENT_BROWSER_BASH_AUTO_ALLOW_PATTERNS = [
  're:^\\s*agent-browser\\b',
  're:^\\s*npx\\s+(?:-y\\s+)?agent-browser\\b'
]
const AGENT_BROWSER_BASH_CHAIN_OPERATOR_REGEX = /\s(?:&&|\|\||;)\s/
const AGENT_BROWSER_BASH_FLAGS_WITH_VALUE = new Set([
  '--cdp',
  '--provider',
  '-p',
  '--executable-path',
  '--session',
  '--profile'
])

type AgentBrowserBashCommandParts = {
  assignmentPrefix: string
  launcher: string
  rest: string
}

const BASH_ACCESS_MODE_ALIASES: Record<string, NativeBashAccessMode> = {
  plan: 'plan',
  read_only: 'plan',
  readonly: 'plan',
  agent: 'agent',
  workspace: 'agent',
  dangerous: 'dangerous',
  unrestricted: 'dangerous'
}

const DEFAULT_BASH_ACCESS_MODE: NativeBashAccessMode = 'agent'

interface ManagedApplyPatchExecutionResult {
  success: boolean
  operationsApplied: number
  touchedPaths: string[]
  message?: string
}

const SUBAGENT_NATIVE_TOOLS_BLOCKED_OVERRIDE_KEYS = new Set([
  'fetchZipEnabled',
  'nativeFetchZipEnabled',
  'executionBackend',
  'nativeExecutionBackend',
  'bashExecutionBackend',
  'nativeBashExecutionBackend'
])

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false
  }
  return undefined
}

function parseInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalized = value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry.length > 0)
  return normalized.length > 0 ? Array.from(new Set(normalized)) : []
}

function normalizeSkillScriptArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_SKILL_SCRIPT_ARGS)
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeBatshitToolFamily(value: unknown): BatshitToolFamily | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  switch (normalized) {
    case 'mcp':
    case 'dynamic':
    case 'dynamic_mcp':
    case 'gateway':
    case 'gateway_tool':
      return 'mcp'
    case 'cli':
    case 'cli_tool':
    case 'cli_tools':
    case 'tool':
    case 'tools':
      return 'cli'
    case 'artifact':
    case 'artifacts':
    case 'artifact_runtime':
      return 'artifact'
    case 'fabric':
    case 'control':
    case 'controls':
    case 'batshit':
    case 'batshit_tool':
    case 'batshit_tools':
      return 'fabric'
    case 'agent_browser':
    case 'agentbrowser':
    case 'browser':
    case 'ab':
      return 'agent_browser'
    default:
      return null
  }
}

function normalizeBatshitToolSchemaMode(input: {
  schemaMode?: unknown
  includeSchema?: unknown
}): BatshitToolSchemaMode {
  if (input.includeSchema === true) return 'full'
  if (typeof input.schemaMode === 'string') {
    const normalized = input.schemaMode.trim().toLowerCase()
    if (normalized === 'full' || normalized === 'compact' || normalized === 'none') {
      return normalized
    }
  }
  return 'compact'
}

function resolveBatshitToolSearchFamilies(input: {
  family?: unknown
  families?: unknown
  allowedFamilies: BatshitToolFamily[]
}): {
  families: BatshitToolFamily[]
  unavailableFamilies: Array<{ family: BatshitToolFamily; reason: string }>
} {
  const requested = new Set<BatshitToolFamily>()
  const singleFamily = normalizeBatshitToolFamily(input.family)
  if (singleFamily) requested.add(singleFamily)
  if (Array.isArray(input.families)) {
    for (const entry of input.families) {
      const family = normalizeBatshitToolFamily(entry)
      if (family) requested.add(family)
    }
  }

  const allowed = new Set(input.allowedFamilies)
  const sourceFamilies = requested.size > 0 ? Array.from(requested) : input.allowedFamilies
  const unavailableFamilies: Array<{ family: BatshitToolFamily; reason: string }> = []
  const families = sourceFamilies.filter((family) => {
    if (allowed.has(family)) return true
    unavailableFamilies.push({
      family,
      reason: `${BATSHIT_TOOL_FAMILY_LABELS[family]} tools are not enabled for this actor/runtime.`
    })
    return false
  })

  return { families, unavailableFamilies }
}

export function parseBatshitToolRef(ref: string): { family: BatshitToolFamily; target: string } {
  const trimmed = typeof ref === 'string' ? ref.trim() : ''
  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(
      'Invalid Batshit tool ref. Expected an exact typed ref such as mcp:tool_name, cli:tool_id, artifact:use.artifact.slug, fabric:sys.artifact.apply_patch, or agent_browser:open.'
    )
  }
  const family = normalizeBatshitToolFamily(trimmed.slice(0, separatorIndex))
  const target = trimmed.slice(separatorIndex + 1).trim()
  if (!family || !target) {
    throw new Error(
      'Invalid Batshit tool ref. The ref must start with mcp:, cli:, artifact:, fabric:, or agent_browser: and include a non-empty target.'
    )
  }
  return { family, target }
}

function buildBatshitToolRef(family: BatshitToolFamily, target: string): string {
  return `${family}:${target}`
}

function stringifyForCompactHint(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value ?? '')
  }
}

function schemaTypeLabel(schema: Record<string, any> | undefined): string {
  if (!schema || typeof schema !== 'object') return 'value'
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((entry) => stringifyForCompactHint(entry)).join(' | ')
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf
      .map((entry: unknown) => schemaTypeLabel(entry as Record<string, any>))
      .filter(Boolean)
      .join(' | ')
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf
      .map((entry: unknown) => schemaTypeLabel(entry as Record<string, any>))
      .filter(Boolean)
      .join(' | ')
  }
  if (schema.type === 'array') {
    return `array<${schemaTypeLabel(schema.items as Record<string, any> | undefined)}>`
  }
  return typeof schema.type === 'string' ? schema.type : 'value'
}

function buildCompactJsonSchemaHint(inputSchema: unknown): string | undefined {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) return undefined
  const schema = inputSchema as Record<string, any>
  const properties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, any>)
      : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((entry: unknown): entry is string => typeof entry === 'string')
      : []
  )
  const fields = Object.entries(properties).slice(0, 8).map(([fieldName, field]) => {
    const fieldSchema = field && typeof field === 'object' ? (field as Record<string, any>) : {}
    const requiredMarker = required.has(fieldName) ? 'required' : 'optional'
    return `${fieldName}: ${schemaTypeLabel(fieldSchema)} ${requiredMarker}`
  })
  if (fields.length === 0) {
    return schema.type === 'object'
      ? 'input: object; use schemaMode="full" if the fields are unclear.'
      : undefined
  }
  const suffix = Object.keys(properties).length > fields.length ? ', ...' : ''
  return `input: { ${fields.join(', ')}${suffix} }`
}

function normalizeBatshitToolUsePayload(input: BatshitToolUseInput): Record<string, any> {
  const knownKeys = new Set([
    'ref',
    'input',
    'params',
    'allowRisky',
    'allow_risky',
    'dryRun',
    'dry_run',
    'selectedGateways',
    'selected_gateways',
    'selectedToolIds',
    'selected_tool_ids',
    'selectedCliToolIds',
    'selected_cli_tool_ids',
    'userId',
    'agentId',
    'agentMetadata',
    'sessionId',
    'dcmDisplaySettings',
    'projectPath',
    'allowedFamilies',
    'runtimeMode',
    'fabricAllowedControlIds',
    'executionBackend',
    'execution_backend',
    'agentBrowserSettings',
    'gatewayToolsCache',
    'executeControlUse'
  ])
  const topLevel = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !knownKeys.has(key) && value !== undefined)
  )
  const params =
    input.params && typeof input.params === 'object' && !Array.isArray(input.params)
      ? input.params
      : {}
  const nested =
    input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? input.input
      : {}
  return {
    ...topLevel,
    ...params,
    ...nested
  }
}

function buildSkillPathListForModelOutput(paths: string[]): string {
  if (paths.length === 0) return '- none'
  const visible = paths.slice(0, MAX_SKILL_PREVIEW_ITEMS)
  const lines = visible.map((entry) => `- ${entry}`)
  if (paths.length > visible.length) {
    lines.push(`- ... +${paths.length - visible.length} more`)
  }
  return lines.join('\n')
}

const NATIVE_SKILL_TOOL_ACTIONS = [
  'invoke',
  'list',
  'read',
  'script_list',
  'script_read',
  'script_run'
] as const
type NativeSkillToolAction = (typeof NATIVE_SKILL_TOOL_ACTIONS)[number]

function normalizeNativeSkillToolAction(value: unknown): NativeSkillToolAction {
  if (typeof value !== 'string') return 'invoke'
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  switch (normalized) {
    case 'invoke':
    case 'list':
    case 'read':
    case 'script_list':
    case 'script_read':
    case 'script_run':
      return normalized
    case 'scripts':
    case 'list_scripts':
      return 'script_list'
    case 'read_script':
      return 'script_read'
    case 'run':
    case 'run_script':
      return 'script_run'
    default:
      return 'invoke'
  }
}

function normalizeCommandPatternList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return normalizeStringArray(value)
  if (typeof value === 'string') {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.length > 0 ? Array.from(new Set(lines)) : []
  }
  return undefined
}

function mergeCommandPatternLists(
  ...lists: Array<readonly string[] | undefined | null>
): string[] | undefined {
  const merged = lists
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  return merged.length > 0 ? Array.from(new Set(merged)) : undefined
}

function firstNonEmptyLine(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? null
  )
}

function summarizeNativeBashExecutionFailure(result: Record<string, any>): string {
  const stderrLine = firstNonEmptyLine(result.stderr)
  if (stderrLine) return `Bash command failed: ${stderrLine}`

  const stdoutLine = firstNonEmptyLine(result.stdout)
  if (stdoutLine) return `Bash command failed: ${stdoutLine}`

  if (result.timedOut === true) return 'Bash command timed out.'
  if (typeof result.exitCode === 'number') {
    return `Bash command failed with exit code ${result.exitCode}.`
  }
  return 'Bash command failed.'
}

function isNativeBashCommandRunFailure(result: Record<string, any>): boolean {
  return (
    result.blocked !== true &&
    typeof result.errorCode !== 'string' &&
    ('exitCode' in result || result.timedOut === true || 'stdout' in result || 'stderr' in result)
  )
}

function isShellIdentifierStart(char: string): boolean {
  return (
    (char >= 'A' && char <= 'Z') ||
    (char >= 'a' && char <= 'z') ||
    char === '_'
  )
}

function isShellIdentifierChar(char: string): boolean {
  return isShellIdentifierStart(char) || (char >= '0' && char <= '9')
}

function skipShellWhitespace(value: string, start: number): number {
  let index = start
  while (index < value.length && /\s/.test(value[index] ?? '')) index += 1
  return index
}

function readShellTokenSpan(
  value: string,
  start: number
): { token: string; start: number; end: number } | null {
  const tokenStart = skipShellWhitespace(value, start)
  if (tokenStart >= value.length) return null

  let index = tokenStart
  let quote: string | null = null
  while (index < value.length) {
    const char = value[index] ?? ''
    if (quote) {
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      index += 1
      continue
    }
    if (/\s/.test(char)) break
    index += 1
  }

  return {
    token: unquoteShellToken(value.slice(tokenStart, index)),
    start: tokenStart,
    end: index
  }
}

function isEnvironmentAssignmentToken(token: string): boolean {
  const equalsIndex = token.indexOf('=')
  if (equalsIndex <= 0) return false
  const name = token.slice(0, equalsIndex)
  if (!isShellIdentifierStart(name[0] ?? '')) return false
  for (const char of name.slice(1)) {
    if (!isShellIdentifierChar(char)) return false
  }
  return true
}

function parseAgentBrowserBashCommand(command: string): AgentBrowserBashCommandParts | null {
  let index = 0
  let assignmentEnd = 0

  while (index < command.length) {
    const token = readShellTokenSpan(command, index)
    if (!token) return null
    if (!isEnvironmentAssignmentToken(token.token)) break
    assignmentEnd = token.end
    index = token.end
  }

  const launcherStartToken = readShellTokenSpan(command, index)
  if (!launcherStartToken) return null

  let launcherEnd = launcherStartToken.end
  if (launcherStartToken.token.toLowerCase() === 'npx') {
    let nextToken = readShellTokenSpan(command, launcherEnd)
    if (nextToken?.token === '-y') {
      launcherEnd = nextToken.end
      nextToken = readShellTokenSpan(command, launcherEnd)
    }
    if (nextToken?.token.toLowerCase() !== 'agent-browser') return null
    launcherEnd = nextToken.end
  } else if (launcherStartToken.token.toLowerCase() !== 'agent-browser') {
    return null
  }

  return {
    assignmentPrefix: command.slice(0, assignmentEnd).trim(),
    launcher: command.slice(launcherStartToken.start, launcherEnd).trim(),
    rest: command.slice(launcherEnd).trim()
  }
}

function isLikelyAgentBrowserBashCommand(command: string): boolean {
  return parseAgentBrowserBashCommand(command) !== null
}

function hasAgentBrowserFlag(command: string, flagPattern: RegExp): boolean {
  return flagPattern.test(command)
}

function unquoteShellToken(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function splitShellWords(value: string): string[] {
  const tokens = value.match(/'[^']*'|"[^"]*"|\S+/g) ?? []
  return tokens.map((token) => unquoteShellToken(token)).filter((token) => token.length > 0)
}

function splitAgentBrowserExtraFlags(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) return []
  return values.flatMap((entry) => splitShellWords(entry))
}

function shellEscape(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function splitAgentBrowserCommandAtChain(commandSegment: string): {
  primary: string
  suffix: string
} {
  const trimmed = commandSegment.trim()
  if (!trimmed) {
    return { primary: '', suffix: '' }
  }

  const match = AGENT_BROWSER_BASH_CHAIN_OPERATOR_REGEX.exec(trimmed)
  if (!match || typeof match.index !== 'number' || match.index <= 0) {
    return { primary: trimmed, suffix: '' }
  }

  return {
    primary: trimmed.slice(0, match.index).trim(),
    suffix: trimmed.slice(match.index).trim()
  }
}

function findAgentBrowserSubcommandIndex(tokens: string[]): number {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token) return -1

    if (token === '--') {
      return index + 1 < tokens.length ? index + 1 : -1
    }

    if (token.startsWith('--')) {
      const [flag] = token.split('=', 1)
      if (AGENT_BROWSER_BASH_FLAGS_WITH_VALUE.has(flag) && !token.includes('=')) {
        index += 2
      } else {
        index += 1
      }
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      if (token === '-p') {
        index += 2
      } else {
        index += 1
      }
      continue
    }

    return index
  }

  return -1
}

function parseAgentBrowserBashScreenshotCommand(command: string): {
  isScreenshot: boolean
  hasExplicitPath: boolean
  screenshotPathToken: string | null
  tokens: string[]
} {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) {
    return {
      isScreenshot: false,
      hasExplicitPath: false,
      screenshotPathToken: null,
      tokens: []
    }
  }

  const rest = parsedCommand.rest
  if (!rest) {
    return {
      isScreenshot: false,
      hasExplicitPath: false,
      screenshotPathToken: null,
      tokens: []
    }
  }

  const { primary } = splitAgentBrowserCommandAtChain(rest)
  const tokens = splitShellWords(primary)
  if (tokens.length === 0) {
    return {
      isScreenshot: false,
      hasExplicitPath: false,
      screenshotPathToken: null,
      tokens
    }
  }

  const subcommandIndex = findAgentBrowserSubcommandIndex(tokens)
  if (subcommandIndex < 0) {
    return {
      isScreenshot: false,
      hasExplicitPath: false,
      screenshotPathToken: null,
      tokens
    }
  }

  const subcommand = tokens[subcommandIndex]?.toLowerCase()
  if (subcommand !== 'screenshot') {
    return {
      isScreenshot: false,
      hasExplicitPath: false,
      screenshotPathToken: null,
      tokens
    }
  }

  let screenshotPathToken: string | null = null
  for (let i = subcommandIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    if (token === '--') {
      screenshotPathToken = i + 1 < tokens.length ? tokens[i + 1] : null
      break
    }
    if (token.startsWith('-')) continue
    screenshotPathToken = token
    break
  }

  return {
    isScreenshot: true,
    hasExplicitPath: Boolean(screenshotPathToken),
    screenshotPathToken,
    tokens
  }
}

function resolveAgentBrowserBashScreenshotPath(command: string, cwd: string): string | null {
  const parsed = parseAgentBrowserBashScreenshotCommand(command)
  if (!parsed.isScreenshot || !parsed.screenshotPathToken) return null

  const rawPath = parsed.screenshotPathToken.trim()
  if (!rawPath) return null
  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) return null

  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath)
}

async function injectAgentBrowserBashScreenshotPath(command: string): Promise<{
  command: string
  injectedPath: string | null
}> {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) {
    return {
      command,
      injectedPath: null
    }
  }

  const { assignmentPrefix, launcher, rest } = parsedCommand
  if (!rest) {
    return {
      command,
      injectedPath: null
    }
  }

  const { primary, suffix } = splitAgentBrowserCommandAtChain(rest)
  const parsed = parseAgentBrowserBashScreenshotCommand(`${launcher} ${primary}`.trim())
  if (!parsed.isScreenshot || parsed.hasExplicitPath) {
    return {
      command,
      injectedPath: null
    }
  }

  const generatedPath = await buildDefaultAgentBrowserScreenshotPath()
  const rebuiltPrimary = [...parsed.tokens, generatedPath].map((token) => shellEscape(token)).join(' ')
  const rebuiltRest = suffix ? `${rebuiltPrimary} ${suffix}` : rebuiltPrimary
  const rebuiltParts: string[] = []
  if (assignmentPrefix.length > 0) rebuiltParts.push(assignmentPrefix)
  rebuiltParts.push(launcher, rebuiltRest)

  return {
    command: rebuiltParts.join(' ').trim(),
    injectedPath: generatedPath
  }
}

function resolveAgentBrowserBashScreenshotModelPayload(output: any): {
  modelImageUrl: string | null
  screenshotPath: string | null
  mediaType: string
} | null {
  if (!output || typeof output !== 'object') return null
  const agentBrowser = normalizeRecord((output as any).agentBrowser)
  const screenshot = normalizeRecord(agentBrowser.screenshot)
  const command = normalizeAgentBrowserToolName(
    typeof screenshot.command === 'string'
      ? screenshot.command
      : typeof agentBrowser.command === 'string'
        ? agentBrowser.command
        : ''
  )
  if (command !== 'screenshot') return null

  const modelImageUrl =
    typeof screenshot.modelImageUrl === 'string' && screenshot.modelImageUrl.trim().length > 0
      ? screenshot.modelImageUrl.trim()
      : typeof (output as any).modelImageUrl === 'string' && (output as any).modelImageUrl.trim().length > 0
        ? (output as any).modelImageUrl.trim()
        : null

  const screenshotPath =
    typeof screenshot.path === 'string' && screenshot.path.trim().length > 0
      ? path.resolve(screenshot.path.trim())
      : null

  const mediaType =
    (typeof screenshot.mediaType === 'string' && screenshot.mediaType.trim().length > 0
      ? screenshot.mediaType.trim()
      : inferImageMediaTypeFromPath(screenshotPath || '') || 'image/png')

  return {
    modelImageUrl,
    screenshotPath,
    mediaType
  }
}

async function buildAgentBrowserBashScreenshotModelOutput(
  output: any
): Promise<
  | {
      type: 'content'
      value: Array<
        | {
            type: 'image-url'
            url: string
          }
        | {
            type: 'image-data'
            data: string
            mediaType: string
          }
      >
    }
  | null
> {
  const payload = resolveAgentBrowserBashScreenshotModelPayload(output)
  if (!payload) return null

  if (payload.modelImageUrl) {
    return {
      type: 'content',
      value: [
        {
          type: 'image-url',
          url: payload.modelImageUrl
        }
      ]
    }
  }

  if (!payload.screenshotPath) return null

  try {
    const bytes = await readFileWithinLimit(
      payload.screenshotPath,
      MAX_AGENT_BROWSER_SCREENSHOT_BYTES
    )
    if (!bytes) return null
    return {
      type: 'content',
      value: [
        {
          type: 'image-data',
          data: bytes.toString('base64'),
          mediaType: payload.mediaType
        }
      ]
    }
  } catch {
    return null
  } finally {
    await cleanupAgentBrowserScreenshotFile(payload.screenshotPath)
  }
}

function normalizeOptionalAgentBrowserExecutablePath(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeOptionalAgentBrowserSetting(value: string | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function applyAgentBrowserBashDefaults(
  command: string,
  settings: AgentBrowserBashSettings
): {
  command: string
  provider: AgentBrowserProvider
  runtimeMode: AgentBrowserRuntimeMode
  appliedDefaults: string[]
  matched: boolean
} {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) {
    return {
      command,
      provider: settings.provider,
      runtimeMode: settings.runtimeMode,
      appliedDefaults: [],
      matched: false
    }
  }

  const { assignmentPrefix, launcher, rest } = parsedCommand
  const restLower = rest.toLowerCase()
  const appliedDefaults: string[] = []
  const injectedTokens: string[] = []

  const hasProviderFlag =
    hasAgentBrowserFlag(rest, /(?:^|\s)--provider(?:\s+|=)/i) ||
    hasAgentBrowserFlag(rest, /(?:^|\s)-p(?:\s+|=)/i)
  const hasCdpFlag = hasAgentBrowserFlag(rest, /(?:^|\s)--cdp(?:\s+|=)/i)
  const hasHeadedFlag = hasAgentBrowserFlag(rest, /(?:^|\s)--headed(?:\s|$)/i)
  const hasExecutableFlag = hasAgentBrowserFlag(rest, /(?:^|\s)--executable-path(?:\s+|=)/i)
  const hasSessionFlag = hasAgentBrowserFlag(rest, /(?:^|\s)--session(?:\s+|=)/i)
  const hasProfileFlag = hasAgentBrowserFlag(rest, /(?:^|\s)--profile(?:\s+|=)/i)
  const isConnectCommand = /^(connect)(\s|$)/i.test(restLower)

  if (settings.runtimeMode === 'chrome-cdp' && !hasCdpFlag && !isConnectCommand) {
    injectedTokens.push('--cdp', `http://127.0.0.1:${settings.cdpPort}`)
    appliedDefaults.push('runtime')
  }

  if (!hasProviderFlag && settings.provider !== 'local') {
    injectedTokens.push('-p', settings.provider)
    appliedDefaults.push('provider')
  }

  if (settings.liveViewEnabled && !hasHeadedFlag) {
    injectedTokens.push('--headed')
    appliedDefaults.push('liveView')
  }

  const session = normalizeOptionalAgentBrowserSetting(settings.session)
  if (session && !hasSessionFlag) {
    injectedTokens.push('--session', session)
    appliedDefaults.push('session')
  }

  const profilePath = normalizeOptionalAgentBrowserSetting(settings.profilePath)
  if (profilePath && !hasProfileFlag) {
    injectedTokens.push('--profile', profilePath)
    appliedDefaults.push('profile')
  }

  const executablePath = normalizeOptionalAgentBrowserExecutablePath(settings.executablePath)
  if (executablePath && !hasExecutableFlag) {
    injectedTokens.push('--executable-path', executablePath)
    appliedDefaults.push('executablePath')
  }

  const extraFlagTokens = splitAgentBrowserExtraFlags(settings.extraFlags)
  if (extraFlagTokens.length > 0) {
    injectedTokens.push(...extraFlagTokens)
    appliedDefaults.push('extraFlags')
  }

  const commandParts: string[] = []
  if (assignmentPrefix.length > 0) commandParts.push(assignmentPrefix)
  commandParts.push(launcher)

  if (injectedTokens.length > 0) {
    commandParts.push(...injectedTokens.map((token) => shellEscape(token)))
  }

  if (rest.length > 0) commandParts.push(rest)

  const providerFromCommand = resolveAgentBrowserProviderFromCommand(commandParts.join(' '), settings.provider)

  return {
    command: commandParts.join(' ').trim(),
    provider: providerFromCommand,
    runtimeMode: settings.runtimeMode,
    appliedDefaults,
    matched: true
  }
}

function resolveAgentBrowserProviderFromCommand(
  command: string,
  fallback: AgentBrowserProvider
): AgentBrowserProvider {
  const providerMatch =
    command.match(/(?:^|\s)--provider(?:\s+|=)("[^"]+"|'[^']+'|[^\s]+)/i) ??
    command.match(/(?:^|\s)-p(?:\s+|=)("[^"]+"|'[^']+'|[^\s]+)/i)

  if (!providerMatch?.[1]) return fallback
  const normalized = normalizeAgentBrowserProvider(unquoteShellToken(providerMatch[1]))
  return normalized ?? fallback
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return normalizeStringArray(value)
  if (typeof value === 'string') {
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.length > 0 ? Array.from(new Set(lines)) : []
  }
  return undefined
}

function normalizeRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, any>) }
    : {}
}

function normalizeAgentBrowserRuntimeMode(value: unknown): AgentBrowserRuntimeMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return AGENT_BROWSER_RUNTIME_MODE_ALIASES[normalized] ?? null
}

function normalizeAgentBrowserProvider(value: unknown): AgentBrowserProvider | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return AGENT_BROWSER_PROVIDER_ALIASES[normalized] ?? null
}

function normalizeAgentBrowserToolName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^\w]/g, '')
  return AGENT_BROWSER_TOOL_NAME_ALIASES[normalized] ?? normalized
}

function inferImageMediaTypeFromPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  return AGENT_BROWSER_IMAGE_EXT_TO_MEDIA[ext] ?? null
}

function tokenizeSearchTerms(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\w\s]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function scoreAgentBrowserMatch(query: string, command: AgentBrowserCommandSpec): number {
  if (!query) return 1
  const q = query.toLowerCase().trim()
  const haystack = [
    command.id,
    command.id.replace(/_/g, ' '),
    command.summary,
    command.argsHint,
    command.paramsHint,
    ...command.examples
  ]
    .join(' ')
    .toLowerCase()

  if (command.id === q) return 300
  if (command.id.startsWith(q)) return 220
  if (command.id.includes(q)) return 160
  if (haystack.includes(q)) return 80

  // Natural-language query support: score partial token overlap when exact substrings
  // do not match (e.g. "screenshot command", "click button", "page title").
  const queryTokens = tokenizeSearchTerms(q)
  if (queryTokens.length === 0) return 0

  const haystackTokens = new Set(tokenizeSearchTerms(haystack))
  const idTokens = new Set(tokenizeSearchTerms(command.id))
  let matched = 0
  for (const token of queryTokens) {
    if (haystackTokens.has(token) || idTokens.has(token)) {
      matched += 1
    }
  }

  if (matched === queryTokens.length) return 60 + matched
  if (matched > 0) return 25 + matched
  return 0
}

function toAgentBrowserArgArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim()
      if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry)
      return ''
    })
    .filter((entry) => entry.length > 0)
}

function buildAgentBrowserFlagArgs(flags: Record<string, AgentBrowserFlagValue> | undefined): string[] {
  if (!flags || typeof flags !== 'object') return []
  const args: string[] = []
  for (const [rawKey, rawValue] of Object.entries(flags)) {
    const key = rawKey.trim()
    if (!key) continue
    const flag = key.startsWith('--') ? key : `--${key}`

    if (typeof rawValue === 'boolean') {
      if (rawValue) args.push(flag)
      continue
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      args.push(flag, String(rawValue))
      continue
    }

    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      args.push(flag, rawValue)
    }
  }
  return args
}

function normalizeWebSearchProvider(value: unknown): NativeWebSearchProvider | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return WEB_SEARCH_PROVIDER_ALIASES[normalized] ?? null
}

function normalizeExaSearchType(value: unknown): ExaSearchType | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return EXA_SEARCH_TYPE_ALIASES[normalized] ?? null
}

function normalizeBashAccessMode(value: unknown): NativeBashAccessMode | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (!normalized) return null
  return BASH_ACCESS_MODE_ALIASES[normalized] ?? null
}

function toLegacyBashPolicyMode(mode: NativeBashAccessMode): LegacyNativeToolPolicyMode {
  return mode === 'plan' ? 'read_only' : 'workspace'
}

function parseCommandPattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('re:')) {
    try {
      return new RegExp(trimmed.slice(3).trim(), 'i')
    } catch {
      return null
    }
  }

  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/')
    const source = trimmed.slice(1, lastSlash)
    const flags = trimmed.slice(lastSlash + 1)
    try {
      return new RegExp(source, flags || 'i')
    } catch {
      return null
    }
  }

  const escaped = trimmed
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*')
  return new RegExp(`^\\s*${escaped}(\\s|$)`, 'i')
}

function commandMatchesPattern(command: string, pattern: string): boolean {
  const regex = parseCommandPattern(pattern)
  if (!regex) return false
  return regex.test(command)
}

function commandMatchesAnyPattern(command: string, patterns?: string[] | null): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pattern) => commandMatchesPattern(command, pattern))
}

function getPythonSafetyViolationReason(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null

  for (const pattern of PYTHON_VERSION_MUTATION_REGEXES) {
    if (pattern.test(trimmed)) {
      return 'Changing the machine Python installation is blocked. Use an engine-local runtime instead.'
    }
  }

  const mutatesPythonPackages = PYTHON_PACKAGE_MUTATION_REGEXES.some((pattern) =>
    pattern.test(trimmed)
  )
  if (!mutatesPythonPackages) return null
  if (/\s--dry-run(?:\s|$)/i.test(trimmed)) return null
  const usesIsolation = ISOLATED_PYTHON_PACKAGE_HINT_REGEXES.some((pattern) =>
    pattern.test(trimmed)
  )
  if (usesIsolation) return null

  return 'Global Python package mutation is blocked. Create or target an isolated environment first (for example `~/.batshit/installs/<engine-id>/.venv`).'
}

function isMarkdownPath(filePath: string | undefined | null): boolean {
  if (!filePath) return false
  return /\.md$/i.test(filePath.trim())
}

const PROTECTED_SYSTEM_SKILL_PATH_SEGMENTS = [
  '/batshit-app/src/lib/server/system-skills/',
  '/src/lib/server/system-skills/'
]

function getSystemSkillRuntimeRoot(): string {
  return path.join(os.homedir(), '.batshit', 'skills')
}

function normalizeSystemSkillRuntimeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/[-_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function isPathWithinResolvedRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

const protectedRepoRootWalkCache = new Map<string, string[]>()

function collectBatshitRepoRootsFrom(startPath: string): string[] {
  const start = path.resolve(startPath)
  const cached = protectedRepoRootWalkCache.get(start)
  if (cached) return cached

  const roots: string[] = []
  let current = start
  while (true) {
    if (
      existsSync(path.join(current, 'batshit-app')) &&
      existsSync(path.join(current, 'batshit-server'))
    ) {
      roots.push(current.replace(/\\/g, '/'))
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  protectedRepoRootWalkCache.set(start, roots)
  return roots
}

function resolveProtectedBatshitRepoRoots(seedPaths: Array<string | null | undefined> = []): string[] {
  // Walk every start point all the way up: the packaged Mac app runs from deep
  // inside the .app bundle, so a fixed two-level walk missed the real source repo.
  const startPoints = [
    ...seedPaths.filter((value): value is string => typeof value === 'string' && value.trim().length > 0),
    process.cwd()
  ]

  const roots = new Set<string>()
  for (const startPoint of startPoints) {
    for (const rootPath of collectBatshitRepoRootsFrom(startPoint)) {
      roots.add(rootPath)
    }
  }

  const extraRoots = (process.env.BATSHIT_PROTECTED_WRITE_PATHS || '')
    .split(':')
    .map((value) => value.trim())
    .filter(Boolean)
  for (const extraRoot of extraRoots) {
    roots.add(path.resolve(extraRoot).replace(/\\/g, '/'))
  }

  return Array.from(roots)
}

// Repo areas that hold runtime/dev-only data (gitignored), not product source.
const PROTECTED_REPO_WRITABLE_SUBPATHS = ['_local', 'logs']

function isWithinWritableRepoSubpath(targetPath: string, rootPath: string): boolean {
  return PROTECTED_REPO_WRITABLE_SUBPATHS.some((subpath) =>
    isPathWithinResolvedRoot(targetPath, path.join(rootPath, subpath).replace(/\\/g, '/'))
  )
}

function stripFdRedirections(command: string): string {
  return command.replace(/\d*>&\d*/g, ' ')
}

const PROTECTED_WRITE_SHAPED_REGEXES: RegExp[] = [
  /(?:^|[^<>])>{1,2}/,
  /\b(?:rm|mv|cp|tee|touch|truncate|unlink|ln|rsync|dd|install)\b/i,
  /\bsed\b[^|;&]*\s-i\b/i,
  /\bperl\b[^|;&]*\s-i\b/i,
  /\b(?:chmod|chown|chgrp|mkdir|rmdir)\b/i,
  /\bgit\s+(?:apply|checkout|restore|clean|reset|stash|am|cherry-pick|merge|rebase|pull|mv|rm|commit)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci|add|remove|rm|update|upgrade|link)\b/i
]

function commandLooksWriteShaped(command: string): boolean {
  const sanitized = stripFdRedirections(command)
  return PROTECTED_WRITE_SHAPED_REGEXES.some((pattern) => pattern.test(sanitized))
}

const SHELL_WRITE_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'tee', 'touch', 'truncate', 'unlink', 'ln', 'rsync', 'install',
  'mkdir', 'rmdir', 'chmod', 'chown', 'chgrp'
])
const PACKAGE_MANAGER_COMMANDS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_MANAGER_WRITE_SUBCOMMANDS = new Set(['install', 'ci', 'add', 'remove', 'rm', 'update', 'upgrade', 'link'])
const GIT_WRITE_SUBCOMMANDS = new Set([
  'apply', 'checkout', 'restore', 'clean', 'reset', 'stash', 'am', 'cherry-pick',
  'merge', 'rebase', 'pull', 'mv', 'rm', 'commit'
])

function stripWrappingQuotes(token: string): string {
  return token.replace(/^['"`]+|['"`]+$/g, '')
}

function extractCandidateShellWriteTargets(command: string): string[] {
  let analysisText = stripFdRedirections(command)
  // Heredoc bodies are file content, not commands — analyze only up to the marker line.
  const heredocMatch = analysisText.match(/<<-?\s*['"\\]?[A-Za-z_][A-Za-z0-9_]*['"]?/)
  if (heredocMatch && heredocMatch.index !== undefined) {
    const newlineIndex = analysisText.indexOf('\n', heredocMatch.index)
    if (newlineIndex !== -1) analysisText = analysisText.slice(0, newlineIndex)
  }

  const targets: string[] = []

  const redirectPattern = />{1,2}\s*("[^"]+"|'[^']+'|[^\s;|&<>]+)/g
  let redirectMatch: RegExpExecArray | null
  while ((redirectMatch = redirectPattern.exec(analysisText))) {
    targets.push(stripWrappingQuotes(redirectMatch[1]))
  }

  for (const rawSegment of analysisText.split(/[\n;|&]+/)) {
    const tokens = rawSegment.trim().split(/\s+/).map(stripWrappingQuotes).filter(Boolean)
    if (tokens.length === 0) continue

    let commandIndex = 0
    while (commandIndex < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex])) {
      commandIndex += 1
    }
    const commandName = (tokens[commandIndex] ?? '').toLowerCase()
    const args = tokens.slice(commandIndex + 1)
    const positional = args.filter((token) => !token.startsWith('-'))

    if (SHELL_WRITE_COMMANDS.has(commandName)) {
      if (commandName === 'cp') {
        if (positional.length > 0) targets.push(positional[positional.length - 1])
      } else {
        targets.push(...positional)
      }
      continue
    }

    if ((commandName === 'sed' || commandName === 'perl') && args.some((token) => token.startsWith('-i'))) {
      targets.push(...positional.slice(1))
      continue
    }

    if (commandName === 'dd') {
      for (const token of args) {
        if (token.startsWith('of=')) targets.push(token.slice(3))
      }
      continue
    }

    if (commandName === 'git') {
      let gitBase = '.'
      const remainingArgs: string[] = []
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '-C' && args[index + 1]) {
          gitBase = args[index + 1]
          index += 1
          continue
        }
        remainingArgs.push(args[index])
      }
      const subcommand = remainingArgs.find((token) => !token.startsWith('-'))?.toLowerCase()
      if (subcommand && GIT_WRITE_SUBCOMMANDS.has(subcommand)) {
        targets.push(gitBase)
      }
      continue
    }

    if (PACKAGE_MANAGER_COMMANDS.has(commandName)) {
      const subcommand = positional[0]?.toLowerCase()
      if (subcommand && PACKAGE_MANAGER_WRITE_SUBCOMMANDS.has(subcommand)) {
        const prefixIndex = args.indexOf('--prefix')
        targets.push(prefixIndex !== -1 && args[prefixIndex + 1] ? args[prefixIndex + 1] : '.')
      }
      continue
    }
  }

  return targets
}

function findProtectedShellWriteViolationRoot(options: {
  command: string
  cwd: string
  protectedRoots: string[]
}): string | null {
  if (options.protectedRoots.length === 0) return null
  if (!commandLooksWriteShaped(options.command)) return null

  const homeDir = os.homedir()
  for (const candidate of extractCandidateShellWriteTargets(options.command)) {
    const expanded =
      candidate === '~' || candidate.startsWith('~/')
        ? path.join(homeDir, candidate.slice(1))
        : candidate
    const resolved = path.resolve(options.cwd, expanded).replace(/\\/g, '/')
    for (const rootPath of options.protectedRoots) {
      if (
        isPathWithinResolvedRoot(resolved, rootPath) &&
        !isWithinWritableRepoSubpath(resolved, rootPath)
      ) {
        return rootPath
      }
    }
  }

  return null
}

function resolveProtectedSystemSkillCacheRoots(seedPaths: Array<string | null | undefined> = []): string[] {
  const protectedRepoRoots = resolveProtectedBatshitRepoRoots(seedPaths)
  const runtimeRoot = getSystemSkillRuntimeRoot().replace(/\\/g, '/')
  const roots = new Set<string>()

  for (const repoRoot of protectedRepoRoots) {
    const systemSkillsRoot = path.join(repoRoot, 'batshit-app', 'src', 'lib', 'server', 'system-skills')
    if (!existsSync(systemSkillsRoot)) continue

    for (const entry of readdirSync(systemSkillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue

      const candidates = new Set<string>([
        entry.name,
        normalizeSystemSkillRuntimeId(entry.name)
      ])

      for (const candidate of candidates) {
        if (!candidate.trim()) continue
        roots.add(path.join(runtimeRoot, candidate).replace(/\\/g, '/'))
      }
    }
  }

  return Array.from(roots)
}

function resolveMappedPath(mapping: ReturnType<typeof mapBashCommandToRendererTool>): string | null {
  if (typeof mapping.args?.filePath === 'string') return mapping.args.filePath
  if (typeof mapping.args?.path === 'string') return mapping.args.path
  return null
}

async function captureMappedTextFileSnapshot(options: {
  mapping: ReturnType<typeof mapBashCommandToRendererTool>
  cwd: string
  workspaceRoot: string
}): Promise<string | null> {
  if (options.mapping.toolName !== 'batshit_server_edit_file') return null

  const mappedPath = resolveMappedPath(options.mapping)
  if (!mappedPath?.trim()) return null

  const resolvedRoot = path.resolve(options.workspaceRoot)
  const absolutePath = path.resolve(options.cwd, mappedPath)
  const realTargetPath = (await getSafeRealPath(absolutePath)) ?? absolutePath
  if (!isPathWithinRoot(realTargetPath, resolvedRoot)) return null

  try {
    const bytes = await readFileWithinLimit(absolutePath, MAX_BASH_EDIT_SNAPSHOT_BYTES)
    if (!bytes) return null
    if (bytes.includes(0)) return null

    return bytes.toString('utf8')
  } catch {
    return null
  }
}

function isProtectedSystemSkillPath(
  targetPath: string,
  cwd: string,
  seedPaths: Array<string | null | undefined> = []
): boolean {
  if (!targetPath.trim()) return false
  const resolved = path.resolve(cwd, targetPath).replace(/\\/g, '/')
  if (PROTECTED_SYSTEM_SKILL_PATH_SEGMENTS.some((segment) => resolved.includes(segment))) {
    return true
  }

  const protectedCacheRoots = resolveProtectedSystemSkillCacheRoots(seedPaths)
  return protectedCacheRoots.some((rootPath) =>
    isPathWithinResolvedRoot(resolved, rootPath)
  )
}

function isProtectedBatshitRepoPath(
  targetPath: string,
  cwd: string,
  seedPaths: Array<string | null | undefined> = []
): boolean {
  const protectedRoots = resolveProtectedBatshitRepoRoots(seedPaths)
  if (!targetPath.trim() || protectedRoots.length === 0) return false
  const resolved = path.resolve(cwd, targetPath).replace(/\\/g, '/')
  return protectedRoots.some(
    (rootPath) =>
      isPathWithinResolvedRoot(resolved, rootPath) &&
      !isWithinWritableRepoSubpath(resolved, rootPath)
  )
}

const PROTECTED_BATSHIT_REPO_WRITE_MESSAGE =
  'Blocked: Batshit product source is read-only from in-app agents, in every access mode including Dangerous. ' +
  'Do not modify Batshit\'s own application files — report the core change you need to the user instead. ' +
  'Batshit development happens in an external coding workspace (Codex / Claude Code), not through in-app agent tools.'

function getProtectedSystemSkillWriteViolationReason(options: {
  command: string
  cwd: string
  touchedPaths?: string[]
  workspaceRoot?: string | null
}): string | null {
  const mapping = mapBashCommandToRendererTool(options.command)
  const touchedPaths = new Set<string>()

  if (
    mapping.toolName === 'batshit_server_overwrite_file' ||
    mapping.toolName === 'batshit_server_edit_file'
  ) {
    const mappedPath = resolveMappedPath(mapping)
    if (mappedPath) {
      touchedPaths.add(mappedPath)
    }
  }

  for (const targetPath of options.touchedPaths ?? []) {
    if (targetPath.trim()) {
      touchedPaths.add(targetPath)
    }
  }

  for (const targetPath of touchedPaths) {
    if (isProtectedSystemSkillPath(targetPath, options.cwd, [options.workspaceRoot])) {
      return (
        'Batshit system skill bundles are protected from in-app bash edits, including any stale runtime cache copies. ' +
        'Update files under batshit-app/src/lib/server/system-skills/ from the external coding workspace instead.'
      )
    }
  }

  const skillCacheRoots = resolveProtectedSystemSkillCacheRoots([options.workspaceRoot])
  const shellViolationRoot = findProtectedShellWriteViolationRoot({
    command: options.command,
    cwd: options.cwd,
    protectedRoots: skillCacheRoots
  })
  if (shellViolationRoot) {
    return (
      'Batshit system skill bundles are protected from in-app bash edits, including any stale runtime cache copies. ' +
      'Update files under batshit-app/src/lib/server/system-skills/ from the external coding workspace instead.'
    )
  }

  return null
}

function getProtectedBatshitRepoWriteViolationReason(options: {
  command: string
  cwd: string
  touchedPaths?: string[]
  workspaceRoot?: string | null
}): string | null {
  const mapping = mapBashCommandToRendererTool(options.command)
  const touchedPaths = new Set<string>()

  if (
    mapping.toolName === 'batshit_server_overwrite_file' ||
    mapping.toolName === 'batshit_server_edit_file'
  ) {
    const mappedPath = resolveMappedPath(mapping)
    if (mappedPath) {
      touchedPaths.add(mappedPath)
    }
  }

  for (const targetPath of options.touchedPaths ?? []) {
    if (targetPath.trim()) {
      touchedPaths.add(targetPath)
    }
  }

  for (const targetPath of touchedPaths) {
    if (isProtectedBatshitRepoPath(targetPath, options.cwd, [options.workspaceRoot])) {
      return PROTECTED_BATSHIT_REPO_WRITE_MESSAGE
    }
  }

  const shellViolationRoot = findProtectedShellWriteViolationRoot({
    command: options.command,
    cwd: options.cwd,
    protectedRoots: resolveProtectedBatshitRepoRoots([options.workspaceRoot])
  })
  if (shellViolationRoot) {
    return PROTECTED_BATSHIT_REPO_WRITE_MESSAGE
  }

  return null
}

function isPlanModeMarkdownWriteCommand(command: string): boolean {
  const mapping = mapBashCommandToRendererTool(command)
  if (mapping.toolName !== 'batshit_server_overwrite_file' && mapping.toolName !== 'batshit_server_edit_file') {
    return false
  }

  return isMarkdownPath(resolveMappedPath(mapping))
}

function usesQuotedHeredoc(command: string): boolean {
  return /<<-?\s*(['"]).+?\1/.test(command) || /<<-?\s*\\[A-Za-z_][A-Za-z0-9_]*/.test(command)
}

function extractTouchTargetPath(command: string): string | null {
  const match = command.match(/^\s*touch\s+(['"]?)([^'"`\s|><]+)\1\s*$/i)
  const candidate = match?.[2]?.trim()
  return candidate && candidate.length > 0 ? candidate : null
}

function getPolicyInspectionCommand(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return ''

  // Heredoc bodies can contain semicolons or shell-like symbols that are not command chaining.
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(trimmed)) {
    return trimmed.split(/\r?\n/, 1)[0]?.trim() ?? trimmed
  }

  return trimmed
}

async function resolveManagedPatchPath(options: {
  rawPath: string
  cwd: string
  workspaceRoot: string
}): Promise<{ absolutePath: string; relativePath: string; exists: boolean }> {
  const resolvedRoot = path.resolve(options.workspaceRoot)
  const absolutePath = path.resolve(options.cwd, options.rawPath)
  const realTargetPath = (await getSafeRealPath(absolutePath)) ?? absolutePath
  if (!isPathWithinRoot(realTargetPath, resolvedRoot)) {
    throw new Error(`Patch target "${options.rawPath}" is outside the allowed workspace root.`)
  }

  let exists = false
  try {
    await stat(absolutePath)
    exists = true
  } catch {
    exists = false
  }

  const relativeRaw = path.relative(resolvedRoot, absolutePath)
  const relativePath = (relativeRaw || path.basename(absolutePath)).split(path.sep).join('/')

  return {
    absolutePath,
    relativePath,
    exists
  }
}

async function executeManagedApplyPatch(options: {
  operations: ManagedApplyPatchOperation[]
  cwd: string
  workspaceRoot: string
}): Promise<ManagedApplyPatchExecutionResult> {
  const touchedPaths = new Set<string>()
  let operationsApplied = 0

  for (const operation of options.operations) {
    if (operation.type === 'add') {
      const target = await resolveManagedPatchPath({
        rawPath: operation.filePath,
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot
      })
      if (target.exists) {
        throw new Error(`Cannot add file "${operation.filePath}" because it already exists.`)
      }

      await mkdir(path.dirname(target.absolutePath), { recursive: true })
      const content = operation.contentLines.length > 0 ? `${operation.contentLines.join('\n')}\n` : ''
      await writeFile(target.absolutePath, content, 'utf8')
      touchedPaths.add(target.relativePath)
      operationsApplied += 1
      continue
    }

    if (operation.type === 'delete') {
      const target = await resolveManagedPatchPath({
        rawPath: operation.filePath,
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot
      })
      if (!target.exists) {
        throw new Error(`Cannot delete "${operation.filePath}" because it does not exist.`)
      }

      await unlink(target.absolutePath)
      touchedPaths.add(target.relativePath)
      operationsApplied += 1
      continue
    }

    const source = await resolveManagedPatchPath({
      rawPath: operation.filePath,
      cwd: options.cwd,
      workspaceRoot: options.workspaceRoot
    })
    if (!source.exists) {
      throw new Error(`Cannot update "${operation.filePath}" because it does not exist.`)
    }

    const originalContent = await readFile(source.absolutePath, 'utf8')
    const nextContent =
      operation.hunks.length > 0
        ? applyManagedPatchHunks({
            content: originalContent,
            hunks: operation.hunks,
            filePath: operation.filePath
          })
        : originalContent

    if (operation.moveToPath) {
      const destination = await resolveManagedPatchPath({
        rawPath: operation.moveToPath,
        cwd: options.cwd,
        workspaceRoot: options.workspaceRoot
      })

      if (destination.exists && destination.absolutePath !== source.absolutePath) {
        throw new Error(
          `Cannot move "${operation.filePath}" to "${operation.moveToPath}" because destination already exists.`
        )
      }

      await mkdir(path.dirname(destination.absolutePath), { recursive: true })
      await writeFile(destination.absolutePath, nextContent, 'utf8')
      if (destination.absolutePath !== source.absolutePath) {
        await unlink(source.absolutePath)
      }
      touchedPaths.add(source.relativePath)
      touchedPaths.add(destination.relativePath)
      operationsApplied += 1
      continue
    }

    await writeFile(source.absolutePath, nextContent, 'utf8')
    touchedPaths.add(source.relativePath)
    operationsApplied += 1
  }

  return {
    success: true,
    operationsApplied,
    touchedPaths: Array.from(touchedPaths),
    message: `Managed apply_patch applied ${operationsApplied} operation(s).`
  }
}

function isPlanModeAllowedCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const commandForPolicy = getPolicyInspectionCommand(trimmed)

  if (/[;&]|&&|\|\|/.test(commandForPolicy)) return false

  if (isManagedApplyPatchCommand(trimmed)) return true

  const mapping = mapBashCommandToRendererTool(trimmed)
  const mappedPath = resolveMappedPath(mapping)

  if (mapping.toolName === 'batshit_server_overwrite_file' || mapping.toolName === 'batshit_server_edit_file') {
    return isMarkdownPath(mappedPath)
  }

  if (SAFE_BASH_COMMAND_ALLOW_LIST.some((pattern) => pattern.test(trimmed))) {
    return true
  }

  const touchPath = extractTouchTargetPath(trimmed)
  if (touchPath && isMarkdownPath(touchPath)) return true

  return false
}

function isAgentModeAutoAllowedCommand(command: string, customAllowList?: string[] | null): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  const mapped = mapBashCommandToRendererTool(trimmed)
  if (mapped.toolName === 'batshit_server_read_file') return true
  if (mapped.toolName === 'batshit_server_list_files') return true
  if (mapped.toolName === 'batshit_server_search_files') return true

  // Agent mode is project write-capable by default.
  // Workspace-root containment + hard safety rules still apply in nativeBashExecute.
  if (mapped.toolName === 'batshit_server_overwrite_file' || mapped.toolName === 'batshit_server_edit_file') {
    return true
  }

  if (SAFE_BASH_COMMAND_ALLOW_LIST.some((pattern) => pattern.test(trimmed))) return true
  return commandMatchesAnyPattern(trimmed, customAllowList)
}

async function getAdminDefaultWebSearchProvider(
  userId?: string
): Promise<NativeWebSearchProvider | null> {
  if (!userId) return null
  try {
    const settings = await redis.getUserSettings(userId)
    const adminSettings = (settings?.admin_settings as Record<string, any>) ?? {}
    return normalizeWebSearchProvider(
      adminSettings.web_search_default_provider ?? adminSettings.webSearchDefaultProvider
    )
  } catch (error) {
    console.error('[Native Tools] Failed loading admin web search default:', error)
    return null
  }
}

async function getAdminDefaultWebSearchOptions(userId?: string): Promise<{
  exaSearchType: ExaSearchType | null
  perplexityMaxTokensPerPage: number | null
}> {
  if (!userId) {
    return {
      exaSearchType: null,
      perplexityMaxTokensPerPage: null
    }
  }

  try {
    const settings = await redis.getUserSettings(userId)
    const adminSettings = (settings?.admin_settings as Record<string, any>) ?? {}
    const exaSearchType = normalizeExaSearchType(
      adminSettings.web_search_exa_type ?? adminSettings.webSearchExaType
    )
    const perplexityMaxTokensPerPageRaw = parseInteger(
      adminSettings.web_search_perplexity_max_tokens_per_page ??
        adminSettings.webSearchPerplexityMaxTokensPerPage
    )

    return {
      exaSearchType,
      perplexityMaxTokensPerPage:
        perplexityMaxTokensPerPageRaw === undefined
          ? null
          : clamp(
              perplexityMaxTokensPerPageRaw,
              MIN_PERPLEXITY_MAX_TOKENS_PER_PAGE,
              MAX_PERPLEXITY_MAX_TOKENS_PER_PAGE
            )
    }
  } catch (error) {
    console.error('[Native Tools] Failed loading admin web search options:', error)
    return {
      exaSearchType: null,
      perplexityMaxTokensPerPage: null
    }
  }
}

async function providerHasRequiredApiKey(
  provider: NativeWebSearchProvider,
  userId?: string
): Promise<boolean> {
  const service = API_KEY_SERVICE_BY_WEB_SEARCH_PROVIDER[provider]
  if (!service) return true
  if (!userId) return false
  return await apiKeyService.exists(service, userId)
}

function providerMissingKeyReason(
  provider: NativeWebSearchProvider,
  userId?: string
): string | null {
  const service = API_KEY_SERVICE_BY_WEB_SEARCH_PROVIDER[provider]
  if (!service) return null
  if (!userId) {
    return `${provider} requires an API key and authenticated user context; falling back to DuckDuckGo.`
  }
  return `${provider} API key is not configured; falling back to DuckDuckGo.`
}

async function resolveWebSearchProvider(options: {
  requestedProvider?: unknown
  agentDefaultProvider?: unknown
  userId?: string
}): Promise<WebSearchProviderResolution> {
  const requestedProvider = normalizeWebSearchProvider(options.requestedProvider)
  const agentDefaultProvider = normalizeWebSearchProvider(options.agentDefaultProvider)
  const adminDefaultProvider = await getAdminDefaultWebSearchProvider(options.userId)

  const preferredOrder: NativeWebSearchProvider[] = [
    ...(requestedProvider ? [requestedProvider] : []),
    ...(agentDefaultProvider ? [agentDefaultProvider] : []),
    ...(adminDefaultProvider ? [adminDefaultProvider] : []),
    'duckduckgo-html'
  ]

  const seen = new Set<NativeWebSearchProvider>()
  const candidates = preferredOrder.filter((provider) => {
    if (seen.has(provider)) return false
    seen.add(provider)
    return true
  })

  let fallbackReason: string | undefined
  for (const provider of candidates) {
    const available = await providerHasRequiredApiKey(provider, options.userId)
    if (available) {
      return {
        requestedProvider,
        agentDefaultProvider,
        adminDefaultProvider,
        resolvedProvider: provider,
        fallbackReason
      }
    }
    fallbackReason = providerMissingKeyReason(provider, options.userId) ?? fallbackReason
  }

  return {
    requestedProvider,
    agentDefaultProvider,
    adminDefaultProvider,
    resolvedProvider: 'duckduckgo-html',
    fallbackReason: fallbackReason ?? 'Falling back to DuckDuckGo.'
  }
}

function normalizeCountryCodeFromRegion(region: string): string | undefined {
  const normalized = region.trim().toLowerCase()
  if (!normalized) return undefined
  const country = normalized.split('-')[0]?.trim()
  if (!country || country.length < 2) return undefined
  return country.toUpperCase()
}

function truncateSnippet(value: unknown, maxChars = 420): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed
}

function decodeDuckDuckGoUrl(rawHref: string): string {
  if (!rawHref) return ''

  try {
    const parsed = new URL(rawHref, 'https://duckduckgo.com')
    const redirected = parsed.searchParams.get('uddg')
    if (redirected) {
      return decodeURIComponent(redirected)
    }
    if (rawHref.startsWith('//')) {
      return `https:${rawHref}`
    }
    return parsed.toString()
  } catch {
    return rawHref
  }
}

export interface ResolvedNativeToolSettings {
  fetchZipEnabled: boolean
  dynamicMcpEnabled: boolean
  cliToolsEnabled: boolean
  artifactRuntimeEnabled: boolean
  batshitToolsEnabled: boolean
  webSearchEnabled: boolean
  bashEnabled: boolean
  executionBackend: NativeExecutionBackend
  automationBashAllowList: string[]
  automationBashDenyList: string[]
  agentBrowserEnabled: boolean
  agentBrowserLiveViewEnabled: boolean
  agentBrowserRuntimeMode: AgentBrowserRuntimeMode
  agentBrowserProvider: AgentBrowserProvider
  agentBrowserCdpPort: number
  agentBrowserSession?: string
  agentBrowserProfilePath?: string
  agentBrowserExecutablePath?: string
  agentBrowserExtraFlags: string[]
  agentBrowserTimeoutMs: number
  bashTimeoutMs: number
  bashAccessMode: NativeBashAccessMode
  bashPolicyMode: LegacyNativeToolPolicyMode
  bashCommandAllowList: string[]
  bashNeverAllowList: string[]
  bashAgentApprovalCardsEnabled: boolean
  webSearchProvider?: NativeWebSearchProvider
  webSearchExaSearchType?: ExaSearchType
  webSearchPerplexityMaxTokensPerPage?: number
}

export function resolveNativeToolSettings(providerSettings?: Record<string, any> | null): ResolvedNativeToolSettings {
  const settings = providerSettings && typeof providerSettings === 'object'
    ? providerSettings
    : {}
  const nested = settings.nativeTools && typeof settings.nativeTools === 'object'
    ? settings.nativeTools
    : settings.batshitNativeTools && typeof settings.batshitNativeTools === 'object'
      ? settings.batshitNativeTools
      : {}

  const getToggle = (...keys: string[]) => {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(nested, key)) {
        const parsed = parseBoolean((nested as any)[key])
        if (parsed !== undefined) return parsed
      }
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        const parsed = parseBoolean((settings as any)[key])
        if (parsed !== undefined) return parsed
      }
    }
    return undefined
  }

  const bashTimeout = parseInteger(
    (nested as any).bashTimeoutMs ??
      (nested as any).nativeBashTimeoutMs ??
      (settings as any).nativeBashTimeoutMs
  )
  const webSearchProvider = normalizeWebSearchProvider(
    (nested as any).webSearchProvider ??
      (nested as any).nativeWebSearchProvider ??
      (settings as any).nativeWebSearchProvider
  )
  const webSearchExaSearchType = normalizeExaSearchType(
    (nested as any).webSearchExaSearchType ??
      (nested as any).webSearchExaType ??
      (nested as any).nativeWebSearchExaSearchType ??
      (settings as any).nativeWebSearchExaSearchType
  )
  const webSearchPerplexityMaxTokensPerPage = parseInteger(
    (nested as any).webSearchPerplexityMaxTokensPerPage ??
      (nested as any).nativeWebSearchPerplexityMaxTokensPerPage ??
      (settings as any).nativeWebSearchPerplexityMaxTokensPerPage
  )
  const bashAccessMode = normalizeBashAccessMode(
    (nested as any).bashAccessMode ??
      (nested as any).nativeBashAccessMode ??
      (nested as any).bashPolicyMode ??
      (settings as any).nativeBashPolicyMode ??
      (settings as any).bashPolicyMode
  )
  const bashCommandAllowList = normalizeCommandPatternList(
    (nested as any).bashCommandAllowList ??
      (nested as any).nativeBashCommandAllowList ??
      (settings as any).nativeBashCommandAllowList
  )
  const bashNeverAllowList = normalizeCommandPatternList(
    (nested as any).bashNeverAllowList ??
      (nested as any).nativeBashNeverAllowList ??
      (settings as any).nativeBashNeverAllowList
  )
  const executionBackend = normalizeNativeExecutionBackend(
    (nested as any).executionBackend ??
      (nested as any).nativeExecutionBackend ??
      (nested as any).bashExecutionBackend ??
      (nested as any).nativeBashExecutionBackend ??
      (settings as any).nativeExecutionBackend ??
      (settings as any).bashExecutionBackend
  )
  const resolvedExecutionBackend =
    executionBackend ??
    (bashAccessMode === 'dangerous'
      ? DEFAULT_NATIVE_BASH_BACKEND
      : getDefaultNativeExecutionBackend())
  const automationBashAllowList = normalizeCommandPatternList(
    (nested as any).automationBashAllowList ??
      (nested as any).nativeAutomationBashAllowList ??
      (settings as any).nativeAutomationBashAllowList
  )
  const automationBashDenyList = normalizeCommandPatternList(
    (nested as any).automationBashDenyList ??
      (nested as any).nativeAutomationBashDenyList ??
      (settings as any).nativeAutomationBashDenyList
  )
  const bashAgentApprovalCardsEnabled =
    getToggle(
      'bashAgentApprovalCardsEnabled',
      'bashApprovalCardsEnabled',
      'nativeBashAgentApprovalCardsEnabled',
      'nativeBashApprovalCardsEnabled'
    ) ?? false
  // SA-096: the six broker-relevant toggles are resolved by the shared util so the compile
  // twins read agent settings exactly the way tool registration does.
  const brokerToggles = resolveBrokerToolToggles(providerSettings)
  const agentBrowserEnabled = brokerToggles.agentBrowserEnabled
  const agentBrowserRuntimeMode = normalizeAgentBrowserRuntimeMode(
    (nested as any).agentBrowserRuntimeMode ??
      (nested as any).nativeAgentBrowserRuntimeMode ??
      (nested as any).agentBrowserMode ??
      (settings as any).nativeAgentBrowserRuntimeMode
  )
  const agentBrowserProvider = normalizeAgentBrowserProvider(
    (nested as any).agentBrowserProvider ??
      (nested as any).nativeAgentBrowserProvider ??
      (settings as any).nativeAgentBrowserProvider
  )
  const agentBrowserCdpPort = parseInteger(
    (nested as any).agentBrowserCdpPort ??
      (nested as any).nativeAgentBrowserCdpPort ??
      (settings as any).nativeAgentBrowserCdpPort
  )
  const agentBrowserTimeoutMs = parseInteger(
    (nested as any).agentBrowserTimeoutMs ??
      (nested as any).nativeAgentBrowserTimeoutMs ??
      (settings as any).nativeAgentBrowserTimeoutMs
  )
  const agentBrowserExecutablePathRaw =
    (nested as any).agentBrowserExecutablePath ??
    (nested as any).nativeAgentBrowserExecutablePath ??
    (settings as any).nativeAgentBrowserExecutablePath
  const agentBrowserExecutablePath =
    typeof agentBrowserExecutablePathRaw === 'string' && agentBrowserExecutablePathRaw.trim().length > 0
      ? agentBrowserExecutablePathRaw.trim()
      : null
  const agentBrowserSessionRaw =
    (nested as any).agentBrowserSession ??
    (nested as any).nativeAgentBrowserSession ??
    (settings as any).nativeAgentBrowserSession
  const agentBrowserSession =
    typeof agentBrowserSessionRaw === 'string' && agentBrowserSessionRaw.trim().length > 0
      ? agentBrowserSessionRaw.trim()
      : null
  const agentBrowserProfilePathRaw =
    (nested as any).agentBrowserProfilePath ??
    (nested as any).agentBrowserProfile ??
    (nested as any).nativeAgentBrowserProfilePath ??
    (nested as any).nativeAgentBrowserProfile ??
    (settings as any).nativeAgentBrowserProfilePath ??
    (settings as any).nativeAgentBrowserProfile
  const agentBrowserProfilePath =
    typeof agentBrowserProfilePathRaw === 'string' && agentBrowserProfilePathRaw.trim().length > 0
      ? agentBrowserProfilePathRaw.trim()
      : null
  const agentBrowserExtraFlags = normalizeStringList(
    (nested as any).agentBrowserExtraFlags ??
      (nested as any).nativeAgentBrowserExtraFlags ??
      (settings as any).nativeAgentBrowserExtraFlags
  )
  const mergedBashAllowList = mergeCommandPatternLists(
    bashCommandAllowList,
    agentBrowserEnabled ? AGENT_BROWSER_BASH_AUTO_ALLOW_PATTERNS : undefined
  )

  return {
    fetchZipEnabled: brokerToggles.fetchZipEnabled,
    dynamicMcpEnabled: brokerToggles.dynamicMcpEnabled,
    cliToolsEnabled: brokerToggles.cliToolsEnabled,
    artifactRuntimeEnabled: brokerToggles.artifactRuntimeEnabled,
    batshitToolsEnabled: brokerToggles.batshitToolsEnabled,
    webSearchEnabled: getToggle('webSearchEnabled', 'nativeWebSearchEnabled') ?? true,
    bashEnabled: getToggle('bashEnabled', 'nativeBashEnabled') ?? true,
    executionBackend: resolvedExecutionBackend,
    automationBashAllowList: automationBashAllowList ?? [],
    automationBashDenyList: automationBashDenyList ?? [],
    agentBrowserEnabled,
    agentBrowserLiveViewEnabled:
      getToggle('agentBrowserLiveViewEnabled', 'nativeAgentBrowserLiveViewEnabled') ?? true,
    agentBrowserRuntimeMode: agentBrowserRuntimeMode ?? DEFAULT_AGENT_BROWSER_RUNTIME_MODE,
    agentBrowserProvider: agentBrowserProvider ?? DEFAULT_AGENT_BROWSER_PROVIDER,
    agentBrowserCdpPort: clamp(
      agentBrowserCdpPort ?? DEFAULT_AGENT_BROWSER_CDP_PORT,
      1,
      65535
    ),
    agentBrowserSession: agentBrowserSession ?? undefined,
    agentBrowserProfilePath: agentBrowserProfilePath ?? undefined,
    agentBrowserExecutablePath: agentBrowserExecutablePath ?? undefined,
    agentBrowserExtraFlags: agentBrowserExtraFlags ?? [],
    agentBrowserTimeoutMs: clamp(
      agentBrowserTimeoutMs ?? DEFAULT_AGENT_BROWSER_TIMEOUT_MS,
      MIN_AGENT_BROWSER_TIMEOUT_MS,
      MAX_AGENT_BROWSER_TIMEOUT_MS
    ),
    bashTimeoutMs: clamp(
      bashTimeout ?? DEFAULT_BASH_TIMEOUT_MS,
      MIN_BASH_TIMEOUT_MS,
      MAX_BASH_TIMEOUT_MS
    ),
    bashAccessMode: bashAccessMode ?? DEFAULT_BASH_ACCESS_MODE,
    bashPolicyMode: toLegacyBashPolicyMode(bashAccessMode ?? DEFAULT_BASH_ACCESS_MODE),
    bashCommandAllowList: mergedBashAllowList ?? [],
    bashNeverAllowList: bashNeverAllowList ?? [],
    bashAgentApprovalCardsEnabled,
    webSearchProvider: webSearchProvider ?? undefined,
    webSearchExaSearchType: webSearchExaSearchType ?? undefined,
    webSearchPerplexityMaxTokensPerPage:
      webSearchPerplexityMaxTokensPerPage === undefined
        ? undefined
        : clamp(
            webSearchPerplexityMaxTokensPerPage,
            MIN_PERPLEXITY_MAX_TOKENS_PER_PAGE,
            MAX_PERPLEXITY_MAX_TOKENS_PER_PAGE
          )
  }
}

function getNestedNativeToolSettingsObject(
  providerSettings?: Record<string, any> | null
): Record<string, any> {
  const settings =
    providerSettings && typeof providerSettings === 'object' ? providerSettings : null
  if (!settings) return {}

  const nativeTools =
    settings.nativeTools && typeof settings.nativeTools === 'object' && !Array.isArray(settings.nativeTools)
      ? (settings.nativeTools as Record<string, any>)
      : settings.batshitNativeTools &&
          typeof settings.batshitNativeTools === 'object' &&
          !Array.isArray(settings.batshitNativeTools)
        ? (settings.batshitNativeTools as Record<string, any>)
        : null

  return nativeTools ? { ...nativeTools } : {}
}

function mergeSubagentNativeToolProviderSettings(
  primaryProviderSettings: Record<string, any> | null,
  subagentProviderSettings: Record<string, any> | null
): Record<string, any> | null {
  const baseSettings =
    primaryProviderSettings && typeof primaryProviderSettings === 'object'
      ? { ...primaryProviderSettings }
      : {}
  const mergedNativeTools = getNestedNativeToolSettingsObject(primaryProviderSettings)
  const subagentNativeTools = getNestedNativeToolSettingsObject(subagentProviderSettings)

  if (Object.keys(subagentNativeTools).length === 0) {
    return Object.keys(baseSettings).length > 0 ? baseSettings : null
  }

  for (const [key, value] of Object.entries(subagentNativeTools)) {
    if (SUBAGENT_NATIVE_TOOLS_BLOCKED_OVERRIDE_KEYS.has(key)) {
      continue
    }
    if (value === null || value === undefined || value === '') {
      delete mergedNativeTools[key]
      continue
    }
    mergedNativeTools[key] = value
  }

  if (Object.keys(mergedNativeTools).length > 0) {
    baseSettings.nativeTools = mergedNativeTools
  } else {
    delete baseSettings.nativeTools
  }

  return Object.keys(baseSettings).length > 0 ? baseSettings : null
}

async function resolveSessionProjectPath(sessionId?: string | null): Promise<string | null> {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!normalized) return null
  const session = await redis.getSession(normalized).catch(() => null)
  const metadata =
    session?.metadata && typeof session.metadata === 'object' ? session.metadata : null
  const projectPath = typeof metadata?.projectPath === 'string' ? metadata.projectPath.trim() : ''
  return projectPath || null
}

const MAX_BASH_COMMAND_CHARS = 4_000
const MAX_MANAGED_APPLY_PATCH_COMMAND_CHARS = 200_000

function buildManagedApplyPatchPolicyScanText(command: string): string {
  // Managed apply_patch payloads are parsed and applied in-process, never run
  // through a shell, so shell-safety rules only inspect the command envelope.
  const beginIndex = command.indexOf(APPLY_PATCH_BEGIN_MARKER)
  const endIndex = command.lastIndexOf(APPLY_PATCH_END_MARKER)
  if (beginIndex < 0 || endIndex <= beginIndex) return command
  return `${command.slice(0, beginIndex)}[managed apply_patch payload]${command.slice(endIndex + APPLY_PATCH_END_MARKER.length)}`
}

function evaluateBashPolicy(
  command: string,
  mode: NativeBashAccessMode,
  neverAllowList?: string[]
): NativeToolExecutionResult {
  const trimmed = command.trim()
  if (!trimmed) {
    return { success: false, blocked: true, reason: 'Command cannot be empty.' }
  }

  const managedPatchCommand = isManagedApplyPatchCommand(trimmed)
  const commandLengthLimit = managedPatchCommand
    ? MAX_MANAGED_APPLY_PATCH_COMMAND_CHARS
    : MAX_BASH_COMMAND_CHARS
  if (trimmed.length > commandLengthLimit) {
    return {
      success: false,
      blocked: true,
      reason: `Command is too long (${trimmed.length} characters; limit ${commandLengthLimit}). For large file writes or edits, send a managed apply_patch command (heredoc with "*** Begin Patch" / "*** End Patch"), which allows up to ${MAX_MANAGED_APPLY_PATCH_COMMAND_CHARS} characters. Otherwise split the work into smaller commands.`
    }
  }

  const policyScanText = managedPatchCommand
    ? buildManagedApplyPatchPolicyScanText(trimmed)
    : trimmed

  for (const rule of DANGEROUS_BASH_RULES) {
    if (rule.pattern.test(policyScanText)) {
      return { success: false, blocked: true, reason: rule.reason }
    }
  }

  const pythonSafetyViolation = getPythonSafetyViolationReason(policyScanText)
  if (pythonSafetyViolation) {
    return { success: false, blocked: true, reason: pythonSafetyViolation }
  }

  if (commandMatchesAnyPattern(trimmed, neverAllowList)) {
    return {
      success: false,
      blocked: true,
      reason: 'Blocked by your bash Never Allow list.'
    }
  }

  if (mode === 'plan') {
    const commandForPolicy = getPolicyInspectionCommand(trimmed)

    if (/[;&]|&&|\|\|/.test(commandForPolicy)) {
      return {
        success: false,
        blocked: true,
        reason: 'Command chaining is blocked in Plan mode.'
      }
    }

    const markdownWriteCommand =
      isManagedApplyPatchCommand(trimmed) || isPlanModeMarkdownWriteCommand(trimmed)
    const quotedHeredocMarkdownWrite = markdownWriteCommand && usesQuotedHeredoc(trimmed)

    if ((trimmed.includes('$(') || trimmed.includes('`')) && !quotedHeredocMarkdownWrite) {
      return {
        success: false,
        blocked: true,
        reason: 'Shell substitutions are blocked in Plan mode.'
      }
    }
    if (!isPlanModeAllowedCommand(trimmed)) {
      return {
        success: false,
        blocked: true,
        reason:
          'Plan mode only allows inspection/search commands plus markdown (.md) write/edit operations.'
      }
    }
  }

  return { success: true }
}

function appendWithLimit(current: string, chunk: string, limit: number): { text: string; truncated: boolean } {
  if (!chunk) return { text: current, truncated: false }
  const combined = current + chunk
  if (combined.length <= limit) return { text: combined, truncated: false }
  return { text: combined.slice(0, limit), truncated: true }
}

async function getSafeRealPath(targetPath: string): Promise<string | null> {
  try {
    return await realpath(targetPath)
  } catch {
    return null
  }
}

async function resolveExistingDirectory(candidatePath: string): Promise<string | null> {
  const trimmed = candidatePath.trim()
  if (!trimmed) return null

  const resolved = path.resolve(trimmed)
  try {
    const info = await stat(resolved)
    if (!info.isDirectory()) return null
    return (await getSafeRealPath(resolved)) ?? resolved
  } catch {
    return null
  }
}

async function resolveBashWorkspaceRoot(options: {
  userId?: string
  projectPath?: string | null
  workspaceRoot?: string | null
}): Promise<{ workspaceRoot: string } | { blocked: true; reason: string }> {
  const explicitWorkspaceRoot =
    typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : ''
  if (explicitWorkspaceRoot) {
    const resolved = await resolveExistingDirectory(explicitWorkspaceRoot)
    if (!resolved) {
      return {
        blocked: true,
        reason: `Configured workspace root is not a valid directory: ${path.resolve(explicitWorkspaceRoot)}`
      }
    }
    return { workspaceRoot: resolved }
  }

  const explicitProjectPath =
    typeof options.projectPath === 'string' ? options.projectPath.trim() : ''
  if (explicitProjectPath) {
    const resolved = await resolveExistingDirectory(explicitProjectPath)
    if (!resolved) {
      return {
        blocked: true,
        reason:
          `Active project path is invalid: ${path.resolve(explicitProjectPath)}. ` +
          'Select a valid project in the Projects sidebar.'
      }
    }
    return { workspaceRoot: resolved }
  }

  if (options.userId) {
    try {
      const preferences = await redis.getProjectPreferences(options.userId)
      const defaultWorkspacePath = preferences?.default_workspace_path?.trim() ?? ''
      if (defaultWorkspacePath) {
        const resolved = await resolveExistingDirectory(defaultWorkspacePath)
        if (!resolved) {
          return {
            blocked: true,
            reason:
              `Default Project Directory is invalid: ${path.resolve(defaultWorkspacePath)}. ` +
              'Update it in Settings -> Projects.'
          }
        }
        return { workspaceRoot: resolved }
      }
    } catch (error) {
      console.error('[Native Tools] Failed to load project preferences for bash workspace:', error)
      return {
        blocked: true,
        reason: 'Unable to load Project preferences for bash workspace resolution.'
      }
    }
  }

  return {
    blocked: true,
    reason:
      'No active project is selected and no Default Project Directory is configured. ' +
      'Set a Default Project Directory in Settings -> Projects, or select a project in the sidebar.'
  }
}

function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const normalizedRoot = rootPath.endsWith(path.sep) ? rootPath : `${rootPath}${path.sep}`
  return candidatePath === rootPath || candidatePath.startsWith(normalizedRoot)
}

async function resolveBashWorkingDirectory(options: {
  requestedCwd?: string | null
  workspaceRoot?: string | null
}): Promise<{ cwd: string } | { blocked: true; reason: string }> {
  const requested = typeof options.requestedCwd === 'string' ? options.requestedCwd.trim() : ''
  const configuredRoot = typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : ''
  if (!configuredRoot) {
    return {
      blocked: true,
      reason: 'No bash workspace root is configured.'
    }
  }
  const unresolvedRoot = configuredRoot
  const resolvedRoot = path.resolve(unresolvedRoot)
  const realRoot = (await getSafeRealPath(resolvedRoot)) ?? resolvedRoot

  const unresolvedCwd = !requested
    ? realRoot
    : path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(realRoot, requested)
  const realCwd = (await getSafeRealPath(unresolvedCwd)) ?? unresolvedCwd

  if (!isPathWithinRoot(realCwd, realRoot)) {
    return {
      blocked: true,
      reason:
        `Requested cwd "${requested || unresolvedCwd}" resolves to "${realCwd}", ` +
        `which is outside allowed workspace root "${realRoot}".`
    }
  }

  return { cwd: realCwd }
}

type CommandRunResult = {
  command: string
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  durationMs: number
  truncated: boolean
}

async function runProcessCommand(options: {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxOutputChars: number
  env?: Record<string, string>
}): Promise<CommandRunResult> {
  const start = Date.now()
  const envOverrides = options.env ?? {}

  return await new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...envOverrides
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    child.stdout.on('data', (chunk) => {
      const next = appendWithLimit(stdout, String(chunk), options.maxOutputChars)
      stdout = next.text
      if (next.truncated) truncated = true
    })

    child.stderr.on('data', (chunk) => {
      const next = appendWithLimit(stderr, String(chunk), options.maxOutputChars)
      stderr = next.text
      if (next.truncated) truncated = true
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 400)
    }, options.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        command: `${options.command} ${options.args.join(' ')}`.trim(),
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - start,
        truncated
      })
    })
  })
}

async function fetchDockerSandboxOperatorJson<TPayload = Record<string, any>>(
  pathname: string,
  init: RequestInit = {},
  timeoutMs?: number
): Promise<
  | { ok: true; statusCode: number; payload: TPayload }
  | { ok: false; statusCode: number; payload: Record<string, any> | null; reason: string }
> {
  const config = resolveDockerSandboxOperatorConfig()
  if (!config.ok) {
    return {
      ok: false,
      statusCode: 0,
      payload: null,
      reason: config.reason
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.timeoutMs)

  try {
    const response = await fetch(`${config.url}${pathname}`, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {})
      },
      signal: controller.signal
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    if (!response.ok || payload?.ok === false) {
      return {
        ok: false,
        statusCode: response.status,
        payload,
        reason:
          typeof payload?.error === 'string'
            ? payload.error
            : `Docker Sandbox operator returned HTTP ${response.status}.`
      }
    }
    return {
      ok: true,
      statusCode: response.status,
      payload: (payload ?? {}) as TPayload
    }
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      statusCode: 0,
      payload: null,
      reason: isAbort
        ? 'Docker Sandbox operator request timed out.'
        : error instanceof Error
          ? `Docker Sandbox operator is unreachable: ${error.message}`
          : 'Docker Sandbox operator is unreachable.'
    }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeOperatorCommandRun(input: Record<string, any> | null | undefined): CommandRunResult {
  const run = input && typeof input === 'object' ? input : {}
  return {
    command: typeof run.command === 'string' ? run.command : 'Docker Sandbox operator execute',
    stdout: typeof run.stdout === 'string' ? run.stdout : '',
    stderr: typeof run.stderr === 'string' ? run.stderr : '',
    exitCode: typeof run.exitCode === 'number' ? run.exitCode : null,
    signal: typeof run.signal === 'string' ? (run.signal as NodeJS.Signals) : null,
    timedOut: run.timedOut === true,
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : 0,
    truncated: run.truncated === true
  }
}

async function getDockerSandboxOperatorBackendStatus(): Promise<{
  available: boolean
  supported: boolean
  dockerUnsupported: boolean
  containerized: boolean
  backend: 'docker_sandbox'
  policy: typeof DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT
  version: string | null
  cli: DockerSandboxCliKind | null
  reason: string | null
}> {
  const result = await fetchDockerSandboxOperatorJson('/v1/sandbox/status')
  if (!result.ok) {
    return {
      available: false,
      supported: true,
      dockerUnsupported: false,
      containerized: isBatshitContainerizedRuntime(),
      backend: 'docker_sandbox',
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      version: null,
      cli: null,
      reason: result.reason
    }
  }

  const payload = result.payload as Record<string, any>
  const cli =
    payload.cli === 'sbx' || payload.cli === 'docker-sandbox'
      ? (payload.cli as DockerSandboxCliKind)
      : null
  const available = payload.available !== false
  return {
    available,
    supported: payload.supported !== false,
    dockerUnsupported: false,
    containerized: true,
    backend: 'docker_sandbox',
    policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
    version: typeof payload.version === 'string' ? payload.version : null,
    cli,
    reason: available
      ? null
      : typeof payload.reason === 'string'
        ? payload.reason
        : 'Docker Sandbox operator is unavailable.'
  }
}

async function recoverDockerSandboxViaOperator(options: {
  userId?: string
  workspaceRoot: string
}): Promise<{
  success: boolean
  recovered: boolean
  backend: 'docker_sandbox'
  sandboxName: string | null
  workspaceRoot: string | null
  workspaceSource: 'explicit' | 'preferences' | 'fallback' | null
  policy: typeof DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT
  status: Awaited<ReturnType<typeof getSandboxBackendStatus>>
  error?: {
    code: NativeAutomationErrorCode
    message: string
  }
}> {
  const result = await fetchDockerSandboxOperatorJson(
    '/v1/sandbox/recover',
    {
      method: 'POST',
      body: JSON.stringify({
        userId: options.userId ?? null,
        workspaceRoot: options.workspaceRoot
      })
    },
    120_000
  )

  const status = await getSandboxBackendStatus()
  if (!result.ok) {
    return {
      success: false,
      recovered: false,
      backend: 'docker_sandbox',
      sandboxName: null,
      workspaceRoot: options.workspaceRoot,
      workspaceSource: 'explicit',
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      status,
      error: {
        code: 'SANDBOX_UNAVAILABLE',
        message: result.reason
      }
    }
  }

  const payload = result.payload as Record<string, any>
  return {
    success: payload.success !== false,
    recovered: payload.recovered !== false,
    backend: 'docker_sandbox',
    sandboxName: typeof payload.sandboxName === 'string' ? payload.sandboxName : null,
    workspaceRoot: typeof payload.workspaceRoot === 'string' ? payload.workspaceRoot : options.workspaceRoot,
    workspaceSource: 'explicit',
    policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
    status,
    ...(payload.success === false
      ? {
          error: {
            code: 'SANDBOX_UNAVAILABLE' as NativeAutomationErrorCode,
            message:
              typeof payload.error === 'string'
                ? payload.error
                : 'Docker Sandbox operator recovery failed.'
          }
        }
      : {})
  }
}

async function executeDockerSandboxViaOperator(options: {
  userId?: string
  sessionId?: string
  workspaceRoot: string
  cwd: string
  command: string
  timeoutMs: number
  maxOutputChars?: number
  env?: Record<string, string>
}): Promise<
  | { ok: true; run: CommandRunResult; sandboxName: string }
  | { ok: false; code: NativeAutomationErrorCode; reason: string; sandboxName?: string }
> {
  const result = await fetchDockerSandboxOperatorJson(
    '/v1/sandbox/execute',
    {
      method: 'POST',
      body: JSON.stringify({
        userId: options.userId ?? null,
        sessionId: options.sessionId ?? null,
        workspaceRoot: options.workspaceRoot,
        cwd: options.cwd,
        command: options.command,
        timeoutMs: options.timeoutMs,
        maxOutputChars: options.maxOutputChars ?? MAX_BASH_OUTPUT_CHARS,
        env: options.env ?? {}
      })
    },
    options.timeoutMs + 10_000
  )

  if (!result.ok) {
    return {
      ok: false,
      code: 'SANDBOX_UNAVAILABLE',
      reason: result.reason
    }
  }

  const payload = result.payload as Record<string, any>
  return {
    ok: true,
    run: normalizeOperatorCommandRun(payload.run as Record<string, any> | null),
    sandboxName: typeof payload.sandboxName === 'string' ? payload.sandboxName : ''
  }
}

async function cleanupDockerSandboxesForSessionViaOperator(sessionId: string): Promise<string[]> {
  const result = await fetchDockerSandboxOperatorJson('/v1/sandbox/cleanup', {
    method: 'POST',
    body: JSON.stringify({ sessionId })
  })
  if (!result.ok) return [result.reason]
  const payload = result.payload as Record<string, any>
  return Array.isArray(payload.warnings)
    ? payload.warnings.filter((warning: unknown): warning is string => typeof warning === 'string')
    : []
}

function buildDockerSandboxSessionHash(sessionId: string) {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 8)
}

function buildDockerSandboxSessionMarker(sessionId: string) {
  return `-s${buildDockerSandboxSessionHash(sessionId)}-`
}

function buildDockerSandboxName(options: {
  userId?: string
  workspaceRoot: string
  sessionId?: string | null
}) {
  const userPrefix =
    typeof options.userId === 'string' && options.userId.trim().length > 0
      ? options.userId.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 20)
      : 'user'
  const workspaceHash = createHash('sha256').update(options.workspaceRoot).digest('hex').slice(0, 10)
  const sessionSegment =
    typeof options.sessionId === 'string' && options.sessionId.trim().length > 0
      ? `s${buildDockerSandboxSessionHash(options.sessionId.trim())}-`
      : ''
  return `${DOCKER_SANDBOX_NAME_PREFIX}${userPrefix}-${sessionSegment}${workspaceHash}`
}

function parseSandboxList(output: string): Array<{ name: string; status: string; workspace: string }> {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length <= 1) return []

  const header = lines[0].split(/\s{2,}/).map((part) => part.trim().toLowerCase())
  const nameIndex = header.findIndex((part) => part === 'sandbox' || part === 'name')
  const statusIndex = header.findIndex((part) => part === 'status')
  const workspaceIndex = header.findIndex((part) => part === 'workspace')

  return lines.slice(1).map((line) => {
    const parts = line.split(/\s{2,}/).filter(Boolean)
    return {
      name: parts[nameIndex >= 0 ? nameIndex : 0] ?? '',
      status: (parts[statusIndex >= 0 ? statusIndex : 2] ?? '').toLowerCase(),
      workspace: parts[workspaceIndex >= 0 ? workspaceIndex : parts.length - 1] ?? ''
    }
  })
}

function isManagedDockerSandboxName(name: string) {
  if (!name) return false
  return name.startsWith(DOCKER_SANDBOX_NAME_PREFIX)
}

type DockerSandboxCli = {
  kind: DockerSandboxCliKind
  command: string
  versionArgs: string[]
}

type DockerSandboxCliCommandInput =
  | { action: 'version' | 'ls' }
  | { action: 'create'; sandboxName: string; workspaceRoot: string; extraWorkspaces?: string[] }
  | { action: 'rm' | 'stop'; sandboxName: string | string[] }
  | { action: 'policy-deny-network'; sandboxName: string }
  | {
      action: 'exec'
      sandboxName: string
      cwd: string
      envArgs: string[]
      commandText: string
    }

const DOCKER_SANDBOX_CLI_DETECTION_ORDER: DockerSandboxCli[] = [
  { kind: 'sbx', command: 'sbx', versionArgs: ['version'] },
  { kind: 'docker-sandbox', command: 'docker', versionArgs: ['sandbox', 'version'] }
]

function orderedDockerSandboxCliCandidates(): DockerSandboxCli[] {
  const preferred = resolvePreferredDockerSandboxCliKind()
  if (!preferred) return DOCKER_SANDBOX_CLI_DETECTION_ORDER
  return [
    ...DOCKER_SANDBOX_CLI_DETECTION_ORDER.filter((candidate) => candidate.kind === preferred),
    ...DOCKER_SANDBOX_CLI_DETECTION_ORDER.filter((candidate) => candidate.kind !== preferred)
  ]
}

function buildDockerSandboxCliCommand(
  kind: DockerSandboxCliKind,
  input: DockerSandboxCliCommandInput
): { command: string; args: string[] } {
  if (kind === 'sbx') {
    if (input.action === 'version') return { command: 'sbx', args: ['version'] }
    if (input.action === 'ls') return { command: 'sbx', args: ['ls'] }
    if (input.action === 'create') {
      return {
        command: 'sbx',
        args: [
          'create',
          '--name',
          input.sandboxName,
          'codex',
          input.workspaceRoot,
          ...(input.extraWorkspaces ?? [])
        ]
      }
    }
    if (input.action === 'rm') {
      const names = Array.isArray(input.sandboxName) ? input.sandboxName : [input.sandboxName]
      return { command: 'sbx', args: ['rm', '--force', ...names] }
    }
    if (input.action === 'stop') {
      const names = Array.isArray(input.sandboxName) ? input.sandboxName : [input.sandboxName]
      return { command: 'sbx', args: ['stop', ...names] }
    }
    if (input.action === 'policy-deny-network') {
      return { command: 'sbx', args: ['policy', 'deny', 'network', input.sandboxName, '**'] }
    }
    if (input.action === 'exec') {
      return {
        command: 'sbx',
        args: [
          'exec',
          '--workdir',
          input.cwd,
          ...input.envArgs,
          input.sandboxName,
          '/bin/bash',
          '-lc',
          input.commandText
        ]
      }
    }
    throw new Error(`Unsupported Docker Sandbox CLI action: ${(input as { action: string }).action}`)
  }

  if (input.action === 'version') return { command: 'docker', args: ['sandbox', 'version'] }
  if (input.action === 'ls') return { command: 'docker', args: ['sandbox', 'ls'] }
  if (input.action === 'create') {
    return {
      command: 'docker',
      args: [
        'sandbox',
        'create',
        '--name',
        input.sandboxName,
        'codex',
        input.workspaceRoot,
        ...(input.extraWorkspaces ?? [])
      ]
    }
  }
  if (input.action === 'rm') {
    const names = Array.isArray(input.sandboxName) ? input.sandboxName : [input.sandboxName]
    return { command: 'docker', args: ['sandbox', 'rm', ...names] }
  }
  if (input.action === 'stop') {
    const names = Array.isArray(input.sandboxName) ? input.sandboxName : [input.sandboxName]
    return { command: 'docker', args: ['sandbox', 'stop', ...names] }
  }
  if (input.action === 'policy-deny-network') {
    return {
      command: 'docker',
      args: ['sandbox', 'network', 'proxy', input.sandboxName, '--policy', DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT]
    }
  }
  if (input.action === 'exec') {
    return {
      command: 'docker',
      args: [
        'sandbox',
        'exec',
        '--workdir',
        input.cwd,
        ...input.envArgs,
        input.sandboxName,
        '/bin/bash',
        '-lc',
        input.commandText
      ]
    }
  }
  throw new Error(`Unsupported Docker Sandbox CLI action: ${(input as { action: string }).action}`)
}

async function resolveDockerSandboxCli(): Promise<
  | { ok: true; cli: DockerSandboxCli; version: string | null }
  | { ok: false; reason: string; attempted: DockerSandboxCliKind[] }
> {
  const errors: string[] = []
  const attempted: DockerSandboxCliKind[] = []

  for (const candidate of orderedDockerSandboxCliCandidates()) {
    attempted.push(candidate.kind)
    try {
      const run = await runProcessCommand({
        command: candidate.command,
        args: candidate.versionArgs,
        cwd: process.cwd(),
        timeoutMs: DOCKER_SANDBOX_STATUS_TIMEOUT_MS,
        maxOutputChars: DOCKER_SANDBOX_STATUS_MAX_OUTPUT_CHARS
      })
      const message = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join('\n')
      if (run.timedOut) {
        errors.push(`${candidate.kind}: Docker Sandbox status check timed out.`)
        continue
      }
      if (run.exitCode !== 0) {
        errors.push(`${candidate.kind}: ${message || 'version command failed.'}`)
        continue
      }
      return { ok: true, cli: candidate, version: message || null }
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      errors.push(
        `${candidate.kind}: ${
          maybeError?.code === 'ENOENT'
            ? `${candidate.command} is not installed or not in PATH.`
            : maybeError?.message || 'version command failed.'
        }`
      )
    }
  }

  return {
    ok: false,
    attempted,
    reason:
      errors.join(' | ') ||
      'Docker Sandbox CLI is unavailable. Install the standalone sbx CLI or legacy Docker Sandbox support.'
  }
}

async function runDockerSandboxLifecycleCommand(options: {
  kind: 'ls' | 'rm' | 'stop'
  sandboxNames?: string[]
  timeoutMs?: number
  maxOutputChars?: number
  fallbackCommand: string
  fallbackError: string
}): Promise<CommandRunResult> {
  const cli = await resolveDockerSandboxCli()
  if (!cli.ok) {
    return {
      command: options.fallbackCommand,
      stdout: '',
      stderr: cli.reason,
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 0,
      truncated: false
    }
  }
  const names = options.sandboxNames ?? []
  const commandSpec =
    options.kind === 'ls'
      ? buildDockerSandboxCliCommand(cli.cli.kind, { action: 'ls' })
      : options.kind === 'rm'
        ? buildDockerSandboxCliCommand(cli.cli.kind, { action: 'rm', sandboxName: names })
        : buildDockerSandboxCliCommand(cli.cli.kind, { action: 'stop', sandboxName: names })
  return await runProcessCommand({
    command: commandSpec.command,
    args: commandSpec.args,
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs ?? DOCKER_SANDBOX_CLEANUP_TIMEOUT_MS,
    maxOutputChars: options.maxOutputChars ?? DOCKER_SANDBOX_STATUS_MAX_OUTPUT_CHARS
  }).catch((error) => {
    const maybeError = error as NodeJS.ErrnoException
    return {
      command: options.fallbackCommand,
      stdout: '',
      stderr: maybeError?.message || options.fallbackError,
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 0,
      truncated: false
    } as CommandRunResult
  })
}

async function bestEffortRemoveDockerSandbox(name: string): Promise<string | null> {
  if (!isManagedDockerSandboxName(name)) return null

  const removeResult = await runDockerSandboxLifecycleCommand({
    kind: 'rm',
    sandboxNames: [name],
    fallbackCommand: 'Docker Sandbox remove',
    fallbackError: 'Failed to remove Docker sandbox.'
  })
  if (!removeResult.timedOut && removeResult.exitCode === 0) {
    return null
  }

  await runDockerSandboxLifecycleCommand({
    kind: 'stop',
    sandboxNames: [name],
    fallbackCommand: 'Docker Sandbox stop',
    fallbackError: 'Failed to stop Docker sandbox before cleanup.'
  })

  const retryRemoveResult = await runDockerSandboxLifecycleCommand({
    kind: 'rm',
    sandboxNames: [name],
    fallbackCommand: 'Docker Sandbox remove',
    fallbackError: 'Failed to remove Docker sandbox after stop.'
  })
  if (!retryRemoveResult.timedOut && retryRemoveResult.exitCode === 0) {
    return null
  }

  return (
    retryRemoveResult.stderr.trim() ||
    retryRemoveResult.stdout.trim() ||
    removeResult.stderr.trim() ||
    removeResult.stdout.trim() ||
    'Docker sandbox cleanup failed.'
  )
}

async function pruneStoppedManagedDockerSandboxes(options?: { keepNames?: string[] }) {
  const listResult = await runDockerSandboxLifecycleCommand({
    kind: 'ls',
    fallbackCommand: 'Docker Sandbox list',
    fallbackError: 'Failed to list Docker sandboxes for cleanup.'
  })
  if (listResult.timedOut || listResult.exitCode !== 0) {
    return [
      listResult.stderr.trim() ||
        listResult.stdout.trim() ||
        'Failed to list Docker sandboxes for cleanup.'
    ].filter(Boolean)
  }

  const keepNames = new Set((options?.keepNames ?? []).filter(Boolean))
  const warnings: string[] = []
  const staleEntries = parseSandboxList(listResult.stdout).filter(
    (entry) =>
      !keepNames.has(entry.name) &&
      isManagedDockerSandboxName(entry.name) &&
      entry.status.trim().toLowerCase() !== 'running'
  )

  for (const entry of staleEntries) {
    const warning = await bestEffortRemoveDockerSandbox(entry.name)
    if (warning) warnings.push(`${entry.name}: ${warning}`)
  }

  return warnings
}

async function cleanupDockerSandboxesForSession(sessionId: string) {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return [] as string[]

  if (
    isBatshitContainerizedRuntime() &&
    containerizedDockerSandboxOperatorEnabled()
  ) {
    const operatorConfig = resolveDockerSandboxOperatorConfig()
    return operatorConfig.ok
      ? await cleanupDockerSandboxesForSessionViaOperator(normalizedSessionId)
      : []
  }

  const listResult = await runDockerSandboxLifecycleCommand({
    kind: 'ls',
    fallbackCommand: 'Docker Sandbox list',
    fallbackError: 'Failed to list Docker sandboxes for session cleanup.'
  })
  const warnings: string[] = []

  if (listResult.timedOut || listResult.exitCode !== 0) {
    warnings.push(
      listResult.stderr.trim() ||
        listResult.stdout.trim() ||
        'Failed to list Docker sandboxes for session cleanup.'
    )
  } else {
    const sessionMarker = buildDockerSandboxSessionMarker(normalizedSessionId)
    const sessionEntries = parseSandboxList(listResult.stdout).filter(
      (entry) => isManagedDockerSandboxName(entry.name) && entry.name.includes(sessionMarker)
    )

    for (const entry of sessionEntries) {
      const warning = await bestEffortRemoveDockerSandbox(entry.name)
      if (warning) warnings.push(`${entry.name}: ${warning}`)
    }
  }

  warnings.push(...(await pruneStoppedManagedDockerSandboxes()))
  return warnings
}

async function cleanupExecutionSandboxesForSession(sessionId: string) {
  const warnings = await cleanupDockerSandboxesForSession(sessionId)
  warnings.push(...(await cleanupAppleContainerSandboxesForSession(sessionId)))
  return warnings
}

export async function getSandboxBackendStatus(): Promise<{
  available: boolean
  supported: boolean
  dockerUnsupported: boolean
  containerized: boolean
  backend: 'docker_sandbox'
  policy: typeof DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT
  version: string | null
  cli: DockerSandboxCliKind | null
  reason: string | null
}> {
  if (
    isBatshitContainerizedRuntime() &&
    containerizedDockerSandboxOperatorEnabled()
  ) {
    return await getDockerSandboxOperatorBackendStatus()
  }

  if (
    isBatshitContainerizedRuntime() &&
    !containerizedDockerSandboxLocalCliExplicitlyAllowed()
  ) {
    return {
      available: false,
      supported: false,
      dockerUnsupported: true,
      containerized: true,
      backend: 'docker_sandbox',
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      version: null,
      cli: null,
      reason: CONTAINERIZED_DOCKER_SANDBOX_DISABLED_REASON
    }
  }

  const resolved = await resolveDockerSandboxCli()
  if (resolved.ok) {
    return {
      available: true,
      supported: true,
      dockerUnsupported: false,
      containerized: isBatshitContainerizedRuntime(),
      backend: 'docker_sandbox',
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      version: resolved.version,
      cli: resolved.cli.kind,
      reason: null
    }
  }

  return {
    available: false,
    supported: true,
    dockerUnsupported: false,
    containerized: isBatshitContainerizedRuntime(),
    backend: 'docker_sandbox',
    policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
    version: null,
    cli: null,
    reason: resolved.reason
  }
}

export async function getAppleContainerSandboxBackendStatus() {
  return await getAppleContainerSandboxStatus()
}

async function resolveSandboxRecoveryWorkspaceRoot(options: {
  userId?: string
  workspaceRoot?: string | null
}): Promise<{ workspaceRoot: string; source: 'explicit' | 'preferences' | 'fallback' } | { blocked: true; reason: string }> {
  const explicitWorkspaceRoot =
    typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : ''

  if (explicitWorkspaceRoot) {
    const resolved = await resolveExistingDirectory(explicitWorkspaceRoot)
    if (!resolved) {
      return {
        blocked: true,
        reason: `Provided workspace root is not a valid directory: ${path.resolve(explicitWorkspaceRoot)}`
      }
    }
    return { workspaceRoot: resolved, source: 'explicit' }
  }

  const fromPreferences = await resolveBashWorkspaceRoot({
    userId: options.userId,
    projectPath: null,
    workspaceRoot: null
  })
  if (!('blocked' in fromPreferences)) {
    return {
      workspaceRoot: fromPreferences.workspaceRoot,
      source: 'preferences'
    }
  }

  const fallbackCandidates = [
    process.env.BATSHIT_WORKSPACE_ROOT,
    path.resolve(process.cwd(), '..'),
    process.cwd()
  ]

  for (const candidate of fallbackCandidates) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) continue
    const resolved = await resolveExistingDirectory(candidate)
    if (resolved) {
      return { workspaceRoot: resolved, source: 'fallback' }
    }
  }

  return {
    blocked: true,
    reason: fromPreferences.reason
  }
}

async function ensureDockerSandboxReady(options: {
  workspaceRoot: string
  userId?: string
  sessionId?: string | null
}): Promise<
  | { ok: true; sandboxName: string; cli: DockerSandboxCliKind }
  | { ok: false; code: NativeAutomationErrorCode; reason: string }
> {
  const status = await getSandboxBackendStatus()
  if (!status.available) {
    return {
      ok: false,
      code: 'SANDBOX_UNAVAILABLE',
      reason:
        status.reason ||
        'Docker Sandbox is unavailable. Start Docker Desktop and install Docker Sandbox support.'
    }
  }
  const resolvedCli = await resolveDockerSandboxCli()
  if (!resolvedCli.ok) {
    return {
      ok: false,
      code: 'SANDBOX_UNAVAILABLE',
      reason: resolvedCli.reason
    }
  }
  const cliKind = resolvedCli.cli.kind

  const sandboxName = buildDockerSandboxName({
    userId: options.userId,
    workspaceRoot: options.workspaceRoot,
    sessionId: options.sessionId ?? null
  })
  const listCommand = buildDockerSandboxCliCommand(cliKind, { action: 'ls' })

  const listResult = await runProcessCommand({
    command: listCommand.command,
    args: listCommand.args,
    cwd: process.cwd(),
    timeoutMs: DOCKER_SANDBOX_STATUS_TIMEOUT_MS,
    maxOutputChars: DOCKER_SANDBOX_STATUS_MAX_OUTPUT_CHARS
  }).catch((error) => {
    const maybeError = error as NodeJS.ErrnoException
    return {
      command: `${listCommand.command} ${listCommand.args.join(' ')}`,
      stdout: '',
      stderr: maybeError?.message || 'Failed to list Docker sandboxes.',
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 0,
      truncated: false
    } as CommandRunResult
  })

  if (listResult.timedOut || listResult.exitCode !== 0) {
    return {
      ok: false,
      code: 'SANDBOX_UNAVAILABLE',
      reason:
        listResult.stderr.trim() ||
        listResult.stdout.trim() ||
        'Unable to query Docker Sandbox state.'
    }
  }

  const existing = parseSandboxList(listResult.stdout).find(
    (entry) => entry.name === sandboxName
  )

  const existingStatus = existing?.status?.trim().toLowerCase() ?? ''
  const existingWorkspace = existing?.workspace?.trim() ?? ''
  const hasWorkspaceMismatch =
    existingWorkspace.length > 0 && existingWorkspace !== '-' && existingWorkspace !== options.workspaceRoot
  const shouldRecreateExisting =
    Boolean(existing) && (existingStatus !== 'running' || hasWorkspaceMismatch)

  if (shouldRecreateExisting) {
    const removeCommand = buildDockerSandboxCliCommand(cliKind, {
      action: 'rm',
      sandboxName
    })
    const removeResult = await runProcessCommand({
      command: removeCommand.command,
      args: removeCommand.args,
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputChars: DOCKER_SANDBOX_STATUS_MAX_OUTPUT_CHARS
    }).catch((error) => {
      const maybeError = error as NodeJS.ErrnoException
      return {
        command: `${removeCommand.command} ${removeCommand.args.join(' ')}`,
        stdout: '',
        stderr: maybeError?.message || 'Failed to remove stale Docker sandbox.',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 0,
        truncated: false
      } as CommandRunResult
    })

    if (removeResult.timedOut || removeResult.exitCode !== 0) {
      return {
        ok: false,
        code: 'BACKEND_UNAVAILABLE',
        reason:
          removeResult.stderr.trim() ||
          removeResult.stdout.trim() ||
          'Failed to reset stale Docker sandbox state.'
      }
    }
  }

  if (!existing || shouldRecreateExisting) {
    const batshitHomeMount = await ensureBatshitHomeSandboxMountPath()
    const extraWorkspaces =
      !isPathInsideSandboxRoot(batshitHomeMount, options.workspaceRoot) &&
      !isPathInsideSandboxRoot(options.workspaceRoot, batshitHomeMount)
        ? [batshitHomeMount]
        : []
    const createCommand = buildDockerSandboxCliCommand(cliKind, {
      action: 'create',
      sandboxName,
      workspaceRoot: options.workspaceRoot,
      extraWorkspaces
    })
    const createResult = await runProcessCommand({
      command: createCommand.command,
      args: createCommand.args,
      cwd: process.cwd(),
      timeoutMs: 90_000,
      maxOutputChars: 120_000
    }).catch((error) => {
      const maybeError = error as NodeJS.ErrnoException
      return {
        command: `${createCommand.command} ${createCommand.args.join(' ')}`,
        stdout: '',
        stderr: maybeError?.message || 'Failed to create Docker sandbox.',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 0,
        truncated: false
      } as CommandRunResult
    })

    if (createResult.timedOut || createResult.exitCode !== 0) {
      return {
        ok: false,
        code: 'SANDBOX_UNAVAILABLE',
        reason:
          createResult.stderr.trim() ||
          createResult.stdout.trim() ||
          'Failed to create Docker sandbox.'
      }
    }
  }

  // Always enforce an explicit network policy so behavior is deterministic.
  const policyCommand = buildDockerSandboxCliCommand(cliKind, {
    action: 'policy-deny-network',
    sandboxName
  })
  const networkPolicyResult = await runProcessCommand({
    command: policyCommand.command,
    args: policyCommand.args,
    cwd: process.cwd(),
    timeoutMs: DOCKER_SANDBOX_STATUS_TIMEOUT_MS,
    maxOutputChars: DOCKER_SANDBOX_STATUS_MAX_OUTPUT_CHARS
  }).catch((error) => {
    const maybeError = error as NodeJS.ErrnoException
    return {
      command: `${policyCommand.command} ${policyCommand.args.join(' ')}`,
      stdout: '',
      stderr: maybeError?.message || 'Failed to configure Docker sandbox network policy.',
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 0,
      truncated: false
    } as CommandRunResult
  })

  if (networkPolicyResult.timedOut || networkPolicyResult.exitCode !== 0) {
    return {
      ok: false,
      code: 'BACKEND_UNAVAILABLE',
      reason:
        networkPolicyResult.stderr.trim() ||
        networkPolicyResult.stdout.trim() ||
        cliKind === 'sbx'
          ? 'Failed to apply Docker sandbox network policy. If sbx reports that no default policy exists, run sbx policy set-default first and retry.'
          : 'Failed to apply Docker sandbox network policy.'
    }
  }

  return { ok: true, sandboxName, cli: cliKind }
}

export async function recoverSandboxBackend(options: {
  userId?: string
  workspaceRoot?: string | null
}): Promise<{
  success: boolean
  recovered: boolean
  backend: 'docker_sandbox'
  sandboxName: string | null
  workspaceRoot: string | null
  workspaceSource: 'explicit' | 'preferences' | 'fallback' | null
  policy: typeof DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT
  status: Awaited<ReturnType<typeof getSandboxBackendStatus>>
  error?: {
    code: NativeAutomationErrorCode
    message: string
  }
}> {
  const status = await getSandboxBackendStatus()
  if (status.dockerUnsupported) {
    return {
      success: false,
      recovered: false,
      backend: 'docker_sandbox',
      sandboxName: null,
      workspaceRoot: null,
      workspaceSource: null,
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      status,
      error: {
        code: 'SANDBOX_UNAVAILABLE',
        message: status.reason || CONTAINERIZED_DOCKER_SANDBOX_DISABLED_REASON
      }
    }
  }

  const workspaceResolution = await resolveSandboxRecoveryWorkspaceRoot({
    userId: options.userId,
    workspaceRoot: options.workspaceRoot ?? null
  })
  if ('blocked' in workspaceResolution) {
    return {
      success: false,
      recovered: false,
      backend: 'docker_sandbox',
      sandboxName: null,
      workspaceRoot: null,
      workspaceSource: null,
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      status,
      error: {
        code: 'INVALID_CONTEXT',
        message: workspaceResolution.reason
      }
    }
  }

  if (
    isBatshitContainerizedRuntime() &&
    containerizedDockerSandboxOperatorEnabled()
  ) {
    return await recoverDockerSandboxViaOperator({
      userId: options.userId,
      workspaceRoot: workspaceResolution.workspaceRoot
    })
  }

  const ensured = await ensureDockerSandboxReady({
    workspaceRoot: workspaceResolution.workspaceRoot,
    userId: options.userId
  })
  if (!ensured.ok) {
    return {
      success: false,
      recovered: false,
      backend: 'docker_sandbox',
      sandboxName: null,
      workspaceRoot: workspaceResolution.workspaceRoot,
      workspaceSource: workspaceResolution.source,
      policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
      status: await getSandboxBackendStatus(),
      error: {
        code: ensured.code,
        message: ensured.reason
      }
    }
  }

  return {
    success: true,
    recovered: true,
    backend: 'docker_sandbox',
    sandboxName: ensured.sandboxName,
    workspaceRoot: workspaceResolution.workspaceRoot,
    workspaceSource: workspaceResolution.source,
    policy: DOCKER_SANDBOX_NETWORK_POLICY_DEFAULT,
    status: await getSandboxBackendStatus()
  }
}

export async function recoverAppleContainerSandboxBackend(options: {
  userId?: string
  workspaceRoot?: string | null
}): Promise<{
  success: boolean
  recovered: boolean
  backend: 'apple_container'
  sandboxName: string | null
  workspaceRoot: string | null
  workspaceSource: 'explicit' | 'preferences' | 'fallback' | null
  status: Awaited<ReturnType<typeof getAppleContainerSandboxStatus>>
  error?: {
    code: NativeAutomationErrorCode
    message: string
  }
}> {
  const status = await getAppleContainerSandboxStatus()
  const workspaceResolution = await resolveSandboxRecoveryWorkspaceRoot({
    userId: options.userId,
    workspaceRoot: options.workspaceRoot ?? null
  })
  if ('blocked' in workspaceResolution) {
    return {
      success: false,
      recovered: false,
      backend: 'apple_container',
      sandboxName: null,
      workspaceRoot: null,
      workspaceSource: null,
      status,
      error: {
        code: 'INVALID_CONTEXT',
        message: workspaceResolution.reason
      }
    }
  }

  try {
    const recovered = await recoverAppleContainerSandbox({
      userId: options.userId,
      workspaceRoot: workspaceResolution.workspaceRoot,
      cwd: workspaceResolution.workspaceRoot
    })
    return {
      success: true,
      recovered: true,
      backend: 'apple_container',
      sandboxName: recovered.sandboxName,
      workspaceRoot: recovered.workspaceRoot,
      workspaceSource: workspaceResolution.source,
      status: await getAppleContainerSandboxStatus()
    }
  } catch (error) {
    return {
      success: false,
      recovered: false,
      backend: 'apple_container',
      sandboxName: null,
      workspaceRoot: workspaceResolution.workspaceRoot,
      workspaceSource: workspaceResolution.source,
      status: await getAppleContainerSandboxStatus(),
      error: {
        code: 'SANDBOX_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Apple Container sandbox recovery failed.'
      }
    }
  }
}

async function runBashCommand(options: {
  command: string
  cwd: string
  timeoutMs: number
  maxOutputChars?: number
  env?: Record<string, string>
}): Promise<CommandRunResult> {
  const maxOutputChars = options.maxOutputChars ?? MAX_BASH_OUTPUT_CHARS
  return await runProcessCommand({
    command: '/bin/zsh',
    args: ['-lc', options.command],
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    maxOutputChars,
    env: options.env
  })
}

async function runDockerSandboxCommand(options: {
  userId?: string
  sessionId?: string
  workspaceRoot: string
  cwd: string
  command: string
  timeoutMs: number
  maxOutputChars?: number
  env?: Record<string, string>
}): Promise<
  | { ok: true; run: CommandRunResult; sandboxName: string }
  | { ok: false; code: NativeAutomationErrorCode; reason: string; sandboxName?: string }
> {
  if (
    isBatshitContainerizedRuntime() &&
    containerizedDockerSandboxOperatorEnabled()
  ) {
    return await executeDockerSandboxViaOperator(options)
  }

  const ensured = await ensureDockerSandboxReady({
    workspaceRoot: options.workspaceRoot,
    userId: options.userId,
    sessionId: options.sessionId
  })
  if (!ensured.ok) {
    return ensured
  }

  const envArgs: string[] = []
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!key || typeof value !== 'string') continue
    envArgs.push('--env', `${key}=${value}`)
  }

  const maxOutputChars = options.maxOutputChars ?? MAX_BASH_OUTPUT_CHARS
  const execCommand = buildDockerSandboxCliCommand(ensured.cli, {
    action: 'exec',
    sandboxName: ensured.sandboxName,
    cwd: options.cwd,
    envArgs,
    commandText: options.command
  })
  const run = await runProcessCommand({
    command: execCommand.command,
    args: execCommand.args,
    cwd: process.cwd(),
    timeoutMs: options.timeoutMs,
    maxOutputChars
  }).catch((error) => {
    const maybeError = error as NodeJS.ErrnoException
    return {
      command: `${execCommand.command} ${execCommand.args.join(' ')}`,
      stdout: '',
      stderr: maybeError?.message || 'Failed to execute command in Docker sandbox.',
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 0,
      truncated: false
    } as CommandRunResult
  })

  if (!options.sessionId) {
    const cleanupWarnings: string[] = []
    const currentCleanupWarning = await bestEffortRemoveDockerSandbox(ensured.sandboxName)
    if (currentCleanupWarning) {
      cleanupWarnings.push(`${ensured.sandboxName}: ${currentCleanupWarning}`)
    }
    cleanupWarnings.push(...(await pruneStoppedManagedDockerSandboxes()))
    if (cleanupWarnings.length > 0) {
      console.warn(
        '[Native Tools] Docker sandbox cleanup warnings:',
        cleanupWarnings.join(' | ')
      )
    }
  }

  return {
    ok: true,
    run,
    sandboxName: ensured.sandboxName
  }
}

async function runAgentBrowserCli(
  request: AgentBrowserCliRunRequest
): Promise<AgentBrowserCliRunResult> {
  if (agentBrowserCliRunnerOverride) {
    return await agentBrowserCliRunnerOverride(request)
  }

  if (isBatshitContainerizedRuntime()) {
    return await runAgentBrowserSidecarCli(request)
  }

  const { command, args } = request
  const timeoutMs = clamp(request.timeoutMs, MIN_AGENT_BROWSER_TIMEOUT_MS, MAX_AGENT_BROWSER_TIMEOUT_MS)
  const maxOutputChars = request.maxOutputChars ?? MAX_AGENT_BROWSER_OUTPUT_CHARS
  const start = Date.now()

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: request.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(request.env ?? {})
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    child.stdout.on('data', (chunk) => {
      const next = appendWithLimit(stdout, String(chunk), maxOutputChars)
      stdout = next.text
      if (next.truncated) truncated = true
    })

    child.stderr.on('data', (chunk) => {
      const next = appendWithLimit(stderr, String(chunk), maxOutputChars)
      stderr = next.text
      if (next.truncated) truncated = true
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 400)
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer)
      resolve({
        command,
        args,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - start,
        truncated
      })
    })
  })
}

function resolveAgentBrowserCommandCandidates(): string[] {
  const custom =
    typeof env.BATSHIT_AGENT_BROWSER_BIN === 'string' && env.BATSHIT_AGENT_BROWSER_BIN.trim().length > 0
      ? env.BATSHIT_AGENT_BROWSER_BIN.trim()
      : typeof process.env.BATSHIT_AGENT_BROWSER_BIN === 'string'
        ? process.env.BATSHIT_AGENT_BROWSER_BIN.trim()
        : ''
  const candidates = [custom, 'agent-browser'].filter((entry) => entry.length > 0)
  return Array.from(new Set(candidates))
}

function parseJsonFromOutput(output: string): any | null {
  const trimmed = output.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
    for (const line of lines) {
      try {
        return JSON.parse(line)
      } catch {
        // continue
      }
    }
    return null
  }
}

function extractAgentBrowserErrorMessage(
  payload: any,
  parsedError: any,
  stderrText: string
): string {
  const payloadError =
    typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.result?.error === 'string'
        ? payload.result.error
        : typeof payload?.data?.error === 'string'
          ? payload.data.error
          : ''
  const parsedErrorValue = typeof parsedError?.error === 'string' ? parsedError.error : ''
  return (payloadError || parsedErrorValue || stderrText || '').trim()
}

function isAgentBrowserNotLaunchedError(errorMessage: string): boolean {
  return /browser not launched(?:\.?\s*call launch first)?/i.test(errorMessage)
}

function isAgentBrowserClosedContextError(errorMessage: string): boolean {
  if (!errorMessage) return false
  return (
    /browsercontext\.newpage:\s*target page, context or browser has been closed/i.test(errorMessage) ||
    /target page, context or browser has been closed/i.test(errorMessage)
  )
}

function isAgentBrowserRecoverableStartupError(errorMessage: string): boolean {
  return isAgentBrowserNotLaunchedError(errorMessage) || isAgentBrowserClosedContextError(errorMessage)
}

function resolveAgentBrowserBootstrapCliArgs(commandId: string, errorMessage: string): string[][] {
  if (!isAgentBrowserRecoverableStartupError(errorMessage)) return []
  if (commandId === 'close') return []
  return [['close'], ['tab', 'new']]
}

function isAgentBrowserBashRunFailure(run: {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}): boolean {
  if (run.timedOut) return true
  if (run.exitCode !== 0) return true

  const parsedStdout = parseJsonFromOutput(run.stdout)
  if (typeof parsedStdout?.success === 'boolean') return parsedStdout.success === false

  const parsedStderr = parseJsonFromOutput(run.stderr)
  if (typeof parsedStderr?.success === 'boolean') return parsedStderr.success === false

  return false
}

function extractAgentBrowserBashErrorMessage(run: { stdout: string; stderr: string }): string {
  const parsedStdout = parseJsonFromOutput(run.stdout)
  const parsedStderr = parseJsonFromOutput(run.stderr)
  const parsedErrorMessage = extractAgentBrowserErrorMessage(parsedStdout, parsedStderr, run.stderr)
  if (parsedErrorMessage) return parsedErrorMessage
  return [run.stderr, run.stdout]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function resolveAgentBrowserBashSubcommand(command: string): string {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) return ''

  const rest = parsedCommand.rest
  if (!rest) return ''

  const { primary } = splitAgentBrowserCommandAtChain(rest)
  if (!primary) return ''

  const tokens = splitShellWords(primary)
  if (tokens.length === 0) return ''

  const subcommandIndex = findAgentBrowserSubcommandIndex(tokens)
  if (subcommandIndex < 0) return ''

  const subcommand = tokens[subcommandIndex]
  return typeof subcommand === 'string' ? subcommand.trim().toLowerCase() : ''
}

function buildAgentBrowserBashBootstrapCommand(command: string, cliArgs: string[]): string | null {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) return null

  const { assignmentPrefix, launcher } = parsedCommand
  if (!launcher) return null

  const rebuiltParts: string[] = []
  if (assignmentPrefix.length > 0) rebuiltParts.push(assignmentPrefix)
  rebuiltParts.push(launcher)
  rebuiltParts.push(...cliArgs.map((arg) => shellEscape(arg)))

  return rebuiltParts.join(' ').trim()
}

function replaceAgentBrowserBashLauncher(command: string, launcher: string): string {
  const parsedCommand = parseAgentBrowserBashCommand(command)
  if (!parsedCommand) return command

  const { assignmentPrefix, rest } = parsedCommand

  const rebuiltParts: string[] = []
  if (assignmentPrefix.length > 0) rebuiltParts.push(assignmentPrefix)
  rebuiltParts.push(shellEscape(launcher))
  if (rest.length > 0) rebuiltParts.push(rest)

  return rebuiltParts.join(' ').trim()
}

function resolveAgentBrowserBashBootstrapCommands(command: string, errorMessage: string): string[] {
  const subcommand = resolveAgentBrowserBashSubcommand(command)
  const cliArgsList = resolveAgentBrowserBootstrapCliArgs(subcommand, errorMessage)
  return cliArgsList
    .map((cliArgs) => buildAgentBrowserBashBootstrapCommand(command, cliArgs))
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function resolveAgentBrowserSidecarUrl(): string {
  const configured =
    env.BATSHIT_AGENT_BROWSER_SIDECAR_URL?.trim() ||
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL?.trim()
  return (configured || AGENT_BROWSER_DOCKER_SIDECAR_DEFAULT_URL).replace(/\/+$/, '')
}

function resolveAgentBrowserSidecarToken(): string | null {
  const token =
    env.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN?.trim() ||
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN?.trim()
  return token || null
}

function buildAgentBrowserSidecarHeaders(includeJson = false): Record<string, string> {
  const token = resolveAgentBrowserSidecarToken()
  return {
    accept: 'application/json',
    ...(includeJson ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {})
  }
}

function normalizeAgentBrowserSidecarRun(
  payload: Record<string, any> | null,
  fallbackArgs: string[]
): AgentBrowserCliRunResult {
  const run = payload?.run && typeof payload.run === 'object' ? payload.run : payload
  return {
    command: typeof run?.command === 'string' ? run.command : 'agent-browser',
    args: Array.isArray(run?.args) ? run.args.map((entry: unknown) => String(entry)) : fallbackArgs,
    stdout: typeof run?.stdout === 'string' ? run.stdout : '',
    stderr: typeof run?.stderr === 'string' ? run.stderr : '',
    exitCode: typeof run?.exitCode === 'number' ? run.exitCode : null,
    signal: typeof run?.signal === 'string' ? (run.signal as NodeJS.Signals) : null,
    timedOut: run?.timedOut === true,
    durationMs: typeof run?.durationMs === 'number' ? run.durationMs : 0,
    truncated: run?.truncated === true
  }
}

async function fetchAgentBrowserSidecarHealth(): Promise<{
  ok: boolean
  url: string
  version: string | null
  reason: string | null
  payload: Record<string, any> | null
}> {
  const url = resolveAgentBrowserSidecarUrl()
  try {
    const response = await fetch(`${url}/health`, {
      headers: buildAgentBrowserSidecarHeaders(false)
    })
    const payload = (await response.json().catch(() => null)) as Record<string, any> | null
    const ok = response.ok && payload?.ok !== false
    return {
      ok,
      url,
      version: typeof payload?.version === 'string' ? payload.version : null,
      reason: ok
        ? null
        : typeof payload?.error === 'string'
          ? payload.error
          : `Docker Agent Browser sidecar returned HTTP ${response.status}.`,
      payload
    }
  } catch (error) {
    return {
      ok: false,
      url,
      version: null,
      reason:
        error instanceof Error
          ? `Docker Agent Browser sidecar is not reachable: ${error.message}`
          : 'Docker Agent Browser sidecar is not reachable.',
      payload: null
    }
  }
}

async function runAgentBrowserSidecarCli(
  request: AgentBrowserCliRunRequest
): Promise<AgentBrowserCliRunResult> {
  const url = resolveAgentBrowserSidecarUrl()
  const response = await fetch(`${url}/v1/run`, {
    method: 'POST',
    headers: buildAgentBrowserSidecarHeaders(true),
    body: JSON.stringify({
      args: request.args,
      env: request.env ?? {},
      timeoutMs: request.timeoutMs,
      maxOutputChars: request.maxOutputChars
    })
  })
  const payload = (await response.json().catch(() => null)) as Record<string, any> | null
  if (!response.ok) {
    throw new Error(
      typeof payload?.error === 'string'
        ? payload.error
        : `Docker Agent Browser sidecar returned HTTP ${response.status}.`
    )
  }
  return normalizeAgentBrowserSidecarRun(payload, request.args)
}

async function checkAgentBrowserAvailability(): Promise<{
  available: boolean
  command?: string
  version?: string
  reason?: string
  supported?: boolean
  dockerUnsupported?: boolean
  supportLevel?: AgentBrowserSupportLevel
}> {
  if (isBatshitContainerizedRuntime()) {
    const health = await fetchAgentBrowserSidecarHealth()
    return {
      available: health.ok,
      command: health.ok ? 'agent-browser' : undefined,
      version: health.version ?? undefined,
      reason: health.ok ? undefined : health.reason ?? DOCKER_AGENT_BROWSER_UNSUPPORTED_REASON,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'docker-sidecar'
    }
  }

  const candidates = resolveAgentBrowserCommandCandidates()
  if (candidates.length === 0) {
    return {
      available: false,
      reason: `No agent-browser binary configured. ${AGENT_BROWSER_INSTALL_HELP}`
    }
  }

  let lastError: string | null = null

  for (const command of candidates) {
    try {
      const probe = await runAgentBrowserCli({
        command,
        args: ['--version'],
        timeoutMs: 5_000,
        maxOutputChars: 4_096
      })
      if (probe.exitCode === 0) {
        const versionOutput = probe.stdout.trim() || probe.stderr.trim()
        return {
          available: true,
          command,
          version: versionOutput || 'unknown',
          supportLevel: 'native-cli'
        }
      }
      const stderr = probe.stderr.trim()
      lastError = stderr || `agent-browser exited with code ${probe.exitCode ?? 'unknown'}`
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      if (maybeError?.code === 'ENOENT') {
        lastError = `Command not found: ${command}`
        continue
      }
      lastError = maybeError?.message || String(error)
    }
  }

  return {
    available: false,
    reason: `${lastError || 'agent-browser is unavailable.'} ${AGENT_BROWSER_INSTALL_HELP}`,
    supportLevel: 'native-cli'
  }
}

function normalizeAgentBrowserVersion(value: string | null | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const semverMatch = trimmed.match(/(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/)
  if (semverMatch?.[1]) return semverMatch[1]
  return trimmed.split(/\s+/)[0] || null
}

export async function getAgentBrowserRuntimeStatus(): Promise<{
  installed: boolean
  supported: boolean
  dockerUnsupported: boolean
  supportLevel: AgentBrowserSupportLevel
  installScope: 'native-cli' | 'docker-sidecar'
  command: string | null
  version: string | null
  reason: string | null
  installCommand: string
  installHelp: string
  testedVersion: string
  packageSpec: string
  packageTarballUrl: string
  packageIntegrity: string
  runtimeMatchesTestedVersion: boolean | null
}> {
  const availability = await checkAgentBrowserAvailability()
  const normalizedVersion = normalizeAgentBrowserVersion(availability.version)
  const runtimeMatchesTestedVersion =
    availability.available && normalizedVersion
      ? normalizedVersion === AGENT_BROWSER_TESTED_VERSION
      : null
  const reason =
    availability.reason ??
    (availability.available && runtimeMatchesTestedVersion === false
      ? `Installed Agent Browser ${normalizedVersion} differs from Batshit's tested runtime ${AGENT_BROWSER_TESTED_VERSION}. Reinstall from Admin to realign.`
      : AGENT_BROWSER_TESTED_VERSION_NOTE)
  return {
    installed: availability.available,
    supported: availability.supported !== false,
    dockerUnsupported: availability.dockerUnsupported === true,
    supportLevel: availability.supportLevel ?? 'native-cli',
    installScope: availability.supportLevel === 'docker-sidecar' ? 'docker-sidecar' : 'native-cli',
    command: availability.command ?? null,
    version: normalizedVersion ?? availability.version ?? null,
    reason,
    installCommand: AGENT_BROWSER_INSTALL_COMMAND,
    installHelp:
      availability.supportLevel === 'docker-sidecar'
        ? DOCKER_AGENT_BROWSER_INSTALL_HELP
        : AGENT_BROWSER_INSTALL_HELP,
    testedVersion: AGENT_BROWSER_TESTED_VERSION,
    packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
    packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
    packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
    runtimeMatchesTestedVersion
  }
}

export async function installAgentBrowserRuntime(): Promise<{
  installed: boolean
  supported: boolean
  dockerUnsupported: boolean
  command: string | null
  version: string | null
  reason: string | null
  installCommand: string
  installHelp: string
  testedVersion: string
  packageSpec: string
  packageTarballUrl: string
  packageIntegrity: string
  runtimeMatchesTestedVersion: boolean | null
  run: {
    command: string
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut: boolean
    durationMs: number
    truncated: boolean
  } | null
}> {
  if (isBatshitContainerizedRuntime()) {
    const status = await getAgentBrowserRuntimeStatus()
    return {
      installed: status.installed,
      supported: true,
      dockerUnsupported: true,
      command: status.command,
      version: status.version,
      reason: DOCKER_AGENT_BROWSER_INSTALL_HELP,
      installCommand: AGENT_BROWSER_INSTALL_COMMAND,
      installHelp: DOCKER_AGENT_BROWSER_INSTALL_HELP,
      testedVersion: AGENT_BROWSER_TESTED_VERSION,
      packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
      packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
      packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
      runtimeMatchesTestedVersion: status.runtimeMatchesTestedVersion,
      run: null
    }
  }

  try {
    const run = await runBashCommand({
      command: AGENT_BROWSER_INSTALL_COMMAND,
      cwd: process.cwd(),
      timeoutMs: AGENT_BROWSER_INSTALL_TIMEOUT_MS,
      maxOutputChars: AGENT_BROWSER_INSTALL_MAX_OUTPUT_CHARS
    })
    const status = await getAgentBrowserRuntimeStatus()
    const failed = run.exitCode !== 0 || run.timedOut || !status.installed
    return {
      installed: failed ? false : status.installed,
      supported: status.supported,
      dockerUnsupported: status.dockerUnsupported,
      command: status.command,
      version: status.version,
      reason:
        run.timedOut
          ? 'Agent Browser install command timed out.'
          : run.exitCode !== 0
            ? run.stderr.trim() || run.stdout.trim() || status.reason
            : status.reason,
      installCommand: AGENT_BROWSER_INSTALL_COMMAND,
      installHelp: AGENT_BROWSER_INSTALL_HELP,
      testedVersion: AGENT_BROWSER_TESTED_VERSION,
      packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
      packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
      packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
      runtimeMatchesTestedVersion: status.runtimeMatchesTestedVersion,
      run: {
        command: run.command,
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        truncated: run.truncated
      }
    }
  } catch (error) {
    return {
      installed: false,
      supported: true,
      dockerUnsupported: false,
      command: null,
      version: null,
      reason: error instanceof Error ? error.message : 'Agent Browser install failed.',
      installCommand: AGENT_BROWSER_INSTALL_COMMAND,
      installHelp: AGENT_BROWSER_INSTALL_HELP,
      testedVersion: AGENT_BROWSER_TESTED_VERSION,
      packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
      packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
      packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
      runtimeMatchesTestedVersion: null,
      run: null
    }
  }
}

export async function uninstallAgentBrowserRuntime(): Promise<{
  uninstalled: boolean
  installed: boolean
  supported: boolean
  dockerUnsupported: boolean
  command: string | null
  version: string | null
  reason: string | null
  uninstallCommand: string
  installCommand: string
  installHelp: string
  testedVersion: string
  packageSpec: string
  packageTarballUrl: string
  packageIntegrity: string
  runtimeMatchesTestedVersion: boolean | null
  run: {
    command: string
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut: boolean
    durationMs: number
    truncated: boolean
  } | null
}> {
  if (isBatshitContainerizedRuntime()) {
    const status = await getAgentBrowserRuntimeStatus()
    return {
      uninstalled: false,
      installed: status.installed,
      supported: true,
      dockerUnsupported: true,
      command: status.command,
      version: status.version,
      reason: DOCKER_AGENT_BROWSER_INSTALL_HELP,
      uninstallCommand: AGENT_BROWSER_UNINSTALL_COMMAND,
      installCommand: AGENT_BROWSER_INSTALL_COMMAND,
      installHelp: DOCKER_AGENT_BROWSER_INSTALL_HELP,
      testedVersion: AGENT_BROWSER_TESTED_VERSION,
      packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
      packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
      packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
      runtimeMatchesTestedVersion: status.runtimeMatchesTestedVersion,
      run: null
    }
  }

  try {
    const run = await runBashCommand({
      command: AGENT_BROWSER_UNINSTALL_COMMAND,
      cwd: process.cwd(),
      timeoutMs: AGENT_BROWSER_UNINSTALL_TIMEOUT_MS,
      maxOutputChars: AGENT_BROWSER_UNINSTALL_MAX_OUTPUT_CHARS
    })
    const status = await getAgentBrowserRuntimeStatus()
    const uninstalled = run.exitCode === 0 && run.timedOut === false && status.installed === false
    return {
      uninstalled,
      installed: status.installed,
      supported: status.supported,
      dockerUnsupported: status.dockerUnsupported,
      command: status.command,
      version: status.version,
      reason:
        run.timedOut
          ? 'Agent Browser uninstall command timed out.'
          : run.exitCode !== 0
            ? run.stderr.trim() || run.stdout.trim() || status.reason
            : status.installed
              ? 'Agent Browser command is still available after uninstall (it may be managed outside npm -g).'
              : status.reason,
      uninstallCommand: AGENT_BROWSER_UNINSTALL_COMMAND,
      installCommand: AGENT_BROWSER_INSTALL_COMMAND,
      installHelp: AGENT_BROWSER_INSTALL_HELP,
      testedVersion: AGENT_BROWSER_TESTED_VERSION,
      packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
      packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
      packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
      runtimeMatchesTestedVersion: status.runtimeMatchesTestedVersion,
      run: {
        command: run.command,
        stdout: run.stdout,
        stderr: run.stderr,
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
        truncated: run.truncated
      }
    }
  } catch (error) {
    return {
      uninstalled: false,
      installed: true,
      supported: true,
      dockerUnsupported: false,
      command: null,
      version: null,
      reason: error instanceof Error ? error.message : 'Agent Browser uninstall failed.',
      uninstallCommand: AGENT_BROWSER_UNINSTALL_COMMAND,
      installCommand: AGENT_BROWSER_INSTALL_COMMAND,
      installHelp: AGENT_BROWSER_INSTALL_HELP,
      testedVersion: AGENT_BROWSER_TESTED_VERSION,
      packageSpec: AGENT_BROWSER_TESTED_PACKAGE_SPEC,
      packageTarballUrl: AGENT_BROWSER_TESTED_TARBALL_URL,
      packageIntegrity: AGENT_BROWSER_TESTED_INTEGRITY,
      runtimeMatchesTestedVersion: null,
      run: null
    }
  }
}

async function resolveAgentBrowserProviderEnv(options: {
  userId: string
  provider: AgentBrowserProvider
}): Promise<
  | { env: Record<string, string>; hasCredential: true }
  | { env: Record<string, string>; hasCredential: false; reason: string }
> {
  if (options.provider === 'local') {
    return { env: {}, hasCredential: true }
  }

  if (options.provider === 'browserbase') {
    const key = (await apiKeyService.retrieve('browserbase', options.userId).catch(() => null))?.trim()
    if (!key) {
      return {
        env: {},
        hasCredential: false,
        reason: 'Browserbase key is missing. Add it in Settings -> API Keys -> Agent Browser Cloud Providers.'
      }
    }

    const projectId = (
      await apiKeyService.retrieve('browserbase_project_id', options.userId).catch(() => null)
    )?.trim()
    if (!projectId) {
      return {
        env: {},
        hasCredential: false,
        reason:
          'Browserbase Project ID is missing. Add it in Settings -> API Keys -> Agent Browser Cloud Providers.'
      }
    }

    const apiUrl = (
      await apiKeyService.retrieve('browserbase_api_url', options.userId).catch(() => null)
    )?.trim()

    const env: Record<string, string> = {
      BROWSERBASE_API_KEY: key,
      BROWSERBASE_PROJECT_ID: projectId
    }
    if (apiUrl) {
      env.BROWSERBASE_API_URL = apiUrl
      env.BROWSERBASE_URL = apiUrl
    }

    return {
      env,
      hasCredential: true
    }
  }

  if (options.provider === 'browseruse') {
    const key = (await apiKeyService.retrieve('browseruse', options.userId).catch(() => null))?.trim()
    if (!key) {
      return {
        env: {},
        hasCredential: false,
        reason: 'Browser Use key is missing. Add it in Settings -> API Keys -> Agent Browser Cloud Providers.'
      }
    }

    const baseUrl = (
      await apiKeyService.retrieve('browseruse_base_url', options.userId).catch(() => null)
    )?.trim()

    const env: Record<string, string> = {
      BROWSER_USE_API_KEY: key,
      BROWSERUSE_API_KEY: key
    }
    if (baseUrl) {
      env.BROWSER_USE_BASE_URL = baseUrl
      env.BROWSERUSE_BASE_URL = baseUrl
    }

    return {
      env,
      hasCredential: true
    }
  }

  const key = (await apiKeyService.retrieve('kernel', options.userId).catch(() => null))?.trim()
  if (!key) {
    return {
      env: {},
      hasCredential: false,
      reason: 'Kernel key is missing. Add it in Settings -> API Keys -> Agent Browser Cloud Providers.'
    }
  }

  const baseUrl = (await apiKeyService.retrieve('kernel_base_url', options.userId).catch(() => null))?.trim()
  const env: Record<string, string> = {
    KERNEL_API_KEY: key
  }
  if (baseUrl) {
    env.KERNEL_BASE_URL = baseUrl
    env.KERNEL_API_URL = baseUrl
  }

  return {
    env,
    hasCredential: true
  }
}

function buildAgentBrowserCommandArgs(
  command: AgentBrowserCommandSpec,
  params: AgentBrowserUseParams
): string[] {
  const args = toAgentBrowserArgArray(params.args)
  if (args.length > 0) return args

  switch (command.id) {
    case 'open': {
      const url = typeof params.url === 'string' ? params.url.trim() : ''
      return url ? [url] : []
    }
    case 'click':
    case 'get_text':
    case 'is_visible':
    case 'is_enabled':
    case 'is_checked':
    case 'is_disabled':
    case 'is_editable':
    case 'is_empty': {
      const selector = typeof params.selector === 'string' ? params.selector.trim() : ''
      return selector ? [selector] : []
    }
    case 'fill':
    case 'type': {
      const selector = typeof params.selector === 'string' ? params.selector.trim() : ''
      const text = typeof params.text === 'string' ? params.text : ''
      return selector && text ? [selector, text] : []
    }
    case 'press': {
      const key = typeof params.key === 'string' ? params.key.trim() : ''
      return key ? [key] : []
    }
    case 'scroll': {
      const direction = typeof params.direction === 'string' ? params.direction.trim().toLowerCase() : ''
      const pixels =
        typeof params.pixels === 'number' && Number.isFinite(params.pixels)
          ? String(Math.floor(params.pixels))
          : ''
      return [direction, pixels].filter(Boolean)
    }
    case 'wait': {
      const waitFor = params.waitFor
      if (typeof waitFor === 'number' && Number.isFinite(waitFor)) return [String(Math.floor(waitFor))]
      if (typeof waitFor === 'string' && waitFor.trim().length > 0) return [waitFor.trim()]
      return []
    }
    case 'screenshot': {
      const filePath = typeof params.path === 'string' ? params.path.trim() : ''
      return filePath ? [filePath] : []
    }
    case 'eval': {
      const js = typeof params.javascript === 'string' ? params.javascript : ''
      return js ? [js] : []
    }
    case 'launch':
    case 'tab_new':
      return []
    default:
      return []
  }
}

function sanitizeScreenshotFilename(rawValue: string): string {
  const baseName = path.basename(rawValue || '').trim()
  if (!baseName) return ''
  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
  return sanitized
}

async function resolveBatshitRuntimeTmpDir(): Promise<string> {
  const tmpDir = resolveBatshitRuntimeTmpRoot()
  await mkdir(tmpDir, {
    recursive: true,
    mode: 0o700
  })
  return tmpDir
}

async function buildDefaultAgentBrowserScreenshotPath(requestedPath?: string): Promise<string> {
  const safeRequestedName =
    typeof requestedPath === 'string' && requestedPath.trim().length > 0
      ? sanitizeScreenshotFilename(requestedPath.trim())
      : ''
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const random = randomUUID().replace(/-/g, '').slice(0, 8)
  const generatedName = `${AGENT_BROWSER_TMP_FILE_PREFIX}${timestamp}-${random}.png`
  const fileName = safeRequestedName || generatedName
  const finalName = path.extname(fileName) ? fileName : `${fileName}.png`

  try {
    const tempDir = await resolveBatshitRuntimeTmpDir()
    return path.join(tempDir, finalName)
  } catch {
    return path.join(os.tmpdir(), generatedName)
  }
}

async function resolveAgentBrowserScreenshotUploadConfig(
  userId: string
): Promise<Awaited<ReturnType<typeof resolveUploadConfigForScreenshot>>> {
  try {
    const userSettings = await redis.getUserSettings(userId)
    return resolveUploadConfigForScreenshot(userSettings, {
      onManagedTunnelUnavailable(details) {
        console.warn(
          '[Native Agent Browser] Managed Cloudflare tunnel unavailable for screenshot upload:',
          details
        )
      }
    })
  } catch (error) {
    console.warn('[Native Agent Browser] Failed to resolve screenshot upload config:', error)
    return null
  }
}

async function uploadAgentBrowserScreenshotForModel(options: {
  userId: string
  sessionId?: string
  filePath: string
  mediaType: string
}): Promise<string | null> {
  const { userId, filePath, mediaType } = options
  const uploadConfig = await resolveAgentBrowserScreenshotUploadConfig(userId)
  if (!uploadConfig) return null

  let fileBytes: Buffer
  let fileName: string
  try {
    const bytes = await readFileWithinLimit(filePath, MAX_AGENT_BROWSER_SCREENSHOT_BYTES)
    if (!bytes) {
      console.warn('[Native Agent Browser] Screenshot unavailable for model upload')
      return null
    }
    fileBytes = bytes
    fileName = path.basename(filePath)
  } catch {
    console.warn('[Native Agent Browser] Unable to read screenshot for upload')
    return null
  }

  try {
    const formData = new FormData()
    const blob = bytesToBlob(fileBytes, { type: mediaType || 'image/png' })
    formData.append('file', blob, fileName)
    formData.append('sessionId', options.sessionId || `agent-browser-${Date.now()}`)
    formData.append('userId', userId)
    formData.append(
      'compressionSettings',
      JSON.stringify({
        compress_images: false,
        force_jpeg: false
      })
    )
    formData.append(
      'uploadSettings',
      JSON.stringify({
        strategy: uploadConfig.strategy,
        storage_mode: uploadConfig.storageMode,
        tunnel_url: uploadConfig.tunnelUrl,
        use_https: uploadConfig.useHttps,
        tunnel_provider: uploadConfig.tunnelProvider,
        cloudflared_auto_start: uploadConfig.cloudflaredAutoStart,
        cloudflared_target_url: uploadConfig.cloudflaredTargetUrl,
        artifact_source: 'agent_browser_screenshot',
        skip_clip_persistence: true,
        artifact_ttl_seconds: AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
        strategyConfig: {
          ttlSeconds: AGENT_BROWSER_SCREENSHOT_ARTIFACT_TTL_SECONDS,
          ephemeral: true
        }
      })
    )

    const response = await fetch(`${getInternalBatshitServerUrl()}/api/upload/single`, {
      method: 'POST',
      headers: getInternalBatshitServerAuthHeaders(),
      body: formData
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      console.warn('[Native Agent Browser] Screenshot upload failed:', {
        status: response.status,
        error: payload?.error || payload?.details || null
      })
      return null
    }

    return resolveScreenshotUploadModelUrl(payload?.file, uploadConfig)
  } catch (error) {
    console.warn('[Native Agent Browser] Screenshot upload request failed:', error)
    return null
  }
}

async function cleanupAgentBrowserScreenshotFile(filePath?: string | null): Promise<void> {
  if (!filePath) return
  try {
    await unlink(filePath)
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String((error as any).code) : null
    if (code !== 'ENOENT') {
      console.warn('[Native Agent Browser] Failed to clean up screenshot file:', {
        path: filePath,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
}

export function __setAgentBrowserCliRunnerForTests(
  runner: ((request: AgentBrowserCliRunRequest) => Promise<AgentBrowserCliRunResult>) | null
): void {
  agentBrowserCliRunnerOverride = runner
}

async function nativeFetchZip(input: {
  userId: string
  zipId: string
  includeContent?: boolean
  maxChars?: number
}): Promise<Record<string, any>> {
  const zipData = await redis.getZip(input.zipId)
  if (!zipData || typeof zipData !== 'object') {
    return {
      found: false,
      zipId: input.zipId
    }
  }

  const sessionId =
    (zipData as any)?.metadata?.sessionId ||
    (zipData as any)?.metadata?.session_id ||
    null

  if (sessionId) {
    const session = await redis.getSession(sessionId)
    const owner = (session as any)?.user_id || (session as any)?.userId || null
    if (owner && owner !== input.userId) {
      return {
        found: false,
        zipId: input.zipId,
        reason: 'Zip belongs to a different user.'
      }
    }
  }

  const fullContent = typeof (zipData as any).content === 'string' ? (zipData as any).content : ''
  const includeContent = input.includeContent !== false
  const maxChars = clamp(input.maxChars ?? DEFAULT_ZIP_CHARS, 64, MAX_ZIP_CHARS)
  const content = includeContent ? fullContent.slice(0, maxChars) : undefined

  return {
    found: true,
    zipId: (zipData as any).id ?? input.zipId,
    type: (zipData as any).type ?? 'unknown',
    tokens: (zipData as any).tokens ?? null,
    description: (zipData as any).description ?? null,
    createdAt: (zipData as any).created_at ?? (zipData as any).createdAt ?? null,
    metadata: (zipData as any).metadata ?? {},
    ...(includeContent
      ? {
          content,
          contentLength: fullContent.length,
          contentTruncated: fullContent.length > maxChars
        }
      : {})
  }
}

async function nativeDynamicMcpFind(input: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  query?: string
  tool?: string
  group?: string | string[]
  exact?: boolean
  limit?: number
  selectedGateways?: string[]
  includeSchema?: boolean
  dcmDisplaySettings?: import('$lib/types/database').AgentDcmDisplaySettings | null
  projectPath?: string | null
  gatewayToolsCache?: GatewayToolsCache
}): Promise<Record<string, any>> {
  return executeSharedDynamicMcpFind({
    userId: input.userId,
    agentId: input.agentId ?? null,
    agentMetadata: input.agentMetadata ?? null,
    query: input.query,
    tool: input.tool,
    group: input.group,
    exact: input.exact,
    limit: input.limit,
    selectedGateways: input.selectedGateways,
    includeSchema: input.includeSchema,
    dcmDisplaySettings: input.dcmDisplaySettings ?? null,
    projectPath: input.projectPath ?? null,
    gatewayToolsCache: input.gatewayToolsCache
  })
}

async function nativeDynamicMcpUse(input: {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  toolName: string
  params?: Record<string, any>
  selectedGateways?: string[]
  dcmDisplaySettings?: import('$lib/types/database').AgentDcmDisplaySettings | null
  projectPath?: string | null
  gatewayToolsCache?: GatewayToolsCache
}): Promise<Record<string, any>> {
  return executeSharedDynamicMcpUse({
    userId: input.userId,
    agentId: input.agentId ?? null,
    agentMetadata: input.agentMetadata ?? null,
    toolName: input.toolName,
    params: input.params,
    selectedGateways: input.selectedGateways,
    dcmDisplaySettings: input.dcmDisplaySettings ?? null,
    projectPath: input.projectPath ?? null,
    gatewayToolsCache: input.gatewayToolsCache,
    internalToolError: `Tool "${input.toolName.trim()}" is internal-only and not callable through Batshit Tool Use.`
  })
}

async function nativeCliToolFind(input: {
  userId: string
  agentId?: string | null
  query?: string
  limit?: number
  includeSchema?: boolean
  selectedCliToolIds?: string[]
}): Promise<Record<string, any>> {
  return await findCliTools({
    userId: input.userId,
    agentId: input.agentId ?? null,
    selectedToolIds: input.selectedCliToolIds,
    query: input.query,
    limit: input.limit,
    includeSchema: input.includeSchema
  })
}

async function nativeCliToolUse(input: {
  userId: string
  agentId?: string | null
  sessionId?: string
  toolId: string
  cliInput?: Record<string, any>
  allowRisky?: boolean
  projectPath?: string | null
  selectedCliToolIds?: string[]
}): Promise<Record<string, any>> {
  const toolId = input.toolId.trim()
  const cliInput =
    input.cliInput && typeof input.cliInput === 'object' && !Array.isArray(input.cliInput)
      ? input.cliInput
      : {}

  return await executeCliTool({
    userId: input.userId,
    agentId: input.agentId ?? null,
    sessionId: input.sessionId,
    toolId,
    input: cliInput,
    selectedToolIds: input.selectedCliToolIds,
    allowRisky: input.allowRisky === true,
    projectPath: input.projectPath ?? null
  })
}

function buildBatshitToolUseExample(ref: string, inputHint: string): string {
  if (inputHint.includes('no input')) {
    return `native_batshit_tool_use({ ref: "${ref}" })`
  }
  const objectHintMatch = inputHint.match(/input:\s*\{\s*([^}]+?)\s*\}/i)
  if (objectHintMatch?.[1]) {
    const fields = objectHintMatch[1]
      .split(',')
      .map((part) => part.trim())
      .map((part) => {
        const name = part.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*(?::|\s)/)?.[1]
        if (!name || name === '...' || name.toLowerCase() === 'input') return null
        const normalized = part.toLowerCase()
        let placeholder = '"<value>"'
        if (normalized.includes('boolean')) placeholder = 'false'
        else if (normalized.includes('number') || normalized.includes('integer')) placeholder = '0'
        else if (normalized.includes('array')) placeholder = '[]'
        else if (normalized.includes('object')) placeholder = '{}'
        else if (normalized.includes('string') || normalized.includes('path')) placeholder = '"<string>"'
        return `${name}: ${placeholder}`
      })
      .filter((entry): entry is string => Boolean(entry))
      .slice(0, 4)
    if (fields.length > 0) {
      return `native_batshit_tool_use({ ref: "${ref}", input: { ${fields.join(', ')} } })`
    }
  }
  return `native_batshit_tool_use({ ref: "${ref}", input: { ... } })`
}

function mapMcpSearchResult(entry: Record<string, any>, schemaMode: BatshitToolSchemaMode): BatshitToolSearchResult {
  const toolName = typeof entry.toolName === 'string' ? entry.toolName : 'unknown-tool'
  const title =
    typeof entry.originalToolName === 'string' && entry.originalToolName.trim().length > 0
      ? entry.originalToolName.trim()
      : toolName
  const description = typeof entry.description === 'string' ? entry.description : ''
  const inputSchema =
    entry.inputSchema && typeof entry.inputSchema === 'object'
      ? (entry.inputSchema as Record<string, any>)
      : undefined
  const hint =
    schemaMode === 'none'
      ? undefined
      : buildCompactJsonSchemaHint(inputSchema) ??
        'input: MCP params object. Use schemaMode="full" if this tool needs exact fields.'
  const ref = buildBatshitToolRef('mcp', toolName)
  return {
    ref,
    family: 'mcp',
    title,
    description,
    hint,
    useExample: buildBatshitToolUseExample(ref, hint ?? ''),
    source:
      typeof entry.gatewayName === 'string' && entry.gatewayName.trim().length > 0
        ? entry.gatewayName
        : typeof entry.groupName === 'string'
          ? entry.groupName
          : undefined,
    ...(schemaMode === 'full' && inputSchema ? { inputSchema } : {}),
    raw: entry
  }
}

function mapCliSearchResult(entry: Record<string, any>, schemaMode: BatshitToolSchemaMode): BatshitToolSearchResult {
  const toolId = typeof entry.toolId === 'string' ? entry.toolId : 'unknown-tool'
  const title = typeof entry.title === 'string' ? entry.title : toolId
  const description = typeof entry.description === 'string' ? entry.description : ''
  const inputSchema =
    entry.inputSchema && typeof entry.inputSchema === 'object'
      ? (entry.inputSchema as Record<string, any>)
      : undefined
  const hint =
    schemaMode === 'none'
      ? undefined
      : typeof entry.schemaHint === 'string' && entry.schemaHint.trim().length > 0
        ? `input: { ${entry.schemaHint.trim()} }`
        : buildCompactJsonSchemaHint(inputSchema) ??
          'input: CLI manifest fields go inside input, not beside ref.'
  const ref = buildBatshitToolRef('cli', toolId)
  return {
    ref,
    family: 'cli',
    title,
    description,
    hint,
    useExample: buildBatshitToolUseExample(ref, hint ?? ''),
    source: typeof entry.executable === 'string' ? entry.executable : undefined,
    ...(schemaMode === 'full' && inputSchema ? { inputSchema } : {}),
    raw: entry
  }
}

function mapControlSearchResult(
  family: 'artifact' | 'fabric',
  entry: Record<string, any>,
  schemaMode: BatshitToolSchemaMode
): BatshitToolSearchResult {
  const controlId = typeof entry.controlId === 'string' ? entry.controlId : 'unknown-control'
  const title = typeof entry.title === 'string' ? entry.title : controlId
  const description = typeof entry.description === 'string' ? entry.description : ''
  const inputSchema =
    entry.inputSchema && typeof entry.inputSchema === 'object'
      ? (entry.inputSchema as Record<string, any>)
      : undefined
  const schemaHint =
    typeof entry.schemaHint === 'string' && entry.schemaHint.trim().length > 0
      ? entry.schemaHint.trim()
      : null
  const hint =
    schemaMode === 'none'
      ? undefined
      : schemaHint
        ? `input: ${schemaHint}`
        : buildCompactJsonSchemaHint(inputSchema) ??
          'input: structured control fields. Use schemaMode="full" if unclear.'
  const ref = buildBatshitToolRef(family, controlId)
  const risk =
    entry.riskLevel === 'confirm' || entry.riskLevel === 'restricted' ? entry.riskLevel : 'safe'
  return {
    ref,
    family,
    title,
    description,
    hint,
    useExample: buildBatshitToolUseExample(ref, hint ?? ''),
    riskLevel: risk,
    source: typeof entry.sourceType === 'string' ? entry.sourceType : undefined,
    ...(schemaMode === 'full' && inputSchema ? { inputSchema } : {}),
    raw: entry
  }
}

type NativeFabricHelperControlDefinition = {
  controlId: string
  title: string
  description: string
  inputSchema: Record<string, any>
  schemaHint: string
  tags: string[]
}

// Input schemas stay here with the execution code; identity/title/hint live in the shared
// catalog so the DCM capability index can count this family without importing this module.
const NATIVE_FABRIC_HELPER_INPUT_SCHEMAS: Record<string, Record<string, any>> = {
  [FABRIC_FETCH_ZIP_CONTROL_ID]: ZIP_FETCH_INPUT_SCHEMA_JSON,
  [FABRIC_COMFYUI_WORKFLOWS_CONTROL_ID]: COMFYUI_WORKFLOWS_INPUT_SCHEMA_JSON,
  [FABRIC_COMFYUI_OBJECT_INFO_CONTROL_ID]: COMFYUI_OBJECT_INFO_INPUT_SCHEMA_JSON
}

const NATIVE_FABRIC_HELPER_CONTROLS: NativeFabricHelperControlDefinition[] =
  NATIVE_FABRIC_HELPER_CONTROL_META.map((meta) => ({
    controlId: meta.controlId,
    title: meta.title,
    description: meta.description,
    schemaHint: meta.schemaHint,
    tags: meta.tags,
    inputSchema: NATIVE_FABRIC_HELPER_INPUT_SCHEMAS[meta.controlId]
  }))

function allowedControlEntryIsNativeFabricHelperOnly(entry: string): boolean {
  const normalized = entry.trim()
  if (!normalized) return false
  if (normalized === FABRIC_COMFYUI_ALLOWED_CONTROL_ID) return true
  return NATIVE_FABRIC_HELPER_CONTROLS.some((definition) => definition.controlId === normalized)
}

function isNativeFabricHelperControlId(controlId: string): boolean {
  const normalized = controlId.trim()
  if (!normalized) return false
  return NATIVE_FABRIC_HELPER_CONTROLS.some((definition) => definition.controlId === normalized)
}

function scoreNativeFabricHelperMatch(query: string, definition: NativeFabricHelperControlDefinition): number {
  if (!query) return 1
  const normalizedQuery = query.trim().toLowerCase()
  const haystack = [
    definition.controlId,
    definition.title,
    definition.description,
    definition.schemaHint,
    ...definition.tags
  ].join(' ').toLowerCase()
  if (definition.controlId.toLowerCase() === normalizedQuery) return 300
  if (definition.controlId.toLowerCase().includes(normalizedQuery)) return 160
  if (definition.title.toLowerCase().includes(normalizedQuery)) return 120
  if (haystack.includes(normalizedQuery)) return 80

  const queryTokens = tokenizeSearchTerms(normalizedQuery)
  if (queryTokens.length === 0) return 0
  const haystackTokens = new Set(tokenizeSearchTerms(haystack))
  let matched = 0
  for (const token of queryTokens) {
    if (haystackTokens.has(token)) matched += 1
  }
  if (matched === queryTokens.length) return 60 + matched
  if (matched > 0) return 25 + matched
  return 0
}

function findNativeFabricHelperControls(input: {
  query: string
  schemaMode: BatshitToolSchemaMode
  allowedControlIds?: string[]
  limit: number
}): { results: BatshitToolSearchResult[]; totalMatches: number } {
  const entries = NATIVE_FABRIC_HELPER_CONTROLS
    .filter((definition) => isControlIdAllowedByList(definition.controlId, input.allowedControlIds))
    .map((definition) => ({
      definition,
      score: scoreNativeFabricHelperMatch(input.query, definition)
    }))
    .filter((entry) => !input.query || entry.score > 0)
    .sort((left, right) => right.score - left.score || left.definition.controlId.localeCompare(right.definition.controlId))

  const results = entries.slice(0, input.limit).map(({ definition }) =>
    mapControlSearchResult(
      'fabric',
      {
        controlId: definition.controlId,
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        schemaHint: definition.schemaHint,
        riskLevel: 'safe',
        status: 'published',
        sourceType: 'core',
        tags: definition.tags
      },
      input.schemaMode
    )
  )

  return {
    results,
    totalMatches: entries.length
  }
}

function resolveBrokerPresentation(
  family: BatshitToolFamily,
  target: string
): { operationKind: BatshitToolUseResponse['operationKind']; rendererFamily: BatshitToolUseResponse['rendererFamily'] } {
  if (family === 'fabric' && target === FABRIC_FETCH_ZIP_CONTROL_ID) {
    return {
      operationKind: 'fetch_zip',
      rendererFamily: 'generic_tool'
    }
  }

  return {
    operationKind: BATSHIT_TOOL_OPERATION_KIND_BY_FAMILY[family],
    rendererFamily: family === 'cli' ? 'cli_tool' : 'generic_tool'
  }
}

async function executeNativeFabricHelperControl(input: {
  userId: string
  controlId: string
  payload: Record<string, any>
  backend: NativeExecutionBackend
}): Promise<Record<string, any> | null> {
  if (input.controlId === FABRIC_FETCH_ZIP_CONTROL_ID) {
    return await nativeFetchZip({
      userId: input.userId,
      zipId: typeof input.payload.zipId === 'string' ? input.payload.zipId : '',
      includeContent: input.payload.includeContent,
      maxChars: typeof input.payload.maxChars === 'number' ? input.payload.maxChars : undefined
    })
  }

  if (input.controlId === FABRIC_COMFYUI_WORKFLOWS_CONTROL_ID) {
    return nativeComfyUiWorkflows({
      backend: input.backend,
      action: input.payload.action,
      baseUrl: input.payload.baseUrl,
      workflowName: input.payload.workflowName,
      includeWorkflow: input.payload.includeWorkflow,
      limit: input.payload.limit,
      timeoutMs: input.payload.timeoutMs
    })
  }

  if (input.controlId === FABRIC_COMFYUI_OBJECT_INFO_CONTROL_ID) {
    return nativeComfyUiObjectInfo({
      backend: input.backend,
      baseUrl: input.payload.baseUrl,
      includeSchema: input.payload.includeSchema,
      classTypes: input.payload.classTypes,
      maxNodes: input.payload.maxNodes,
      timeoutMs: input.payload.timeoutMs
    })
  }

  return null
}

function mapAgentBrowserSearchResult(
  entry: Record<string, any>,
  schemaMode: BatshitToolSchemaMode
): BatshitToolSearchResult {
  const toolName = typeof entry.toolName === 'string' ? entry.toolName : 'unknown-command'
  const title = toolName
  const description = typeof entry.summary === 'string' ? entry.summary : ''
  const paramsHint =
    typeof entry.paramsHint === 'string' && entry.paramsHint.trim().length > 0
      ? entry.paramsHint.trim()
      : typeof entry.argsHint === 'string' && entry.argsHint.trim().length > 0
        ? entry.argsHint.trim()
        : null
  const hint = schemaMode === 'none' ? undefined : paramsHint ? `input: ${paramsHint}` : 'input: command params object.'
  const ref = buildBatshitToolRef('agent_browser', toolName)
  return {
    ref,
    family: 'agent_browser',
    title,
    description,
    hint,
    useExample: buildBatshitToolUseExample(ref, hint ?? ''),
    source: typeof entry.cliCommand === 'string' ? entry.cliCommand : undefined,
    raw: entry
  }
}

async function nativeBatshitToolSearch(input: BatshitToolSearchInput & {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  selectedGateways?: string[]
  selectedCliToolIds?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  allowedFamilies: BatshitToolFamily[]
  runtimeMode: ControlRuntimeMode
  fabricAllowedControlIds?: string[]
  allowArtifactRuntimeTools?: boolean
  agentBrowserSettings?: Parameters<typeof nativeAgentBrowserFind>[0]['settings']
  projectPath?: string | null
  gatewayToolsCache?: GatewayToolsCache
}): Promise<BatshitToolSearchResponse> {
  const normalizedLimit = clamp(parseInteger(input.limit) ?? DEFAULT_DYNAMIC_RESULTS, 1, MAX_DYNAMIC_RESULTS)
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  const schemaMode = normalizeBatshitToolSchemaMode(input)
  const includeSchema = schemaMode !== 'none'
  const { families, unavailableFamilies } = resolveBatshitToolSearchFamilies({
    family: input.family,
    families: input.families,
    allowedFamilies: input.allowedFamilies
  })

  const results: BatshitToolSearchResult[] = []
  let totalMatches = 0

  for (const family of families) {
    if (family === 'mcp') {
      const found = await nativeDynamicMcpFind({
        userId: input.userId,
        agentId: input.agentId ?? null,
        agentMetadata: input.agentMetadata ?? null,
        query,
        limit: normalizedLimit,
        includeSchema,
        selectedGateways: input.selectedGateways,
        dcmDisplaySettings: input.dcmDisplaySettings ?? null,
        projectPath: input.projectPath ?? null,
        gatewayToolsCache: input.gatewayToolsCache
      })
      const entries = Array.isArray(found.results) ? found.results : []
      totalMatches += typeof found.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapMcpSearchResult(entry, schemaMode)))
      continue
    }

    if (family === 'cli') {
      const found = await nativeCliToolFind({
        userId: input.userId,
        agentId: input.agentId ?? null,
        query,
        limit: normalizedLimit,
        includeSchema,
        selectedCliToolIds: input.selectedCliToolIds
      })
      const entries = Array.isArray(found.results) ? found.results : []
      totalMatches += typeof found.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapCliSearchResult(entry, schemaMode)))
      continue
    }

    if (family === 'artifact') {
      const found = await findControls({
        userId: input.userId,
        agentId: input.agentId ?? undefined,
        query,
        runtimeMode: input.runtimeMode,
        includeSchema,
        limit: normalizedLimit,
        allowedControlIds: Array.from(ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS)
      })
      const entries = Array.isArray(found.results) ? found.results : []
      totalMatches += typeof found.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapControlSearchResult(family, entry, schemaMode)))
      continue
    }

    if (family === 'fabric') {
      const helperFound = findNativeFabricHelperControls({
        query,
        schemaMode,
        allowedControlIds: input.fabricAllowedControlIds,
        limit: normalizedLimit
      })
      const shouldSearchRegistry =
        !Array.isArray(input.fabricAllowedControlIds) ||
        input.fabricAllowedControlIds.length === 0 ||
        input.fabricAllowedControlIds.some((entry) => !allowedControlEntryIsNativeFabricHelperOnly(entry))

      if (shouldSearchRegistry) {
        const found = await findControls({
          userId: input.userId,
          agentId: input.agentId ?? undefined,
          query,
          runtimeMode: input.runtimeMode,
          includeSchema,
          limit: normalizedLimit + helperFound.results.length,
          allowedControlIds: input.fabricAllowedControlIds
        })
        const entries = (Array.isArray(found.results) ? found.results : []).filter(
          (entry) => !isNativeFabricHelperControlId(entry.controlId)
        )
        totalMatches += entries.length
        results.push(...entries.map((entry) => mapControlSearchResult(family, entry, schemaMode)))
      }
      totalMatches += helperFound.totalMatches
      results.push(...helperFound.results)
      continue
    }

    if (family === 'agent_browser') {
      const found = await nativeAgentBrowserFind({
        userId: input.userId,
        query,
        limit: normalizedLimit,
        settings: input.agentBrowserSettings
      })
      const entries = Array.isArray(found.results) ? found.results : []
      totalMatches += typeof found.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapAgentBrowserSearchResult(entry, schemaMode)))
    }
  }

  return {
    results: results.slice(0, normalizedLimit),
    totalMatches,
    query,
    limit: normalizedLimit,
    schemaMode,
    families,
    ...(unavailableFamilies.length > 0 ? { unavailableFamilies } : {}),
    operationKind: 'tool_find',
    rendererFamily: 'tool_find'
  }
}

async function nativeBatshitToolUse(input: BatshitToolUseInput & {
  userId: string
  agentId?: string | null
  agentMetadata?: Record<string, any> | null
  sessionId?: string
  selectedGateways?: string[]
  selectedCliToolIds?: string[]
  dcmDisplaySettings?: AgentDcmDisplaySettings | null
  projectPath?: string | null
  allowedFamilies: BatshitToolFamily[]
  runtimeMode: ControlRuntimeMode
  fabricAllowedControlIds?: string[]
  executionBackend?: NativeExecutionBackend
  agentBrowserSettings?: Parameters<typeof nativeAgentBrowserUse>[0]['settings']
  gatewayToolsCache?: GatewayToolsCache
  executeControlUse?: (
    controlInput: ControlUseInput,
    allowedControlIds: string[]
  ) => Promise<Record<string, any>>
}): Promise<BatshitToolUseResponse> {
  const parsed = parseBatshitToolRef(input.ref)
  if (!input.allowedFamilies.includes(parsed.family)) {
    return {
      success: false,
      ref: input.ref,
      family: parsed.family,
      target: parsed.target,
      operationKind: BATSHIT_TOOL_OPERATION_KIND_BY_FAMILY[parsed.family],
      rendererFamily: parsed.family === 'cli' ? 'cli_tool' : 'generic_tool',
      error: `${BATSHIT_TOOL_FAMILY_LABELS[parsed.family]} tools are not enabled for this actor/runtime.`
    }
  }

  const payload = normalizeBatshitToolUsePayload(input)
  const { operationKind, rendererFamily } = resolveBrokerPresentation(parsed.family, parsed.target)
  let routed: Record<string, any>

  if (parsed.family === 'mcp') {
    routed = await nativeDynamicMcpUse({
      userId: input.userId,
      agentId: input.agentId ?? null,
      agentMetadata: input.agentMetadata ?? null,
      toolName: parsed.target,
      params: payload,
      selectedGateways: input.selectedGateways,
      dcmDisplaySettings: input.dcmDisplaySettings ?? null,
      projectPath: input.projectPath ?? null,
      gatewayToolsCache: input.gatewayToolsCache
    })
  } else if (parsed.family === 'cli') {
    routed = await nativeCliToolUse({
      userId: input.userId,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId,
      toolId: parsed.target,
      cliInput: payload,
      allowRisky: input.allowRisky === true,
      projectPath: input.projectPath ?? null,
      selectedCliToolIds: input.selectedCliToolIds
    })
  } else if (parsed.family === 'artifact' || parsed.family === 'fabric') {
    const controlInput: ControlUseInput = {
      controlId: parsed.target,
      input: payload,
      dryRun: input.dryRun === true,
      allowRisky: input.allowRisky === true
    }
    const allowedControlIds =
      parsed.family === 'artifact'
        ? Array.from(ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS)
        : input.fabricAllowedControlIds ?? []
    if (parsed.family === 'fabric' && !isControlIdAllowedByList(parsed.target, allowedControlIds)) {
      return {
        success: false,
        ref: input.ref,
        family: parsed.family,
        target: parsed.target,
        operationKind,
        rendererFamily,
        code: 'OUT_OF_SCOPE',
        error: `Fabric tools are not enabled for this actor/runtime; control "${parsed.target}" is out of scope.`
      }
    }
    const nativeHelperResult =
      parsed.family === 'fabric' && isControlIdAllowedByList(parsed.target, allowedControlIds)
        ? await executeNativeFabricHelperControl({
            userId: input.userId,
            controlId: parsed.target,
            payload,
            backend: input.executionBackend ?? getDefaultNativeExecutionBackend()
          })
        : null
    if (nativeHelperResult) {
      routed = {
        success: nativeHelperResult.success === false ? false : true,
        ...nativeHelperResult,
        controlId: parsed.target,
        riskLevel: 'safe',
        status: 'published'
      }
    } else {
      routed = input.executeControlUse
        ? await input.executeControlUse(controlInput, allowedControlIds)
        : await useControl({
            userId: input.userId,
            agentId: input.agentId ?? undefined,
            sessionId: input.sessionId,
            runtimeMode: input.runtimeMode,
            controlId: parsed.target,
            input: normalizeNativeControlUseInput(controlInput as Record<string, any>),
            dryRun: input.dryRun === true,
            allowRisky: input.allowRisky === true,
            selectedGateways: input.selectedGateways,
            allowedControlIds
          })
    }
  } else {
    routed = await nativeAgentBrowserUse({
      userId: input.userId,
      sessionId: input.sessionId,
      toolName: parsed.target,
      params: payload,
      settings: input.agentBrowserSettings
    })
  }

  return {
    ...(routed ?? {}),
    ref: input.ref,
    family: parsed.family,
    target: parsed.target,
    operationKind,
    rendererFamily
  }
}

function formatBatshitToolSearchModelOutput() {
  return async ({ output }: { output: any }) => {
    if (output && typeof output === 'object' && Array.isArray((output as any).results)) {
      const results = (output as any).results as Array<Record<string, any>>
      const totalMatches =
        typeof (output as any).totalMatches === 'number' ? (output as any).totalMatches : results.length
      const families = Array.isArray((output as any).families)
        ? (output as any).families.map((entry: unknown) => String(entry)).join(', ')
        : 'all'
      const lines = results.flatMap((entry) => {
        const ref = typeof entry.ref === 'string' ? entry.ref : 'unknown:unknown'
        const family = normalizeBatshitToolFamily(entry.family) ?? 'mcp'
        const title = typeof entry.title === 'string' && entry.title.trim().length > 0 ? entry.title : ref
        const description =
          typeof entry.description === 'string' && entry.description.trim().length > 0
            ? entry.description.trim()
            : ''
        const source =
          typeof entry.source === 'string' && entry.source.trim().length > 0
            ? ` source=${entry.source.trim()}`
            : ''
        const risk =
          typeof entry.riskLevel === 'string' && entry.riskLevel !== 'safe'
            ? ` risk=${entry.riskLevel}`
            : ''
        const resultLines = [
          `- ${family}: ${ref} (${title})${source}${risk}`,
          ...(description ? [`  about: ${description}`] : [])
        ]
        if (typeof entry.hint === 'string' && entry.hint.trim().length > 0) {
          resultLines.push(`  hint: ${entry.hint.trim()}`)
        }
        if (typeof entry.useExample === 'string' && entry.useExample.trim().length > 0) {
          resultLines.push(`  example: ${entry.useExample.trim()}`)
        }
        if (entry.inputSchema && typeof entry.inputSchema === 'object') {
          resultLines.push(`  full_schema: ${JSON.stringify(entry.inputSchema)}`)
        }
        return resultLines
      })
      const unavailable = Array.isArray((output as any).unavailableFamilies)
        ? ((output as any).unavailableFamilies as Array<Record<string, any>>)
            .map((entry) => {
              const family = typeof entry.family === 'string' ? entry.family : 'unknown'
              const reason = typeof entry.reason === 'string' ? entry.reason : 'not enabled'
              return `- ${family}: ${reason}`
            })
        : []

      return {
        type: 'text' as const,
        value: [
          `Batshit tools found: ${results.length} (total matches: ${totalMatches}; families: ${families})`,
          ...(lines.length > 0 ? lines : ['- none']),
          ...(unavailable.length > 0 ? ['', 'unavailable_families:', ...unavailable] : []),
          '',
          'Use native_batshit_tool_use with one exact ref from the results. Put capability-specific fields inside input.'
        ].join('\n')
      }
    }

    return {
      type: 'json' as const,
      value: output ?? null
    }
  }
}

function stringifyBatshitToolModelValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return String(value ?? '')
  }
}

function formatBrokerFetchZipModelValue(output: Record<string, any>): string | null {
  if (output.operationKind !== 'fetch_zip' && output.target !== FABRIC_FETCH_ZIP_CONTROL_ID) {
    return null
  }
  const payload =
    output.result && typeof output.result === 'object' && !Array.isArray(output.result)
      ? output.result as Record<string, any>
      : output
  const found = payload.found === true
  const zipId = typeof payload.zipId === 'string' ? payload.zipId : String(output.target ?? 'unknown')
  const lines = [
    `fetch_zip ${found ? 'succeeded' : 'not_found'}: ${zipId}`,
    ...(typeof payload.type === 'string' ? [`type: ${payload.type}`] : []),
    ...(typeof payload.description === 'string' && payload.description.trim()
      ? [`description: ${payload.description.trim()}`]
      : []),
    ...(typeof payload.tokens === 'number' ? [`tokens: ${payload.tokens}`] : []),
    ...(payload.contentTruncated === true ? ['content_truncated: true'] : [])
  ]

  if (typeof payload.content === 'string') {
    lines.push('', 'content:', payload.content)
  }
  if (!found && typeof payload.reason === 'string') {
    lines.push(`reason: ${payload.reason}`)
  }
  return lines.join('\n')
}

function formatComfyUiObjectInfoModelValue(output: Record<string, any>): string | null {
  if (output.target !== FABRIC_COMFYUI_OBJECT_INFO_CONTROL_ID && output.helper !== 'native_comfyui_object_info') {
    return null
  }
  if (output.success === false) {
    const errorObj = output.error && typeof output.error === 'object' ? output.error as Record<string, any> : {}
    return [
      'comfyui_object_info failed',
      `code: ${typeof errorObj.code === 'string' ? errorObj.code : 'BACKEND_UNAVAILABLE'}`,
      `message: ${typeof errorObj.message === 'string' ? errorObj.message : 'Unknown error.'}`
    ].join('\n')
  }
  const preview = Array.isArray(output.availableClassTypesPreview)
    ? output.availableClassTypesPreview.map((entry: unknown) => String(entry))
    : []
  const missing = Array.isArray(output.missingClassTypes)
    ? output.missingClassTypes.map((entry: unknown) => String(entry))
    : []
  const schema = output.schema && typeof output.schema === 'object' ? output.schema : null
  return [
    'comfyui_object_info: success',
    `backend: ${String(output.backend ?? 'unknown')}`,
    ...(typeof output.baseUrl === 'string' ? [`base_url: ${output.baseUrl}`] : []),
    `node_count: ${typeof output.nodeCount === 'number' ? output.nodeCount : 0}`,
    ...(preview.length > 0 ? [`class_types_preview (${preview.length}): ${preview.join(', ')}`] : []),
    ...(missing.length > 0 ? [`missing_class_types: ${missing.join(', ')}`] : []),
    ...(schema
      ? ['', 'schema_json:', stringifyBatshitToolModelValue(schema)]
      : [
          '',
          'schema_hint:',
          'Set includeSchema=true and optional classTypes=[...] when you need exact node input details.'
        ])
  ].join('\n')
}

function formatComfyUiWorkflowsModelValue(output: Record<string, any>): string | null {
  if (output.target !== FABRIC_COMFYUI_WORKFLOWS_CONTROL_ID && output.helper !== 'native_comfyui_workflows') {
    return null
  }
  if (output.success === false) {
    const errorObj = output.error && typeof output.error === 'object' ? output.error as Record<string, any> : {}
    return [
      'comfyui_workflows failed',
      `code: ${typeof errorObj.code === 'string' ? errorObj.code : 'BACKEND_UNAVAILABLE'}`,
      `message: ${typeof errorObj.message === 'string' ? errorObj.message : 'Unknown error.'}`
    ].join('\n')
  }
  const action = output.action === 'get' ? 'get' : 'list'
  if (action === 'list') {
    const workflows = Array.isArray(output.workflows)
      ? output.workflows.map((entry: unknown) => String(entry))
      : []
    return [
      'comfyui_workflows: success',
      'action: list',
      `backend: ${String(output.backend ?? 'unknown')}`,
      ...(typeof output.baseUrl === 'string' ? [`base_url: ${output.baseUrl}`] : []),
      `workflow_count: ${typeof output.workflowCount === 'number' ? output.workflowCount : workflows.length}`,
      ...(workflows.length > 0 ? ['', `workflows (${workflows.length}):`, ...workflows.map((entry) => `- ${entry}`)] : []),
      ...(output.workflowsTruncated === true ? ['', 'workflows_truncated: true'] : [])
    ].join('\n')
  }

  const preview = Array.isArray(output.classTypesPreview)
    ? output.classTypesPreview.map((entry: unknown) => String(entry))
    : []
  return [
    'comfyui_workflows: success',
    'action: get',
    `backend: ${String(output.backend ?? 'unknown')}`,
    ...(typeof output.baseUrl === 'string' ? [`base_url: ${output.baseUrl}`] : []),
    ...(typeof output.workflowName === 'string' ? [`workflow_name: ${output.workflowName}`] : []),
    `workflow_format: ${String(output.workflowFormat ?? 'unknown')}`,
    `workflow_node_count: ${String(output.workflowNodeCount ?? 0)}`,
    ...(preview.length > 0 ? [`class_types_preview (${preview.length}): ${preview.join(', ')}`] : []),
    ...(output.includeWorkflow === true
      ? ['', 'workflow_json:', stringifyBatshitToolModelValue(output.workflow)]
      : ['', 'workflow_hint:', 'Set includeWorkflow=true to receive full workflow JSON.'])
  ].join('\n')
}

function formatSpecializedBrokerUseModelValue(output: Record<string, any>): string | null {
  return (
    formatBrokerFetchZipModelValue(output) ??
    formatComfyUiObjectInfoModelValue(output) ??
    formatComfyUiWorkflowsModelValue(output)
  )
}

function formatBatshitToolUseModelOutput() {
  return async ({ output }: { output: any }) => {
    if (output && typeof output === 'object') {
      const specialized = formatSpecializedBrokerUseModelValue(output as Record<string, any>)
      if (specialized) {
        return {
          type: 'text' as const,
          value: specialized
        }
      }

      const ref = typeof (output as any).ref === 'string' ? (output as any).ref : 'unknown'
      const family = typeof (output as any).family === 'string' ? (output as any).family : 'unknown'
      const target =
        typeof (output as any).target === 'string'
          ? (output as any).target
          : typeof (output as any).controlId === 'string'
            ? (output as any).controlId
            : ref.includes(':')
              ? ref.slice(ref.indexOf(':') + 1)
              : ref
      if ((output as any).success === false) {
        const errorObject =
          (output as any).error && typeof (output as any).error === 'object'
            ? (output as any).error
            : {}
        const error =
          typeof (output as any).error === 'string'
            ? (output as any).error
            : typeof (errorObject as any).message === 'string'
              ? (errorObject as any).message
              : 'Batshit tool use failed.'
        const code =
          typeof (output as any).code === 'string'
            ? (output as any).code
            : typeof (errorObject as any).code === 'string'
              ? (errorObject as any).code
              : null
        const details = (errorObject as any).details
        const retryPayload =
          (output as any).retryPayload && typeof (output as any).retryPayload === 'object'
            ? (output as any).retryPayload
            : null
        const approvalHint =
          code === 'CONTROL_RISK_REQUIRES_APPROVAL'
            ? [
                '',
                'approval_hint:',
                'If the user approved this action, immediately retry this same ref with allowRisky: true.',
                'Use the same payload bytes. You may omit input to reuse the cached payload for this turn.',
                ...(target === 'sys.voice.engine.complete_local_setup'
                  ? [
                      'Do not switch to sys.voice.engine.register / update / health_check / enable or ad-hoc bash just because this confirm gate fired.',
                      'Retry sys.voice.engine.complete_local_setup itself so the helper keeps ownership of TTS/STT launch, readiness, smoke, registration, and enablement.'
                    ]
                  : [])
              ]
            : []
        const promptHint =
          code === 'CONTROL_EXECUTION_FAILED' && /prompt is required/i.test(error)
            ? [
                '',
                'input_hint:',
                'Retry with a non-empty prompt in input.prompt (or top-level prompt).'
              ]
            : []
        return {
          type: 'text' as const,
          value: [
            `batshit_tool_use failed: ${ref}`,
            `family: ${family}`,
            ...(code ? [`code: ${code}`] : []),
            `message: ${error}`,
            ...(details !== undefined ? ['', 'details:', stringifyBatshitToolModelValue(details)] : []),
            ...(retryPayload ? ['', 'retry_payload:', stringifyBatshitToolModelValue(retryPayload)] : []),
            ...approvalHint,
            ...promptHint
          ].join('\n')
        }
      }

      return {
        type: 'text' as const,
        value: [
          `batshit_tool_use succeeded: ${ref}`,
          `family: ${family}`,
          ...((output as any).retryPayloadReused === true
            ? ['retry_payload: reused cached payload for this allowRisky retry.']
            : []),
          '',
          'result:',
          JSON.stringify(output, null, 2)
        ].join('\n')
      }
    }

    return {
      type: 'json' as const,
      value: output ?? null
    }
  }
}

async function readSearchProviderError(response: Response): Promise<string | null> {
  try {
    const payload = await response.json()
    const message =
      payload?.error?.message ??
      payload?.error ??
      payload?.message ??
      payload?.detail ??
      payload?.details
    if (typeof message === 'string' && message.trim().length > 0) {
      return message.trim()
    }
  } catch {
    // fall through to text body
  }

  try {
    const text = await response.text()
    if (text.trim().length > 0) return text.trim()
  } catch {
    // ignore text parse errors
  }

  return null
}

async function nativeWebSearchDuckDuckGo(input: {
  query: string
  maxResults: number
  region: string
  safeSearch: 'strict' | 'moderate' | 'off'
  timeoutMs: number
}): Promise<Record<string, any>> {
  const safeSearch = input.safeSearch === 'off' ? '-2' : input.safeSearch === 'strict' ? '1' : '-1'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}&kl=${encodeURIComponent(input.region)}&kp=${safeSearch}`
  let response: Response
  try {
    response = await fetch(searchUrl, {
      headers: {
        'User-Agent': 'BatshitRoomNativeSearch/1.0 (+https://batshit.ai)'
      },
      signal: controller.signal
    })
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      success: false,
      error: isAbort
        ? `Search timed out after ${input.timeoutMs}ms.`
        : `Search request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    return {
      success: false,
      error: `Search provider returned ${response.status}.`
    }
  }

  const html = await response.text()
  const $ = loadHtml(html)
  const results: Array<{ title: string; url: string; snippet: string }> = []

  $('.result').each((index, element) => {
    if (results.length >= input.maxResults) return
    if (index > 50) return

    const link = $(element).find('.result__a').first()
    const rawHref = link.attr('href') || ''
    const title = link.text().trim()
    const snippet = $(element).find('.result__snippet').first().text().trim()

    if (!title || !rawHref) return

    results.push({
      title,
      url: decodeDuckDuckGoUrl(rawHref),
      snippet
    })
  })

  return {
    success: true,
    query: input.query,
    provider: 'duckduckgo-html',
    fetchedAt: new Date().toISOString(),
    results
  }
}

async function nativeWebSearchExa(input: {
  userId: string
  query: string
  maxResults: number
  timeoutMs: number
  searchType: ExaSearchType
}): Promise<Record<string, any>> {
  const apiKey = await apiKeyService.retrieve('exa', input.userId)
  if (!apiKey) {
    return {
      success: false,
      error: 'Exa API key is not configured.'
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  let response: Response
  try {
    response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey
      },
      body: JSON.stringify({
        query: input.query,
        numResults: input.maxResults,
        type: input.searchType
      }),
      signal: controller.signal
    })
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      success: false,
      error: isAbort
        ? `Search timed out after ${input.timeoutMs}ms.`
        : `Search request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const providerError = await readSearchProviderError(response)
    return {
      success: false,
      error: providerError
        ? `Exa returned ${response.status}: ${providerError}`
        : `Exa returned ${response.status}.`
    }
  }

  const payload = await response.json().catch(() => null)
  const rawResults = Array.isArray(payload?.results) ? payload.results : []
  const results = rawResults
    .slice(0, input.maxResults)
    .map((entry: any) => {
      const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
      const url = typeof entry?.url === 'string' ? entry.url.trim() : ''
      const snippetSource =
        entry?.text ??
        entry?.snippet ??
        (Array.isArray(entry?.highlights) ? entry.highlights.join(' ') : '')
      return {
        title: title || url || 'Untitled result',
        url,
        snippet: truncateSnippet(snippetSource)
      }
    })
    .filter((entry: { url: string }) => entry.url.length > 0)

  return {
    success: true,
    query: input.query,
    provider: 'exa',
    searchType: input.searchType,
    fetchedAt: new Date().toISOString(),
    results
  }
}

async function nativeWebSearchPerplexity(input: {
  userId: string
  query: string
  maxResults: number
  timeoutMs: number
  maxTokensPerPage: number
}): Promise<Record<string, any>> {
  const apiKey = await apiKeyService.retrieve('perplexity', input.userId)
  if (!apiKey) {
    return {
      success: false,
      error: 'Perplexity API key is not configured.'
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  let response: Response
  try {
    response = await fetch('https://api.perplexity.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        query: input.query,
        max_results: input.maxResults,
        max_tokens_per_page: input.maxTokensPerPage
      }),
      signal: controller.signal
    })
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      success: false,
      error: isAbort
        ? `Search timed out after ${input.timeoutMs}ms.`
        : `Search request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
    }
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const providerError = await readSearchProviderError(response)
    return {
      success: false,
      error: providerError
        ? `Perplexity returned ${response.status}: ${providerError}`
        : `Perplexity returned ${response.status}.`
    }
  }

  const payload = await response.json().catch(() => null)
  const rawResults = Array.isArray(payload?.results) ? payload.results : []
  const results = rawResults
    .slice(0, input.maxResults)
    .map((entry: any) => {
      const title = typeof entry?.title === 'string' ? entry.title.trim() : ''
      const url = typeof entry?.url === 'string' ? entry.url.trim() : ''
      const snippetSource =
        entry?.snippet ??
        entry?.content ??
        entry?.text ??
        (Array.isArray(entry?.highlights) ? entry.highlights.join(' ') : '')
      return {
        title: title || url || 'Untitled result',
        url,
        snippet: truncateSnippet(snippetSource)
      }
    })
    .filter((entry: { url: string }) => entry.url.length > 0)

  return {
    success: true,
    query: input.query,
    provider: 'perplexity',
    maxTokensPerPage: input.maxTokensPerPage,
    fetchedAt: new Date().toISOString(),
    results
  }
}

async function nativeWebSearch(input: {
  userId?: string
  query: string
  provider?: string
  agentDefaultProvider?: string
  exaSearchType?: string
  agentDefaultExaSearchType?: string
  perplexityMaxTokensPerPage?: number
  agentDefaultPerplexityMaxTokensPerPage?: number
  maxResults?: number
  region?: string
  safeSearch?: 'strict' | 'moderate' | 'off'
  timeoutMs?: number
}): Promise<Record<string, any>> {
  const query = input.query.trim()
  if (!query) {
    return {
      success: false,
      error: 'Query is required.'
    }
  }

  const maxResults = clamp(
    parseInteger(input.maxResults) ?? DEFAULT_SEARCH_RESULTS,
    1,
    MAX_SEARCH_RESULTS
  )
  const region = typeof input.region === 'string' && input.region.trim().length > 0
    ? input.region.trim()
    : 'us-en'
  const safeSearch = input.safeSearch === 'off' ? 'off' : input.safeSearch === 'strict' ? 'strict' : 'moderate'
  const timeoutMs = clamp(
    parseInteger(input.timeoutMs) ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS,
    1_000,
    MAX_WEB_SEARCH_TIMEOUT_MS
  )

  const providerResolution = await resolveWebSearchProvider({
    requestedProvider: input.provider,
    agentDefaultProvider: input.agentDefaultProvider,
    userId: input.userId
  })
  const adminDefaults = await getAdminDefaultWebSearchOptions(input.userId)
  const exaSearchType =
    normalizeExaSearchType(input.exaSearchType) ??
    normalizeExaSearchType(input.agentDefaultExaSearchType) ??
    adminDefaults.exaSearchType ??
    DEFAULT_EXA_SEARCH_TYPE
  const perplexityMaxTokensPerPage = clamp(
    parseInteger(input.perplexityMaxTokensPerPage) ??
      parseInteger(input.agentDefaultPerplexityMaxTokensPerPage) ??
      adminDefaults.perplexityMaxTokensPerPage ??
      DEFAULT_PERPLEXITY_MAX_TOKENS_PER_PAGE,
    MIN_PERPLEXITY_MAX_TOKENS_PER_PAGE,
    MAX_PERPLEXITY_MAX_TOKENS_PER_PAGE
  )

  let result: Record<string, any>
  if (providerResolution.resolvedProvider === 'exa') {
    if (!input.userId) {
      result = {
        success: false,
        error: 'Exa requires an authenticated user context.'
      }
    } else {
      result = await nativeWebSearchExa({
        userId: input.userId,
        query,
        maxResults,
        timeoutMs,
        searchType: exaSearchType
      })
    }
  } else if (providerResolution.resolvedProvider === 'perplexity') {
    if (!input.userId) {
      result = {
        success: false,
        error: 'Perplexity requires an authenticated user context.'
      }
    } else {
      result = await nativeWebSearchPerplexity({
        userId: input.userId,
        query,
        maxResults,
        timeoutMs,
        maxTokensPerPage: perplexityMaxTokensPerPage
      })
    }
  } else {
    result = await nativeWebSearchDuckDuckGo({
      query,
      maxResults,
      region,
      safeSearch,
      timeoutMs
    })
  }

  return {
    ...result,
    providerRequested: providerResolution.requestedProvider ?? null,
    providerAgentDefault: providerResolution.agentDefaultProvider ?? null,
    providerAdminDefault: providerResolution.adminDefaultProvider ?? null,
    providerFallbackReason: providerResolution.fallbackReason ?? null,
    providerOptions: {
      exaSearchType,
      perplexityMaxTokensPerPage
    }
  }
}

type NativeComfyUiObjectInfoAttempt = {
  objectInfoUrl: string
  baseUrl: string
  success: boolean
  status?: number
  timedOut?: boolean
  error?: string
  nodeCount?: number
}

type ComfyUiObjectInfoTarget = {
  baseUrl: string
  objectInfoUrl: string
}

function toComfyUiObjectInfoTarget(rawValue: string): ComfyUiObjectInfoTarget | null {
  const trimmed = rawValue.trim()
  if (!trimmed) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }

  const normalizedPath = parsed.pathname.replace(/\/+$/, '')
  const hasObjectInfoSuffix = normalizedPath.endsWith('/object_info')
  const basePath = hasObjectInfoSuffix
    ? normalizedPath.slice(0, normalizedPath.length - '/object_info'.length)
    : normalizedPath

  const baseUrl = new URL(parsed.toString())
  baseUrl.pathname = basePath || '/'
  baseUrl.search = ''
  baseUrl.hash = ''
  const baseUrlText = baseUrl.toString().replace(/\/$/, '')

  const objectInfoUrl = new URL(baseUrl.toString())
  const objectInfoPath = `${basePath || ''}/object_info`.replace(/\/{2,}/g, '/')
  objectInfoUrl.pathname = objectInfoPath.startsWith('/') ? objectInfoPath : `/${objectInfoPath}`
  objectInfoUrl.search = ''
  objectInfoUrl.hash = ''

  return {
    baseUrl: baseUrlText,
    objectInfoUrl: objectInfoUrl.toString()
  }
}

function buildComfyUiHostFallbackCandidates(
  hostname: string,
  backend: NativeExecutionBackend
): string[] {
  const normalized = hostname.trim().toLowerCase()
  const candidates = [hostname]

  if (backend !== 'docker_sandbox') return candidates

  if (normalized === 'host.docker.internal') {
    candidates.push('127.0.0.1', 'localhost')
    return candidates
  }

  if (normalized === '127.0.0.1') {
    candidates.push('localhost', 'host.docker.internal')
    return candidates
  }

  if (normalized === 'localhost') {
    candidates.push('127.0.0.1', 'host.docker.internal')
  }

  return candidates
}

function expandComfyUiObjectInfoTargetForBackend(
  target: ComfyUiObjectInfoTarget,
  backend: NativeExecutionBackend
): ComfyUiObjectInfoTarget[] {
  let baseUrl: URL
  let objectInfoUrl: URL
  try {
    baseUrl = new URL(target.baseUrl)
    objectInfoUrl = new URL(target.objectInfoUrl)
  } catch {
    return [target]
  }

  const hostCandidates = buildComfyUiHostFallbackCandidates(baseUrl.hostname, backend)
  const seen = new Set<string>()
  const expanded: ComfyUiObjectInfoTarget[] = []

  for (const host of hostCandidates) {
    const candidateBaseUrl = new URL(baseUrl.toString())
    const candidateObjectInfoUrl = new URL(objectInfoUrl.toString())
    candidateBaseUrl.hostname = host
    candidateObjectInfoUrl.hostname = host

    const candidate: ComfyUiObjectInfoTarget = {
      baseUrl: candidateBaseUrl.toString().replace(/\/$/, ''),
      objectInfoUrl: candidateObjectInfoUrl.toString()
    }

    if (seen.has(candidate.objectInfoUrl)) continue
    seen.add(candidate.objectInfoUrl)
    expanded.push(candidate)
  }

  return expanded
}

function expandComfyUiObjectInfoTargetsForBackend(
  targets: ComfyUiObjectInfoTarget[],
  backend: NativeExecutionBackend
): ComfyUiObjectInfoTarget[] {
  const seen = new Set<string>()
  const expanded: ComfyUiObjectInfoTarget[] = []

  for (const target of targets) {
    for (const candidate of expandComfyUiObjectInfoTargetForBackend(target, backend)) {
      if (seen.has(candidate.objectInfoUrl)) continue
      seen.add(candidate.objectInfoUrl)
      expanded.push(candidate)
    }
  }

  return expanded
}

function buildComfyUiObjectInfoTargets(options: {
  backend: NativeExecutionBackend
  baseUrl?: string
}): {
  targets: ComfyUiObjectInfoTarget[]
  aliasUsed: string | null
  requestedBaseUrl: string | null
  error?: string
} {
  const aliasMap = buildRuntimeUrlAliasMap(options.backend)
  const rawBaseUrl = normalizeOptionalString(options.baseUrl)

  if (!rawBaseUrl) {
    const targets = [aliasMap.comfyui_api_desktop, aliasMap.comfyui_api_standalone]
      .map((candidate) => toComfyUiObjectInfoTarget(candidate))
      .filter((candidate): candidate is ComfyUiObjectInfoTarget => Boolean(candidate))
    const expandedTargets = expandComfyUiObjectInfoTargetsForBackend(targets, options.backend)
    return {
      targets: expandedTargets,
      aliasUsed: null,
      requestedBaseUrl: null
    }
  }

  const aliasResolved = resolveRuntimeUrlAlias(rawBaseUrl, options.backend)
  if (aliasResolved) {
    const target = toComfyUiObjectInfoTarget(aliasResolved)
    if (!target) {
      return {
        targets: [],
        aliasUsed: rawBaseUrl,
        requestedBaseUrl: rawBaseUrl,
        error: `Alias "${rawBaseUrl}" resolved to an invalid URL (${aliasResolved}).`
      }
    }
    return {
      targets: expandComfyUiObjectInfoTargetsForBackend([target], options.backend),
      aliasUsed: rawBaseUrl,
      requestedBaseUrl: rawBaseUrl
    }
  }

  const direct = toComfyUiObjectInfoTarget(rawBaseUrl)
  if (!direct) {
    return {
      targets: [],
      aliasUsed: null,
      requestedBaseUrl: rawBaseUrl,
      error:
        `Invalid baseUrl "${rawBaseUrl}". Use an http/https URL or one of: ` +
        `${Object.keys(aliasMap).join(', ')}`
    }
  }

  return {
    targets: expandComfyUiObjectInfoTargetsForBackend([direct], options.backend),
    aliasUsed: null,
    requestedBaseUrl: rawBaseUrl
  }
}

function buildComfyUiBaseUrlCandidates(options: {
  backend: NativeExecutionBackend
  baseUrl?: string
}): {
  baseUrls: string[]
  aliasUsed: string | null
  requestedBaseUrl: string | null
  error?: string
} {
  const resolved = buildComfyUiObjectInfoTargets(options)
  if (resolved.error) {
    return {
      baseUrls: [],
      aliasUsed: resolved.aliasUsed,
      requestedBaseUrl: resolved.requestedBaseUrl,
      error: resolved.error
    }
  }

  const seen = new Set<string>()
  const baseUrls: string[] = []
  for (const target of resolved.targets) {
    if (seen.has(target.baseUrl)) continue
    seen.add(target.baseUrl)
    baseUrls.push(target.baseUrl)
  }

  return {
    baseUrls,
    aliasUsed: resolved.aliasUsed,
    requestedBaseUrl: resolved.requestedBaseUrl
  }
}

type NativeComfyUiWorkflowsAttempt = {
  action: 'list' | 'get'
  baseUrl: string
  requestUrl: string
  success: boolean
  status?: number
  timedOut?: boolean
  error?: string
}

function normalizeComfyUiWorkflowName(rawValue: string): string {
  return rawValue
    .trim()
    .replace(/^\/+/, '')
    .replace(/^workflows\//i, '')
}

function buildComfyUiWorkflowListUrls(baseUrl: string): string[] {
  return [`${baseUrl}/userdata?dir=workflows`, `${baseUrl}/api/userdata?dir=workflows`]
}

function buildComfyUiWorkflowFetchUrls(baseUrl: string, workflowName: string): string[] {
  const normalizedWorkflowName = normalizeComfyUiWorkflowName(workflowName)
  const workflowPath = `workflows/${normalizedWorkflowName}`
  const encodedWorkflowPath = encodeURIComponent(workflowPath)

  return [
    `${baseUrl}/userdata/${encodedWorkflowPath}`,
    `${baseUrl}/api/userdata/${encodedWorkflowPath}`,
    `${baseUrl}/userdata/workflows/${encodeURIComponent(normalizedWorkflowName)}`,
    `${baseUrl}/api/userdata/workflows/${encodeURIComponent(normalizedWorkflowName)}`
  ]
}

function parseComfyUiWorkflowList(payload: unknown): string[] | null {
  if (Array.isArray(payload)) {
    return payload
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean)
  }

  if (payload && typeof payload === 'object') {
    const candidates = ['items', 'files', 'workflows']
      .map((key) => (payload as Record<string, unknown>)[key])
      .find((value) => Array.isArray(value))

    if (Array.isArray(candidates)) {
      return candidates
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean)
    }
  }

  return null
}

function summarizeComfyUiWorkflowPayload(payload: unknown): {
  format: 'api' | 'ui' | 'unknown'
  nodeCount: number
  classTypesPreview: string[]
  classTypesPreviewTruncated: boolean
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      format: 'unknown',
      nodeCount: 0,
      classTypesPreview: [],
      classTypesPreviewTruncated: false
    }
  }

  const asRecord = payload as Record<string, any>
  if (Array.isArray(asRecord.nodes)) {
    const nodes = (asRecord.nodes as Array<Record<string, any>>).filter(
      (node) => node && typeof node === 'object'
    )
    const classTypes = nodes
      .map((node) => (typeof node.type === 'string' ? node.type.trim() : ''))
      .filter(Boolean)
    const uniqueClassTypes = Array.from(new Set(classTypes)).sort((left, right) =>
      left.localeCompare(right)
    )
    const classTypesPreview = uniqueClassTypes.slice(0, 40)
    return {
      format: 'ui',
      nodeCount: nodes.length,
      classTypesPreview,
      classTypesPreviewTruncated: uniqueClassTypes.length > classTypesPreview.length
    }
  }

  const nodeEntries = Object.entries(asRecord).filter(([_, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const classType = (value as Record<string, unknown>).class_type
    return typeof classType === 'string' && classType.trim().length > 0
  })
  if (nodeEntries.length > 0) {
    const classTypes = nodeEntries
      .map(([_, value]) => String((value as Record<string, unknown>).class_type).trim())
      .filter(Boolean)
    const uniqueClassTypes = Array.from(new Set(classTypes)).sort((left, right) =>
      left.localeCompare(right)
    )
    const classTypesPreview = uniqueClassTypes.slice(0, 40)
    return {
      format: 'api',
      nodeCount: nodeEntries.length,
      classTypesPreview,
      classTypesPreviewTruncated: uniqueClassTypes.length > classTypesPreview.length
    }
  }

  return {
    format: 'unknown',
    nodeCount: 0,
    classTypesPreview: [],
    classTypesPreviewTruncated: false
  }
}

async function nativeComfyUiWorkflows(input: {
  backend?: NativeExecutionBackend
  baseUrl?: string
  action?: 'list' | 'get'
  workflowName?: string
  includeWorkflow?: boolean
  timeoutMs?: number
  limit?: number
}): Promise<Record<string, any>> {
  const backend =
    normalizeNativeExecutionBackend(input.backend) ?? getDefaultNativeExecutionBackend()
  const timeoutMs = clamp(
    parseInteger(input.timeoutMs) ?? DEFAULT_COMFYUI_WORKFLOW_TIMEOUT_MS,
    1_000,
    MAX_COMFYUI_WORKFLOW_TIMEOUT_MS
  )
  const limit = clamp(
    parseInteger(input.limit) ?? DEFAULT_COMFYUI_WORKFLOW_LIST_LIMIT,
    1,
    MAX_COMFYUI_WORKFLOW_LIST_LIMIT
  )
  const action = input.action === 'get' ? 'get' : 'list'
  const includeWorkflow = input.includeWorkflow === true

  const baseCandidates = buildComfyUiBaseUrlCandidates({
    backend,
    baseUrl: input.baseUrl
  })

  if (baseCandidates.error) {
    return {
      success: false,
      helper: 'native_comfyui_workflows',
      action,
      backend,
      aliasUsed: baseCandidates.aliasUsed,
      requestedBaseUrl: baseCandidates.requestedBaseUrl,
      error: {
        code: 'INVALID_INPUT',
        message: baseCandidates.error,
        details: {
          availableAliases: Object.keys(buildRuntimeUrlAliasMap(backend))
        }
      }
    }
  }

  if (action === 'get') {
    const workflowName = normalizeOptionalString(input.workflowName)
    if (!workflowName) {
      return {
        success: false,
        helper: 'native_comfyui_workflows',
        action,
        backend,
        aliasUsed: baseCandidates.aliasUsed,
        requestedBaseUrl: baseCandidates.requestedBaseUrl,
        error: {
          code: 'INVALID_INPUT',
          message: 'workflowName is required when action=get.'
        }
      }
    }

    const normalizedWorkflowName = normalizeComfyUiWorkflowName(workflowName)
    const attempts: NativeComfyUiWorkflowsAttempt[] = []

    for (const baseUrl of baseCandidates.baseUrls) {
      for (const requestUrl of buildComfyUiWorkflowFetchUrls(baseUrl, normalizedWorkflowName)) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        let response: Response

        try {
          response = await fetch(requestUrl, {
            headers: {
              Accept: 'application/json'
            },
            signal: controller.signal
          })
        } catch (error) {
          clearTimeout(timer)
          const isAbort = error instanceof DOMException && error.name === 'AbortError'
          attempts.push({
            action,
            baseUrl,
            requestUrl,
            success: false,
            timedOut: isAbort,
            error: isAbort
              ? `Request timed out after ${timeoutMs}ms.`
              : `Request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
          })
          continue
        } finally {
          clearTimeout(timer)
        }

        if (!response.ok) {
          attempts.push({
            action,
            baseUrl,
            requestUrl,
            success: false,
            status: response.status,
            error: `HTTP ${response.status}`
          })
          continue
        }

        const payload = await response.json().catch(() => null)
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          attempts.push({
            action,
            baseUrl,
            requestUrl,
            success: false,
            error: 'Expected a workflow JSON object payload.'
          })
          continue
        }

        const workflowSummary = summarizeComfyUiWorkflowPayload(payload)
        attempts.push({
          action,
          baseUrl,
          requestUrl,
          success: true,
          status: response.status
        })

        return {
          success: true,
          helper: 'native_comfyui_workflows',
          action,
          backend,
          aliasUsed: baseCandidates.aliasUsed,
          requestedBaseUrl: baseCandidates.requestedBaseUrl,
          baseUrl,
          workflowName: normalizedWorkflowName,
          workflowPath: `workflows/${normalizedWorkflowName}`,
          includeWorkflow,
          workflowFormat: workflowSummary.format,
          workflowNodeCount: workflowSummary.nodeCount,
          classTypesPreview: workflowSummary.classTypesPreview,
          classTypesPreviewTruncated: workflowSummary.classTypesPreviewTruncated,
          workflow: includeWorkflow ? payload : undefined,
          attempts
        }
      }
    }

    const notFoundOnly = attempts.length > 0 && attempts.every((attempt) => attempt.status === 404)
    return {
      success: false,
      helper: 'native_comfyui_workflows',
      action,
      backend,
      aliasUsed: baseCandidates.aliasUsed,
      requestedBaseUrl: baseCandidates.requestedBaseUrl,
      attempts,
      error: {
        code: notFoundOnly ? 'INVALID_INPUT' : 'BACKEND_UNAVAILABLE',
        message: notFoundOnly
          ? `Workflow "${normalizedWorkflowName}" was not found in ComfyUI userdata/workflows.`
          : 'Unable to fetch ComfyUI workflow JSON from runtime targets. Verify ComfyUI URL and reachability.'
      }
    }
  }

  const attempts: NativeComfyUiWorkflowsAttempt[] = []
  for (const baseUrl of baseCandidates.baseUrls) {
    for (const requestUrl of buildComfyUiWorkflowListUrls(baseUrl)) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response

      try {
        response = await fetch(requestUrl, {
          headers: {
            Accept: 'application/json'
          },
          signal: controller.signal
        })
      } catch (error) {
        clearTimeout(timer)
        const isAbort = error instanceof DOMException && error.name === 'AbortError'
        attempts.push({
          action,
          baseUrl,
          requestUrl,
          success: false,
          timedOut: isAbort,
          error: isAbort
            ? `Request timed out after ${timeoutMs}ms.`
            : `Request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
        })
        continue
      } finally {
        clearTimeout(timer)
      }

      if (!response.ok) {
        attempts.push({
          action,
          baseUrl,
          requestUrl,
          success: false,
          status: response.status,
          error: `HTTP ${response.status}`
        })
        continue
      }

      const payload = await response.json().catch(() => null)
      const workflows = parseComfyUiWorkflowList(payload)
      if (!workflows) {
        attempts.push({
          action,
          baseUrl,
          requestUrl,
          success: false,
          error: 'Expected an array payload for workflow list.'
        })
        continue
      }

      const normalizedWorkflows = Array.from(
        new Set(
          workflows
            .map((entry) => entry.trim())
            .filter(Boolean)
        )
      ).sort((left, right) => left.localeCompare(right))
      const limitedWorkflows = normalizedWorkflows.slice(0, limit)

      attempts.push({
        action,
        baseUrl,
        requestUrl,
        success: true,
        status: response.status
      })

      return {
        success: true,
        helper: 'native_comfyui_workflows',
        action,
        backend,
        aliasUsed: baseCandidates.aliasUsed,
        requestedBaseUrl: baseCandidates.requestedBaseUrl,
        baseUrl,
        workflowCount: normalizedWorkflows.length,
        workflows: limitedWorkflows,
        workflowsTruncated: normalizedWorkflows.length > limitedWorkflows.length,
        attempts
      }
    }
  }

  return {
    success: false,
    helper: 'native_comfyui_workflows',
    action,
    backend,
    aliasUsed: baseCandidates.aliasUsed,
    requestedBaseUrl: baseCandidates.requestedBaseUrl,
    attempts,
    error: {
      code: 'BACKEND_UNAVAILABLE',
      message: 'Unable to list ComfyUI workflows from runtime targets. Verify ComfyUI URL and reachability.'
    }
  }
}

function summarizeComfyUiSchemaByClassTypes(options: {
  schema: Record<string, any>
  classTypes: string[]
  maxNodes: number
}): {
  selected: Record<string, any>
  selectedClassTypes: string[]
  missingClassTypes: string[]
  truncated: boolean
} {
  const availableClassTypes = Object.keys(options.schema).sort((left, right) =>
    left.localeCompare(right)
  )
  const requestedClassTypes = options.classTypes
    .map((entry) => entry.trim())
    .filter(Boolean)

  let selectedClassTypes: string[]
  let missingClassTypes: string[] = []
  let truncated = false

  if (requestedClassTypes.length > 0) {
    const requestedSet = new Set(requestedClassTypes)
    selectedClassTypes = availableClassTypes.filter((classType) =>
      requestedSet.has(classType)
    )
    missingClassTypes = requestedClassTypes.filter(
      (classType) => !selectedClassTypes.includes(classType)
    )
  } else {
    selectedClassTypes = availableClassTypes.slice(0, options.maxNodes)
    truncated = availableClassTypes.length > selectedClassTypes.length
  }

  const selected: Record<string, any> = {}
  for (const classType of selectedClassTypes) {
    selected[classType] = options.schema[classType]
  }

  return {
    selected,
    selectedClassTypes,
    missingClassTypes,
    truncated
  }
}

async function nativeComfyUiObjectInfo(input: {
  backend?: NativeExecutionBackend
  baseUrl?: string
  includeSchema?: boolean
  classTypes?: string[]
  maxNodes?: number
  timeoutMs?: number
}): Promise<Record<string, any>> {
  const backend =
    normalizeNativeExecutionBackend(input.backend) ?? getDefaultNativeExecutionBackend()
  const timeoutMs = clamp(
    parseInteger(input.timeoutMs) ?? DEFAULT_COMFYUI_OBJECT_INFO_TIMEOUT_MS,
    1_000,
    MAX_COMFYUI_OBJECT_INFO_TIMEOUT_MS
  )
  const maxNodes = clamp(
    parseInteger(input.maxNodes) ?? DEFAULT_COMFYUI_OBJECT_INFO_MAX_NODES,
    1,
    MAX_COMFYUI_OBJECT_INFO_MAX_NODES
  )
  const includeSchema = input.includeSchema === true
  const classTypes = (normalizeStringList(input.classTypes) ?? []).slice(
    0,
    MAX_COMFYUI_OBJECT_INFO_CLASS_TYPES
  )
  const targetsResult = buildComfyUiObjectInfoTargets({
    backend,
    baseUrl: input.baseUrl
  })

  if (targetsResult.error) {
    return {
      success: false,
      helper: 'native_comfyui_object_info',
      backend,
      aliasUsed: targetsResult.aliasUsed,
      requestedBaseUrl: targetsResult.requestedBaseUrl,
      error: {
        code: 'INVALID_INPUT',
        message: targetsResult.error,
        details: {
          availableAliases: Object.keys(buildRuntimeUrlAliasMap(backend))
        }
      }
    }
  }

  const attempts: NativeComfyUiObjectInfoAttempt[] = []
  for (const target of targetsResult.targets) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response

    try {
      response = await fetch(target.objectInfoUrl, {
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      })
    } catch (error) {
      clearTimeout(timer)
      const isAbort = error instanceof DOMException && error.name === 'AbortError'
      attempts.push({
        objectInfoUrl: target.objectInfoUrl,
        baseUrl: target.baseUrl,
        success: false,
        timedOut: isAbort,
        error: isAbort
          ? `Request timed out after ${timeoutMs}ms.`
          : `Request failed: ${error instanceof Error ? error.message : 'Unknown error.'}`
      })
      continue
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      attempts.push({
        objectInfoUrl: target.objectInfoUrl,
        baseUrl: target.baseUrl,
        success: false,
        status: response.status,
        error: `HTTP ${response.status}`
      })
      continue
    }

    const payload = await response.json().catch(() => null)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      attempts.push({
        objectInfoUrl: target.objectInfoUrl,
        baseUrl: target.baseUrl,
        success: false,
        error: 'Expected a JSON object payload.'
      })
      continue
    }

    const schema = payload as Record<string, any>
    const nodeCount = Object.keys(schema).length
    if (nodeCount === 0) {
      attempts.push({
        objectInfoUrl: target.objectInfoUrl,
        baseUrl: target.baseUrl,
        success: false,
        error: 'ComfyUI returned an empty /object_info payload.',
        nodeCount
      })
      continue
    }

    const summarized = summarizeComfyUiSchemaByClassTypes({
      schema,
      classTypes,
      maxNodes
    })
    const previewClassTypes = Object.keys(schema)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, maxNodes)

    attempts.push({
      objectInfoUrl: target.objectInfoUrl,
      baseUrl: target.baseUrl,
      success: true,
      status: response.status,
      nodeCount
    })

    return {
      success: true,
      helper: 'native_comfyui_object_info',
      backend,
      aliasUsed: targetsResult.aliasUsed,
      requestedBaseUrl: targetsResult.requestedBaseUrl,
      baseUrl: target.baseUrl,
      objectInfoUrl: target.objectInfoUrl,
      nodeCount,
      timeoutMs,
      schemaRequested: includeSchema,
      requestedClassTypes: classTypes,
      availableClassTypesPreview: previewClassTypes,
      availableClassTypesPreviewTruncated: nodeCount > previewClassTypes.length,
      returnedSchemaNodeCount: includeSchema
        ? summarized.selectedClassTypes.length
        : 0,
      missingClassTypes: summarized.missingClassTypes,
      schemaTruncated: includeSchema ? summarized.truncated : false,
      schema: includeSchema ? summarized.selected : undefined,
      attempts
    }
  }

  return {
    success: false,
    helper: 'native_comfyui_object_info',
    backend,
    aliasUsed: targetsResult.aliasUsed,
    requestedBaseUrl: targetsResult.requestedBaseUrl,
    timeoutMs,
    attempts,
    error: {
      code: 'BACKEND_UNAVAILABLE',
      message:
        'Unable to fetch ComfyUI /object_info from the runtime targets. Verify ComfyUI URL and runtime reachability.',
      details: {
        attemptedTargets: attempts.map((attempt) => attempt.objectInfoUrl),
        availableAliases: Object.keys(buildRuntimeUrlAliasMap(backend))
      }
    }
  }
}

async function nativeBashExecute(input: {
  userId?: string
  sessionId?: string
  projectPath?: string | null
  command: string
  cwd?: string | null
  workspaceRoot?: string | null
  policyMode?: LegacyNativeToolPolicyMode
  accessMode?: NativeBashAccessMode | LegacyNativeToolPolicyMode | null
  commandAllowList?: string[] | null
  neverAllowList?: string[] | null
  timeoutMs?: number
  defaultTimeoutMs?: number | null
  requireApproval?: boolean
  approved?: boolean
  maxOutputChars?: number
  backend?: NativeExecutionBackend | null
  agentBrowserSettings?: AgentBrowserBashSettings | null
}): Promise<Record<string, any>> {
  const command = input.command?.trim() || ''
  const accessMode =
    normalizeBashAccessMode(input.accessMode ?? input.policyMode) ??
    DEFAULT_BASH_ACCESS_MODE
  const backend =
    normalizeNativeExecutionBackend(input.backend) ?? DEFAULT_NATIVE_BASH_BACKEND
  const policyMode = toLegacyBashPolicyMode(accessMode)
  const neverAllowList = normalizeCommandPatternList(input.neverAllowList) ?? []
  const requestedTimeoutMs = parseInteger(input.timeoutMs)
  const defaultTimeoutMs = parseInteger(input.defaultTimeoutMs)
  const timeoutMs = clamp(
    requestedTimeoutMs ?? defaultTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
    MIN_BASH_TIMEOUT_MS,
    MAX_BASH_TIMEOUT_MS
  )
  const maxOutputChars = clamp(
    parseInteger(input.maxOutputChars) ?? MAX_BASH_OUTPUT_CHARS,
    1_000,
    MAX_BASH_OUTPUT_CHARS
  )

  if (input.requireApproval === true && input.approved !== true) {
    return {
      success: false,
      blocked: true,
      reason: 'Command execution requires explicit approval.',
      command,
      policyMode,
      accessMode
    }
  }

  const policy = evaluateBashPolicy(command, accessMode, neverAllowList)
  if (policy.blocked) {
    return {
      success: false,
      blocked: true,
      reason: policy.reason,
      command,
      policyMode,
      accessMode
    }
  }

  const agentBrowserSettings = input.agentBrowserSettings
  const wantsAgentBrowserRuntime =
    agentBrowserSettings?.enabled === true &&
    isLikelyAgentBrowserBashCommand(command)
  let effectiveBackend = backend

  let commandToRun = command
  let effectiveTimeoutMs = timeoutMs
  let commandEnv: Record<string, string> | undefined
  let agentBrowserMetadata: Record<string, any> | undefined

  if (wantsAgentBrowserRuntime) {
    const dockerBlockReason = getDockerAgentBrowserRawBashBlockReason()
    if (dockerBlockReason) {
      return {
        success: false,
        blocked: false,
        errorCode: 'BACKEND_UNAVAILABLE',
        reason: dockerBlockReason,
        error: dockerBlockReason,
        command,
        policyMode,
        accessMode,
        backend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[backend],
        agentBrowser: {
          dockerUnsupported: false,
          supported: true,
          supportLevel: 'docker-sidecar',
          rawBashUnsupported: true
        }
      }
    }
  }

  if (wantsAgentBrowserRuntime && backend === 'docker_sandbox') {
    const availability = await checkAgentBrowserAvailability()
    if (availability.available && availability.command) {
      commandToRun = replaceAgentBrowserBashLauncher(commandToRun, availability.command)
      effectiveBackend = 'local'
      agentBrowserMetadata = {
        ...(agentBrowserMetadata ?? {}),
        managedRuntimeCommand: availability.command,
        managedRuntimeVersion: availability.version ?? null,
        backendOverride: 'local'
      }
    } else {
      const managedRuntimeReason =
        availability.reason ||
        'Managed Agent Browser runtime is unavailable. Configure Batshit Admin settings to provide a managed runtime command.'
      return {
        success: false,
        blocked: false,
        errorCode: 'BACKEND_UNAVAILABLE',
        reason: managedRuntimeReason,
        error: managedRuntimeReason,
        command,
        policyMode,
        accessMode,
        backend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[backend],
        agentBrowser: {
          managedRuntimeRequired: true,
          managedRuntimeUnavailable: managedRuntimeReason
        }
      }
    }
  }

  const useAgentBrowserDefaults = effectiveBackend === 'local' && wantsAgentBrowserRuntime

  if (useAgentBrowserDefaults && agentBrowserSettings) {
    const transformed = applyAgentBrowserBashDefaults(commandToRun, agentBrowserSettings)
    if (transformed.matched) {
      commandToRun = transformed.command
      agentBrowserMetadata = {
        ...(agentBrowserMetadata ?? {}),
        runtimeMode: transformed.runtimeMode,
        provider: transformed.provider,
        appliedDefaults: transformed.appliedDefaults
      }
    }

    const agentBrowserTimeoutMs = parseInteger(agentBrowserSettings.timeoutMs)
    if (requestedTimeoutMs === undefined && agentBrowserTimeoutMs !== undefined) {
      effectiveTimeoutMs = clamp(
        Math.max(timeoutMs, agentBrowserTimeoutMs),
        MIN_BASH_TIMEOUT_MS,
        MAX_BASH_TIMEOUT_MS
      )
      agentBrowserMetadata = {
        ...(agentBrowserMetadata ?? {}),
        timeoutMsApplied: effectiveTimeoutMs
      }
    }

    const screenshotPathInjection = await injectAgentBrowserBashScreenshotPath(commandToRun)
    if (screenshotPathInjection.injectedPath) {
      commandToRun = screenshotPathInjection.command
      const previousDefaults = Array.isArray(agentBrowserMetadata?.appliedDefaults)
        ? agentBrowserMetadata?.appliedDefaults
        : []
      agentBrowserMetadata = {
        ...(agentBrowserMetadata ?? {}),
        appliedDefaults: Array.from(new Set([...previousDefaults, 'screenshotPath'])),
        screenshotPathInjected: screenshotPathInjection.injectedPath
      }
    }

    const providerForCredentials = resolveAgentBrowserProviderFromCommand(
      commandToRun,
      agentBrowserSettings.provider
    )

    if (providerForCredentials !== 'local') {
      if (!input.userId) {
        const reason = `Provider "${providerForCredentials}" requires an authenticated user to load API keys.`
        return {
          success: false,
          blocked: false,
          reason,
          error: reason,
          command,
          policyMode,
          accessMode
        }
      }

      const providerEnvResult = await resolveAgentBrowserProviderEnv({
        userId: input.userId,
        provider: providerForCredentials
      })

      if (!providerEnvResult.hasCredential) {
        return {
          success: false,
          blocked: false,
          reason: providerEnvResult.reason,
          error: providerEnvResult.reason,
          command,
          policyMode,
          accessMode
        }
      }

      commandEnv = providerEnvResult.env
      agentBrowserMetadata = {
        ...(agentBrowserMetadata ?? {}),
        provider: providerForCredentials,
        providerCredentialsInjected: true
      }
    }
  }

  const workspaceResolution = await resolveBashWorkspaceRoot({
    userId: input.userId,
    projectPath: input.projectPath ?? null,
    workspaceRoot: input.workspaceRoot ?? null
  })

  if ('blocked' in workspaceResolution) {
    return {
      success: false,
      blocked: true,
      reason: workspaceResolution.reason,
      command,
      policyMode,
      accessMode
    }
  }

  const cwdResolution = await resolveBashWorkingDirectory({
    requestedCwd: input.cwd ?? input.projectPath ?? null,
    workspaceRoot: workspaceResolution.workspaceRoot
  })

  if ('blocked' in cwdResolution) {
    return {
      success: false,
      blocked: true,
      reason: cwdResolution.reason,
      command,
      policyMode,
      accessMode
    }
  }

  const mapping = mapBashCommandToRendererTool(command)
  const beforeEditSnapshot = await captureMappedTextFileSnapshot({
    mapping,
    cwd: cwdResolution.cwd,
    workspaceRoot: workspaceResolution.workspaceRoot
  })

  const managedPatchCommand = isManagedApplyPatchCommand(command)
  if (managedPatchCommand) {
    const managedPatchDocument = extractManagedApplyPatchDocument(command)
    if (!managedPatchDocument) {
      return {
        success: false,
        blocked: false,
        errorCode: 'INVALID_INPUT',
        reason:
          'Managed apply_patch requires a payload enclosed by "*** Begin Patch" and "*** End Patch".',
        error:
          'Managed apply_patch requires a payload enclosed by "*** Begin Patch" and "*** End Patch".',
        command,
        policyMode,
        accessMode,
        backend: effectiveBackend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot
      }
    }

    const parsedPatch = parseManagedApplyPatchDocument(managedPatchDocument)
    if (!parsedPatch.success) {
      const reason = parsedPatch.message || 'Invalid apply_patch payload.'
      return {
        success: false,
        blocked: false,
        errorCode: 'INVALID_INPUT',
        reason,
        error: reason,
        command,
        policyMode,
        accessMode,
        backend: effectiveBackend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot
      }
    }

    if (accessMode === 'plan') {
      const blockedTargets = parsedPatch.touchedPaths.filter((targetPath) => !isMarkdownPath(targetPath))
      if (blockedTargets.length > 0) {
        const listedTargets = blockedTargets.slice(0, 5).join(', ')
        const remainingCount = blockedTargets.length - Math.min(blockedTargets.length, 5)
        const suffix = remainingCount > 0 ? ` (+${remainingCount} more)` : ''
        const reason = `Plan mode only allows markdown (.md) apply_patch targets. Blocked: ${listedTargets}${suffix}`
        return {
          success: false,
          blocked: true,
          errorCode: 'POLICY_BLOCKED',
          reason,
          command,
          policyMode,
          accessMode,
          backend: effectiveBackend,
          backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
          cwd: cwdResolution.cwd,
          workspaceRoot: workspaceResolution.workspaceRoot
        }
      }
    }

    const protectedSystemSkillReason = getProtectedSystemSkillWriteViolationReason({
      command,
      cwd: cwdResolution.cwd,
      touchedPaths: parsedPatch.touchedPaths,
      workspaceRoot: workspaceResolution.workspaceRoot
    })
    if (protectedSystemSkillReason) {
      return {
        success: false,
        blocked: true,
        errorCode: 'POLICY_BLOCKED',
        reason: protectedSystemSkillReason,
        command,
        policyMode,
        accessMode,
        backend: effectiveBackend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot
      }
    }

    const protectedBatshitRepoReason = getProtectedBatshitRepoWriteViolationReason({
      command,
      cwd: cwdResolution.cwd,
      touchedPaths: parsedPatch.touchedPaths,
      workspaceRoot: workspaceResolution.workspaceRoot
    })
    if (protectedBatshitRepoReason) {
      return {
        success: false,
        blocked: true,
        errorCode: 'POLICY_BLOCKED',
        reason: protectedBatshitRepoReason,
        command,
        policyMode,
        accessMode,
        backend: effectiveBackend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot
      }
    }

    const managedStartedAt = Date.now()
    try {
      const execution = await executeManagedApplyPatch({
        operations: parsedPatch.operations,
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot
      })
      const mapping = mapBashCommandToRendererTool(command)
      const primaryTouchedPath = execution.touchedPaths[0]
      return {
        success: true,
        blocked: false,
        command,
        stdout: execution.message || '',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: Date.now() - managedStartedAt,
        truncated: false,
        policyMode,
        accessMode,
        backend: effectiveBackend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot,
        mappedToolName: mapping.toolName,
        mappedToolInput: {
          ...(mapping.args ?? {}),
          ...(primaryTouchedPath ? { filePath: primaryTouchedPath, path: primaryTouchedPath } : {}),
          touchedPaths: execution.touchedPaths
        },
        mappedReason: mapping.reason,
        managedApplyPatch: {
          managed: true,
          operationsApplied: execution.operationsApplied,
          touchedPaths: execution.touchedPaths
        }
      }
    } catch (error) {
      const reason =
        error instanceof Error && error.message
          ? error.message
          : 'Managed apply_patch execution failed.'
      return {
        success: false,
        blocked: false,
        errorCode: 'INVALID_INPUT',
        reason,
        error: reason,
        command,
        policyMode,
        accessMode,
        backend: effectiveBackend,
        backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
        cwd: cwdResolution.cwd,
        workspaceRoot: workspaceResolution.workspaceRoot
      }
    }
  }

  const protectedSystemSkillReason = getProtectedSystemSkillWriteViolationReason({
    command,
    cwd: cwdResolution.cwd,
    workspaceRoot: workspaceResolution.workspaceRoot
  })
  if (protectedSystemSkillReason) {
    return {
      success: false,
      blocked: true,
      errorCode: 'POLICY_BLOCKED',
      reason: protectedSystemSkillReason,
      command,
      policyMode,
      accessMode,
      backend: effectiveBackend,
      backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
      cwd: cwdResolution.cwd,
      workspaceRoot: workspaceResolution.workspaceRoot
    }
  }

  const protectedBatshitRepoReason = getProtectedBatshitRepoWriteViolationReason({
    command,
    cwd: cwdResolution.cwd,
    workspaceRoot: workspaceResolution.workspaceRoot
  })
  if (protectedBatshitRepoReason) {
    return {
      success: false,
      blocked: true,
      errorCode: 'POLICY_BLOCKED',
      reason: protectedBatshitRepoReason,
      command,
      policyMode,
      accessMode,
      backend: effectiveBackend,
      backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
      cwd: cwdResolution.cwd,
      workspaceRoot: workspaceResolution.workspaceRoot
    }
  }

  const executeWithBackend = async (
    commandValue: string
  ): Promise<
    | { ok: true; run: CommandRunResult; sandboxName?: string }
    | { ok: false; code: NativeAutomationErrorCode; reason: string; sandboxName?: string }
  > => {
    if (effectiveBackend === 'docker_sandbox') {
      const sandboxRun = await runDockerSandboxCommand({
        userId: input.userId,
        sessionId: input.sessionId,
        workspaceRoot: workspaceResolution.workspaceRoot,
        cwd: cwdResolution.cwd,
        command: commandValue,
        timeoutMs: effectiveTimeoutMs,
        maxOutputChars,
        env: commandEnv
      })
      if (!sandboxRun.ok) return sandboxRun
      return {
        ok: true,
        run: sandboxRun.run,
        sandboxName: sandboxRun.sandboxName
      }
    }

    if (effectiveBackend === 'apple_container') {
      const sandboxRun = await executeAppleContainerSandboxCommand({
        userId: input.userId,
        sessionId: input.sessionId,
        workspaceRoot: workspaceResolution.workspaceRoot,
        cwd: cwdResolution.cwd,
        command: commandValue,
        timeoutMs: effectiveTimeoutMs,
        maxOutputChars,
        env: commandEnv
      })
      if (!sandboxRun.ok) {
        return {
          ok: false,
          code: 'SANDBOX_UNAVAILABLE',
          reason: sandboxRun.reason,
          sandboxName: sandboxRun.sandboxName
        }
      }
      if (sandboxRun.cleanupWarnings.length > 0) {
        console.warn(
          '[Native Tools] Apple Container sandbox cleanup warnings:',
          sandboxRun.cleanupWarnings.join(' | ')
        )
      }
      return {
        ok: true,
        run: sandboxRun.run,
        sandboxName: sandboxRun.sandboxName
      }
    }

    const run = await runBashCommand({
      command: commandValue,
      cwd: cwdResolution.cwd,
      timeoutMs: effectiveTimeoutMs,
      maxOutputChars,
      env: commandEnv
    })
    return { ok: true, run }
  }

  let sandboxName: string | null = null
  const initialRunResult = await executeWithBackend(commandToRun)
  if (!initialRunResult.ok) {
    return {
      success: false,
      blocked: false,
      errorCode: initialRunResult.code,
      reason: initialRunResult.reason,
      command,
      policyMode,
      accessMode,
      backend: effectiveBackend,
      ...(initialRunResult.sandboxName ? { sandboxName: initialRunResult.sandboxName } : {})
    }
  }
  if (initialRunResult.sandboxName) {
    sandboxName = initialRunResult.sandboxName
  }

  let run = initialRunResult.run
  let recoveryAttempted = false
  let recoverySucceeded = false
  let recoveryError: string | null = null

  if (useAgentBrowserDefaults && isLikelyAgentBrowserBashCommand(commandToRun)) {
    const initialErrorMessage = extractAgentBrowserBashErrorMessage(run)
    const isRecoverableStartupFailure =
      isAgentBrowserBashRunFailure(run) && isAgentBrowserRecoverableStartupError(initialErrorMessage)
    const bootstrapCommands = isRecoverableStartupFailure
      ? resolveAgentBrowserBashBootstrapCommands(commandToRun, initialErrorMessage)
      : []

    if (bootstrapCommands.length > 0) {
      recoveryAttempted = true
      for (const bootstrapCommand of bootstrapCommands) {
        try {
          const bootstrapResult = await executeWithBackend(bootstrapCommand)
          if (!bootstrapResult.ok) {
            recoveryError = bootstrapResult.reason
            continue
          }
          if (bootstrapResult.sandboxName) {
            sandboxName = bootstrapResult.sandboxName
          }
          const bootstrapRun = bootstrapResult.run
          if (isAgentBrowserBashRunFailure(bootstrapRun)) {
            const bootstrapMessage = extractAgentBrowserBashErrorMessage(bootstrapRun)
            if (bootstrapMessage) recoveryError = bootstrapMessage
          }
        } catch (error) {
          const maybeError = error as NodeJS.ErrnoException
          recoveryError = maybeError?.message || String(error)
        }
      }

      try {
        const retryResult = await executeWithBackend(commandToRun)
        if (!retryResult.ok) {
          recoveryError = retryResult.reason
          throw new Error(recoveryError)
        }
        if (retryResult.sandboxName) {
          sandboxName = retryResult.sandboxName
        }
        const retryRun = retryResult.run
        run = retryRun
        recoverySucceeded = !isAgentBrowserBashRunFailure(retryRun)
        if (!recoverySucceeded) {
          const retryMessage = extractAgentBrowserBashErrorMessage(retryRun)
          if (retryMessage) recoveryError = retryMessage
        }
      } catch (error) {
        const maybeError = error as NodeJS.ErrnoException
        recoveryError = maybeError?.message || String(error)
      }
    }
  }
  const afterEditSnapshot =
    run.exitCode === 0 && run.timedOut === false
      ? await captureMappedTextFileSnapshot({
          mapping,
          cwd: cwdResolution.cwd,
          workspaceRoot: workspaceResolution.workspaceRoot
        })
      : null
  const screenshotPath = resolveAgentBrowserBashScreenshotPath(commandToRun, cwdResolution.cwd)
  const isAgentBrowserScreenshot = Boolean(screenshotPath)
  const screenshotMediaType = inferImageMediaTypeFromPath(screenshotPath || '') || 'image/png'
  let screenshotReadyForModel = false
  let modelImageUrl: string | null = null

  if (screenshotPath) {
    try {
      const details = await stat(screenshotPath)
      screenshotReadyForModel =
        details.isFile() && details.size > 0 && details.size <= MAX_AGENT_BROWSER_SCREENSHOT_BYTES
    } catch {
      screenshotReadyForModel = false
    }
  }

  if (
    isAgentBrowserScreenshot &&
    screenshotPath &&
    screenshotReadyForModel &&
    run.exitCode === 0 &&
    run.timedOut === false &&
    input.userId
  ) {
    modelImageUrl = await uploadAgentBrowserScreenshotForModel({
      userId: input.userId,
      sessionId: input.sessionId,
      filePath: screenshotPath,
      mediaType: screenshotMediaType
    })

    if (modelImageUrl) {
      await cleanupAgentBrowserScreenshotFile(screenshotPath)
      screenshotReadyForModel = false
    }
  }

  if (isAgentBrowserScreenshot) {
    agentBrowserMetadata = {
      ...(agentBrowserMetadata ?? {}),
      command: 'screenshot',
      screenshot: {
        command: 'screenshot',
        path: screenshotReadyForModel ? screenshotPath : null,
        mediaType: screenshotMediaType,
        modelImageUrl,
        modelVisibleInLoop: Boolean(modelImageUrl || screenshotReadyForModel),
        ephemeral: true,
        historyRetention: 'none'
      }
    }
  }

  if (recoveryAttempted || recoverySucceeded || recoveryError) {
    agentBrowserMetadata = {
      ...(agentBrowserMetadata ?? {}),
      recovery: {
        attempted: recoveryAttempted,
        succeeded: recoverySucceeded,
        ...(recoveryError ? { error: recoveryError } : {})
      }
    }
  }

  return {
    success: run.exitCode === 0 && run.timedOut === false,
    blocked: false,
    command: run.command,
    stdout: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    durationMs: run.durationMs,
    truncated: run.truncated,
    policyMode,
    accessMode,
    backend: effectiveBackend,
    backendLabel: NATIVE_EXECUTION_BACKEND_LABELS[effectiveBackend],
    cwd: cwdResolution.cwd,
    workspaceRoot: workspaceResolution.workspaceRoot,
    ...(sandboxName ? { sandboxName } : {}),
    mappedToolName: mapping.toolName,
    mappedToolInput: mapping.args,
    mappedReason: mapping.reason,
    ...(beforeEditSnapshot && afterEditSnapshot
      ? {
          before: beforeEditSnapshot,
          after: afterEditSnapshot
        }
      : {}),
    ...(commandToRun !== command ? { requestedCommand: command } : {}),
    ...(agentBrowserMetadata ? { agentBrowser: agentBrowserMetadata } : {}),
    ...(modelImageUrl ? { modelImageUrl } : {})
  }
}

async function nativeAgentBrowserFind(input: {
  userId: string
  query?: string
  limit?: number
  settings?: {
    liveViewEnabled?: boolean
    runtimeMode?: AgentBrowserRuntimeMode
    cdpPort?: number
    provider?: AgentBrowserProvider
    executablePath?: string
    extraFlags?: string[]
    timeoutMs?: number
  }
}): Promise<Record<string, any>> {
  const normalizedLimit = clamp(
    parseInteger(input.limit) ?? DEFAULT_AGENT_BROWSER_RESULTS,
    1,
    MAX_AGENT_BROWSER_RESULTS
  )
  const query = typeof input.query === 'string' ? input.query.trim().toLowerCase() : ''

  const availability = await checkAgentBrowserAvailability()
  const ranked = AGENT_BROWSER_COMMANDS.map((command) => ({
    ...command,
    score: scoreAgentBrowserMatch(query, command)
  }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))

  return {
    available: availability.available,
    supported: availability.supported !== false,
    dockerUnsupported: availability.dockerUnsupported === true,
    runtime: {
      command: availability.command ?? null,
      version: availability.version ?? null
    },
    installHelp: availability.available
      ? null
      : availability.supportLevel === 'docker-sidecar'
        ? DOCKER_AGENT_BROWSER_INSTALL_HELP
        : availability.reason ?? AGENT_BROWSER_INSTALL_HELP,
    reason: availability.available ? null : availability.reason ?? null,
    query,
    limit: normalizedLimit,
    totalMatches: ranked.length,
    supportLevel: availability.supportLevel ?? 'native-cli',
    defaults: {
      liveViewEnabled:
        availability.supportLevel === 'docker-sidecar'
          ? false
          : input.settings?.liveViewEnabled ?? true,
      runtimeMode:
        availability.supportLevel === 'docker-sidecar'
          ? DEFAULT_AGENT_BROWSER_RUNTIME_MODE
          : input.settings?.runtimeMode ?? DEFAULT_AGENT_BROWSER_RUNTIME_MODE,
      cdpPort: input.settings?.cdpPort ?? DEFAULT_AGENT_BROWSER_CDP_PORT,
      provider: input.settings?.provider ?? DEFAULT_AGENT_BROWSER_PROVIDER,
      executablePath:
        availability.supportLevel === 'docker-sidecar' ? null : input.settings?.executablePath ?? null,
      extraFlags: input.settings?.extraFlags ?? [],
      timeoutMs: input.settings?.timeoutMs ?? DEFAULT_AGENT_BROWSER_TIMEOUT_MS
    },
    results: ranked.slice(0, normalizedLimit).map((entry) => ({
      toolName: entry.id,
      cliCommand: entry.cli.join(' '),
      summary: entry.summary,
      argsHint: entry.argsHint,
      paramsHint: entry.paramsHint,
      examples: entry.examples
    }))
  }
}

function rewriteLocalhostUrlForDockerAgentBrowserSidecar(value: string): {
  url: string
  rewritten: boolean
} {
  try {
    const parsed = new URL(value)
    if (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]' ||
      parsed.hostname === '::1'
    ) {
      parsed.hostname = 'host.docker.internal'
      return {
        url: parsed.toString(),
        rewritten: true
      }
    }
  } catch {
    // Agent Browser will report invalid/non-URL targets itself.
  }
  return {
    url: value,
    rewritten: false
  }
}

async function nativeAgentBrowserUse(input: {
  userId: string
  sessionId?: string
  toolName: string
  params?: AgentBrowserUseParams
  settings?: {
    liveViewEnabled?: boolean
    runtimeMode?: AgentBrowserRuntimeMode
    cdpPort?: number
    provider?: AgentBrowserProvider
    executablePath?: string
    extraFlags?: string[]
    timeoutMs?: number
  }
}): Promise<Record<string, any>> {
  const normalizedToolName = normalizeAgentBrowserToolName(input.toolName)
  if (!normalizedToolName) {
    return {
      success: false,
      error: 'toolName is required. Run agent-browser --help to list available commands.'
    }
  }

  const command = AGENT_BROWSER_COMMAND_INDEX.get(normalizedToolName)
  if (!command) {
    const suggestions = AGENT_BROWSER_COMMANDS.map((entry) => entry.id)
      .filter((entry) => entry.includes(normalizedToolName))
      .slice(0, 5)
    return {
      success: false,
      toolName: normalizedToolName,
      error:
        suggestions.length > 0
          ? `Unknown Agent Browser command "${normalizedToolName}". Try: ${suggestions.join(', ')}`
          : `Unknown Agent Browser command "${normalizedToolName}". Run agent-browser --help for available commands.`
    }
  }

  const availability = await checkAgentBrowserAvailability()
  if (!availability.available || !availability.command) {
    return {
      success: false,
      supported: availability.supported !== false,
      dockerUnsupported: availability.dockerUnsupported === true,
      supportLevel: availability.supportLevel ?? 'native-cli',
      toolName: command.id,
      error: availability.reason ?? AGENT_BROWSER_INSTALL_HELP
    }
  }

  const params = input.params && typeof input.params === 'object' ? input.params : {}
  const dockerSidecar = availability.supportLevel === 'docker-sidecar'
  const requestedRuntimeMode =
    normalizeAgentBrowserRuntimeMode(params.runtimeMode) ??
    input.settings?.runtimeMode ??
    DEFAULT_AGENT_BROWSER_RUNTIME_MODE
  const runtimeMode = dockerSidecar ? DEFAULT_AGENT_BROWSER_RUNTIME_MODE : requestedRuntimeMode
  const provider =
    normalizeAgentBrowserProvider(params.provider) ??
    input.settings?.provider ??
    DEFAULT_AGENT_BROWSER_PROVIDER
  const requestedLiveView =
    parseBoolean(params.liveView) ??
    input.settings?.liveViewEnabled ??
    true
  const liveView = dockerSidecar ? false : requestedLiveView
  const cdpPort = clamp(
    parseInteger(params.cdpPort) ??
      input.settings?.cdpPort ??
      DEFAULT_AGENT_BROWSER_CDP_PORT,
    1,
    65535
  )
  const requestedExecutablePath =
    (typeof params.executablePath === 'string' && params.executablePath.trim().length > 0
      ? params.executablePath.trim()
      : input.settings?.executablePath) ?? null
  const executablePath = dockerSidecar ? null : requestedExecutablePath
  const extraFlags = [
    ...(input.settings?.extraFlags ?? []),
    ...toAgentBrowserArgArray(params.extraFlags)
  ]
  const timeoutMs = clamp(
    parseInteger(params.timeoutMs) ??
      input.settings?.timeoutMs ??
      DEFAULT_AGENT_BROWSER_TIMEOUT_MS,
    MIN_AGENT_BROWSER_TIMEOUT_MS,
    MAX_AGENT_BROWSER_TIMEOUT_MS
  )
  let commandArgs = buildAgentBrowserCommandArgs(command, params)
  let dockerSidecarUrlRewrite: Record<string, string> | null = null
  if (dockerSidecar && command.id === 'open' && typeof commandArgs[0] === 'string') {
    const originalUrl = commandArgs[0]
    const rewrite = rewriteLocalhostUrlForDockerAgentBrowserSidecar(originalUrl)
    if (rewrite.rewritten) {
      commandArgs = [rewrite.url, ...commandArgs.slice(1)]
      dockerSidecarUrlRewrite = {
        originalUrl,
        sidecarUrl: rewrite.url
      }
    }
  }
  if (command.id === 'screenshot') {
    const requestedPath = commandArgs[0]
    commandArgs = [await buildDefaultAgentBrowserScreenshotPath(requestedPath)]
  }
  const autoWaitBeforeScreenshot =
    command.id === 'screenshot'
      ? parseBoolean(params.autoWaitBeforeScreenshot) ?? true
      : false
  const screenshotWaitMs =
    command.id === 'screenshot'
      ? clamp(
          parseInteger(params.screenshotWaitMs) ?? DEFAULT_AGENT_BROWSER_SCREENSHOT_WAIT_MS,
          MIN_AGENT_BROWSER_SCREENSHOT_WAIT_MS,
          MAX_AGENT_BROWSER_SCREENSHOT_WAIT_MS
        )
      : 0
  const flagArgs = buildAgentBrowserFlagArgs(params.flags)
  const sessionArg =
    typeof params.session === 'string' && params.session.trim().length > 0
      ? ['--session', params.session.trim()]
      : []
  const explicitHeaded = parseBoolean(params.headed)
  const headedArg =
    !dockerSidecar && (explicitHeaded === true || (explicitHeaded === undefined && liveView === true))
      ? ['--headed']
      : []
  const runtimeArgs =
    runtimeMode === 'chrome-cdp'
      ? ['--cdp', `http://127.0.0.1:${cdpPort}`]
      : []
  const providerArgs = provider !== 'local' ? ['-p', provider] : []
  const executableArgs = executablePath ? ['--executable-path', executablePath] : []
  const jsonArg = params.json === false ? [] : ['--json']

  const args = [
    ...runtimeArgs,
    ...providerArgs,
    ...headedArg,
    ...executableArgs,
    ...sessionArg,
    ...extraFlags,
    ...jsonArg,
    ...command.cli,
    ...commandArgs,
    ...flagArgs
  ]

  const providerEnvResult = await resolveAgentBrowserProviderEnv({
    userId: input.userId,
    provider
  })
  if (!providerEnvResult.hasCredential) {
    return {
      success: false,
      toolName: command.id,
      error: providerEnvResult.reason
    }
  }

  let livePreviewPreparation: Record<string, any> | null = null
  const shouldPrepareLivePreview =
    command.id === 'open' &&
    liveView === true &&
    runtimeMode === 'chromium' &&
    provider === 'local' &&
    sessionArg.length === 0 &&
    (parseBoolean(params.autoPrepareLivePreview) ?? true)

  if (shouldPrepareLivePreview) {
    const prepArgs = [
      ...runtimeArgs,
      ...providerArgs,
      ...headedArg,
      ...executableArgs,
      ...sessionArg,
      ...extraFlags,
      ...jsonArg,
      'close'
    ]

    try {
      const prepRun = await runAgentBrowserCli({
        command: availability.command,
        args: prepArgs,
        timeoutMs,
        env: providerEnvResult.env
      })
      const prepOutput = parseJsonFromOutput(prepRun.stdout)
      const prepError = parseJsonFromOutput(prepRun.stderr)
      const prepErrorMessage = extractAgentBrowserErrorMessage(prepOutput, prepError, prepRun.stderr)
      const prepSuccessFromPayload =
        typeof prepOutput?.success === 'boolean' ? prepOutput.success : prepRun.exitCode === 0
      livePreviewPreparation = {
        attempted: true,
        succeeded: prepSuccessFromPayload && prepRun.timedOut === false,
        error: prepSuccessFromPayload ? null : prepErrorMessage,
        exitCode: prepRun.exitCode,
        durationMs: prepRun.durationMs
      }
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      livePreviewPreparation = {
        attempted: true,
        succeeded: false,
        error: maybeError?.message || String(error),
        exitCode: null,
        durationMs: null
      }
    }
  }

  let preScreenshotWait: Record<string, any> | null = null
  if (command.id === 'screenshot' && autoWaitBeforeScreenshot && screenshotWaitMs > 0) {
    const waitArgs = [
      ...runtimeArgs,
      ...providerArgs,
      ...headedArg,
      ...executableArgs,
      ...sessionArg,
      ...extraFlags,
      ...jsonArg,
      'wait',
      String(screenshotWaitMs)
    ]

    try {
      const waitRun = await runAgentBrowserCli({
        command: availability.command,
        args: waitArgs,
        timeoutMs,
        env: providerEnvResult.env
      })
      const waitOutput = parseJsonFromOutput(waitRun.stdout)
      const waitError = parseJsonFromOutput(waitRun.stderr)
      const waitSuccessFromPayload =
        typeof waitOutput?.success === 'boolean' ? waitOutput.success : waitRun.exitCode === 0
      const waitErrorMessage =
        (typeof waitOutput?.error === 'string' && waitOutput.error) ||
        (typeof waitError?.error === 'string' && waitError.error) ||
        waitRun.stderr.trim() ||
        (waitRun.timedOut ? 'Agent Browser wait command timed out.' : null)

      preScreenshotWait = {
        attempted: true,
        waitMs: screenshotWaitMs,
        success: waitSuccessFromPayload && waitRun.timedOut === false,
        durationMs: waitRun.durationMs,
        timedOut: waitRun.timedOut,
        exitCode: waitRun.exitCode,
        error: waitSuccessFromPayload ? null : waitErrorMessage
      }
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException
      preScreenshotWait = {
        attempted: true,
        waitMs: screenshotWaitMs,
        success: false,
        durationMs: null,
        timedOut: false,
        exitCode: null,
        error: maybeError?.message || String(error)
      }
    }
  }

  let run: AgentBrowserCliRunResult
  try {
    run = await runAgentBrowserCli({
      command: availability.command,
      args,
      timeoutMs,
      env: providerEnvResult.env
    })
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException
    return {
      success: false,
      toolName: command.id,
      error:
        maybeError?.code === 'ENOENT'
          ? `${AGENT_BROWSER_INSTALL_HELP} (agent-browser binary not found).`
          : maybeError?.message || String(error)
    }
  }

  let parsedOutput = parseJsonFromOutput(run.stdout)
  let parsedError = parseJsonFromOutput(run.stderr)
  let bootstrapAttempted = false
  let bootstrapSucceeded = false

  const bootstrapCliCommands = resolveAgentBrowserBootstrapCliArgs(
    command.id,
    extractAgentBrowserErrorMessage(parsedOutput, parsedError, run.stderr)
  )

  if (bootstrapCliCommands.length > 0) {
    bootstrapAttempted = true
    for (const bootstrapCli of bootstrapCliCommands) {
      const bootstrapArgs = [
        ...runtimeArgs,
        ...providerArgs,
        ...headedArg,
        ...executableArgs,
        ...sessionArg,
        ...extraFlags,
        ...jsonArg,
        ...bootstrapCli
      ]

      try {
        const bootstrapRun = await runAgentBrowserCli({
          command: availability.command,
          args: bootstrapArgs,
          timeoutMs,
          env: providerEnvResult.env
        })
        const bootstrapOutput = parseJsonFromOutput(bootstrapRun.stdout)
        const bootstrapError = parseJsonFromOutput(bootstrapRun.stderr)
        const bootstrapErrorMessage = extractAgentBrowserErrorMessage(
          bootstrapOutput,
          bootstrapError,
          bootstrapRun.stderr
        )
        const bootstrapSuccessFromPayload =
          typeof bootstrapOutput?.success === 'boolean'
            ? bootstrapOutput.success
            : bootstrapRun.exitCode === 0
        const bootstrapCommandSucceeded =
          bootstrapSuccessFromPayload && bootstrapRun.timedOut === false

        if (!bootstrapCommandSucceeded) continue

        // Verify bootstrap actually restored a usable browser context by retrying
        // the original command immediately. If the retry still fails with the same
        // startup-state errors, continue to the next bootstrap candidate.
        const retryRun = await runAgentBrowserCli({
          command: availability.command,
          args,
          timeoutMs,
          env: providerEnvResult.env
        })
        const retryOutput = parseJsonFromOutput(retryRun.stdout)
        const retryError = parseJsonFromOutput(retryRun.stderr)
        const retryErrorMessage = extractAgentBrowserErrorMessage(
          retryOutput,
          retryError,
          retryRun.stderr
        )
        const retrySuccessFromPayload =
          typeof retryOutput?.success === 'boolean' ? retryOutput.success : retryRun.exitCode === 0

        run = retryRun
        parsedOutput = retryOutput
        parsedError = retryError

        if (retrySuccessFromPayload && retryRun.timedOut === false) {
          bootstrapSucceeded = true
          break
        }

        const retryRecoverable = isAgentBrowserRecoverableStartupError(retryErrorMessage)

        if (!retryRecoverable) {
          break
        }
      } catch {
        // Try next bootstrap candidate.
      }
    }
  }

  const successFromPayload =
    typeof parsedOutput?.success === 'boolean' ? parsedOutput.success : run.exitCode === 0
  const errorMessage =
    (typeof parsedOutput?.error === 'string' && parsedOutput.error) ||
    (typeof parsedError?.error === 'string' && parsedError.error) ||
    run.stderr.trim() ||
    (run.timedOut ? 'Agent Browser command timed out.' : null)

  let resultPayload: unknown = parsedOutput?.data ?? parsedOutput ?? run.stdout.trim()
  let modelImageUrl: string | null = null

  if (command.id === 'screenshot' && successFromPayload && run.timedOut === false) {
    const screenshotPath =
      typeof commandArgs[0] === 'string' && commandArgs[0].trim().length > 0
        ? path.resolve(commandArgs[0])
        : null
    if (screenshotPath) {
      const mediaType = inferImageMediaTypeFromPath(screenshotPath) || 'image/png'
      const uploadedUrl = await uploadAgentBrowserScreenshotForModel({
        userId: input.userId,
        sessionId: input.sessionId,
        filePath: screenshotPath,
        mediaType
      })

      if (uploadedUrl) {
        modelImageUrl = uploadedUrl
        resultPayload = {
          url: uploadedUrl,
          mediaType,
          source: 'agent_browser_screenshot',
          command: 'screenshot'
        }
        await cleanupAgentBrowserScreenshotFile(screenshotPath)
      }
    }
  }

  return {
    success: successFromPayload && run.timedOut === false,
    toolName: command.id,
    cliCommand: `${availability.command} ${args.join(' ')}`.trim(),
    supportLevel: availability.supportLevel ?? 'native-cli',
    result: resultPayload,
    error: successFromPayload ? null : errorMessage,
    runtime: {
      command: availability.command,
      version: availability.version ?? null,
      supportLevel: availability.supportLevel ?? 'native-cli',
      mode: runtimeMode,
      requestedMode: requestedRuntimeMode,
      provider,
      liveViewEnabled: liveView,
      requestedLiveViewEnabled: requestedLiveView,
      cdpPort: runtimeMode === 'chrome-cdp' ? cdpPort : null,
      ...(dockerSidecar
        ? {
            dockerSidecar: {
              url: resolveAgentBrowserSidecarUrl(),
              headedDisabled: explicitHeaded === true || requestedLiveView === true,
              executablePathIgnored: Boolean(requestedExecutablePath),
              urlRewrite: dockerSidecarUrlRewrite
            }
          }
        : {})
    },
    execution: {
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      exitCode: run.exitCode,
      signal: run.signal,
      truncated: run.truncated
    },
    bootstrap: {
      attempted: bootstrapAttempted,
      succeeded: bootstrapSucceeded
    },
    ...(livePreviewPreparation ? { livePreviewPreparation } : {}),
    ...(preScreenshotWait ? { preScreenshotWait } : {}),
    ...(modelImageUrl ? { modelImageUrl } : {}),
    raw: {
      stdout: run.stdout,
      stderr: run.stderr
    }
  }
}

const NATIVE_AUTOMATION_ACTION_SCHEMA = z.enum(NATIVE_AUTOMATION_ACTIONS)
const NATIVE_AUTOMATION_CONTEXT_SCHEMA = z
  .object({
    session_id: z.string().trim().min(1),
    agent_id: z.string().trim().min(1),
    mode: z.enum(['mode1', 'mode2', 'mode3', 'mode4']),
    actor_type: z.enum(['primary', 'subagent']),
    parent_agent_id: z.string().trim().optional()
  })
  .superRefine((value, ctx) => {
    if (value.actor_type === 'subagent' && !value.parent_agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'parent_agent_id is required when actor_type is subagent.'
      })
    }
  })

const NATIVE_AUTOMATION_INPUT_SCHEMAS = {
  bash_execute: z.object({
    command: z.string().trim().min(1),
    cwd: z.string().trim().optional(),
    timeoutMs: z.number().int().min(MIN_BASH_TIMEOUT_MS).max(MAX_BASH_TIMEOUT_MS).optional(),
    maxOutputChars: z.number().int().min(1_000).max(MAX_BASH_OUTPUT_CHARS).optional()
  }),
  cli_tool_find: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_DYNAMIC_RESULTS).optional(),
    includeSchema: z.boolean().optional(),
    selectedToolIds: z.array(z.string()).optional()
  }),
  cli_tool_use: z.object({
    toolId: z.string().trim().min(1).optional(),
    input: z.record(z.string(), z.any()).optional(),
    params: z.record(z.string(), z.any()).optional(),
    allowRisky: z.boolean().optional(),
    selectedToolIds: z.array(z.string()).optional()
  }).passthrough(),
  agent_browser_find: z.object({
    query: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_AGENT_BROWSER_RESULTS).optional()
  }),
  agent_browser_use: z.object({
    toolName: z.string().trim().min(1),
    params: z.record(z.string(), z.any()).optional()
  }),
  artifact_find: CONTROL_FIND_INPUT_SCHEMA,
  artifact_use: CONTROL_USE_INPUT_SCHEMA,
  runtime_addon_list: z.object({
    includeStatus: z.boolean().optional()
  }),
  runtime_addon_status: z.object({
    addonId: z.enum(RUNTIME_ADDON_IDS)
  }),
  runtime_addon_prepare: z.object({
    addonId: z.enum(RUNTIME_ADDON_IDS)
  }),
  runtime_addon_start: z.object({
    addonId: z.enum(RUNTIME_ADDON_IDS)
  }),
  runtime_addon_stop: z.object({
    addonId: z.enum(RUNTIME_ADDON_IDS)
  }),
  native_skill: z.object({
    skillId: z.string().trim().min(1),
    action: z.enum(NATIVE_SKILL_TOOL_ACTIONS).optional(),
    path: z.string().trim().optional(),
    args: z.array(z.string()).max(MAX_SKILL_SCRIPT_ARGS).optional(),
    maxChars: z.number().int().min(64).max(MAX_SKILL_REFERENCE_CHARS).optional(),
    cwd: z.string().trim().optional(),
    timeoutMs: z.number().int().min(MIN_BASH_TIMEOUT_MS).max(MAX_BASH_TIMEOUT_MS).optional(),
    maxOutputChars: z.number().int().min(1_000).max(MAX_BASH_OUTPUT_CHARS).optional()
  }),
  batshit_tool_search: BATSHIT_TOOL_SEARCH_INPUT_SCHEMA,
  batshit_tool_use: BATSHIT_TOOL_USE_INPUT_SCHEMA,
  web_search: z.object({
    query: z.string().trim().min(1),
    provider: z.enum(['duckduckgo-html', 'exa', 'perplexity']).optional(),
    exaSearchType: z.enum(['auto', 'fast', 'neural', 'deep']).optional(),
    perplexityMaxTokensPerPage: z.number().int().min(64).max(4096).optional(),
    maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
    region: z.string().optional(),
    safeSearch: z.enum(['strict', 'moderate', 'off']).optional(),
    timeoutMs: z.number().int().min(1_000).max(MAX_WEB_SEARCH_TIMEOUT_MS).optional()
  }),
  fetch_zip: z.object({
    zipId: z.string().trim().min(1),
    includeContent: z.boolean().optional(),
    maxChars: z.number().int().min(64).max(MAX_ZIP_CHARS).optional()
  })
} as const

function resolveNativeAutomationToggleState(
  action: NativeAutomationAction,
  settings: ResolvedNativeToolSettings
): boolean {
  switch (action) {
    case 'bash_execute':
      return settings.bashEnabled
    case 'cli_tool_find':
    case 'cli_tool_use':
      return settings.cliToolsEnabled
    case 'agent_browser_find':
    case 'agent_browser_use':
      return settings.agentBrowserEnabled
    case 'artifact_find':
    case 'artifact_use':
      return settings.artifactRuntimeEnabled
    case 'runtime_addon_list':
    case 'runtime_addon_status':
    case 'runtime_addon_prepare':
    case 'runtime_addon_start':
    case 'runtime_addon_stop':
      return settings.batshitToolsEnabled
    case 'native_skill':
      return true
    case 'batshit_tool_search':
    case 'batshit_tool_use':
      return Boolean(
        settings.dynamicMcpEnabled ||
          settings.cliToolsEnabled ||
          settings.agentBrowserEnabled ||
          settings.artifactRuntimeEnabled ||
          settings.batshitToolsEnabled ||
          settings.fetchZipEnabled
      )
    case 'web_search':
      return settings.webSearchEnabled
    case 'fetch_zip':
      return settings.fetchZipEnabled
    default:
      return false
  }
}

function resolveBatshitToolBrokerFamiliesForAutomation(
  settings: ResolvedNativeToolSettings,
  context: NativeAutomationDispatchContext,
  options?: { memoryControlsEnabled?: boolean }
): BatshitToolFamily[] {
  const families: BatshitToolFamily[] = []
  if (settings.dynamicMcpEnabled) families.push('mcp')
  if (settings.cliToolsEnabled) families.push('cli')
  if (settings.artifactRuntimeEnabled) families.push('artifact')
  if (settings.agentBrowserEnabled) families.push('agent_browser')
  if (settings.fetchZipEnabled && context.actor_type === 'primary') families.push('fabric')
  if (
    settings.batshitToolsEnabled &&
    context.actor_type === 'primary' &&
    (context.mode === 'mode3' || context.mode === 'mode4')
  ) {
    if (!families.includes('fabric')) families.push('fabric')
  }
  // SA-104 P3: memory controls open the fabric family for PRIMARY actors on every mode
  // (n8n mode1/mode2 included) — the sys.zip.fetch precedent, scoped by the per-agent
  // memory_enabled flag resolved by the caller from the governing agent record.
  if (
    settings.batshitToolsEnabled &&
    context.actor_type === 'primary' &&
    options?.memoryControlsEnabled === true
  ) {
    if (!families.includes('fabric')) families.push('fabric')
  }
  return families
}

function parseNativeAutomationContext(
  context: unknown
): { ok: true; value: NativeAutomationDispatchContext } | { ok: false; message: string; details?: any } {
  const parsed = NATIVE_AUTOMATION_CONTEXT_SCHEMA.safeParse(
    normalizeNativeAutomationContextInput(context)
  )
  if (!parsed.success) {
    return {
      ok: false,
      message: 'Invalid context payload.',
      details: parsed.error.flatten()
    }
  }
  return { ok: true, value: parsed.data }
}

function normalizePublicPrimaryAgentType(value: unknown): PublicPrimaryAgentType | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'n8n' || normalized === 'api' || normalized === 'cli') {
    return normalized
  }
  return null
}

function normalizeNativeAutomationContextInput(context: unknown): unknown {
  const record = asObjectRecord(context)
  if (!record) return context
  if (typeof record.mode === 'string' && record.mode.trim().length > 0) {
    return context
  }

  const primaryAgentType = normalizePublicPrimaryAgentType(
    record.primary_agent_type ?? record.primaryAgentType ?? record.agent_type ?? record.agentType
  )
  if (!primaryAgentType) return context

  return {
    ...record,
    mode: PUBLIC_PRIMARY_AGENT_TYPE_TO_NATIVE_MODE[primaryAgentType]
  }
}

function parseNativeAutomationAction(
  action: unknown
): { ok: true; value: NativeAutomationAction } | { ok: false; message: string } {
  const parsed = NATIVE_AUTOMATION_ACTION_SCHEMA.safeParse(action)
  if (!parsed.success) {
    return {
      ok: false,
      message: `Invalid action. Allowed actions: ${NATIVE_AUTOMATION_ACTIONS.join(', ')}.`
    }
  }
  return { ok: true, value: parsed.data }
}

function parseNativeAutomationInput(
  action: NativeAutomationAction,
  input: unknown
): { ok: true; value: Record<string, any> } | { ok: false; message: string; details?: any } {
  const normalizedInput = normalizeNativeAutomationInput(action, input)
  const schema = NATIVE_AUTOMATION_INPUT_SCHEMAS[action]
  const parsed = schema.safeParse(normalizedInput ?? {})
  if (!parsed.success) {
    return {
      ok: false,
      message: `Invalid input for action "${action}".`,
      details: parsed.error.flatten()
    }
  }
  return { ok: true, value: parsed.data }
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function parseJsonObjectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null
  }

  try {
    const parsed = JSON.parse(trimmed)
    return asObjectRecord(parsed)
  } catch {
    return null
  }
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length > 0) {
        return trimmed
      }
    }
  }
  return undefined
}

function firstFiniteNumber(values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
  }
  return undefined
}

function normalizeBashExecuteInput(input: unknown): unknown {
  const source = asObjectRecord(input)
  if (!source) {
    return input
  }

  const nestedInput = asObjectRecord(source.input)
  const argumentsInput = asObjectRecord(source.arguments)
  const valueInput = asObjectRecord(source.value) ?? parseJsonObjectRecord(source.value)
  const argumentsValueInput =
    asObjectRecord(argumentsInput?.value) ?? parseJsonObjectRecord(argumentsInput?.value)

  const command = firstNonEmptyString([
    source.command,
    source.cmd,
    source.innerCommand,
    nestedInput?.command,
    nestedInput?.cmd,
    nestedInput?.innerCommand,
    argumentsInput?.command,
    argumentsInput?.cmd,
    argumentsInput?.innerCommand,
    valueInput?.command,
    valueInput?.cmd,
    valueInput?.innerCommand,
    argumentsValueInput?.command,
    argumentsValueInput?.cmd,
    argumentsValueInput?.innerCommand
  ])

  const cwd = firstNonEmptyString([
    source.cwd,
    source.path,
    source.dirPath,
    nestedInput?.cwd,
    nestedInput?.path,
    nestedInput?.dirPath,
    argumentsInput?.cwd,
    argumentsInput?.path,
    argumentsInput?.dirPath,
    valueInput?.cwd,
    valueInput?.path,
    valueInput?.dirPath,
    argumentsValueInput?.cwd,
    argumentsValueInput?.path,
    argumentsValueInput?.dirPath
  ])

  const timeoutMs = firstFiniteNumber([
    source.timeoutMs,
    nestedInput?.timeoutMs,
    argumentsInput?.timeoutMs,
    valueInput?.timeoutMs,
    argumentsValueInput?.timeoutMs
  ])

  const maxOutputChars = firstFiniteNumber([
    source.maxOutputChars,
    source.maxChars,
    nestedInput?.maxOutputChars,
    nestedInput?.maxChars,
    argumentsInput?.maxOutputChars,
    argumentsInput?.maxChars,
    valueInput?.maxOutputChars,
    valueInput?.maxChars,
    argumentsValueInput?.maxOutputChars,
    argumentsValueInput?.maxChars
  ])

  return {
    ...source,
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputChars !== undefined ? { maxOutputChars } : {})
  }
}

function normalizeNativeSkillAutomationInput(input: unknown): unknown {
  const source = asObjectRecord(input)
  if (!source) {
    return input
  }

  const nestedInput = asObjectRecord(source.input)
  const argumentsInput = asObjectRecord(source.arguments)
  const valueInput = asObjectRecord(source.value) ?? parseJsonObjectRecord(source.value)
  const argumentsValueInput =
    asObjectRecord(argumentsInput?.value) ?? parseJsonObjectRecord(argumentsInput?.value)

  const skillId = firstNonEmptyString([
    source.skillId,
    source.skill_id,
    nestedInput?.skillId,
    nestedInput?.skill_id,
    argumentsInput?.skillId,
    argumentsInput?.skill_id,
    valueInput?.skillId,
    valueInput?.skill_id,
    argumentsValueInput?.skillId,
    argumentsValueInput?.skill_id
  ])

  const action = firstNonEmptyString([
    source.action,
    nestedInput?.action,
    argumentsInput?.action,
    valueInput?.action,
    argumentsValueInput?.action
  ])

  const path = firstNonEmptyString([
    source.path,
    source.reference,
    source.referencePath,
    source.reference_path,
    nestedInput?.path,
    nestedInput?.reference,
    nestedInput?.referencePath,
    nestedInput?.reference_path,
    argumentsInput?.path,
    argumentsInput?.reference,
    argumentsInput?.referencePath,
    argumentsInput?.reference_path,
    valueInput?.path,
    valueInput?.reference,
    valueInput?.referencePath,
    valueInput?.reference_path,
    argumentsValueInput?.path,
    argumentsValueInput?.reference,
    argumentsValueInput?.referencePath,
    argumentsValueInput?.reference_path
  ])

  const maxChars = firstFiniteNumber([
    source.maxChars,
    source.max_chars,
    nestedInput?.maxChars,
    nestedInput?.max_chars,
    argumentsInput?.maxChars,
    argumentsInput?.max_chars,
    valueInput?.maxChars,
    valueInput?.max_chars,
    argumentsValueInput?.maxChars,
    argumentsValueInput?.max_chars
  ])

  const cwd = firstNonEmptyString([
    source.cwd,
    nestedInput?.cwd,
    argumentsInput?.cwd,
    valueInput?.cwd,
    argumentsValueInput?.cwd
  ])

  const timeoutMs = firstFiniteNumber([
    source.timeoutMs,
    source.timeout_ms,
    nestedInput?.timeoutMs,
    nestedInput?.timeout_ms,
    argumentsInput?.timeoutMs,
    argumentsInput?.timeout_ms,
    valueInput?.timeoutMs,
    valueInput?.timeout_ms,
    argumentsValueInput?.timeoutMs,
    argumentsValueInput?.timeout_ms
  ])

  const maxOutputChars = firstFiniteNumber([
    source.maxOutputChars,
    source.max_output_chars,
    nestedInput?.maxOutputChars,
    nestedInput?.max_output_chars,
    argumentsInput?.maxOutputChars,
    argumentsInput?.max_output_chars,
    valueInput?.maxOutputChars,
    valueInput?.max_output_chars,
    argumentsValueInput?.maxOutputChars,
    argumentsValueInput?.max_output_chars
  ])

  const args =
    Array.isArray(source.args)
      ? source.args
      : Array.isArray(nestedInput?.args)
        ? nestedInput?.args
        : Array.isArray(argumentsInput?.args)
          ? argumentsInput?.args
          : Array.isArray(valueInput?.args)
            ? valueInput?.args
            : Array.isArray(argumentsValueInput?.args)
              ? argumentsValueInput?.args
              : undefined

  return {
    ...source,
    ...(skillId ? { skillId } : {}),
    ...(action ? { action: normalizeNativeSkillToolAction(action) } : {}),
    ...(path ? { path } : {}),
    ...(args ? { args } : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
    ...(cwd ? { cwd } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxOutputChars !== undefined ? { maxOutputChars } : {})
  }
}

function normalizeNativeAgentBrowserFindInput(input: unknown): unknown {
  const source = asObjectRecord(input)
  if (!source) {
    return input
  }

  const nestedInput = asObjectRecord(source.input)
  const argumentsInput = asObjectRecord(source.arguments)
  const valueInput = asObjectRecord(source.value) ?? parseJsonObjectRecord(source.value)
  const argumentsValueInput =
    asObjectRecord(argumentsInput?.value) ?? parseJsonObjectRecord(argumentsInput?.value)

  const query = firstNonEmptyString([
    source.query,
    source.q,
    nestedInput?.query,
    nestedInput?.q,
    argumentsInput?.query,
    argumentsInput?.q,
    valueInput?.query,
    valueInput?.q,
    argumentsValueInput?.query,
    argumentsValueInput?.q
  ])

  const limit = firstFiniteNumber([
    source.limit,
    source.maxResults,
    nestedInput?.limit,
    nestedInput?.maxResults,
    argumentsInput?.limit,
    argumentsInput?.maxResults,
    valueInput?.limit,
    valueInput?.maxResults,
    argumentsValueInput?.limit,
    argumentsValueInput?.maxResults
  ])

  return {
    ...source,
    ...(query ? { query } : {}),
    ...(limit !== undefined ? { limit } : {})
  }
}

function normalizeNativeAgentBrowserUseInput(input: unknown): unknown {
  const source = asObjectRecord(input)
  if (!source) {
    return input
  }

  const nestedInput = asObjectRecord(source.input)
  const argumentsInput = asObjectRecord(source.arguments)
  const valueInput = asObjectRecord(source.value) ?? parseJsonObjectRecord(source.value)
  const argumentsValueInput =
    asObjectRecord(argumentsInput?.value) ?? parseJsonObjectRecord(argumentsInput?.value)

  const toolName = firstNonEmptyString([
    source.toolName,
    source.tool_name,
    source.tool,
    nestedInput?.toolName,
    nestedInput?.tool_name,
    nestedInput?.tool,
    argumentsInput?.toolName,
    argumentsInput?.tool_name,
    argumentsInput?.tool,
    valueInput?.toolName,
    valueInput?.tool_name,
    valueInput?.tool,
    argumentsValueInput?.toolName,
    argumentsValueInput?.tool_name,
    argumentsValueInput?.tool
  ])

  const knownKeys = new Set([
    'toolName',
    'tool_name',
    'tool',
    'params',
    'input',
    'arguments',
    'value'
  ])

  const topLevelParams = Object.fromEntries(
    Object.entries(source).filter(([key, value]) => !knownKeys.has(key) && value !== undefined)
  )

  const params =
    source.params && typeof source.params === 'object' && !Array.isArray(source.params)
      ? {
          ...topLevelParams,
          ...source.params
        }
      : nestedInput && Object.keys(nestedInput).length > 0
        ? {
            ...topLevelParams,
            ...nestedInput
          }
        : topLevelParams

  return {
    ...source,
    ...(toolName ? { toolName } : {}),
    ...(Object.keys(params).length > 0 ? { params } : {})
  }
}

function normalizeNativeAutomationInput(action: NativeAutomationAction, input: unknown): unknown {
  if (action === 'bash_execute') {
    return normalizeBashExecuteInput(input)
  }
  if (action === 'native_skill') {
    return normalizeNativeSkillAutomationInput(input)
  }
  if (action === 'agent_browser_find') {
    return normalizeNativeAgentBrowserFindInput(input)
  }
  if (action === 'agent_browser_use') {
    return normalizeNativeAgentBrowserUseInput(input)
  }
  if (action === 'artifact_use' && input && typeof input === 'object' && !Array.isArray(input)) {
    const raw = input as Record<string, any>
    return {
      controlId: raw.controlId ?? raw.control_id,
      input: normalizeNativeControlUseInput(
        raw as { input?: Record<string, any> } & Record<string, any>
      ),
      dryRun: raw.dryRun ?? raw.dry_run,
      allowRisky: raw.allowRisky ?? raw.allow_risky
    }
  }
  if (action === 'cli_tool_use' && input && typeof input === 'object' && !Array.isArray(input)) {
    const raw = input as Record<string, any>
    const knownKeys = new Set([
      'toolId',
      'tool_id',
      'input',
      'params',
      'allowRisky',
      'allow_risky',
      'selectedToolIds',
      'selected_tool_ids'
    ])
    const topLevelInput = Object.fromEntries(
      Object.entries(raw).filter(([key, value]) => !knownKeys.has(key) && value !== undefined)
    )
    return {
      toolId: raw.toolId ?? raw.tool_id,
      input:
        raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? {
              ...topLevelInput,
              ...(raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
                ? raw.params
                : {}),
              ...raw.input
            }
          : raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
            ? { ...topLevelInput, ...raw.params }
            : topLevelInput,
      allowRisky: raw.allowRisky ?? raw.allow_risky,
      selectedToolIds: raw.selectedToolIds ?? raw.selected_tool_ids
    }
  }
  if (
    (action === 'runtime_addon_list' ||
      action === 'runtime_addon_status' ||
      action === 'runtime_addon_prepare' ||
      action === 'runtime_addon_start' ||
      action === 'runtime_addon_stop') &&
    input &&
    typeof input === 'object' &&
    !Array.isArray(input)
  ) {
    const raw = input as Record<string, any>
    return {
      addonId: raw.addonId ?? raw.addon_id,
      includeStatus: raw.includeStatus ?? raw.include_status
    }
  }
  return input
}

function normalizeMode3CliToolUseRequest(
  raw: Record<string, any>,
  selectedCliToolIds: string[]
): {
  toolId?: string
  input: Record<string, any>
  allowRisky?: boolean
  selectedToolIds?: string[]
} {
  const knownKeys = new Set(['toolId', 'tool_id', 'input', 'params', 'allowRisky', 'allow_risky', 'selectedToolIds', 'selected_tool_ids'])
  const topLevelInput = Object.fromEntries(
    Object.entries(raw).filter(([key, value]) => !knownKeys.has(key) && value !== undefined)
  )

  const nestedInput =
    raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input) ? raw.input : {}
  const paramsInput =
    raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params) ? raw.params : {}
  const mergedInput = {
    ...topLevelInput,
    ...paramsInput,
    ...nestedInput
  }

  const requestedToolId =
    typeof raw.toolId === 'string'
      ? raw.toolId.trim()
      : typeof raw.tool_id === 'string'
        ? raw.tool_id.trim()
        : ''
  const normalizedRequestedToolId = requestedToolId.toLowerCase()
  const allowRisky =
    typeof raw.allowRisky === 'boolean'
      ? raw.allowRisky
      : typeof raw.allow_risky === 'boolean'
        ? raw.allow_risky
        : undefined
  const selectedToolIds =
    Array.isArray(raw.selectedToolIds) && raw.selectedToolIds.every((entry) => typeof entry === 'string')
      ? raw.selectedToolIds
      : Array.isArray(raw.selected_tool_ids) && raw.selected_tool_ids.every((entry) => typeof entry === 'string')
        ? raw.selected_tool_ids
        : undefined

  let resolvedToolId = requestedToolId || undefined
  if (
    (!resolvedToolId || ['selected', 'selected_tool', 'active', 'active_tool'].includes(normalizedRequestedToolId)) &&
    selectedCliToolIds.length === 1
  ) {
    resolvedToolId = selectedCliToolIds[0]
  }

  return {
    toolId: resolvedToolId,
    input: mergedInput,
    allowRisky,
    selectedToolIds
  }
}

function buildNativeAutomationResult(params: {
  success: boolean
  action: NativeAutomationAction
  backend: NativeExecutionBackend
  context: NativeAutomationDispatchContext
  data?: Record<string, any>
  error?: { code: NativeAutomationErrorCode; message: string; details?: Record<string, any> }
}): NativeAutomationDispatchResult {
  return {
    success: params.success,
    action: params.action,
    backend: params.backend,
    context: {
      mode: params.context.mode,
      actor_type: params.context.actor_type,
      agent_id: params.context.agent_id,
      ...(params.context.parent_agent_id
        ? { parent_agent_id: params.context.parent_agent_id }
        : {})
    },
    ...(params.data ? { data: params.data } : {}),
    ...(params.error ? { error: params.error } : {})
  }
}

function mapControlUseErrorToNativeAutomationErrorCode(
  code: ControlUseErrorCode | undefined
): NativeAutomationErrorCode {
  switch (code) {
    case 'CONTROL_NOT_FOUND':
    case 'CONTROL_INPUT_INVALID':
    case 'CONTROL_NOT_EXECUTABLE':
      return 'INVALID_INPUT'
    case 'CONTROL_NOT_ALLOWED':
    case 'CONTROL_RISK_REQUIRES_APPROVAL':
      return 'POLICY_BLOCKED'
    case 'CONTROL_EXECUTION_FAILED':
    default:
      return 'BACKEND_UNAVAILABLE'
  }
}

type NonInteractiveAutomationBashPolicyResult =
  | {
      allowed: true
      allowListCount: number
      denyListCount: number
    }
  | {
      allowed: false
      code: 'POLICY_BLOCKED'
      message: string
    }

function evaluateNonInteractiveAutomationBashPolicy(options: {
  command: string
  accessMode: NativeBashAccessMode
  commandAllowList?: string[]
  legacyAutomationAllowList?: string[]
  denyList?: string[]
}): NonInteractiveAutomationBashPolicyResult {
  const command = options.command.trim()
  if (!command) {
    return {
      allowed: false,
      code: 'POLICY_BLOCKED' as const,
      message: 'Command cannot be empty.'
    }
  }

  const denyList = normalizeCommandPatternList(options.denyList) ?? []
  if (commandMatchesAnyPattern(command, denyList)) {
    return {
      allowed: false,
      code: 'POLICY_BLOCKED' as const,
      message: 'Blocked by Native Automation deny list.'
    }
  }

  const mergedAllowList = mergeCommandPatternLists(
    normalizeCommandPatternList(options.commandAllowList),
    normalizeCommandPatternList(options.legacyAutomationAllowList)
  ) ?? []

  if (options.accessMode !== 'agent') {
    return {
      allowed: true,
      allowListCount: mergedAllowList.length,
      denyListCount: denyList.length
    }
  }

  if (!isAgentModeAutoAllowedCommand(command, mergedAllowList)) {
    return {
      allowed: false,
      code: 'POLICY_BLOCKED' as const,
      message:
        'Blocked by Agent mode policy. Add this command to the allow list or switch to Dangerous mode.'
    }
  }

  return {
    allowed: true,
    allowListCount: mergedAllowList.length,
    denyListCount: denyList.length
  }
}

export async function dispatchNativeAutomationPackAction(input: {
  userId: string
  action: unknown
  payloadInput: unknown
  context: unknown
  projectPath?: string | null
}): Promise<NativeAutomationDispatchResult> {
  const parsedAction = parseNativeAutomationAction(input.action)
  if (!parsedAction.ok) {
    return buildNativeAutomationResult({
      success: false,
      action: 'bash_execute',
      backend: getDefaultNativeExecutionBackend(),
      context: {
        session_id: '',
        agent_id: '',
        mode: 'mode1',
        actor_type: 'primary'
      },
      error: {
        code: 'INVALID_ACTION',
        message: parsedAction.message
      }
    })
  }

  const action = parsedAction.value
  const parsedContext = parseNativeAutomationContext(input.context)
  if (!parsedContext.ok) {
    return buildNativeAutomationResult({
      success: false,
      action,
      backend: getDefaultNativeExecutionBackend(),
      context: {
        session_id: '',
        agent_id: '',
        mode: 'mode1',
        actor_type: 'primary'
      },
      error: {
        code: 'INVALID_CONTEXT',
        message: parsedContext.message,
        details: parsedContext.details
      }
    })
  }
  const context = parsedContext.value

  const governingAgentId =
    context.actor_type === 'subagent' ? context.parent_agent_id || '' : context.agent_id
  const agentRecord = (await redis.get(`agent:${governingAgentId}`)) as
    | (Record<string, any> & { user_id?: string })
    | null
  if (!agentRecord || agentRecord.user_id !== input.userId) {
    return buildNativeAutomationResult({
      success: false,
      action,
      backend: getDefaultNativeExecutionBackend(),
      context,
      error: {
        code: 'INVALID_CONTEXT',
        message: `Unable to resolve owning primary agent "${governingAgentId}" for this request.`
      }
    })
  }

  const primaryProviderSettings = (agentRecord.provider_specific_settings ?? null) as
    | Record<string, any>
    | null
  let effectiveProviderSettings = primaryProviderSettings
  let subagentRecord:
    | (Record<string, any> & {
        user_id?: string
        provider_specific_settings?: Record<string, any> | null
        dcmDisplaySettings?: AgentDcmDisplaySettings | null
      })
    | null = null

  if (context.actor_type === 'subagent') {
    const rawSubagentRecord = await redis.json.get(`subagent:${context.agent_id}`)
    subagentRecord =
      rawSubagentRecord && typeof rawSubagentRecord === 'object'
        ? (rawSubagentRecord as Record<string, any> & { user_id?: string })
        : null

    if (subagentRecord && subagentRecord.user_id === input.userId) {
      effectiveProviderSettings = mergeSubagentNativeToolProviderSettings(
        primaryProviderSettings,
        (subagentRecord.provider_specific_settings ?? null) as Record<string, any> | null
      )
    }
  }

  const nativeSettings = resolveNativeToolSettings(effectiveProviderSettings)
  const backend = nativeSettings.executionBackend

  if (!resolveNativeAutomationToggleState(action, nativeSettings)) {
    return buildNativeAutomationResult({
      success: false,
      action,
      backend,
      context,
      error: {
        code: 'ACTION_DISABLED',
        message: `Action "${action}" is disabled for this agent.`
      }
    })
  }

  if (action === 'fetch_zip') {
    if (context.actor_type === 'subagent') {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'ACTION_DISABLED',
          message: 'fetch_zip is unavailable in subagent runs.'
        }
      })
    }
    if (context.mode !== 'mode1' && context.mode !== 'mode2') {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'ACTION_DISABLED',
          message: 'fetch_zip is only available to n8n Primary Agent calls.'
        }
      })
    }
  }

  const parsedInput = parseNativeAutomationInput(action, input.payloadInput)
  if (!parsedInput.ok) {
    return buildNativeAutomationResult({
      success: false,
      action,
      backend,
      context,
      error: {
        code: 'INVALID_INPUT',
        message: parsedInput.message,
        details: parsedInput.details
      }
    })
  }

  const resolvedProjectPath =
    (typeof input.projectPath === 'string' && input.projectPath.trim().length > 0
      ? input.projectPath.trim()
      : null) ??
    (await resolveSessionProjectPath(context.session_id))

  if (action === 'batshit_tool_search' || action === 'batshit_tool_use') {
    const subagentGatewayScope =
      context.actor_type === 'subagent'
        ? await resolveDynamicMcpGatewayScope({
            userId: input.userId,
            agentMetadata: subagentRecord ?? null,
            selectedGateways: parsedInput.value.selectedGateways
          })
        : null
    const subagentCliScope =
      context.actor_type === 'subagent'
        ? await resolveCliToolSelectionScope({
            userId: input.userId,
            agentMetadata: subagentRecord ?? null,
            selectedToolIds: parsedInput.value.selectedToolIds
          })
        : null
    // SA-104 P3: per-agent memory enablement, PRIMARY actors only. Subagents never get
    // memory refs — subagent memory access is a deferred product decision and memory is
    // PA-owned state (see BROKER_FABRIC_MEMORY_CONTROL_IDS).
    const brokerMemoryControlsEnabled =
      context.actor_type === 'primary' && resolveAgentMemoryEnabled(agentRecord)
    const brokerAllowedFamilies = resolveBatshitToolBrokerFamiliesForAutomation(nativeSettings, context, {
      memoryControlsEnabled: brokerMemoryControlsEnabled
    })
    // SA-096 P4: same source as mode 3 registration and the DCM capability index's Fabric
    // count. This lane keeps its own actor/mode conditions, expressed as the two flags.
    const brokerFabricAllowedControlIds = new Set<string>(
      resolveBrokerFabricAllowedControlIds({
        toggles: {
          fetchZipEnabled: nativeSettings.fetchZipEnabled,
          dynamicMcpEnabled: nativeSettings.dynamicMcpEnabled,
          cliToolsEnabled: nativeSettings.cliToolsEnabled,
          artifactRuntimeEnabled: nativeSettings.artifactRuntimeEnabled,
          batshitToolsEnabled: nativeSettings.batshitToolsEnabled,
          agentBrowserEnabled: nativeSettings.agentBrowserEnabled
        },
        allowFetchZip: context.actor_type === 'primary',
        allowFabricControlTools:
          context.actor_type === 'primary' &&
          (context.mode === 'mode3' || context.mode === 'mode4'),
        memoryControlsEnabled: brokerMemoryControlsEnabled
      })
    )
    const brokerSelectedGateways =
      context.actor_type === 'subagent'
        ? subagentGatewayScope?.resolvedGateways
        : parsedInput.value.selectedGateways
    const brokerSelectedCliToolIds =
      context.actor_type === 'subagent'
        ? subagentCliScope?.toolIds
        : parsedInput.value.selectedToolIds
    const brokerDcmDisplaySettings =
      context.actor_type === 'subagent'
        ? ((subagentRecord?.dcmDisplaySettings ??
            (subagentRecord as Record<string, any> | null)?.dcm_display_settings ??
            null) as AgentDcmDisplaySettings | null)
        : null

    if (action === 'batshit_tool_search') {
      const result = await nativeBatshitToolSearch({
        ...(parsedInput.value as BatshitToolSearchInput),
        userId: input.userId,
        agentId: context.actor_type === 'subagent' ? context.agent_id : governingAgentId || null,
        agentMetadata: context.actor_type === 'subagent' ? subagentRecord ?? null : null,
        selectedGateways: brokerSelectedGateways,
        selectedCliToolIds: brokerSelectedCliToolIds,
        dcmDisplaySettings: brokerDcmDisplaySettings,
        allowedFamilies: brokerAllowedFamilies,
        runtimeMode: context.mode,
        fabricAllowedControlIds: Array.from(brokerFabricAllowedControlIds),
        projectPath: resolvedProjectPath,
        agentBrowserSettings: {
          liveViewEnabled: nativeSettings.agentBrowserLiveViewEnabled,
          runtimeMode: nativeSettings.agentBrowserRuntimeMode,
          cdpPort: nativeSettings.agentBrowserCdpPort,
          provider: nativeSettings.agentBrowserProvider,
          executablePath: nativeSettings.agentBrowserExecutablePath,
          extraFlags: nativeSettings.agentBrowserExtraFlags,
          timeoutMs: nativeSettings.agentBrowserTimeoutMs
        }
      })
      return buildNativeAutomationResult({
        success: true,
        action,
        backend,
        context,
        data: result
      })
    }

    try {
      const result = await nativeBatshitToolUse({
        ...(parsedInput.value as BatshitToolUseInput),
        userId: input.userId,
        agentId: context.actor_type === 'subagent' ? context.agent_id : governingAgentId || null,
        agentMetadata: context.actor_type === 'subagent' ? subagentRecord ?? null : null,
        sessionId: context.session_id,
        selectedGateways: brokerSelectedGateways,
        selectedCliToolIds: brokerSelectedCliToolIds,
        dcmDisplaySettings: brokerDcmDisplaySettings,
        projectPath: resolvedProjectPath,
        allowedFamilies: brokerAllowedFamilies,
        runtimeMode: context.mode,
        fabricAllowedControlIds: Array.from(brokerFabricAllowedControlIds),
        executionBackend: backend,
        agentBrowserSettings: {
          liveViewEnabled: nativeSettings.agentBrowserLiveViewEnabled,
          runtimeMode: nativeSettings.agentBrowserRuntimeMode,
          cdpPort: nativeSettings.agentBrowserCdpPort,
          provider: nativeSettings.agentBrowserProvider,
          executablePath: nativeSettings.agentBrowserExecutablePath,
          extraFlags: nativeSettings.agentBrowserExtraFlags,
          timeoutMs: nativeSettings.agentBrowserTimeoutMs
        }
      })
      if (result.success === false) {
        return buildNativeAutomationResult({
          success: false,
          action,
          backend,
          context,
          error: {
            code:
              result.code === 'NOT_FOUND' || result.code === 'INPUT_VALIDATION_FAILED'
                ? 'INVALID_INPUT'
                : result.code === 'POLICY_BLOCKED' ||
                    result.code === 'OUT_OF_SCOPE' ||
                    result.code === 'REQUIRES_APPROVAL' ||
                    result.error?.code === 'CONTROL_RISK_REQUIRES_APPROVAL'
                  ? 'POLICY_BLOCKED'
                  : 'BACKEND_UNAVAILABLE',
            message:
              typeof result.error === 'string'
                ? result.error
                : result.error?.message || 'Batshit tool use failed.',
            details: {
              ref: parsedInput.value.ref,
              family: result.family,
              target: result.target,
              code: result.code ?? result.error?.code
            }
          }
        })
      }
      return buildNativeAutomationResult({
        success: true,
        action,
        backend,
        context,
        data: result
      })
    } catch (error) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'INVALID_INPUT',
          message: error instanceof Error ? error.message : 'Invalid Batshit tool ref.'
        }
      })
    }
  }

  if (action === 'bash_execute') {
    const mergedCommandAllowList = mergeCommandPatternLists(
      nativeSettings.bashCommandAllowList,
      nativeSettings.automationBashAllowList
    ) ?? []

    const policyResult = evaluateNonInteractiveAutomationBashPolicy({
      command: parsedInput.value.command,
      accessMode: nativeSettings.bashAccessMode,
      commandAllowList: mergedCommandAllowList,
      denyList: nativeSettings.automationBashDenyList
    })
    if (!policyResult.allowed) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: policyResult.code,
          message: policyResult.message
        }
      })
    }

    const managedApplyPatchCommand = isManagedApplyPatchCommand(parsedInput.value.command)
    if (backend === 'docker_sandbox' && !managedApplyPatchCommand) {
      const sandboxStatus = await getSandboxBackendStatus()
      if (!sandboxStatus.available) {
        return buildNativeAutomationResult({
          success: false,
          action,
          backend,
          context,
          error: {
            code: 'SANDBOX_UNAVAILABLE',
            message:
              sandboxStatus.reason ||
              'Docker Sandbox is unavailable. Start Docker Desktop and verify sandbox support.'
          }
        })
      }
    }

    const result = await nativeBashExecute({
      userId: input.userId,
      sessionId: context.session_id,
      projectPath: resolvedProjectPath,
      command: parsedInput.value.command,
      cwd: parsedInput.value.cwd,
      timeoutMs: parsedInput.value.timeoutMs,
      maxOutputChars: parsedInput.value.maxOutputChars,
      defaultTimeoutMs: nativeSettings.bashTimeoutMs,
      accessMode: nativeSettings.bashAccessMode,
      commandAllowList: mergedCommandAllowList,
      neverAllowList: nativeSettings.bashNeverAllowList,
      requireApproval: false,
      approved: true,
      backend
    })

    const policyProfile = {
      type: 'non_interactive',
      accessMode: nativeSettings.bashAccessMode,
      allowListCount: (policyResult as any).allowListCount ?? mergedCommandAllowList.length,
      denyListCount: (policyResult as any).denyListCount ?? 0,
      hardDenyRules: 'enforced'
    }

    if (result.success !== true) {
      if (isNativeBashCommandRunFailure(result)) {
        return buildNativeAutomationResult({
          success: true,
          action,
          backend,
          context,
          data: {
            ...result,
            failureMessage: summarizeNativeBashExecutionFailure(result),
            policyProfile
          }
        })
      }

      const propagatedErrorCode =
        typeof result.errorCode === 'string' &&
        NATIVE_AUTOMATION_ERROR_CODES.includes(result.errorCode as NativeAutomationErrorCode)
          ? (result.errorCode as NativeAutomationErrorCode)
          : null
      const errorCode: NativeAutomationErrorCode =
        propagatedErrorCode ?? (result.blocked ? 'POLICY_BLOCKED' : 'BACKEND_UNAVAILABLE')
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: errorCode,
          message:
            result.reason ||
            result.error ||
            summarizeNativeBashExecutionFailure(result) ||
            'Bash execution failed.',
          details: {
            command: parsedInput.value.command,
            ...(typeof result.stderr === 'string' && result.stderr.trim()
              ? { stderr: result.stderr.trim().slice(0, 2_000) }
              : {}),
            ...(typeof result.stdout === 'string' && result.stdout.trim()
              ? { stdout: result.stdout.trim().slice(0, 2_000) }
              : {}),
            ...(typeof result.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
            ...(result.timedOut === true ? { timedOut: true } : {}),
            ...(typeof result.sandboxName === 'string' ? { sandboxName: result.sandboxName } : {})
          }
        }
      })
    }

    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: {
        ...result,
        policyProfile
      }
    })
  }

  if (action === 'cli_tool_find') {
    const subagentCliScope =
      context.actor_type === 'subagent'
        ? await resolveCliToolSelectionScope({
            userId: input.userId,
            agentMetadata: subagentRecord ?? null,
            selectedToolIds: parsedInput.value.selectedToolIds
          })
        : null
    const result = await nativeCliToolFind({
      userId: input.userId,
      agentId: context.actor_type === 'subagent' ? null : governingAgentId || null,
      query: parsedInput.value.query,
      limit: parsedInput.value.limit,
      includeSchema: parsedInput.value.includeSchema,
      selectedCliToolIds:
        context.actor_type === 'subagent'
          ? subagentCliScope?.toolIds
          : parsedInput.value.selectedToolIds
    })
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  if (action === 'cli_tool_use') {
    const subagentCliScope =
      context.actor_type === 'subagent'
        ? await resolveCliToolSelectionScope({
            userId: input.userId,
            agentMetadata: subagentRecord ?? null,
            selectedToolIds: parsedInput.value.selectedToolIds
          })
        : null
    const result = await nativeCliToolUse({
      userId: input.userId,
      agentId: context.actor_type === 'subagent' ? context.agent_id : governingAgentId || null,
      sessionId: context.session_id,
      toolId: parsedInput.value.toolId,
      cliInput: parsedInput.value.input,
      allowRisky: parsedInput.value.allowRisky,
      projectPath: resolvedProjectPath,
      selectedCliToolIds:
        context.actor_type === 'subagent'
          ? subagentCliScope?.toolIds
          : parsedInput.value.selectedToolIds
    })
    if (result.success === false) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code:
            result.code === 'NOT_FOUND' || result.code === 'INPUT_VALIDATION_FAILED'
              ? 'INVALID_INPUT'
              : result.code === 'POLICY_BLOCKED' || result.code === 'OUT_OF_SCOPE' || result.code === 'REQUIRES_APPROVAL'
                ? 'POLICY_BLOCKED'
                : 'BACKEND_UNAVAILABLE',
          message: result.error,
          details: {
            toolId: parsedInput.value.toolId,
            cliCode: result.code,
            requiresApproval: result.requiresApproval === true
          }
        }
      })
    }
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  if (action === 'agent_browser_find') {
    const result = await nativeAgentBrowserFind({
      userId: input.userId,
      query: parsedInput.value.query,
      limit: parsedInput.value.limit,
      settings: {
        liveViewEnabled: nativeSettings.agentBrowserLiveViewEnabled,
        runtimeMode: nativeSettings.agentBrowserRuntimeMode,
        cdpPort: nativeSettings.agentBrowserCdpPort,
        provider: nativeSettings.agentBrowserProvider,
        executablePath: nativeSettings.agentBrowserExecutablePath,
        extraFlags: nativeSettings.agentBrowserExtraFlags,
        timeoutMs: nativeSettings.agentBrowserTimeoutMs
      }
    })

    if (result.dockerUnsupported === true) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: result.reason || result.installHelp || DOCKER_AGENT_BROWSER_UNSUPPORTED_REASON,
          details: {
            dockerUnsupported: true,
            supportLevel: result.supportLevel
          }
        }
      })
    }

    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  if (action === 'agent_browser_use') {
    const result = await nativeAgentBrowserUse({
      userId: input.userId,
      sessionId: context.session_id,
      toolName: parsedInput.value.toolName,
      params: parsedInput.value.params,
      settings: {
        liveViewEnabled: nativeSettings.agentBrowserLiveViewEnabled,
        runtimeMode: nativeSettings.agentBrowserRuntimeMode,
        cdpPort: nativeSettings.agentBrowserCdpPort,
        provider: nativeSettings.agentBrowserProvider,
        executablePath: nativeSettings.agentBrowserExecutablePath,
        extraFlags: nativeSettings.agentBrowserExtraFlags,
        timeoutMs: nativeSettings.agentBrowserTimeoutMs
      }
    })

    if (result.success === false) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: result.error || 'Agent Browser request failed.'
        }
      })
    }

    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  const controlAgentId =
    context.actor_type === 'subagent' ? context.agent_id : governingAgentId || null

  if (action === 'artifact_find') {
    const result = await findControls({
      userId: input.userId,
      agentId: controlAgentId ?? undefined,
      query: parsedInput.value.query,
      tags: parsedInput.value.tags,
      sourceType: parsedInput.value.sourceType,
      riskLevel: parsedInput.value.riskLevel,
      runtimeMode: context.mode,
      includeSchema: parsedInput.value.includeSchema,
      includeDraft: parsedInput.value.includeDraft,
      limit: parsedInput.value.limit,
      allowedControlIds: Array.from(ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS)
    })

    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  if (action === 'artifact_use') {
    const result = await useControl({
      userId: input.userId,
      controlId: parsedInput.value.controlId,
      agentId: controlAgentId ?? undefined,
      sessionId: context.session_id,
      input: normalizeNativeControlUseInput(parsedInput.value as Record<string, any>),
      dryRun: parsedInput.value.dryRun,
      allowRisky: parsedInput.value.allowRisky,
      runtimeMode: context.mode,
      allowedControlIds: Array.from(ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS)
    })

    if (result.success === false) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: mapControlUseErrorToNativeAutomationErrorCode(result.error?.code),
          message: result.error?.message || 'Artifact runtime execution failed.',
          details: result.error?.details
        }
      })
    }

    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  if (action === 'runtime_addon_list') {
    const addons = await listRuntimeAddons({
      includeStatus: parsedInput.value.includeStatus === true
    })
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: {
        addons
      }
    })
  }

  if (action === 'runtime_addon_status') {
    const addon = await getRuntimeAddonStatus(parsedInput.value.addonId)
    if (!addon) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'INVALID_INPUT',
          message: `Unknown runtime add-on "${parsedInput.value.addonId}".`
        }
      })
    }
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: {
        addon
      }
    })
  }

  if (action === 'runtime_addon_prepare') {
    const addon = await prepareRuntimeAddon(parsedInput.value.addonId)
    if (!addon) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'INVALID_INPUT',
          message: `Unknown runtime add-on "${parsedInput.value.addonId}".`
        }
      })
    }
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: {
        addon
      }
    })
  }

  if (action === 'runtime_addon_start' || action === 'runtime_addon_stop') {
    const operation = action === 'runtime_addon_start' ? 'start' : 'stop'
    const addon = await controlRuntimeAddon(parsedInput.value.addonId, operation)
    if (!addon) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'INVALID_INPUT',
          message: `Unknown runtime add-on "${parsedInput.value.addonId}".`
        }
      })
    }
    if (!addon.success) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: addon.error || `Runtime add-on ${operation} failed.`,
          details: {
            addonId: addon.addonId,
            operator: addon.operator
          }
        }
      })
    }
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: {
        addon
      }
    })
  }

  if (action === 'native_skill') {
    const result = await executeNativeSkillToolAction({
      userId: input.userId,
      settings: nativeSettings,
      sessionId: context.session_id,
      projectPath: resolvedProjectPath,
      bashApprovalRequestsEnabled: false,
      skillId: parsedInput.value.skillId,
      action: parsedInput.value.action ?? 'invoke',
      path: parsedInput.value.path,
      args: parsedInput.value.args,
      maxChars: parsedInput.value.maxChars,
      cwd: parsedInput.value.cwd,
      timeoutMs: parsedInput.value.timeoutMs,
      maxOutputChars: parsedInput.value.maxOutputChars
    })

    if (result.success === false) {
      const propagatedErrorCode =
        typeof result.errorCode === 'string' &&
        NATIVE_AUTOMATION_ERROR_CODES.includes(result.errorCode as NativeAutomationErrorCode)
          ? (result.errorCode as NativeAutomationErrorCode)
          : null
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: propagatedErrorCode ?? (result.blocked ? 'POLICY_BLOCKED' : 'BACKEND_UNAVAILABLE'),
          message: result.error || 'Skill runtime request failed.'
        }
      })
    }

    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  if (action === 'web_search') {
    const result = await nativeWebSearch({
      userId: input.userId,
      query: parsedInput.value.query,
      provider: parsedInput.value.provider,
      agentDefaultProvider: nativeSettings.webSearchProvider,
      exaSearchType: parsedInput.value.exaSearchType,
      agentDefaultExaSearchType: nativeSettings.webSearchExaSearchType,
      perplexityMaxTokensPerPage: parsedInput.value.perplexityMaxTokensPerPage,
      agentDefaultPerplexityMaxTokensPerPage:
        nativeSettings.webSearchPerplexityMaxTokensPerPage,
      maxResults: parsedInput.value.maxResults,
      region: parsedInput.value.region,
      safeSearch: parsedInput.value.safeSearch,
      timeoutMs: parsedInput.value.timeoutMs
    })
    if (result.success === false) {
      return buildNativeAutomationResult({
        success: false,
        action,
        backend,
        context,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: result.error || 'Web search failed.'
        }
      })
    }
    return buildNativeAutomationResult({
      success: true,
      action,
      backend,
      context,
      data: result
    })
  }

  const result = await nativeFetchZip({
    userId: input.userId,
    zipId: parsedInput.value.zipId,
    includeContent: parsedInput.value.includeContent,
    maxChars: parsedInput.value.maxChars
  })
  return buildNativeAutomationResult({
    success: true,
    action,
    backend,
    context,
    data: result
  })
}

export const NATIVE_FABRIC_USE_TOP_LEVEL_INPUT_KEYS = [
  'zone',
  'target_zone',
  'targetZone',
  'zone_name',
  'zoneName',
  'placement',
  'location'
] as const

async function executeNativeSkillToolAction(input: {
  userId: string
  settings: ResolvedNativeToolSettings
  sessionId?: string
  projectPath?: string | null
  bashApprovalRequestsEnabled: boolean
  skillId: string
  action?: unknown
  path?: string
  args?: unknown
  maxChars?: number
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
}): Promise<Record<string, any>> {
  const action = normalizeNativeSkillToolAction(input.action)

  if (action === 'invoke' || action === 'list' || action === 'read') {
    const result = await executeSkillRuntimeAction({
      userId: input.userId,
      skillId: input.skillId,
      action,
      path: input.path,
      maxChars: input.maxChars
    })
    if (result.success === true && (action === 'invoke' || action === 'read')) {
      return {
        ...result,
        operationKind: 'skill_read',
        rendererFamily: 'skill_read'
      }
    }
    return result
  }

  const runtimeResult = await resolveSkillRuntimeForTool(input.userId, input.skillId)
  if (!runtimeResult.runtime) {
    return {
      success: false,
      action,
      error: runtimeResult.error
    }
  }

  const { skill, cacheDir, bundleFiles } = runtimeResult.runtime
  const scripts = bundleFiles.filter((file) => file.kind === 'script')
  const scriptPaths = scripts.map((file) => file.path)

  if (action === 'script_list') {
    return {
      success: true,
      action,
      skillId: skill.id,
      skillName: skill.displayName || skill.name,
      totalScripts: scriptPaths.length,
      scripts: scriptPaths
    }
  }

  const targetPath = normalizeOptionalString(input.path)
  if (!targetPath) {
    return {
      success: false,
      action,
      error: 'path is required for script_read and script_run actions.',
      availableScripts: scriptPaths
    }
  }

  const file = findBundleFileByPath(scripts, targetPath)
  if (!file) {
    return {
      success: false,
      action,
      error: `Script "${targetPath}" was not found in the skill bundle.`,
      availableScripts: scriptPaths
    }
  }

  if (action === 'script_read') {
    const maxChars = clamp(
      parseInteger(input.maxChars) ?? DEFAULT_SKILL_SCRIPT_CHARS,
      64,
      MAX_SKILL_SCRIPT_CHARS
    )
    const decoded = readSkillBundleFileText(file, maxChars)
    return {
      success: true,
      action,
      skillId: skill.id,
      skillName: skill.displayName || skill.name,
      path: file.path,
      content: decoded.content,
      contentTruncated: decoded.truncated,
      originalChars: decoded.originalChars,
      returnedChars: decoded.content.length,
      operationKind: 'skill_read',
      rendererFamily: 'skill_read'
    }
  }

  if (!input.settings.bashEnabled) {
    return {
      success: false,
      action,
      blocked: true,
      errorCode: 'ACTION_DISABLED',
      error: 'native_bash_execute is disabled in Agent Settings, so skill script execution is unavailable.'
    }
  }

  const absolutePath = resolveBundleFileAbsolutePath(cacheDir, file)
  if (!absolutePath) {
    return {
      success: false,
      action,
      blocked: true,
      errorCode: 'POLICY_BLOCKED',
      error: `Script "${file.path}" resolves outside the allowed skill cache directory.`
    }
  }

  const command = buildSkillScriptCommand(absolutePath, normalizeSkillScriptArgs(input.args))
  const agentModePolicyOnly =
    input.settings.bashAccessMode === 'agent' && !input.bashApprovalRequestsEnabled
  if (
    agentModePolicyOnly &&
    !isAgentModeAutoAllowedCommand(command, input.settings.bashCommandAllowList)
  ) {
    return {
      success: false,
      action,
      blocked: true,
      errorCode: 'POLICY_BLOCKED',
      error:
        'Blocked by Agent mode policy. Add this command to the allow list, switch Approval Policy to On Failure, or switch to Dangerous mode.',
      command,
      policyMode: input.settings.bashPolicyMode,
      accessMode: input.settings.bashAccessMode
    }
  }

  const execution = await nativeBashExecute({
    userId: input.userId,
    sessionId: input.sessionId,
    projectPath: input.projectPath ?? null,
    command,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    defaultTimeoutMs: input.settings.bashTimeoutMs,
    backend: input.settings.executionBackend,
    accessMode: input.settings.bashAccessMode,
    commandAllowList: input.settings.bashCommandAllowList,
    neverAllowList: input.settings.bashNeverAllowList,
    maxOutputChars: input.maxOutputChars,
    agentBrowserSettings: {
      enabled: input.settings.agentBrowserEnabled,
      liveViewEnabled: input.settings.agentBrowserLiveViewEnabled,
      runtimeMode: input.settings.agentBrowserRuntimeMode,
      cdpPort: input.settings.agentBrowserCdpPort,
      provider: input.settings.agentBrowserProvider,
      session: input.settings.agentBrowserSession,
      profilePath: input.settings.agentBrowserProfilePath,
      executablePath: input.settings.agentBrowserExecutablePath,
      extraFlags: input.settings.agentBrowserExtraFlags,
      timeoutMs: input.settings.agentBrowserTimeoutMs
    }
  })

  return {
    success: true,
    action,
    skillId: skill.id,
    skillName: skill.displayName || skill.name,
    path: file.path,
    command,
    runSucceeded: execution.success === true,
    execution,
    operationKind: 'bash',
    rendererFamily: 'bash'
  }
}

type NativeFabricUseTopLevelInputKey = (typeof NATIVE_FABRIC_USE_TOP_LEVEL_INPUT_KEYS)[number]

const NATIVE_FABRIC_USE_PASSTHROUGH_BLOCKLIST = new Set<string>([
  'controlId',
  'control_id',
  'input',
  'dryRun',
  'dry_run',
  'allowRisky',
  'allow_risky',
  'selectedGateways',
  'selected_gateways',
  'gatewayToolsCache'
])

export function normalizeNativeControlUseInput(
  input: { input?: Record<string, any> } & Record<string, any>
): Record<string, any> | undefined {
  const mergedInput =
    input.input && typeof input.input === 'object' && !Array.isArray(input.input)
      ? { ...input.input }
      : {}

  for (const key of NATIVE_FABRIC_USE_TOP_LEVEL_INPUT_KEYS) {
    const aliasValue = input[key as NativeFabricUseTopLevelInputKey]
    if (aliasValue === undefined || aliasValue === null) continue
    if (Object.prototype.hasOwnProperty.call(mergedInput, key)) continue
    mergedInput[key] = aliasValue
  }

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (NATIVE_FABRIC_USE_PASSTHROUGH_BLOCKLIST.has(key)) continue
    if (Object.prototype.hasOwnProperty.call(mergedInput, key)) continue
    mergedInput[key] = value
  }

  return Object.keys(mergedInput).length > 0 ? mergedInput : undefined
}

export type NativeToolApprovalPolicy = (
  input: unknown
) => Promise<'user-approval' | undefined>

export interface Mode3NativeToolSet {
  tools: Record<string, any>
  /**
   * AI SDK 7 call-level tool approval policies keyed by registered tool name.
   * Passed to streamText/generateText as `toolApproval` (the v6 tool-level
   * `needsApproval` option is deprecated in v7).
   */
  toolApprovals: Record<string, NativeToolApprovalPolicy>
}

export async function buildMode3NativeTools(context: NativeToolContext): Promise<Mode3NativeToolSet> {
  const settings = resolveNativeToolSettings(context.providerSettings)
  const selectedGateways = normalizeStringArray(context.selectedGateways)
  const cliToolScope = await resolveCliToolSelectionScope({
    userId: context.userId,
    agentId: context.agentId ?? null,
    selectedToolIds: normalizeStringArray(context.selectedCliToolIds)
  })
  const selectedCliToolIds = cliToolScope.toolIds

  const tools: Record<string, any> = {}
  const toolApprovals: Record<string, NativeToolApprovalPolicy> = {}
  const resolvedSessionId = normalizeOptionalString(context.sessionId)
  const resolvedAgentId = normalizeOptionalString(context.agentId)
  const gatewayToolsCache: GatewayToolsCache = new Map()
  type RiskRetryCacheEntry = {
    controlId: string
    input: Record<string, any> | undefined
    inputHash: string
    inputBytes: number
    capturedAt: string
  }
  const controlRiskRetryCache = new Map<string, RiskRetryCacheEntry>()
  const buildRiskRetryCacheKey = (controlId: string) =>
    `${resolvedSessionId ?? 'no-session'}::${resolvedAgentId ?? 'no-agent'}::${controlId}`
  const cloneRiskRetryInput = (
    payload: Record<string, any> | undefined
  ): Record<string, any> | undefined => {
    if (!payload || typeof payload !== 'object') return undefined
    try {
      return structuredClone(payload)
    } catch {
      try {
        return JSON.parse(JSON.stringify(payload)) as Record<string, any>
      } catch {
        return undefined
      }
    }
  }
  const serializeRiskRetryInput = (
    payload: Record<string, any> | undefined
  ): { json: string; hash: string; bytes: number } | null => {
    try {
      const json = JSON.stringify(payload ?? {})
      if (typeof json !== 'string') return null
      const hash = createHash('sha256').update(json).digest('hex')
      const bytes = new TextEncoder().encode(json).length
      return { json, hash, bytes }
    } catch {
      return null
    }
  }
  const executeBrokerScopedControlUse = async (
    input: ControlUseInput,
    wrapperAllowedControlIds: string[]
  ) => {
    const retryCacheKey = buildRiskRetryCacheKey(input.controlId)
    const cachedRetry = controlRiskRetryCache.get(retryCacheKey)
    let normalizedInput = normalizeNativeControlUseInput(input as Record<string, any>)
    let retryPayloadReused = false

    if (input.allowRisky === true) {
      if (cachedRetry) {
        const hasExplicitInput =
          normalizedInput &&
          typeof normalizedInput === 'object' &&
          Object.keys(normalizedInput).length > 0
        if (!hasExplicitInput) {
          normalizedInput = cloneRiskRetryInput(cachedRetry.input)
          retryPayloadReused = true
        } else {
          const provided = serializeRiskRetryInput(normalizedInput)
          if (!provided) {
            return {
              success: false,
              controlId: input.controlId,
              error: {
                code: 'INVALID_INPUT',
                message: 'Risk retry input must be JSON-serializable.',
                details: {
                  reason: 'payload_serialization_failed'
                }
              }
            }
          }
          if (provided.hash !== cachedRetry.inputHash) {
            return {
              success: false,
              controlId: input.controlId,
              error: {
                code: 'INVALID_INPUT',
                message:
                  'Risk retry payload mismatch. Retry with the same input payload, or omit input to reuse cached payload.',
                details: {
                  expectedInputHash: cachedRetry.inputHash,
                  providedInputHash: provided.hash
                }
              }
            }
          }
        }
      } else {
        const hasExplicitInput =
          normalizedInput &&
          typeof normalizedInput === 'object' &&
          Object.keys(normalizedInput).length > 0
        if (!hasExplicitInput) {
          return {
            success: false,
            controlId: input.controlId,
            error: {
              code: 'INVALID_CONTEXT',
              message:
                'No cached payload exists for this risky retry. Send the full input once, then retry with allowRisky.',
              details: {
                retryCacheKey
              }
            }
          }
        }
      }
    }

    const response = await useControl({
      userId: context.userId,
      agentId: context.agentId ?? undefined,
      sessionId: context.sessionId,
      runtimeMode: 'mode3',
      controlId: input.controlId,
      input: normalizedInput,
      dryRun: input.dryRun,
      allowRisky: input.allowRisky,
      selectedGateways,
      allowedControlIds: wrapperAllowedControlIds
    })

    if (!response || typeof response !== 'object') {
      return response
    }

    const responseError =
      (response as any).error && typeof (response as any).error === 'object'
        ? (response as any).error
        : null
    const errorCode =
      responseError && typeof responseError.code === 'string' ? responseError.code : null

    if ((response as any).success === false && errorCode === 'CONTROL_RISK_REQUIRES_APPROVAL') {
      const serialized = serializeRiskRetryInput(normalizedInput)
      if (!serialized) {
        return {
          ...(response as Record<string, any>),
          retryPayload: {
            cached: false,
            reason: 'payload_serialization_failed'
          }
        }
      }

      controlRiskRetryCache.set(retryCacheKey, {
        controlId: input.controlId,
        input: cloneRiskRetryInput(normalizedInput),
        inputHash: serialized.hash,
        inputBytes: serialized.bytes,
        capturedAt: new Date().toISOString()
      })

      return {
        ...(response as Record<string, any>),
        retryPayload: {
          cached: true,
          retryCacheKey,
          inputHash: serialized.hash,
          inputBytes: serialized.bytes
        }
      }
    }

    if ((response as any).success === true) {
      controlRiskRetryCache.delete(retryCacheKey)
      if (retryPayloadReused) {
        return {
          ...(response as Record<string, any>),
          retryPayloadReused: true
        }
      }
    }

    return response
  }

  const bashApprovalRequestsEnabled =
    settings.bashAccessMode === 'agent' &&
    (context.toolApprovalMode
      ? context.toolApprovalMode === 'all'
      : settings.bashAgentApprovalCardsEnabled === true)

  const nativeSkillNeedsApproval = async (input: unknown) => {
    if (!input || typeof input !== 'object') return false
    const action = normalizeNativeSkillToolAction((input as any).action)
    return action === 'script_run' && bashApprovalRequestsEnabled
  }

  toolApprovals.native_skill = async (input) =>
    (await nativeSkillNeedsApproval(input)) ? 'user-approval' : undefined

  tools.native_skill = tool({
    description:
      'Invoke/list/read skill docs and list/read/run bundled skill scripts. Script runs are mediated through native bash safety policy.',
    inputSchema: z.object({
      skillId: z.string().min(1).describe('The skill ID to operate on'),
      action: z.enum(NATIVE_SKILL_TOOL_ACTIONS).optional(),
      path: z.string().optional(),
      args: z.array(z.string()).max(MAX_SKILL_SCRIPT_ARGS).optional(),
      maxChars: z.number().int().min(64).max(MAX_SKILL_SCRIPT_CHARS).optional(),
      cwd: z.string().optional(),
      timeoutMs: z.number().int().min(MIN_BASH_TIMEOUT_MS).max(MAX_BASH_TIMEOUT_MS).optional(),
      maxOutputChars: z.number().int().min(1_000).max(MAX_BASH_OUTPUT_CHARS).optional()
    }),
    execute: async (input) =>
      executeNativeSkillToolAction({
        userId: context.userId,
        settings,
        sessionId: context.sessionId,
        projectPath: context.projectPath ?? null,
        bashApprovalRequestsEnabled,
        skillId: input.skillId,
        action: input.action ?? 'invoke',
        path: input.path,
        args: input.args,
        maxChars: input.maxChars,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        maxOutputChars: input.maxOutputChars
      }),
    toModelOutput: async ({ output }: { output: any }) => {
      if (output && typeof output === 'object' && (output as any).success === true) {
        if ((output as any).action === 'invoke') {
          const skillMarkdown = typeof (output as any).skillMarkdown === 'string' ? (output as any).skillMarkdown : ''
          const skillName = typeof (output as any)?.skill?.name === 'string' ? (output as any).skill.name : 'unknown'
          const skillId = typeof (output as any)?.skill?.id === 'string' ? (output as any).skill.id : 'unknown'
          const refs = Array.isArray((output as any)?.skill?.references)
            ? (output as any).skill.references.map((entry: unknown) => String(entry))
            : []
          const scripts = Array.isArray((output as any)?.skill?.scripts)
            ? (output as any).skill.scripts.map((entry: unknown) => String(entry))
            : []
          const warnings = Array.isArray((output as any)?.warnings)
            ? (output as any).warnings.map((entry: unknown) => String(entry).trim()).filter(Boolean)
            : []
          return {
            type: 'text',
            value: [
              `==== SKILL: ${skillName} (${skillId}) ====`,
              skillMarkdown,
              '==== END SKILL ====',
              '',
              'skill_references:',
              buildSkillPathListForModelOutput(refs),
              '',
              'skill_scripts:',
              buildSkillPathListForModelOutput(scripts),
              ...(warnings.length > 0
                ? ['', 'skill_warnings:', ...warnings.map((entry: string) => `- ${entry}`)]
                : []),
              '',
              'Use `native_skill` with action="read" and the skillId to load references on demand.',
              'Use `native_skill` with action="script_run" only when bundled skill script execution is necessary.'
            ]
              .filter((line) => line !== '')
              .join('\n')
          }
        }

        if ((output as any).action === 'list') {
          const references = Array.isArray((output as any).references)
            ? (output as any).references.map((entry: unknown) => String(entry))
            : []
          return {
            type: 'text',
            value: [
              `Active skill references (${references.length}):`,
              buildSkillPathListForModelOutput(references)
            ].join('\n')
          }
        }

        if ((output as any).action === 'read') {
          const pathLabel = typeof (output as any).path === 'string' ? (output as any).path : 'reference'
          const content = typeof (output as any).content === 'string' ? (output as any).content : ''
          const truncated = (output as any).contentTruncated === true
          return {
            type: 'text',
            value: [
              `==== SKILL REFERENCE (${pathLabel}) ====`,
              content,
              truncated ? '[truncated]' : '',
              '==== END SKILL REFERENCE ===='
            ]
              .filter((line) => line !== '')
              .join('\n')
          }
        }

        if ((output as any).action === 'script_list') {
          const scripts = Array.isArray((output as any).scripts)
            ? (output as any).scripts.map((entry: unknown) => String(entry))
            : []
          return {
            type: 'text',
            value: [`Skill scripts (${scripts.length}):`, buildSkillPathListForModelOutput(scripts)].join('\n')
          }
        }

        if ((output as any).action === 'script_read') {
          const pathLabel = typeof (output as any).path === 'string' ? (output as any).path : 'script'
          const content = typeof (output as any).content === 'string' ? (output as any).content : ''
          const truncated = (output as any).contentTruncated === true
          return {
            type: 'text',
            value: [
              `==== SKILL SCRIPT (${pathLabel}) ====`,
              content,
              truncated ? '[truncated]' : '',
              '==== END SKILL SCRIPT ===='
            ]
              .filter((line) => line !== '')
              .join('\n')
          }
        }

        if ((output as any).action === 'script_run') {
          const execution = (output as any).execution
          if (execution && typeof execution === 'object') {
            const stdout = typeof execution.stdout === 'string' ? execution.stdout : ''
            const stderr = typeof execution.stderr === 'string' ? execution.stderr : ''
            const exitCode =
              typeof execution.exitCode === 'number'
                ? execution.exitCode
                : typeof execution.exit_code === 'number'
                  ? execution.exit_code
                  : undefined
            return {
              type: 'text',
              value: [
                `skill script run result: ${execution.success === true ? 'success' : 'failed'}`,
                ...(typeof (output as any).path === 'string' ? [`script: ${(output as any).path}`] : []),
                ...(typeof (output as any).command === 'string' ? [`command: ${(output as any).command}`] : []),
                ...(exitCode !== undefined ? [`exit_code: ${exitCode}`] : []),
                ...(stdout ? ['', 'stdout:', stdout] : []),
                ...(stderr ? ['', 'stderr:', stderr] : [])
              ]
                .filter((line) => line !== '')
                .join('\n')
            }
          }
        }
      }

      if (output && typeof output === 'object') {
        const availableReferences = Array.isArray((output as any).availableReferences)
          ? (output as any).availableReferences.map((entry: unknown) => String(entry))
          : []
        const availableScripts = Array.isArray((output as any).availableScripts)
          ? (output as any).availableScripts.map((entry: unknown) => String(entry))
          : []
        const error = typeof (output as any).error === 'string'
          ? (output as any).error
          : 'Skill request failed.'
        return {
          type: 'text',
          value: [
            `native_skill failed: ${error}`,
            ...(availableReferences.length > 0
              ? ['', 'Available references:', buildSkillPathListForModelOutput(availableReferences)]
              : []),
            ...(availableScripts.length > 0
              ? ['', 'Available scripts:', buildSkillPathListForModelOutput(availableScripts)]
              : [])
          ].join('\n')
        }
      }

      return {
        type: 'json',
        value: output ?? null
      }
    }
  })

  const allowArtifactRuntimeTools = context.allowArtifactRuntimeTools !== false
  const allowFabricControlTools = context.allowFabricControlTools !== false
  // SA-104 P3: opt-in per agent; subagent callers leave this unset/false.
  const memoryControlsEnabled = context.memoryControlsEnabled === true

  // SA-096: shared with the compile twins' broker-guidance gate so registered tools and
  // shipped instructions can never disagree. Rules live in $lib/utils/brokerAvailability.
  const brokerToggles = resolveBrokerToolToggles(context.providerSettings)
  const apiBrokerAllowedFamilies: BatshitToolFamily[] = resolveBrokerFamilies({
    runtime: 'api',
    toggles: brokerToggles,
    hasCliTools: selectedCliToolIds.length > 0,
    allowArtifactRuntimeTools,
    allowFabricControlTools,
    memoryControlsEnabled
  })
  // SA-096 P4: same source as the DCM capability index's Fabric count.
  const apiBrokerFabricAllowedControlIds = new Set<string>(
    resolveBrokerFabricAllowedControlIds({
      toggles: brokerToggles,
      allowFabricControlTools,
      memoryControlsEnabled
    })
  )

  if (apiBrokerAllowedFamilies.length > 0) {
    tools.native_batshit_tool_search = tool({
      description:
        'Search Batshit MCP, CLI, artifact, and Fabric capability families through one compact typed-ref broker. Use family to filter when you know the lane.',
      inputSchema: BATSHIT_TOOL_SEARCH_INPUT_SCHEMA,
      execute: async (input: BatshitToolSearchInput) =>
        nativeBatshitToolSearch({
          ...input,
          userId: context.userId,
          agentId: context.agentId ?? null,
          selectedGateways,
          selectedCliToolIds,
          dcmDisplaySettings: context.dcmDisplaySettings ?? null,
          projectPath: context.projectPath ?? null,
          gatewayToolsCache,
          allowedFamilies: apiBrokerAllowedFamilies,
          runtimeMode: 'mode3',
          fabricAllowedControlIds: Array.from(apiBrokerFabricAllowedControlIds)
        }),
      toModelOutput: formatBatshitToolSearchModelOutput()
    })

    tools.native_batshit_tool_use = tool({
      description:
        'Execute one exact ref returned by native_batshit_tool_search. Refs look like mcp:tool, cli:toolId, artifact:use.artifact.slug, or fabric:sys.control.',
      inputSchema: BATSHIT_TOOL_USE_INPUT_SCHEMA,
      execute: async (input: BatshitToolUseInput) =>
        nativeBatshitToolUse({
          ...input,
          userId: context.userId,
          agentId: context.agentId ?? null,
          sessionId: context.sessionId,
          selectedGateways,
          selectedCliToolIds,
          dcmDisplaySettings: context.dcmDisplaySettings ?? null,
          projectPath: context.projectPath ?? null,
          gatewayToolsCache,
          allowedFamilies: apiBrokerAllowedFamilies,
          runtimeMode: 'mode3',
          fabricAllowedControlIds: Array.from(apiBrokerFabricAllowedControlIds),
          executionBackend: settings.executionBackend,
          executeControlUse: executeBrokerScopedControlUse
        }),
      toModelOutput: formatBatshitToolUseModelOutput()
    })
  }

  if (settings.webSearchEnabled) {
    tools.native_web_search = tool({
      description:
        'Run web search using the provider configured in Batshit settings. Batshit resolves the provider from agent settings first, then admin defaults, then DuckDuckGo as fallback when needed.',
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
        region: z.string().optional(),
        safeSearch: z.enum(['strict', 'moderate', 'off']).optional(),
      timeoutMs: z.number().int().min(1_000).max(MAX_WEB_SEARCH_TIMEOUT_MS).optional()
    }),
      execute: async (input) =>
        nativeWebSearch({
          userId: context.userId,
          query: input.query,
          agentDefaultProvider: settings.webSearchProvider,
          agentDefaultExaSearchType: settings.webSearchExaSearchType,
          agentDefaultPerplexityMaxTokensPerPage:
            settings.webSearchPerplexityMaxTokensPerPage,
          maxResults: input.maxResults,
          region: input.region,
          safeSearch: input.safeSearch,
          timeoutMs: input.timeoutMs
        })
    })
  }

  if (settings.bashEnabled) {
    const bashNeedsApproval =
      bashApprovalRequestsEnabled
        ? async (input: unknown) => {
            let command = ''

            if (typeof input === 'string') {
              const trimmed = input.trim()
              if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                  const parsed = JSON.parse(trimmed)
                  if (parsed && typeof parsed === 'object' && typeof (parsed as any).command === 'string') {
                    command = (parsed as any).command.trim()
                  }
                } catch {
                  // fall through to treat the string as a direct command
                }
              }
              if (!command) {
                command = trimmed
              }
            } else if (input && typeof input === 'object' && typeof (input as any).command === 'string') {
              command = (input as any).command.trim()
            }

            if (!command) return false

            // Hard-blocked commands should fail immediately without an approval prompt.
            const policy = evaluateBashPolicy(
              command,
              'agent',
              settings.bashNeverAllowList
            )
            if (policy.blocked) return false

            return !isAgentModeAutoAllowedCommand(
              command,
              settings.bashCommandAllowList
            )
          }
        : false

    if (typeof bashNeedsApproval === 'function') {
      toolApprovals.native_bash_execute = async (input) =>
        (await bashNeedsApproval(input)) ? 'user-approval' : undefined
    }

    tools.native_bash_execute = tool({
      description:
        'Execute bash commands using Agent Settings access mode (Plan, Agent, Dangerous) with policy guards and renderer mapping.',
      inputSchema: z.object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().min(MIN_BASH_TIMEOUT_MS).max(MAX_BASH_TIMEOUT_MS).optional(),
        maxOutputChars: z.number().int().min(1_000).max(MAX_BASH_OUTPUT_CHARS).optional()
      }),
      execute: async (input) => {
        const command = typeof input.command === 'string' ? input.command.trim() : ''
        const agentModePolicyOnly =
          settings.bashAccessMode === 'agent' && !bashApprovalRequestsEnabled

        if (
          agentModePolicyOnly &&
          command &&
          !isAgentModeAutoAllowedCommand(command, settings.bashCommandAllowList)
        ) {
          return {
            success: false,
            blocked: true,
            reason:
              'Blocked by Agent mode policy. Add this command to the allow list, switch Approval Policy to On Failure, or switch to Dangerous mode.',
            command,
            policyMode: settings.bashPolicyMode,
            accessMode: settings.bashAccessMode
          }
        }

        return nativeBashExecute({
          userId: context.userId,
          sessionId: context.sessionId,
          projectPath: context.projectPath ?? null,
          command: input.command,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          defaultTimeoutMs: settings.bashTimeoutMs,
          backend: settings.executionBackend,
          // Enforce persisted Agent Settings access mode; do not allow per-call overrides.
          accessMode: settings.bashAccessMode,
          commandAllowList: settings.bashCommandAllowList,
          neverAllowList: settings.bashNeverAllowList,
          maxOutputChars: input.maxOutputChars,
          agentBrowserSettings: {
            enabled: settings.agentBrowserEnabled,
            liveViewEnabled: settings.agentBrowserLiveViewEnabled,
            runtimeMode: settings.agentBrowserRuntimeMode,
            cdpPort: settings.agentBrowserCdpPort,
            provider: settings.agentBrowserProvider,
            session: settings.agentBrowserSession,
            profilePath: settings.agentBrowserProfilePath,
            executablePath: settings.agentBrowserExecutablePath,
            extraFlags: settings.agentBrowserExtraFlags,
            timeoutMs: settings.agentBrowserTimeoutMs
          }
        })
      },
      toModelOutput: async ({ output }) => {
        const screenshotOutput = await buildAgentBrowserBashScreenshotModelOutput(output)
        if (screenshotOutput) return screenshotOutput

        if (typeof output === 'string') {
          return {
            type: 'text',
            value: output
          }
        }

        return {
          type: 'json',
          value: output ?? null
        }
      }
    })
  }

  return { tools, toolApprovals }
}

export const nativeToolService = {
  buildMode3NativeTools,
  nativeBatshitToolSearch,
  nativeBatshitToolUse,
  nativeFetchZip,
  nativeDynamicMcpFind,
  nativeDynamicMcpUse,
  nativeCliToolFind,
  nativeCliToolUse,
  nativeWebSearch,
  nativeComfyUiObjectInfo,
  nativeComfyUiWorkflows,
  nativeBashExecute,
  dispatchNativeAutomationPackAction,
  resolveNativeToolSettings,
  getSandboxBackendStatus,
  recoverSandboxBackend,
  getAppleContainerSandboxBackendStatus,
  recoverAppleContainerSandboxBackend,
  normalizeNativeExecutionBackend,
  nativeAgentBrowserFind,
  nativeAgentBrowserUse,
  getAgentBrowserRuntimeStatus,
  installAgentBrowserRuntime,
  uninstallAgentBrowserRuntime,
  cleanupDockerSandboxesForSession,
  cleanupExecutionSandboxesForSession,
  __setAgentBrowserCliRunnerForTests
}
