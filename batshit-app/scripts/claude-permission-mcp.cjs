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
const os = require('node:os')
const process = require('node:process')
const { randomUUID } = require('node:crypto')
const sdkRoot = path.join(__dirname, '..', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs')
const { Server } = require(path.join(sdkRoot, 'server', 'index.js'))
const { StdioServerTransport } = require(path.join(sdkRoot, 'server', 'stdio.js'))
const { CallToolRequestSchema, ListToolsRequestSchema } = require(path.join(sdkRoot, 'types.js'))
const { createClient } = require('redis')
// F-P7-10: one shutdown rule for every stdio bridge. This one holds an open Redis socket,
// so without it the process outlives its parent CLI forever as a PID-1 orphan.
const { installStdioLifecycle } = require(path.join(__dirname, 'lib', 'mcp-stdio-lifecycle.cjs'))

const APPROVAL_TOOL_NAME = 'batshit_permission_prompt'
const APPROVAL_TOOL_FULL_NAME =
  process.env.BATSHIT_PERMISSION_TOOL_NAME ||
  'mcp__batshit_gateway_claude-approvals__batshit_permission_prompt'
const DEFAULT_TIMEOUT_SECONDS = 60 * 10
/**
 * BL-496 (A5): how long a card waits for its answer, and so the card's own `expiresAt`. Ten
 * minutes: measured on Claude Code 2.1.280, the CLI keeps this MCP call open the full 600 s
 * (`claude-code-integration.md`, the approval section). The only other value is a test knob;
 * it can only shorten the wait, and only in a test run (`VITEST` or `NODE_ENV=test`), so an
 * app's own environment can never shorten a real approval.
 */
const IS_TEST_RUN = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test'
const TEST_WAIT_SECONDS = IS_TEST_RUN
  ? Number.parseInt(process.env.BATSHIT_TEST_CLAUDE_APPROVAL_WAIT_SECONDS || '', 10)
  : Number.NaN
const APPROVAL_WAIT_SECONDS =
  Number.isInteger(TEST_WAIT_SECONDS) && TEST_WAIT_SECONDS > 0 && TEST_WAIT_SECONDS < DEFAULT_TIMEOUT_SECONDS
    ? TEST_WAIT_SECONDS
    : DEFAULT_TIMEOUT_SECONDS
/**
 * BL-496 (A6): the words the model gets when nobody answered. Claude Code refuses a deny with
 * no `message` ("The permission prompt tool returned an invalid permission result", measured
 * on 2.1.280), so a deny always carries words.
 */
const UNANSWERED_DENY_MESSAGE =
  'Nobody answered this approval in 10 minutes, so it was denied. Do not try it again now. Tell the user what you need.'
const DENY_WITHOUT_REASON_MESSAGE = 'The user denied this tool call.'
/** A Redis failure inside the wait: not a person's deny and not an unanswered card. */
const WAIT_FAILED_DENY_MESSAGE =
  'Batshit could not read the answer to this approval, so it was denied. Do not try it again now. Tell the user the approval could not be read.'
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

function wildcardToRegex(pattern, { filePattern = false, literalPrefix = '' } = {}) {
  const escaped = escapeRegex(pattern)
  const withDouble = escaped.replace(/\\\*\\\*/g, '.*')
  const withSingle = withDouble.replace(/\\\*/g, '[^/]*')
  const glob = filePattern ? withSingle.replace(/\\\?/g, '[^/]') : withSingle
  return new RegExp(`^${escapeRegex(literalPrefix)}${glob}$`, 'i')
}

function matchRule(rule, toolName, toolInput) {
  const parsed = parseRule(rule)
  if (!parsed) return false
  const base = parsed.tool.toLowerCase()
  const name = toolName.toLowerCase()
  // Claude's Edit rules govern all file-editing tools, including notebook cells.
  if (base !== name && !(base === 'edit' && (name === 'write' || name === 'notebookedit'))) return false
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

  const filePath = extractFilePath(toolInput, toolName)
  if (!filePath) return false
  const fileTarget = filePath.replace(/\\/g, '/')
  const anchoredRule = parsed.pattern.startsWith('//') || parsed.pattern.startsWith('~/')
  const normalized = anchoredRule
    ? path.resolve(WORKDIR, fileTarget).replace(/\\/g, '/')
    : fileTarget
  // Claude uses // for an absolute path. A home prefix is literal even when the
  // actual home directory contains glob characters; only the rule suffix is a glob.
  const pattern = parsed.pattern.startsWith('//') ? parsed.pattern.slice(1)
    : parsed.pattern.startsWith('~/') ? parsed.pattern.slice(2) : parsed.pattern
  const literalPrefix = parsed.pattern.startsWith('~/')
    ? `${os.homedir().replace(/\\/g, '/').replace(/\/$/, '')}/` : ''
  try {
    return wildcardToRegex(pattern, { filePattern: true, literalPrefix }).test(normalized)
  } catch {
    return false
  }
}

function extractFilePath(toolInput, toolName) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  // Match the actual tool target before compatibility aliases. An unrelated
  // field must not hide a NotebookEdit's notebook_path or a Write's file_path.
  const fields = toolName.toLowerCase() === 'notebookedit'
    ? ['notebook_path', 'file_path', 'filePath', 'path', 'file']
    : ['file_path', 'filePath', 'path', 'file']
  for (const field of fields) {
    if (typeof toolInput[field] === 'string' && toolInput[field]) return toolInput[field]
  }
  return ''
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

function buildResponsePayload(approved, reason, toolInput) {
  if (approved) {
    const payload = { behavior: 'allow' }
    payload.updatedInput = toolInput
    return payload
  }
  const payload = { behavior: 'deny' }
  payload.message =
    typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : DENY_WITHOUT_REASON_MESSAGE
  return payload
}

function matchRules(rules, toolName, toolInput) {
  if (!rules || rules.length === 0) return false
  for (const rule of rules) {
    if (matchRule(rule, toolName, toolInput)) return true
  }
  return false
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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
  const filePath = extractFilePath(toolInput, toolName)
  const inAllowedDir = isEdit && filePath && isWithinAllowedDirs(filePath)

  if (PERMISSION_MODE === 'plan') {
    if (isRead || isWeb) return { decision: 'allow' }
    if (PLAN_ALLOW_TOOLS.has(toolName.toLowerCase())) return { decision: 'allow' }
    return { decision: 'deny', reason: 'Plan mode blocks edits/commands' }
  }

  if (isMcpTool && ALLOWED_MCP_TOOLS.has(toolName)) {
    return { decision: 'allow' }
  }

  if (PERMISSION_MODE === 'dontAsk') {
    if (allowed) return { decision: 'allow' }
    if (inAllowedDir) return { decision: 'allow' }
    if (autoAllow || isWeb) return { decision: 'allow' }
    return { decision: 'deny', reason: 'Auto-deny (dontAsk)' }
  }

  if (PERMISSION_MODE === 'acceptEdits') {
    // Claude Code already evaluated allowed rules and ordinary in-directory edits.
    // A request escalated here must reach the user: our wildcard/path checks cannot
    // override Claude's compound-command or protected-file decision (BL-497).
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
    // BL-496 (A6): the wait ran out. A typed expiry, not a human's deny.
    if (!result || !result.element) {
      return { approved: false, expired: true, expiryReason: 'unanswered', reason: UNANSWERED_DENY_MESSAGE }
    }
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
    return { approved: false, expired: true, expiryReason: 'wait_failed', reason: WAIT_FAILED_DENY_MESSAGE }
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
              tool_name: { type: 'string', minLength: 1, description: 'Claude Code tool requesting permission' },
              input: { type: 'object', description: 'Exact input Claude Code is asking to run' },
              tool_use_id: { type: 'string', minLength: 1, description: 'Claude Code tool use identifier' }
            },
            required: ['tool_name', 'input', 'tool_use_id'],
            additionalProperties: true
          }
        }
      ]
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request?.params?.arguments || {}
    const dispatchedToolName = request?.params?.name
    const callback = args && typeof args === 'object' ? args : {}
    const toolName = typeof callback.tool_name === 'string' ? callback.tool_name.trim() : ''
    const toolUseId = typeof callback.tool_use_id === 'string' ? callback.tool_use_id.trim() : ''
    const toolInput = callback.input
    const resolvedSessionId = sessionId

    if (dispatchedToolName !== APPROVAL_TOOL_NAME || !resolvedSessionId || !toolName || !toolUseId || !isPlainObject(toolInput)) {
      // Fail CLOSED: a permission gate without its session context cannot ask
      // the user, so it must deny — never silently allow (G-0078).
      console.error('[claude-approval-mcp] Invalid callback or missing session id; denying tool approval', {
        toolName,
        messageId
      })
      const payload = buildResponsePayload(
        false,
        'Tool approval denied: the callback was malformed, unknown, or missing launch session context.',
        toolInput
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structured_content: payload
      }
    }

    const decision = evaluateDecision(toolName, toolInput)

    if (decision.decision !== 'prompt') {
      const payload = buildResponsePayload(decision.decision === 'allow', decision.reason, toolInput)
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structured_content: payload
      }
    }

    const approvalId = randomUUID()
    const presentationArgs = { approvalId, toolName, toolInput, toolUseId }
    // BL-496 (A5): one clock. The card ends when this wait ends, and says when.
    const requestedAtMs = Date.now()
    const requestedAt = new Date(requestedAtMs).toISOString()
    const expiresAt = new Date(requestedAtMs + APPROVAL_WAIT_SECONDS * 1000).toISOString()
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
      args: presentationArgs,
      requestedAt,
      expiresAt
    })

    const key = `toolApprovalResponse:${resolvedSessionId}:${approvalId}`
    const approvalResult = await waitForApproval(key, APPROVAL_WAIT_SECONDS)
    const payload = buildResponsePayload(approvalResult.approved, approvalResult.reason, toolInput)
    await publishSseEvent(resolvedSessionId, {
      type: 'tool-result',
      ...toolEventBase,
      result: payload,
      // BL-496 (A6): the card's end, typed: a human's answer, or a wait nobody answered.
      approvalStatus: approvalResult.approved ? 'approved' : approvalResult.expired ? 'expired' : 'denied',
      ...(approvalResult.expired ? { expiryReason: approvalResult.expiryReason } : {})
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structured_content: payload
    }
  })

  const transport = new StdioServerTransport()
  await server.connect(transport)

  // AFTER connect: the transport's `data` listener is what puts stdin into flowing mode, and
  // a paused stream never emits `end`.
  installStdioLifecycle({
    logPrefix: '[claude-approval-mcp]',
    onShutdown: async () => {
      if (redis.isOpen) await redis.quit()
    }
  })
}

main().catch((error) => {
  console.error('[claude-approval-mcp] Failed to start', error)
  process.exit(1)
})
