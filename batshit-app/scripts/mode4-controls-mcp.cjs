#!/usr/bin/env node
/**
 * CLI Internal Controls MCP Server (stdio)
 *
 * Exposes the Batshit internal helper tool set for managed CLI agents:
 * - batshit_server_fetch_zip
 * - batshit_tool_search
 * - batshit_tool_use
 * - batshit_server_dynamic_mcp_find
 * - batshit_server_dynamic_mcp_use
 * - batshit_server_cli_tool_find
 * - batshit_server_cli_tool_use
 * - batshit_server_agent_browser_find
 * - batshit_server_agent_browser_use
 * - batshit_server_bash_execute
 * - native_skill
 * - mcp_artifact_find
 * - mcp_artifact_use
 * - mcp_fabric_find
 * - mcp_fabric_use
 *
 * This server is intentionally STDIO-only and injected by managed Codex/Claude
 * profile generation. It avoids requiring a user-configured batshit-server gateway.
 */

const path = require('node:path')
const process = require('node:process')

const sdkRoot = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs')
const { Server } = require(path.join(sdkRoot, 'server', 'index.js'))
const { StdioServerTransport } = require(path.join(sdkRoot, 'server', 'stdio.js'))
const { CallToolRequestSchema, ListToolsRequestSchema } = require(path.join(sdkRoot, 'types.js'))
const fetchFn = globalThis.fetch || require('node-fetch')
const {
  normalizeCliRuntime,
  isRecallPayloadWithMedia,
  buildCallToolContent,
  attachMediaDeliveryError
} = require(path.join(__dirname, 'lib', 'cli-tool-result-content.cjs'))

const TOOL_NAMES = {
  fetchZip: 'batshit_server_fetch_zip',
  batshitToolSearch: 'batshit_tool_search',
  batshitToolUse: 'batshit_tool_use',
  dynamicFind: 'batshit_server_dynamic_mcp_find',
  dynamicUse: 'batshit_server_dynamic_mcp_use',
  cliFind: 'batshit_server_cli_tool_find',
  cliUse: 'batshit_server_cli_tool_use',
  agentBrowserFind: 'batshit_server_agent_browser_find',
  agentBrowserUse: 'batshit_server_agent_browser_use',
  bashExecute: 'batshit_server_bash_execute',
  skillRuntime: 'native_skill',
  artifactFind: 'mcp_artifact_find',
  artifactUse: 'mcp_artifact_use',
  controlFind: 'mcp_fabric_find',
  controlUse: 'mcp_fabric_use'
}

const ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS = ['use.artifact.*']

const TOOL_DEFINITIONS = [
  {
    name: TOOL_NAMES.fetchZip,
    description: 'Fetch a Batshit zip payload by zipId without changing unzip state.',
    inputSchema: {
      type: 'object',
      properties: {
        zipId: { type: 'string', description: 'Zip id, e.g. zip:abc123' },
        maxChars: { type: 'number', description: 'Optional max returned content length' },
        includeContent: { type: 'boolean', description: 'Include full content preview (default true)' }
      },
      required: ['zipId']
    }
  },
  {
    name: TOOL_NAMES.batshitToolSearch,
    description:
      'Search Batshit MCP, CLI, artifact, Fabric, and Agent Browser capabilities through one typed-ref broker.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        family: {
          type: 'string',
          enum: ['mcp', 'cli', 'artifact', 'fabric', 'agent_browser']
        },
        families: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['mcp', 'cli', 'artifact', 'fabric', 'agent_browser']
          }
        },
        limit: { type: 'number' },
        schemaMode: { type: 'string', enum: ['compact', 'full', 'none'] },
        includeSchema: { type: 'boolean' }
      }
    }
  },
  {
    name: TOOL_NAMES.batshitToolUse,
    description:
      'Execute one exact typed ref returned by batshit_tool_search, such as mcp:tool, cli:toolId, artifact:use.artifact.slug, fabric:sys.control, or agent_browser:open.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        params: { type: 'object', additionalProperties: true },
        allowRisky: { type: 'boolean' },
        dryRun: { type: 'boolean' }
      },
      required: ['ref']
    }
  },
  {
    name: TOOL_NAMES.bashExecute,
    description:
      'Run a Batshit-managed bash command through the current agent Bash settings/sandbox. Prefer this over raw CLI shell/read/list/search tools when the result may need same-turn Batshit zip-control or Batshit Read/List/Search/Edit/Bash rendering.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run.' },
        cwd: { type: 'string', description: 'Optional working directory override.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in milliseconds.' },
        maxOutputChars: { type: 'number', description: 'Optional max returned output characters.' }
      },
      required: ['command']
    }
  },
  {
    name: TOOL_NAMES.dynamicFind,
    description: 'Discover MCP tools by query/tool/group through Batshit Dynamic MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tool: { type: 'string' },
        group: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
        },
        exact: { type: 'boolean' },
        limit: { type: 'number' },
        includeSchema: { type: 'boolean' },
        selectedGateways: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: TOOL_NAMES.dynamicUse,
    description: 'Execute an MCP tool by exact toolName through Batshit Dynamic MCP.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string' },
        params: { type: 'object', additionalProperties: true },
        selectedGateways: { type: 'array', items: { type: 'string' } }
      },
      required: ['toolName']
    }
  },
  {
    name: TOOL_NAMES.cliFind,
    description: 'Discover active CLI tools for the current Batshit agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        includeSchema: { type: 'boolean' }
      }
    }
  },
  {
    name: TOOL_NAMES.cliUse,
    description: 'Execute an active CLI tool by toolId through the Batshit CLI tool registry.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        params: { type: 'object', additionalProperties: true },
        allowRisky: { type: 'boolean' }
      },
      required: ['toolId']
    }
  },
  {
    name: TOOL_NAMES.agentBrowserFind,
    description: 'Discover available Agent Browser commands for the current Batshit agent.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: TOOL_NAMES.agentBrowserUse,
    description: 'Execute an Agent Browser command through Batshit using this agent’s saved browser defaults.',
    inputSchema: {
      type: 'object',
      properties: {
        toolName: { type: 'string' },
        params: { type: 'object', additionalProperties: true }
      },
      required: ['toolName']
    }
  },
  {
    name: TOOL_NAMES.skillRuntime,
    description: 'Invoke, list, or read Batshit skill documentation and references.',
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', description: 'The skill id to operate on.' },
        action: { type: 'string', enum: ['invoke', 'list', 'read'] },
        path: { type: 'string', description: 'Reference path to read, such as references/guide.md or SKILL.md.' },
        maxChars: { type: 'number', description: 'Optional max returned content length for read actions.' }
      },
      required: ['skillId']
    }
  },
  {
    name: TOOL_NAMES.artifactFind,
    description: 'Discover published artifact runtime capabilities only (for example use.artifact.{slug}).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        includeSchema: { type: 'boolean' },
        includeDraft: { type: 'boolean' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: TOOL_NAMES.artifactUse,
    description: 'Execute a published artifact runtime capability by controlId.',
    inputSchema: {
      type: 'object',
      properties: {
        controlId: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        params: { type: 'object', additionalProperties: true },
        dryRun: { type: 'boolean' },
        allowRisky: { type: 'boolean' }
      },
      required: ['controlId']
    }
  },
  {
    name: TOOL_NAMES.controlFind,
    description: 'Discover Batshit control capabilities (Fabric Registry find).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        sourceType: {
          oneOf: [
            { type: 'string', enum: ['core', 'artifact', 'workflow', 'plugin'] },
            {
              type: 'array',
              items: { type: 'string', enum: ['core', 'artifact', 'workflow', 'plugin'] }
            }
          ]
        },
        riskLevel: {
          oneOf: [
            { type: 'string', enum: ['safe', 'confirm', 'restricted'] },
            {
              type: 'array',
              items: { type: 'string', enum: ['safe', 'confirm', 'restricted'] }
            }
          ]
        },
        includeSchema: { type: 'boolean' },
        includeDraft: { type: 'boolean' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: TOOL_NAMES.controlUse,
    description: 'Execute a Batshit control capability by controlId (Fabric Registry use).',
    inputSchema: {
      type: 'object',
      properties: {
        controlId: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        params: { type: 'object', additionalProperties: true },
        dryRun: { type: 'boolean' },
        allowRisky: { type: 'boolean' },
        selectedGateways: { type: 'array', items: { type: 'string' } }
      },
      required: ['controlId']
    }
  }
]

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((entry) => entry.match(/^--([^=]+)=(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]])
)

const userId = args.user || args['user-id'] || process.env.BATSHIT_USER_ID
if (!userId) {
  console.error('[cli-controls-mcp] Missing required --user (or BATSHIT_USER_ID) parameter')
  process.exit(1)
}
const agentId = args.agent || args['agent-id'] || process.env.BATSHIT_AGENT_ID || null
const sessionId = args.session || args['session-id'] || process.env.BATSHIT_SESSION_ID || null
/**
 * SA-105 P3 (AMD-105-09): which managed CLI launched this bridge. Both profile
 * managers pass it explicitly rather than the bridge inferring it, because env
 * plumbing is structurally different between them (Codex passes an allow-list of
 * variables to forward; Claude writes a literal env map with `${VAR}`
 * interpolation), so one argv flag costs one line on each side and is visible in
 * `ps`. Missing or unrecognised means no in-turn image delivery at all.
 */
const cliRuntime = normalizeCliRuntime(args.runtime || process.env.BATSHIT_CLI_RUNTIME)
const projectPath =
  args['project-path'] ||
  args.projectPath ||
  args.project ||
  process.env.BATSHIT_PROJECT_PATH ||
  null

const defaultBatshitBaseUrl =
  process.env.BATSHIT_CONTAINERIZED === '1'
    ? `http://127.0.0.1:${process.env.PORT || '3000'}`
    : 'http://localhost:5620'
const batshitBaseUrl =
  args.url ||
  args['frontend-url'] ||
  process.env.BATSHIT_CLI_HELPER_BASE_URL ||
  process.env.BATSHIT_INTERNAL_APP_URL ||
  process.env.BATSHIT_FRONTEND_URL ||
  process.env.PUBLIC_BASE_URL ||
  process.env.ORIGIN ||
  defaultBatshitBaseUrl

function resolveServiceToken() {
  const token = process.env.BATSHIT_TOKEN || ''
  return token.trim()
}

function normalizeArgs(input) {
  if (input && typeof input === 'object' && input.value && typeof input.value === 'object') {
    return normalizeArgs(input.value)
  }
  if (
    input &&
    typeof input === 'object' &&
    input.arguments &&
    typeof input.arguments === 'object' &&
    !Array.isArray(input.arguments)
  ) {
    return normalizeArgs(input.arguments)
  }
  return input && typeof input === 'object' ? input : {}
}

function optionalNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

function toErrorPayload(message, details) {
  return {
    success: false,
    error: message,
    ...(details && typeof details === 'object' ? { details } : {})
  }
}

function reserveZipId(type = 'cool_tool') {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 7)
  return `${type}_${timestamp}_${random}`
}

function attachZipControlNotice(payload) {
  if (!sessionId) return payload

  const zipId = reserveZipId('cool_tool')
  const notice = {
    zipId,
    instruction:
      'Use this exact zipId in unzip/zip controls if this tool result should stay expanded or change zip state. Use zip IDs only.'
  }

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      ...payload,
      batshitZipControl: notice
    }
  }

  return {
    result: payload,
    batshitZipControl: notice
  }
}

async function postJson(endpointPath, payload, timeoutMs = 60000) {
  const token = resolveServiceToken()
  if (!token) {
    return {
      ok: false,
      status: 500,
      body: toErrorPayload('BATSHIT_TOKEN is not configured for CLI internal control tools.')
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchFn(`${batshitBaseUrl}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-batshit-service-token': token,
        'x-batshit-user-id': userId
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    })

    const text = await response.text()
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      body = { raw: text }
    }

    return {
      ok: response.ok,
      status: response.status,
      body
    }
  } catch (error) {
    return {
      ok: false,
      status: 500,
      body: toErrorPayload(error instanceof Error ? error.message : 'Request failed')
    }
  } finally {
    clearTimeout(timer)
  }
}

function formatFetchZipResult(responseBody, inputZipId) {
  if (!responseBody || responseBody.success !== true || !responseBody.result) {
    const message =
      responseBody?.error?.message ||
      responseBody?.error ||
      'fetch_zip failed'
    return {
      success: false,
      tool: 'fetch_zip',
      zipId: inputZipId || '',
      error: message
    }
  }

  const result = responseBody.result
  if (result.found !== true) {
    return {
      success: false,
      tool: 'fetch_zip',
      zipId: result.zipId || inputZipId || '',
      error: result.reason || 'Zip not found'
    }
  }

  const metadata = {
    type: result.type || 'unknown',
    tokens: result.tokens ?? null,
    description: result.description ?? null,
    ...(result.metadata && typeof result.metadata === 'object' ? result.metadata : {})
  }

  return {
    success: true,
    tool: 'fetch_zip',
    zipId: result.zipId || inputZipId || '',
    truncated: result.contentTruncated === true,
    totalLength: typeof result.contentLength === 'number' ? result.contentLength : undefined,
    content: typeof result.content === 'string' ? result.content : undefined,
    metadata
  }
}

async function callControlFind(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const payload = {
    userId,
    ...(agentId ? { agentId } : {}),
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(Array.isArray(args.tags) ? { tags: args.tags } : {}),
    ...(args.sourceType ? { sourceType: args.sourceType } : {}),
    ...(args.riskLevel ? { riskLevel: args.riskLevel } : {}),
    ...(typeof args.includeSchema === 'boolean' ? { includeSchema: args.includeSchema } : {}),
    ...(typeof args.includeDraft === 'boolean' ? { includeDraft: args.includeDraft } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(Array.isArray(args.allowedControlIds) ? { allowedControlIds: args.allowedControlIds } : {})
  }

  const response = await postJson('/api/controls/find', payload, 30000)
  return response.body
}

async function callControlUse(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const {
    controlId,
    control_id,
    id,
    sessionId: sessionIdArg,
    session_id,
    input,
    params,
    dryRun,
    dry_run,
    allowRisky,
    allow_risky,
    selectedGateways,
    allowedControlIds,
    ...extraArgs
  } = args
  const resolvedSessionId =
    (typeof sessionIdArg === 'string' && sessionIdArg.trim().length > 0
      ? sessionIdArg.trim()
      : typeof session_id === 'string' && session_id.trim().length > 0
        ? session_id.trim()
        : typeof sessionId === 'string' && sessionId.trim().length > 0
          ? sessionId.trim()
          : null)
  const payloadInput =
    input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : params && typeof params === 'object' && !Array.isArray(params)
        ? params
        : Object.keys(extraArgs).length > 0
          ? extraArgs
          : {}

  const payload = {
    userId,
    ...(agentId ? { agentId } : {}),
    ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
    controlId: controlId || control_id || id || '',
    input: payloadInput,
    dryRun: dryRun === true || dry_run === true,
    allowRisky: allowRisky === true || allow_risky === true,
    ...(Array.isArray(selectedGateways) ? { selectedGateways } : {}),
    ...(Array.isArray(allowedControlIds) ? { allowedControlIds } : {})
  }

  const response = await postJson('/api/controls/use', payload, 60000)
  return response.body
}

async function callArtifactFind(rawArgs) {
  const args = normalizeArgs(rawArgs)
  return await callControlFind({
    ...args,
    allowedControlIds: ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS
  })
}

async function callArtifactUse(rawArgs) {
  const args = normalizeArgs(rawArgs)
  return await callControlUse({
    ...args,
    allowedControlIds: ARTIFACT_RUNTIME_ALLOWED_CONTROL_IDS
  })
}

async function callDynamicFind(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const controlUseResponse = await callControlUse({
    controlId: 'sys.mcp.dynamic.find',
    input: {
      ...(typeof args.query === 'string' ? { query: args.query } : {}),
      ...(typeof args.tool === 'string' ? { tool: args.tool } : {}),
      ...(typeof args.toolName === 'string' ? { tool: args.toolName } : {}),
      ...(typeof args.group === 'string' || Array.isArray(args.group) ? { group: args.group } : {}),
      ...(typeof args.exact === 'boolean' ? { exact: args.exact } : {}),
      ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
      ...(typeof args.includeSchema === 'boolean' ? { includeSchema: args.includeSchema } : {}),
      ...(Array.isArray(args.selectedGateways) ? { selectedGateways: args.selectedGateways } : {}),
      ...(typeof projectPath === 'string' && projectPath.trim().length > 0
        ? { projectPath: projectPath.trim() }
        : {})
    },
    dryRun: args.dryRun === true || args.dry_run === true
  })

  if (controlUseResponse?.success === true) {
    return controlUseResponse.result ?? {}
  }

  return toErrorPayload(
    controlUseResponse?.error?.message || controlUseResponse?.error || 'Dynamic MCP find failed',
    controlUseResponse?.error?.details
  )
}

async function callDynamicUse(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const params =
    args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? args.params
      : {}

  const extraTopLevel = { ...args }
  delete extraTopLevel.toolName
  delete extraTopLevel.tool
  delete extraTopLevel.tool_name
  delete extraTopLevel.params
  delete extraTopLevel.selectedGateways
  delete extraTopLevel.dryRun
  delete extraTopLevel.dry_run

  const normalizedParams = Object.keys(extraTopLevel).length > 0
    ? { ...params, ...extraTopLevel }
    : params

  const toolName = args.toolName || args.tool || args.tool_name || ''

  const controlUseResponse = await callControlUse({
    controlId: 'sys.mcp.dynamic.use',
    input: {
      toolName,
      params: normalizedParams,
      ...(Array.isArray(args.selectedGateways) ? { selectedGateways: args.selectedGateways } : {}),
      ...(typeof projectPath === 'string' && projectPath.trim().length > 0
        ? { projectPath: projectPath.trim() }
        : {})
    },
    dryRun: args.dryRun === true || args.dry_run === true
  })

  if (controlUseResponse?.success === true) {
    return controlUseResponse.result ?? {}
  }

  return toErrorPayload(
    controlUseResponse?.error?.message || controlUseResponse?.error || 'Dynamic MCP use failed',
    controlUseResponse?.error?.details
  )
}

async function callCliFind(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const payload = {
    userId,
    ...(agentId ? { agentId } : {}),
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.includeSchema === 'boolean' ? { includeSchema: args.includeSchema } : {})
  }

  const response = await postJson('/api/cli-tools/find', payload, 30000)
  return response.body
}

async function callCliUse(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const payloadInput =
    args.input && typeof args.input === 'object' && !Array.isArray(args.input)
      ? args.input
      : args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? args.params
        : {}

  const payload = {
    userId,
    ...(agentId ? { agentId } : {}),
    toolId: args.toolId || args.tool_id || '',
    input: payloadInput,
    allowRisky: args.allowRisky === true || args.allow_risky === true,
    ...(typeof projectPath === 'string' && projectPath.trim().length > 0
      ? { projectPath: projectPath.trim() }
      : {})
  }

  const response = await postJson('/api/cli-tools/execute', payload, 60000)
  return response.body
}

async function callAgentBrowser(rawArgs, action) {
  const args = normalizeArgs(rawArgs)
  const payload = {
    userId,
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    action,
    ...(typeof args.query === 'string' ? { query: args.query } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.toolName === 'string' ? { toolName: args.toolName } : {}),
    ...(typeof args.tool_name === 'string' ? { toolName: args.tool_name } : {}),
    ...(args.params && typeof args.params === 'object' && !Array.isArray(args.params)
      ? { params: args.params }
      : {})
  }

  const response = await postJson('/api/native-tools/agent-browser', payload, 90000)
  return response.body
}

async function callFetchZip(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const zipId = typeof args.zipId === 'string' ? args.zipId : args.zip_id
  const controlUseResponse = await callControlUse({
    controlId: 'sys.zip.fetch',
    input: {
      zipId,
      ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
      ...(typeof args.max_chars === 'number' ? { maxChars: args.max_chars } : {}),
      ...(typeof args.includeContent === 'boolean' ? { includeContent: args.includeContent } : {})
    },
    dryRun: args.dryRun === true || args.dry_run === true
  })

  return formatFetchZipResult(controlUseResponse, zipId)
}

async function callBashExecute(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const command =
    typeof args.command === 'string' && args.command.trim().length > 0
      ? args.command.trim()
      : typeof args.cmd === 'string' && args.cmd.trim().length > 0
        ? args.cmd.trim()
        : ''

  if (!command) {
    return toErrorPayload('command is required for batshit_server_bash_execute.')
  }
  if (!sessionId) {
    return toErrorPayload('BATSHIT_SESSION_ID is required for batshit_server_bash_execute.')
  }
  if (!agentId) {
    return toErrorPayload('Agent id is required for batshit_server_bash_execute.')
  }

  const timeoutMs = optionalNumber(args.timeoutMs, args.timeout_ms)
  const maxOutputChars = optionalNumber(args.maxOutputChars, args.max_output_chars)
  const input = {
    command,
    ...(typeof args.cwd === 'string' && args.cwd.trim().length > 0 ? { cwd: args.cwd.trim() } : {}),
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
    ...(typeof maxOutputChars === 'number' ? { maxOutputChars } : {})
  }

  const response = await postJson(
    '/api/native-tools/dispatch',
    {
      userId,
      ...(typeof projectPath === 'string' && projectPath.trim().length > 0
        ? { projectPath: projectPath.trim() }
        : {}),
      action: 'bash_execute',
      input,
      context: {
        session_id: sessionId,
        agent_id: agentId,
        mode: 'mode4',
        actor_type: 'primary'
      }
    },
    Math.max(60000, typeof timeoutMs === 'number' ? timeoutMs + 5000 : 120000)
  )
  const body = response.body

  if (body?.success !== true) {
    return {
      success: false,
      tool: 'bash_execute',
      action: 'bash_execute',
      command,
      error: body?.error?.message || body?.error || 'bash_execute failed',
      ...(body?.error?.code ? { errorCode: body.error.code } : {}),
      ...(body?.error?.details ? { details: body.error.details } : {})
    }
  }

  return {
    ...(body.data && typeof body.data === 'object' ? body.data : { result: body.data }),
    success: true,
    tool: 'bash_execute',
    action: 'bash_execute',
    command,
    ...(body.backend ? { backend: body.backend } : {})
  }
}

const BATSHIT_TOOL_FAMILIES = ['mcp', 'cli', 'artifact', 'fabric', 'agent_browser']

function normalizeBatshitToolFamily(value) {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, '_')
  if (normalized === 'dynamic' || normalized === 'dynamic_mcp' || normalized === 'gateway') return 'mcp'
  if (normalized === 'tool' || normalized === 'tools' || normalized === 'cli_tool' || normalized === 'cli_tools') return 'cli'
  if (normalized === 'artifacts' || normalized === 'artifact_runtime') return 'artifact'
  if (normalized === 'control' || normalized === 'controls' || normalized === 'batshit_tools') return 'fabric'
  if (normalized === 'browser' || normalized === 'agentbrowser' || normalized === 'ab') return 'agent_browser'
  return BATSHIT_TOOL_FAMILIES.includes(normalized) ? normalized : null
}

function resolveBatshitToolFamilies(args) {
  const requested = new Set()
  const single = normalizeBatshitToolFamily(args.family)
  if (single) requested.add(single)
  if (Array.isArray(args.families)) {
    for (const entry of args.families) {
      const family = normalizeBatshitToolFamily(entry)
      if (family) requested.add(family)
    }
  }
  return requested.size > 0 ? Array.from(requested) : BATSHIT_TOOL_FAMILIES
}

function parseBatshitToolRef(ref) {
  const trimmed = typeof ref === 'string' ? ref.trim() : ''
  const separatorIndex = trimmed.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error('Invalid Batshit tool ref. Expected mcp:..., cli:..., artifact:..., fabric:..., or agent_browser:...')
  }
  const family = normalizeBatshitToolFamily(trimmed.slice(0, separatorIndex))
  const target = trimmed.slice(separatorIndex + 1).trim()
  if (!family || !target) {
    throw new Error('Invalid Batshit tool ref. Use an exact typed ref from batshit_tool_search.')
  }
  return { family, target }
}

function normalizeSchemaMode(args) {
  if (args.includeSchema === true) return 'full'
  if (typeof args.schemaMode === 'string') {
    const normalized = args.schemaMode.trim().toLowerCase()
    if (normalized === 'compact' || normalized === 'full' || normalized === 'none') return normalized
  }
  return 'compact'
}

function mapBatshitSearchResult(family, entry, schemaMode) {
  if (family === 'mcp') {
    const toolName = typeof entry.toolName === 'string' ? entry.toolName : 'unknown-tool'
    const title =
      typeof entry.originalToolName === 'string' && entry.originalToolName.trim()
        ? entry.originalToolName.trim()
        : toolName
    const ref = `mcp:${toolName}`
    return {
      ref,
      family,
      title,
      description: typeof entry.description === 'string' ? entry.description : '',
      hint:
        schemaMode === 'none'
          ? undefined
          : entry.inputSchema
            ? 'input: MCP params object; schemaMode full includes the exact schema.'
            : 'input: MCP params object.',
      source: entry.gatewayName || entry.groupName || undefined,
      ...(schemaMode === 'full' && entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
      useExample: `batshit_tool_use({ ref: "${ref}", input: { ... } })`
    }
  }
  if (family === 'cli') {
    const toolId = typeof entry.toolId === 'string' ? entry.toolId : 'unknown-tool'
    const ref = `cli:${toolId}`
    return {
      ref,
      family,
      title: typeof entry.title === 'string' ? entry.title : toolId,
      description: typeof entry.description === 'string' ? entry.description : '',
      hint:
        schemaMode === 'none'
          ? undefined
          : typeof entry.schemaHint === 'string'
            ? `input: { ${entry.schemaHint} }`
            : 'input: CLI manifest fields go inside input.',
      source: entry.executable || undefined,
      ...(schemaMode === 'full' && entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
      useExample: `batshit_tool_use({ ref: "${ref}", input: { ... } })`
    }
  }
  if (family === 'agent_browser') {
    const toolName = typeof entry.toolName === 'string' ? entry.toolName : 'unknown-command'
    const ref = `agent_browser:${toolName}`
    return {
      ref,
      family,
      title: toolName,
      description: typeof entry.summary === 'string' ? entry.summary : '',
      hint:
        schemaMode === 'none'
          ? undefined
          : entry.paramsHint || entry.argsHint || 'input: Agent Browser command params object.',
      source: entry.cliCommand || undefined,
      useExample: `batshit_tool_use({ ref: "${ref}", input: { ... } })`
    }
  }

  const controlId = typeof entry.controlId === 'string' ? entry.controlId : 'unknown-control'
  const ref = `${family}:${controlId}`
  return {
    ref,
    family,
    title: typeof entry.title === 'string' ? entry.title : controlId,
    description: typeof entry.description === 'string' ? entry.description : '',
    hint:
      schemaMode === 'none'
        ? undefined
        : typeof entry.schemaHint === 'string'
          ? `input: ${entry.schemaHint}`
          : 'input: structured control fields.',
    riskLevel: entry.riskLevel || 'safe',
    source: entry.sourceType || undefined,
    ...(schemaMode === 'full' && entry.inputSchema ? { inputSchema: entry.inputSchema } : {}),
    useExample: `batshit_tool_use({ ref: "${ref}", input: { ... } })`
  }
}

async function callBatshitToolSearch(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const schemaMode = normalizeSchemaMode(args)
  const includeSchema = schemaMode !== 'none'
  const limit = typeof args.limit === 'number' ? args.limit : 10
  const families = resolveBatshitToolFamilies(args)
  const results = []
  let totalMatches = 0

  for (const family of families) {
    if (family === 'mcp') {
      const found = await callDynamicFind({ ...args, includeSchema, limit })
      const entries = Array.isArray(found?.results) ? found.results : []
      totalMatches += typeof found?.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapBatshitSearchResult(family, entry, schemaMode)))
    } else if (family === 'cli') {
      const found = await callCliFind({ ...args, includeSchema, limit })
      const entries = Array.isArray(found?.results) ? found.results : []
      totalMatches += typeof found?.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapBatshitSearchResult(family, entry, schemaMode)))
    } else if (family === 'artifact') {
      const found = await callArtifactFind({ ...args, includeSchema, limit })
      const entries = Array.isArray(found?.results) ? found.results : []
      totalMatches += typeof found?.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapBatshitSearchResult(family, entry, schemaMode)))
    } else if (family === 'fabric') {
      const found = await callControlFind({ ...args, includeSchema, limit })
      const entries = Array.isArray(found?.results) ? found.results : []
      totalMatches += typeof found?.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapBatshitSearchResult(family, entry, schemaMode)))
    } else if (family === 'agent_browser') {
      const found = await callAgentBrowser({ ...args, limit }, 'find')
      const entries = Array.isArray(found?.results) ? found.results : []
      totalMatches += typeof found?.totalMatches === 'number' ? found.totalMatches : entries.length
      results.push(...entries.map((entry) => mapBatshitSearchResult(family, entry, schemaMode)))
    }
  }

  return {
    results: results.slice(0, Math.max(1, Math.min(limit, 20))),
    totalMatches,
    query: typeof args.query === 'string' ? args.query : '',
    limit,
    schemaMode,
    families,
    operationKind: 'tool_find',
    rendererFamily: 'tool_find'
  }
}

async function callBatshitToolUse(rawArgs) {
  const args = normalizeArgs(rawArgs)
  let parsed
  try {
    parsed = parseBatshitToolRef(args.ref)
  } catch (error) {
    return toErrorPayload(error instanceof Error ? error.message : 'Invalid Batshit tool ref')
  }
  const payloadInput =
    args.input && typeof args.input === 'object' && !Array.isArray(args.input)
      ? args.input
      : args.params && typeof args.params === 'object' && !Array.isArray(args.params)
        ? args.params
        : {}

  let result
  if (parsed.family === 'mcp') {
    result = await callDynamicUse({ toolName: parsed.target, params: payloadInput })
  } else if (parsed.family === 'cli') {
    result = await callCliUse({
      toolId: parsed.target,
      input: payloadInput,
      allowRisky: args.allowRisky === true || args.allow_risky === true
    })
  } else if (parsed.family === 'artifact') {
    result = await callArtifactUse({
      controlId: parsed.target,
      input: payloadInput,
      dryRun: args.dryRun === true || args.dry_run === true,
      allowRisky: args.allowRisky === true || args.allow_risky === true
    })
  } else if (parsed.family === 'fabric') {
    result = await callControlUse({
      controlId: parsed.target,
      input: payloadInput,
      dryRun: args.dryRun === true || args.dry_run === true,
      allowRisky: args.allowRisky === true || args.allow_risky === true
    })
  } else {
    result = await callAgentBrowser({ toolName: parsed.target, params: payloadInput }, 'use')
  }

  return {
    ...(result && typeof result === 'object' ? result : { result }),
    ref: args.ref,
    family: parsed.family,
    target: parsed.target,
    operationKind:
      parsed.family === 'mcp'
        ? 'dynamic_use'
        : parsed.family === 'cli'
          ? 'cli_tool'
          : parsed.family === 'artifact'
            ? 'artifact_use'
            : parsed.family === 'fabric'
              ? 'fabric_use'
              : 'agent_browser_use',
    rendererFamily: parsed.family === 'cli' ? 'cli_tool' : 'generic_tool'
  }
}

async function callSkillRuntime(rawArgs) {
  const args = normalizeArgs(rawArgs)
  const payload = {
    userId,
    ...(typeof args.skillId === 'string' ? { skillId: args.skillId } : {}),
    ...(typeof args.action === 'string' ? { action: args.action } : {}),
    ...(typeof args.path === 'string' ? { path: args.path } : {}),
    ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {})
  }

  const response = await postJson('/api/skills/runtime', payload, 30000)
  return response.body
}

/**
 * SA-105 P3 — deliver recalled memory images in THIS turn on the managed CLI
 * lanes (DL-105-09).
 *
 * The control result that just came back is byte-free by design (DL-105-04), so
 * bytes are fetched here, at delivery time, through one narrow service-token app
 * route in the same `resolveNativeToolUser` family the bridge already uses
 * (AMD-105-10). No new transport, no new secret.
 *
 * The route — not this bridge — owns the lane decision, the per-image
 * `delivery`/`reason`, and the per-memory `media_note`, so the CLI lanes and the
 * API lanes cannot drift into saying different things about the same image. The
 * bridge stays a pipe: it forwards the plan, splices the finished plan back, and
 * turns the returned bytes into MCP image blocks.
 */
async function deliverRecalledImages(payload) {
  if (!cliRuntime || !agentId) return { payload, images: [] }
  if (!isRecallPayloadWithMedia(payload)) return { payload, images: [] }

  const response = await postJson(
    '/api/memory/recall-media',
    { userId, agentId, runtime: cliRuntime, recall: payload },
    60000
  )

  const body = response.body
  if (!response.ok || !body || body.success !== true || !body.recall) {
    // Loud, not silent: the agent is told in its own payload that images it may
    // be expecting are not attached, instead of receiving an unexplained plan.
    const message =
      (body && typeof body.error === 'string' && body.error) ||
      `delivery request failed with status ${response.status}`
    return { payload: attachMediaDeliveryError(payload, message), images: [] }
  }

  return {
    payload: body.recall,
    images: Array.isArray(body.images) ? body.images : []
  }
}

async function executeTool(name, args) {
  if (name === TOOL_NAMES.fetchZip) return await callFetchZip(args)
  if (name === TOOL_NAMES.batshitToolSearch) return await callBatshitToolSearch(args)
  if (name === TOOL_NAMES.batshitToolUse) return await callBatshitToolUse(args)
  if (name === TOOL_NAMES.dynamicFind) return await callDynamicFind(args)
  if (name === TOOL_NAMES.dynamicUse) return await callDynamicUse(args)
  if (name === TOOL_NAMES.cliFind) return await callCliFind(args)
  if (name === TOOL_NAMES.cliUse) return await callCliUse(args)
  if (name === TOOL_NAMES.agentBrowserFind) return await callAgentBrowser(args, 'find')
  if (name === TOOL_NAMES.agentBrowserUse) return await callAgentBrowser(args, 'use')
  if (name === TOOL_NAMES.bashExecute) return await callBashExecute(args)
  if (name === TOOL_NAMES.skillRuntime) return await callSkillRuntime(args)
  if (name === TOOL_NAMES.artifactFind) return await callArtifactFind(args)
  if (name === TOOL_NAMES.artifactUse) return await callArtifactUse(args)
  if (name === TOOL_NAMES.controlFind) return await callControlFind(args)
  if (name === TOOL_NAMES.controlUse) return await callControlUse(args)

  return toErrorPayload(`Unknown tool: ${name}`)
}

async function main() {
  const server = new Server(
    {
      name: 'batshit-cli-internal-tools',
      version: '0.1.0'
    },
    {
      capabilities: {
        tools: {}
      }
    }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request?.params?.name || ''
    const args = request?.params?.arguments || {}
    const delivery = await deliverRecalledImages(await executeTool(name, args))
    const payload = attachZipControlNotice(delivery.payload)

    // `buildCallToolContent` never sets `structuredContent` — Codex drops
    // `content[]` when it is present (openai/codex#10334), which would delete
    // both the JSON text and the images.
    return buildCallToolContent(payload, delivery.images)
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('[cli-controls-mcp] Fatal error', error)
  process.exit(1)
})
