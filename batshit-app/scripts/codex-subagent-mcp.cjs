#!/usr/bin/env node
/**
 * Shared CLI Primary Subagent MCP Server (stdio)
 *
 * Exposes assigned Batshit subagents as MCP tools so CLI Primary Agents can call them.
 * The filename is historical: Codex and Claude managed profiles both spawn this bridge.
 */

const path = require('node:path')
const process = require('node:process')
const sdkRoot = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs')
const { Server } = require(path.join(sdkRoot, 'server', 'index.js'))
const { StdioServerTransport } = require(path.join(sdkRoot, 'server', 'stdio.js'))
const { CallToolRequestSchema, ListToolsRequestSchema } = require(path.join(sdkRoot, 'types.js'))
const { createClient } = require('redis')
const fetchFn = globalThis.fetch || require('node-fetch')

// --- CLI args --------------------------------------------------------------
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur) => {
  const match = cur.match(/^--([^=]+)=(.*)$/)
  if (match) acc.push([match[1], match[2]])
  return acc
}, []))

const agentId = args.agent || args['agent-id'] || process.env.BATSHIT_AGENT_ID
const userId = args.user || args['user-id'] || process.env.BATSHIT_USER_ID
if (!agentId || !userId) {
  console.error('[subagent-mcp] Missing required --agent and --user params')
  process.exit(1)
}

// --- Redis client ---------------------------------------------------------
const redisUrl = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || 'redis://localhost:6379'
const redisPassword = process.env.REDIS_PASSWORD || undefined
const redis = createClient({ url: redisUrl, password: redisPassword })
redis.on('error', (err) => console.error('[subagent-mcp] Redis error', err))

const DEFAULT_FRONTEND_URL =
  process.env.BATSHIT_CONTAINERIZED === '1'
    ? `http://127.0.0.1:${process.env.PORT || '3000'}`
    : 'http://localhost:5620'
const MANAGED_SUBAGENT_ROUTE = '/api/subagents/managed-execute'
const MANAGED_SUBAGENT_TIMEOUT_MS = normalizeTimeoutMs(
  process.env.BATSHIT_MANAGED_SUBAGENT_TIMEOUT_MS,
  120000
)
const AMBIGUOUS_CODEX_SESSION = '__batshit_ambiguous_codex_session__'
const serviceToken = process.env.BATSHIT_TOKEN || process.env.MCP_GATEWAY_AUTH_TOKEN || ''
const batshitBaseUrl = trimTrailingSlash(
  args.url ||
    args['frontend-url'] ||
    process.env.BATSHIT_CLI_HELPER_BASE_URL ||
    process.env.BATSHIT_INTERNAL_APP_URL ||
    process.env.BATSHIT_FRONTEND_URL ||
    process.env.PUBLIC_BASE_URL ||
    process.env.ORIGIN ||
    DEFAULT_FRONTEND_URL
)

function trimTrailingSlash(value) {
  const text = (value || '').toString().trim()
  return text.replace(/\/+$/, '') || DEFAULT_FRONTEND_URL
}

function normalizeTimeoutMs(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.min(Math.floor(parsed), 10 * 60 * 1000)
}

function normalizeToolArgs(input) {
  if (
    input &&
    typeof input === 'object' &&
    input.arguments &&
    typeof input.arguments === 'object' &&
    !Array.isArray(input.arguments)
  ) {
    return normalizeToolArgs(input.arguments)
  }
  return input && typeof input === 'object' ? input : {}
}

async function loadAgent(agentId) {
  const key = `agent:${agentId}`
  const raw = await redis.json.get(key)
  return raw || null
}

async function loadSubagent(subagentId) {
  const key = `subagent:${subagentId}`
  return (await redis.json.get(key)) || null
}

function safeName(value, fallback) {
  const base = (value || fallback || '').toString()
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'subagent'
}

function assertUniqueKey(baseKey, usedKeys, displayName) {
  const root = baseKey || 'subagent'
  if (usedKeys.has(root)) {
    throw new Error(
      `Subagent slug '${root}' is already taken by more than one assigned subagent. Choose another subagent slug or delete/rename the original${displayName ? ` (${displayName})` : ''}.`
    )
  }
  usedKeys.add(root)
  return root
}

function getAssignedSubagentIds(agent) {
  return Array.from(
    new Set(
      [
        ...(Array.isArray(agent?.assignedSubagents) ? agent.assignedSubagents : []),
        ...(Array.isArray(agent?.assigned_subagent_ids) ? agent.assigned_subagent_ids : [])
      ].filter((value) => typeof value === 'string' && value.trim().length > 0)
    )
  )
}

function normalizeSubagentType(subagent) {
  const rawType = (subagent?.subagentType || subagent?.subagent_type || '').toString().trim().toLowerCase()
  if (rawType === 'n8n-subnode' || rawType === 'n8n-workflow' || rawType === 'api' || rawType === 'cli') {
    return rawType
  }
  if (rawType === 'batshit' || rawType === 'mcp_agent') {
    return 'n8n-workflow'
  }
  if (rawType === 'n8n') {
    return 'n8n-subnode'
  }
  return subagent?.webhookUrl || subagent?.webhook_url || subagent?.workflowName || subagent?.workflow_name
    ? 'n8n-workflow'
    : 'n8n-subnode'
}

function getSubagentTypeLabel(type) {
  if (type === 'api') return 'API Subagent'
  if (type === 'cli') return 'CLI Subagent'
  if (type === 'n8n-workflow') return 'n8n Workflow Subagent'
  return 'Subagent'
}

async function compileSubagentSystemPrompt(subagent) {
  const get = (key) => redis.get(key)
  const [promptRaw, descRaw] = await Promise.all([
    get('batshit:sub_system_prompt'),
    get('batshit:subagent_instructions')
  ])
  const sections = []
  if (promptRaw) sections.push(`==== BATSHIT SUB-AGENT SYSTEM PROMPT ====\n\n${promptRaw}`)

  let globalPrompt = ''
  try {
    const settings = await redis.json.get(`user:${userId}:settings`)
    globalPrompt = settings?.global_custom_system_prompt || ''
  } catch (err) {
    // fall back silently
  }
  if ((subagent.include_global_prompt === true || subagent.includeGlobalPrompt === true) && globalPrompt) {
    sections.push(`==== GLOBAL CUSTOM SYSTEM PROMPT ====\n\n${globalPrompt}`)
  }

  if (subagent.system_prompt) {
    sections.push(`==== SUBAGENT CUSTOM SYSTEM PROMPT ====\n\n${subagent.system_prompt}`)
  }

  const systemPrompt = sections.join('\n\n')
  const description = descRaw || ''
  return { systemPrompt, description }
}

async function listSubagentTools(agentId) {
  const agent = await loadAgent(agentId)
  if (!agent) {
    throw new Error(`Primary agent ${agentId} was not found`)
  }
  if (agent.user_id && agent.user_id !== userId) {
    throw new Error(`Primary agent ${agentId} is not owned by bridge user ${userId}`)
  }
  const ids = getAssignedSubagentIds(agent)
  const tools = []
  const usedKeys = new Set()
  for (const id of ids) {
    const sub = await loadSubagent(id)
    if (!sub) continue
    if (sub.user_id && sub.user_id !== userId) continue
    const subagentType = normalizeSubagentType(sub)
    if (!['n8n-workflow', 'api', 'cli'].includes(subagentType)) continue
    const display = sub.displayName || sub.name || id
    const webhook = sub.webhookUrl || sub.webhook_url || sub.workflowName || sub.workflow_name
    if (subagentType === 'n8n-workflow' && !webhook) continue
    const key = assertUniqueKey(safeName(sub.id || display, id), usedKeys, display)
    const compiled =
      subagentType === 'n8n-workflow'
        ? await compileSubagentSystemPrompt(sub)
        : { systemPrompt: '', description: '' }
    const description =
      sub.description ||
      compiled.description ||
      `Run ${display}, an assigned Batshit ${getSubagentTypeLabel(subagentType)}.`
    tools.push({
      key,
      subagentId: sub.id || id,
      subagentType,
      display,
      description,
      webhook,
      systemPrompt: compiled.systemPrompt,
      provider: sub.primary_model_provider || sub.settings?.primary_model_provider || null,
      model: sub.primary_model_name || sub.settings?.primary_model_name || null
    })
  }
  return tools
}

function resolveChatInput(params) {
  const value = params?.chatInput ?? params?.message ?? params?.input ?? ''
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

async function resolveSessionId(params) {
  const sessionIdFromArgsOrEnv =
    params?.sessionId ||
    params?.session_id ||
    params?._meta?.sessionId ||
    params?._meta?.session_id ||
    process.env.BATSHIT_SESSION_ID ||
    null
	  if (sessionIdFromArgsOrEnv) return sessionIdFromArgsOrEnv

	  try {
	    const sessionIds = await redis.sMembers(`codex_sessions:${userId}:${agentId}`)
	    if (sessionIds.length === 1) {
	      return sessionIds[0]
	    }
	    if (sessionIds.length > 1) {
	      return AMBIGUOUS_CODEX_SESSION
	    }
	    return null
	  } catch (error) {
	    return null
	  }
}

function resolveProjectPath(params) {
  return (
    params?.projectPath ||
    params?.project_path ||
    params?._meta?.projectPath ||
    params?._meta?.project_path ||
    process.env.BATSHIT_PROJECT_PATH ||
    null
  )
}

function parseResponseText(text) {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function extractErrorMessage(status, parsed) {
  if (!parsed) return `HTTP ${status}`
  if (typeof parsed === 'string') return `HTTP ${status}: ${parsed}`
  if (typeof parsed.error === 'string') return parsed.error
  if (parsed.error && typeof parsed.error.message === 'string') return parsed.error.message
  if (typeof parsed.message === 'string') return parsed.message
  return `HTTP ${status}: ${JSON.stringify(parsed)}`
}

async function callManagedSubagent(tool, params) {
  const chatInput = resolveChatInput(params)
  const resolvedSessionId = await resolveSessionId(params)
	  if (!resolvedSessionId) {
	    return {
	      error:
	        'Managed Subagent call needs a Batshit session ID. Start the CLI Primary Agent from an active Batshit chat session.'
	    }
	  }
	  if (resolvedSessionId === AMBIGUOUS_CODEX_SESSION) {
	    return {
	      error:
	        'Managed Subagent call could not choose a Batshit session because multiple Codex chats for this agent are running. Batshit passes the session through BATSHIT_SESSION_ID for normal runs; if this keeps happening, stop the parallel Codex run and try again.'
	    }
	  }
  if (!serviceToken) {
    return {
      error:
        'Managed Subagent bridge requires BATSHIT_TOKEN so Batshit can verify the local internal call.'
    }
  }

  const timeoutMs = normalizeTimeoutMs(params?.timeoutMs ?? params?.timeout_ms, MANAGED_SUBAGENT_TIMEOUT_MS)
  const body = {
    agentId,
    subagentId: tool.subagentId,
    sessionId: resolvedSessionId,
    chatInput,
    projectPath: resolveProjectPath(params),
    timeoutMs
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs + 5000)
  try {
    const res = await fetchFn(`${batshitBaseUrl}${MANAGED_SUBAGENT_ROUTE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source': 'batshit-cli-subagent-bridge',
        'x-batshit-service-token': serviceToken,
        'x-batshit-user-id': userId
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    clearTimeout(timeout)
    const text = await res.text()
    const parsed = parseResponseText(text)
    if (!res.ok || parsed?.success === false) {
      throw new Error(extractErrorMessage(res.status, parsed))
    }
    return {
      content: {
        ...parsed,
        subagentType: parsed?.subagentType || tool.subagentType,
        subagentId: parsed?.subagentId || tool.subagentId,
        subagentName: parsed?.subagentName || tool.display,
        toolSource:
          parsed?.toolSource ||
          (tool.subagentType === 'cli'
            ? 'managed-cli-subagent'
            : tool.subagentType === 'api'
              ? 'managed-api-subagent'
              : 'workflow-webhook')
      }
    }
  } catch (err) {
    clearTimeout(timeout)
    return { error: err.message || 'Managed Subagent call failed' }
  }
}

async function callSubagent(tool, params) {
  return callManagedSubagent(tool, params)
}

async function main() {
  await redis.connect()
  const server = new Server({
    name: 'batshit-subagent-bridge',
    version: '0.1.0'
  }, {
    capabilities: {
      tools: {}
    }
  })

  let cachedTools = []

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      cachedTools = await listSubagentTools(agentId)
      return {
        tools: cachedTools.map((t) => ({
          name: `subagent_${t.key}`,
          description: t.description || `Run Batshit subagent ${t.display}`,
          inputSchema: {
            type: 'object',
            properties: {
              chatInput: { type: 'string', description: 'Message to send to the subagent' }
            },
            required: ['chatInput']
          }
        }))
      }
    } catch (error) {
      console.error('[subagent-mcp] listTools failed', error)
      return { tools: [] }
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name || ''
    const key = name.replace(/^subagent_/, '')
    const tool = cachedTools.find((t) => t.key === key)
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Subagent ${name} not found or not listed` }]
      }
    }
    const result = await callSubagent(tool, normalizeToolArgs(request.params.arguments || {}))
    if (result.error) {
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }]
      }
    }
    return {
      content: [{ type: 'text', text: typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2) }]
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('[subagent-mcp] fatal error', err)
  process.exit(1)
})
