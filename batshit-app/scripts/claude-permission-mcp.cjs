#!/usr/bin/env node
/**
 * Claude Permission Prompt MCP Server (stdio)
 *
 * Exposes a single MCP tool used by Claude Code CLI to resolve permission
 * prompts in non-interactive mode. The CLI calls this tool whenever a tool
 * requires approval; we wait for the user response via Redis and return
 * allow/deny back to Claude.
 */

const path = require('node:path')
const process = require('node:process')
const sdkRoot = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs')
const { Server } = require(path.join(sdkRoot, 'server', 'index.js'))
const { StdioServerTransport } = require(path.join(sdkRoot, 'server', 'stdio.js'))
const { CallToolRequestSchema, ListToolsRequestSchema } = require(path.join(sdkRoot, 'types.js'))
const { createClient } = require('redis')

const APPROVAL_TOOL_NAME = 'batshit_permission_prompt'
const APPROVAL_TOOL_FULL_NAME =
  process.env.BATSHIT_PERMISSION_TOOL_NAME ||
  'mcp__batshit_gateway_claude-approvals__batshit_permission_prompt'
const DEFAULT_TIMEOUT_SECONDS = 60 * 10
const SSE_CHANNEL_PREFIX = 'batshit:sse:'
const PERMISSION_MODE = process.env.BATSHIT_CLAUDE_PERMISSION_MODE || 'default'
const WORKDIR = process.env.BATSHIT_CLAUDE_WORKDIR || process.cwd()

const AUTO_ALLOW_TOOLS = parseJsonList(process.env.BATSHIT_CLAUDE_AUTO_ALLOW_TOOLS)
const ALLOWED_TOOLS = parseJsonList(process.env.BATSHIT_CLAUDE_ALLOWED_TOOLS)
const DENIED_TOOLS = parseJsonList(process.env.BATSHIT_CLAUDE_DENIED_TOOLS)
const ALLOWED_MCP_TOOLS = new Set(parseJsonList(process.env.BATSHIT_CLAUDE_ALLOWED_MCP_TOOLS))
const PLAN_ALLOW_TOOLS = new Set(
  parseJsonList(process.env.BATSHIT_CLAUDE_PLAN_ALLOW_TOOLS).map((entry) =>
    typeof entry === 'string' ? entry.toLowerCase() : ''
  )
)
const ALLOWED_DIRS = parseJsonList(process.env.BATSHIT_CLAUDE_ALLOWED_DIRS)

const sessionId = process.env.BATSHIT_SESSION_ID || null
const messageId = process.env.BATSHIT_MESSAGE_ID || null

const redisUrl = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING || 'redis://localhost:6379'
const redisPassword = process.env.REDIS_PASSWORD || undefined
const redis = createClient({ url: redisUrl, password: redisPassword })
redis.on('error', (err) => console.error('[claude-approval-mcp] Redis error', err))

function parseJsonList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry.trim().length)
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.filter((entry) => typeof entry === 'string' && entry.trim().length)
    }
  } catch {
    // ignore JSON parse errors
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length)
}

function normalizeToolName(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function parseRule(rule) {
  if (!rule || typeof rule !== 'string') return null
  const trimmed = rule.trim()
  if (!trimmed) return null
  const match = trimmed.match(/^([^(]+)\((.*)\)$/)
  if (!match) return { tool: trimmed, pattern: null }
  return { tool: match[1].trim(), pattern: match[2].trim() }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function wildcardToRegex(pattern) {
  const escaped = escapeRegex(pattern)
  const withDouble = escaped.replace(/\\\*\\\*/g, '.*')
  const withSingle = withDouble.replace(/\\\*/g, '[^/]*')
  return new RegExp(`^${withSingle}$`, 'i')
}

function matchRule(rule, toolName, toolInput) {
  const parsed = parseRule(rule)
  if (!parsed) return false
  const base = parsed.tool.toLowerCase()
  const name = toolName.toLowerCase()
  if (base !== name) return false
  if (!parsed.pattern) return true

  if (base === 'bash') {
    const command = typeof toolInput?.command === 'string' ? toolInput.command.trim() : ''
    if (!command) return false
    try {
      return wildcardToRegex(parsed.pattern).test(command)
    } catch {
      return command.startsWith(parsed.pattern)
    }
  }

  const filePath = extractFilePath(toolInput)
  if (!filePath) return false
  const normalized = filePath.replace(/\\/g, '/')
  try {
    return wildcardToRegex(parsed.pattern).test(normalized)
  } catch {
    return normalized.startsWith(parsed.pattern)
  }
}

function resolveToolInput(args) {
  if (!args || typeof args !== 'object') return undefined
  return (
    args.toolInput ??
    args.tool_input ??
    args.input ??
    args.arguments ??
    args.params ??
    undefined
  )
}

function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  return (
    toolInput.filePath ||
    toolInput.file_path ||
    toolInput.path ||
    toolInput.file ||
    ''
  )
}

function isWithinAllowedDirs(filePath) {
  if (!filePath || ALLOWED_DIRS.length === 0) return false
  const resolvedFile = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.normalize(path.resolve(WORKDIR, filePath))
  return ALLOWED_DIRS.some((dir) => {
    if (!dir) return false
    const resolvedDir = path.normalize(path.isAbsolute(dir) ? dir : path.resolve(WORKDIR, dir))
    if (resolvedFile === resolvedDir) return true
    return resolvedFile.startsWith(`${resolvedDir}${path.sep}`)
  })
}

function resolveApprovalId(request, args) {
  if (args && typeof args.approvalId === 'string' && args.approvalId.trim().length > 0) {
    return args.approvalId.trim()
  }
  if (args && typeof args.requestId === 'string' && args.requestId.trim().length > 0) {
    return args.requestId.trim()
  }
  if (args && typeof args.id === 'string' && args.id.trim().length > 0) {
    return args.id.trim()
  }
  if (request && typeof request.id === 'string' && request.id.trim().length > 0) {
    return request.id.trim()
  }
  return `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function buildResponsePayload(approved, reason, args) {
  if (approved) {
    const payload = { behavior: 'allow' }
    const updatedInput = resolveToolInput(args)
    if (updatedInput && typeof updatedInput === 'object') {
      payload.updatedInput = updatedInput
    }
    return payload
  }
  const payload = { behavior: 'deny' }
  if (typeof reason === 'string' && reason.trim().length > 0) {
    payload.message = reason.trim()
  }
  return payload
}

function matchRules(rules, toolName, toolInput) {
  if (!rules || rules.length === 0) return false
  for (const rule of rules) {
    if (matchRule(rule, toolName, toolInput)) return true
  }
  return false
}

function getToolName(args) {
  return normalizeToolName(
    args?.toolName ||
      args?.tool ||
      args?.name ||
      args?.tool_name ||
      args?.toolNameRaw ||
      ''
  )
}

function evaluateDecision(toolName, toolInput) {
  const lower = toolName.toLowerCase()
  const isRead = lower === 'read'
  const isWeb = lower === 'websearch' || lower === 'webfetch'
  const isEdit = lower === 'edit' || lower === 'write' || lower === 'notebookedit'
  const isMcpTool = toolName.startsWith('mcp__') || toolName.startsWith('mcp.')

  const denied = matchRules(DENIED_TOOLS, toolName, toolInput)
  if (denied) return { decision: 'deny', reason: 'Denied by rule' }

  const allowed = matchRules(ALLOWED_TOOLS, toolName, toolInput)
  const autoAllow =
    AUTO_ALLOW_TOOLS.some((entry) => entry.toLowerCase() === lower) || isRead
  const filePath = extractFilePath(toolInput)
  const inAllowedDir = isEdit && filePath && isWithinAllowedDirs(filePath)

  if (isMcpTool && ALLOWED_MCP_TOOLS.has(toolName)) {
    return { decision: 'allow' }
  }

  if (PERMISSION_MODE === 'plan') {
    if (isRead || isWeb) return { decision: 'allow' }
    if (PLAN_ALLOW_TOOLS.has(toolName.toLowerCase())) return { decision: 'allow' }
    return { decision: 'deny', reason: 'Plan mode blocks edits/commands' }
  }

  if (PERMISSION_MODE === 'dontAsk') {
    if (allowed) return { decision: 'allow' }
    if (inAllowedDir) return { decision: 'allow' }
    if (autoAllow || isWeb) return { decision: 'allow' }
    return { decision: 'deny', reason: 'Auto-deny (dontAsk)' }
  }

  if (PERMISSION_MODE === 'acceptEdits') {
    if (allowed) return { decision: 'allow' }
    if (inAllowedDir) return { decision: 'allow' }
    if (autoAllow) return { decision: 'allow' }
    return { decision: 'prompt' }
  }

  if (PERMISSION_MODE === 'bypassPermissions') {
    return { decision: 'allow' }
  }

  if (autoAllow || isWeb) return { decision: 'allow' }
  return { decision: 'prompt' }
}

async function publishSseEvent(sessionId, payload) {
  if (!sessionId) return
  try {
    await redis.publish(`${SSE_CHANNEL_PREFIX}${sessionId}`, JSON.stringify(payload))
  } catch (error) {
    console.error('[claude-approval-mcp] Failed to publish SSE event', error)
  }
}

async function waitForApproval(key, timeoutSeconds) {
  const timeout = Number.isFinite(timeoutSeconds) ? timeoutSeconds : DEFAULT_TIMEOUT_SECONDS
  try {
    const result = await redis.brPop(key, timeout)
    if (!result || !result.element) return { approved: false }
    const raw = result.element
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'boolean') return { approved: parsed }
      if (parsed && typeof parsed === 'object') {
        return {
          approved: parsed.approved === true,
          reason: typeof parsed.reason === 'string' ? parsed.reason : undefined
        }
      }
    } catch {
      // ignore JSON parse errors
    }
    const normalized = String(raw).trim().toLowerCase()
    if (normalized === 'allow' || normalized === 'approved' || normalized === 'true') {
      return { approved: true }
    }
    if (normalized === 'deny' || normalized === 'denied' || normalized === 'false') {
      return { approved: false }
    }
    return { approved: false, reason: String(raw) }
  } catch (error) {
    console.error('[claude-approval-mcp] Approval wait failed', error)
    return { approved: false, reason: 'Approval wait failed' }
  }
}

async function main() {
  await redis.connect()

  const server = new Server(
    { name: 'batshit-claude-approvals', version: '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: APPROVAL_TOOL_NAME,
          description: 'batshit: Resolve Claude Code permission prompts (returns allow/deny).',
          inputSchema: {
            type: 'object',
            properties: {
              approvalId: { type: 'string', description: 'Optional approval request id' },
              toolName: { type: 'string', description: 'Tool requesting permission' },
              toolInput: { type: 'object', description: 'Input for the tool requesting permission' },
              prompt: { type: 'string', description: 'Prompt shown to the user' },
              sessionId: { type: 'string', description: 'Optional session id override' }
            },
            additionalProperties: true
          }
        }
      ]
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request?.params?.arguments || {}
    const approvalId = resolveApprovalId(request, args)
    const resolvedSessionId =
      (args && typeof args.sessionId === 'string' && args.sessionId.trim().length > 0
        ? args.sessionId.trim()
        : null) ||
      sessionId

    if (!resolvedSessionId) {
      // Fail CLOSED: a permission gate without its session context cannot ask
      // the user, so it must deny — never silently allow (G-0078).
      console.error('[claude-approval-mcp] Missing session id; denying tool approval', {
        approvalId,
        messageId
      })
      const payload = buildResponsePayload(
        false,
        'Tool approval denied: the approval bridge received no session id, so the user cannot be asked. Re-run the message; if this persists, the Claude lane is not propagating BATSHIT_SESSION_ID.',
        args
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structured_content: payload
      }
    }

    const toolArgs = args && typeof args === 'object' ? args : {}
    const toolName = getToolName(toolArgs)
    const toolInput = resolveToolInput(toolArgs) ?? toolArgs
    const decision = evaluateDecision(toolName, toolInput)

    if (decision.decision !== 'prompt') {
      const payload = buildResponsePayload(decision.decision === 'allow', decision.reason, toolArgs)
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structured_content: payload
      }
    }

    const toolEventBase = {
      sessionId: resolvedSessionId,
      messageId,
      toolCallId: approvalId,
      toolName: APPROVAL_TOOL_FULL_NAME
    }
    await publishSseEvent(resolvedSessionId, {
      type: 'tool_start',
      ...toolEventBase
    })
    await publishSseEvent(resolvedSessionId, {
      type: 'tool-call',
      ...toolEventBase,
      args: toolArgs
    })

    const key = `toolApprovalResponse:${resolvedSessionId}:${approvalId}`
    const approvalResult = await waitForApproval(key, DEFAULT_TIMEOUT_SECONDS)
    const payload = buildResponsePayload(approvalResult.approved, approvalResult.reason, toolArgs)
    await publishSseEvent(resolvedSessionId, {
      type: 'tool-result',
      ...toolEventBase,
      result: payload
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structured_content: payload
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((error) => {
  console.error('[claude-approval-mcp] Failed to start', error)
  process.exit(1)
})
