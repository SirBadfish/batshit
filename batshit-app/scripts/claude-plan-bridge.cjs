#!/usr/bin/env node
'use strict'

/**
 * SA-139 (D2, D4): the Claude plan connection's bridge. Claude Code starts this one file in four roles,
 * each with the run folder as its last argument:
 *
 *   mcp    the run's only MCP server (`batshit`): `tools/list` from Batshit's prepared list, and each
 *          `tools/call` waits for the result Batshit releases for that exact call.
 *   pre    the PreToolUse hook: asks Batshit to admit the call (its native `tool_use_id`, name and input
 *          must match a call Claude streamed), then allows it and tags its input with that id, so the MCP
 *          call can be matched to it.
 *   batch  the PostToolBatch hook: waits until Batshit starts the next model step, then hands Claude
 *          that step's note, or stops the run (exit 2) when Batshit saw an integrity problem.
 *   gate   the UserPromptSubmit hook: lets a prompt through only after Batshit's startup checks passed.
 *   session the SessionStart hook: tells Batshit that Claude Code runs its hooks, before any prompt.
 *
 * Everything goes over the run's own Unix socket (`<run>/s`), proved with the run's secret, which lives
 * in a 0600 file (`<run>/secret`), never on a command line (a blocked prompt echoes the command line).
 * Only environment variable NAMES ever leave this process, never values: hooks see Claude Code's own
 * messaging token in their environment.
 */

const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const readline = require('node:readline')

const role = process.argv[2]
const runDir = process.argv[3]
/** The field the PreToolUse hook adds to a call's input; the MCP server removes it again. */
const CALL_TAG = '__batshit_call'
/** Names a gate refuses to see: each one can move Claude Code off the plan sign-in. */
const ROUTE_NAME = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH)/

/** Hook roles exit 2 (Claude Code's "block") on any failure, so they block even without `onFailure`. */
const BLOCKING_ROLES = new Set(['gate', 'pre', 'batch'])

function fail(message) {
  process.stderr.write(`claude-plan bridge (${role}): ${message}\n`)
  process.exit(BLOCKING_ROLES.has(role) ? 2 : 1)
}

if (!runDir || !path.isAbsolute(runDir)) fail('no run folder')

function readSecret() {
  return fs.readFileSync(path.join(runDir, 'secret'), 'utf8').trim()
}

/** One request, one answer line. A closed or refused socket is an error: the hook fails closed. */
function ask(request) {
  return new Promise((resolve, reject) => {
    let secret
    try { secret = readSecret() } catch (error) { reject(error); return }
    const conn = net.createConnection(path.join(runDir, 's'))
    let buffer = ''
    let answered = false
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(JSON.stringify({ ...request, secret }) + '\n'))
    conn.on('data', chunk => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      answered = true
      conn.end()
      try { resolve(JSON.parse(buffer.slice(0, end))) } catch (error) { reject(error) }
    })
    conn.on('error', error => { if (!answered) reject(error) })
    conn.on('close', () => { if (!answered) reject(new Error('Batshit closed the run')) })
  })
}

function readHookInput() {
  return JSON.parse(fs.readFileSync(0, 'utf8'))
}

async function gate() {
  const event = readHookInput()
  const envNames = Object.keys(process.env).filter(name => ROUTE_NAME.test(name))
  const answer = await ask({
    op: 'gate',
    prompt: typeof event.prompt === 'string' ? event.prompt : null,
    claudePid: process.env.CLAUDE_PID ?? null,
    parentPid: process.ppid,
    envNames
  })
  if (answer && answer.decision === 'allow') return
  process.stdout.write(JSON.stringify({ decision: 'block', reason: String(answer?.reason || 'Batshit refused this run before any model call.') }))
}

async function session() {
  readHookInput()
  await ask({ op: 'session' })
}

async function pre() {
  const event = readHookInput()
  const answer = await ask({ op: 'pre', id: event.tool_use_id ?? null, name: event.tool_name ?? null, input: event.tool_input ?? null })
  if (!answer || answer.decision !== 'allow') {
    process.stderr.write(String(answer?.reason || 'Batshit refused this call. Nothing ran.'))
    process.exit(2)
  }
  const input = event.tool_input && typeof event.tool_input === 'object' && !Array.isArray(event.tool_input) ? event.tool_input : {}
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, [CALL_TAG]: event.tool_use_id } }
  }))
}

async function batch() {
  const event = readHookInput()
  const ids = Array.isArray(event.tool_calls) ? event.tool_calls.map(call => call?.tool_use_id ?? null) : []
  const answer = await ask({ op: 'batch', ids })
  if (answer && answer.block) {
    process.stderr.write(String(answer.reason || 'Batshit stopped this run.'))
    process.exit(2)
  }
  if (answer && typeof answer.note === 'string' && answer.note) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: answer.note } }))
  }
}

function mcp() {
  const send = message => process.stdout.write(JSON.stringify(message) + '\n')
  const errorResult = (id, text) => send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } })
  let relisted = null
  const reader = readline.createInterface({ input: process.stdin })
  reader.on('line', async line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const { id, method, params } = message
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'batshit', version: '1.0.0' }
      } })
    }
    if (method === 'tools/list') {
      try {
        const answer = await ask({ op: 'tools' })
        send({ jsonrpc: '2.0', id, result: { tools: Array.isArray(answer?.tools) ? answer.tools : [] } })
      } catch (error) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: `Batshit's tool list is unavailable: ${error?.message || error}` } })
      }
      if (relisted) { const done = relisted; relisted = null; done() }
      return
    }
    if (method === 'tools/call') {
      const raw = params?.arguments
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return errorResult(id, 'Batshit could not read this call. Nothing ran.')
      const { [CALL_TAG]: callId, ...args } = raw
      try {
        const metaId = params?._meta?.['claudecode/toolUseId']
        const answer = await ask({ op: 'call', id: typeof callId === 'string' ? callId : null, metaId: typeof metaId === 'string' ? metaId : null, name: params?.name ?? null, args })
        if (answer && answer.toolsChanged) {
          // D8: Claude Code re-reads the list before it sees this result, so the next model call has it.
          const seen = new Promise(resolve => { relisted = resolve; setTimeout(resolve, 5000).unref() })
          send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
          await seen
        }
        const result = answer?.result
        if (!result || !Array.isArray(result.content)) return errorResult(id, 'Batshit sent no result for this call.')
        return send({ jsonrpc: '2.0', id, result: { isError: Boolean(result.isError), content: result.content } })
      } catch (error) {
        return errorResult(id, `Batshit's bridge could not reach the run: ${error?.message || error}`)
      }
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  })
  // After the reader starts stdin flowing, so stdin end can fire (Claude Plan Connection FM).
  require(path.join(__dirname, 'lib', 'mcp-stdio-lifecycle.cjs')).installStdioLifecycle({ logPrefix: '[claude-plan-bridge]' })
}

const roles = { gate, pre, batch, session }
if (role === 'mcp') mcp()
else if (roles[role]) roles[role]().catch(error => fail(error?.message || String(error)))
else fail('unknown role')
