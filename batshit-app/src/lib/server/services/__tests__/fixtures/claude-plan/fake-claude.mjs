#!/usr/bin/env node
// SA-139 P2 test double for Claude Code 2.1.296 in `-p` stream-json mode. It speaks the same wire as the
// real binary (shapes copied from recorded real events, `recorded/*.jsonl`; `fakeShapes.test.ts` compares
// them) and it really runs what the real binary runs for Batshit: the `--settings` hooks in exec form
// (UserPromptSubmit, PreToolUse, PostToolBatch) and the `--mcp-config` stdio MCP server, so the production
// bridge, socket and admission code are exercised end to end with zero model calls.
//
// The script it plays is `scenario.json` in its working folder; it appends what it saw to `fake-log.jsonl`
// there. Dispatch follows the pin: a call starts at its tool_use block's stop, consecutive read-only calls
// run together, anything else one at a time.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
const cwd = process.cwd()
const scenario = existsSync(path.join(cwd, 'scenario.json')) ? JSON.parse(readFileSync(path.join(cwd, 'scenario.json'), 'utf8')) : {}
const VERSION = scenario.version ?? '2.1.296'
const log = (entry) => appendFileSync(path.join(cwd, 'fake-log.jsonl'), JSON.stringify({ at: Date.now(), ...entry }) + '\n')

if (argv[0] === '--version') { process.stdout.write(`${VERSION} (Claude Code)\n`); process.exit(0) }
// The sign-in read comes as `--setting-sources "" auth status --json` (S11), as on the real pin; a bare `auth status` works there too.
const authArgs = argv[0] === '--setting-sources' ? argv.slice(2) : argv
if (authArgs[0] === 'auth' && authArgs[1] === 'status') {
  process.stdout.write(JSON.stringify(scenario.authStatus ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.com', subscriptionType: 'max' }))
  process.exit(scenario.authStatus?.loggedIn === false ? 1 : 0)
}

const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
const sessionId = randomUUID()
if (scenario.ignoreTerm) process.on('SIGTERM', () => log({ kind: 'sigterm-ignored' }))
// The messaging socket the real binary keeps at /tmp/cc-socks/<pid>.sock: a real one here, in the project.
let messagingSocket = `/tmp/cc-socks/${process.pid}.sock`
let messagingServer = null
if (scenario.messagingSocket) {
  mkdirSync(path.join(cwd, 'cc-socks'), { recursive: true })
  messagingSocket = path.join(cwd, 'cc-socks', `${process.pid}.sock`)
  messagingServer = createServer(() => undefined)
  await new Promise(resolve => messagingServer.listen(messagingSocket, resolve))
}
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'))
log({ kind: 'start', argv, env: process.env, pid: process.pid, settings, systemPrompt: readFileSync(flag('--system-prompt-file'), 'utf8') })
const mcpConfig = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'))
const model = flag('--model') ?? 'claude-sonnet-5-5'
const out = (event) => process.stdout.write(JSON.stringify(event) + '\n')
const stream = (event, messageId) => out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), ...(messageId ? { api_message_id: messageId } : {}) })
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
// Entries of the pin's real `initialize` model list (recorded 2026-10-26).
const ALL_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']
const MODELS = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', supportsEffort: true, supportedEffortLevels: ALL_EFFORT },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportsEffort: true, supportedEffortLevels: ALL_EFFORT },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', supportsEffort: true, supportedEffortLevels: ALL_EFFORT },
  { value: 'claude-haiku-4-5-20251001', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'claude-opus-4-6', resolvedModel: 'claude-opus-4-6', displayName: 'Opus 4.6', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] }
]

// ---- hooks (exec form, as the real binary runs them) ----
function runHook(hook, input) {
  return new Promise(resolve => {
    const child = spawn(hook.command, hook.args ?? [], { env: { ...process.env, ...(scenario.hookEnvExtra ?? {}), CLAUDE_PID: String(process.pid), CLAUDE_CODE_MESSAGING_TOKEN: 'fake-token-never-forwarded' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: null, stdout, stderr, timedOut: true }) }, (hook.timeout ?? 600) * 1000)
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: '/dev/null', cwd, permission_mode: 'dontAsk', ...input }))
  })
}
const hooksFor = (event, toolName) => (settings.hooks?.[event] ?? []).filter(group => !group.matcher || (toolName && new RegExp(`^(${group.matcher})$`).test(toolName))).flatMap(group => group.hooks)
/** Returns { blocked, reason, json }: exit 2 blocks; another failure blocks only with onFailure "block". */
async function hookOutcome(event, input, toolName) {
  for (const hook of hooksFor(event, toolName)) {
    // Written before the hook runs (appendFileSync), so it survives a kill while the hook waits.
    log({ kind: 'hook-start', event, toolUseId: input?.tool_use_id ?? null })
    const result = await runHook(hook, { hook_event_name: event, ...input })
    log({ kind: 'hook', event, code: result.code, stdout: result.stdout.slice(0, 2000), stderr: result.stderr.slice(0, 500) })
    if (result.code === 2) return { blocked: true, reason: result.stderr }
    if (result.code !== 0) { if (hook.onFailure === 'block') return { blocked: true, reason: `hook failed: ${result.stderr}` }; continue }
    let json = null
    try { json = result.stdout.trim() ? JSON.parse(result.stdout) : null } catch { if (hook.onFailure === 'block') return { blocked: true, reason: 'invalid JSON' } }
    if (json?.decision === 'block') return { blocked: true, reason: json.reason, json }
    if (json) return { blocked: false, json }
  }
  return { blocked: false, json: null }
}

// ---- the MCP server ----
const server = mcpConfig.mcpServers?.batshit
const mcp = spawn(server.command, server.args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
let nextId = 1
const pending = new Map()
let listChangedSeen = 0
createInterface({ input: mcp.stdout }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'notifications/tools/list_changed') { listChangedSeen++; void rpc('tools/list').then(r => { mcpTools = r.result.tools }); return }
  const waiter = pending.get(message.id)
  if (waiter) { pending.delete(message.id); waiter(message) }
})
mcp.stderr.on('data', d => log({ kind: 'mcp-stderr', text: String(d) }))
function rpc(method, params) {
  const id = nextId++
  return new Promise(resolve => { pending.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
}
// The pin probes `server/discover` first and then initializes with protocol 2025-11-25 (recorded).
log({ kind: 'discover', answer: await rpc('server/discover', {}) })
await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: { roots: { listChanged: true } }, clientInfo: { name: 'claude-code', version: VERSION } })
mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
let mcpTools = (await rpc('tools/list')).result?.tools ?? []
log({ kind: 'tools', tools: mcpTools })
// SessionStart runs before stdin is read (P0 §4); a policy that turns hooks off skips it.
if (!scenario.sessionHookSkipped) await hookOutcome('SessionStart', { source: 'startup' })

// ---- stdin ----
const lines = createInterface({ input: process.stdin })
const inbox = []
let inboxWaiter = null
let stdinEnded = false
lines.on('line', line => { const message = JSON.parse(line); if (inboxWaiter) { const w = inboxWaiter; inboxWaiter = null; w(message) } else inbox.push(message) })
lines.on('close', () => { stdinEnded = true; if (inboxWaiter) { const w = inboxWaiter; inboxWaiter = null; w(null) } })
const nextInput = () => inbox.length ? Promise.resolve(inbox.shift()) : stdinEnded ? Promise.resolve(null) : new Promise(r => { inboxWaiter = r })

function initEvent() {
  return { type: 'system', subtype: 'init', cwd, session_id: sessionId, tools: [...mcpTools.map(t => `mcp__batshit__${t.name}`), ...(scenario.extraInitTools ?? [])],
    mcp_servers: [{ name: 'batshit', status: 'connected', source: 'dynamic' }], model: scenario.initModel ?? model, permissionMode: scenario.permissionMode ?? flag('--permission-mode'),
    apiKeySource: scenario.apiKeySource ?? 'none', claude_code_version: scenario.initVersion ?? VERSION, output_style: 'default', uuid: randomUUID(), messaging_socket_path: messagingSocket }
}
function resultEvent(extra) {
  return { type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: '', stop_reason: 'end_turn', session_id: sessionId, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, uuid: randomUUID(), ...extra }
}

// --replay-user-messages: each user message Claude Code takes in is written back, marked isReplay.
function replayUser(content) {
  if (!argv.includes('--replay-user-messages')) return
  out({ type: 'user', message: { role: 'user', content }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), timestamp: new Date().toISOString(), isReplay: true })
}

// ---- one model call ----
let modelCalls = 0
async function modelCall(turn) {
  modelCalls++
  log({ kind: 'model-call', n: modelCalls })
  out({ type: 'system', subtype: 'status', status: 'requesting', session_id: sessionId, uuid: randomUUID() })
  // An API refusal (2.1.296's shape): no message streams; an optional rejected rate-limit event, the
  // assistant error message, then the turn's `result` (written by the main loop).
  if (turn.apiError) {
    // rate_limit_info carries status and isUsingOverage (the full form also overageStatus); a request
    // served from extra usage also reads "rejected", with isUsingOverage true.
    // A refused state, then a retry: the retry's own answer is what the turn ends on.
    if (turn.apiError.retryAfterRejected) {
      out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793120400, rateLimitType: 'five_hour', isUsingOverage: false }, uuid: randomUUID(), session_id: sessionId })
      out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 5, error_status: 529, error: 'overloaded', session_id: sessionId, uuid: randomUUID() })
    }
    if (turn.apiError.rateLimit) out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793120400, rateLimitType: 'five_hour', isUsingOverage: false, ...(typeof turn.apiError.rateLimit === 'object' ? turn.apiError.rateLimit : {}) }, uuid: randomUUID(), session_id: sessionId })
    out({ type: 'assistant', message: { model: '<synthetic>', id: randomUUID(), type: 'message', role: 'assistant', content: [{ type: 'text', text: turn.apiError.text }] }, is_api_error_message: true, ...(turn.apiError.status ? { api_error_status: turn.apiError.status } : {}), ...(turn.apiError.kind ? { api_error: turn.apiError.kind } : {}), session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID() })
    return { calls: [], dispatched: [], apiError: turn.apiError }
  }
  if (turn.resultSubtype) return { calls: [], dispatched: [], resultSubtype: turn.resultSubtype }
  const attempts = turn.retryAfterIndex !== undefined ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const id = `msg_fake_${modelCalls}_${attempt}`
    // `scenario.noUsage` (SA-139 P4): Claude Code reports no usage, so the count stays unknown, never zero.
    stream({ type: 'message_start', message: { model, id, type: 'message', role: 'assistant', content: [], stop_reason: null, ...(scenario.noUsage ? {} : { usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 1 } }) } }, id)
    if (turn.stallMs) await sleep(turn.stallMs)
    const calls = []
    const dispatched = []
    for (const [index, block] of (turn.blocks ?? []).entries()) {
      if (attempt === 0 && turn.retryAfterIndex === index) {
        out({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 5, error_status: 529, error: 'overloaded', session_id: sessionId, uuid: randomUUID() })
        break
      }
      if (block.type === 'text') {
        stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, id)
        for (const piece of block.text.match(/.{1,5}/gs) ?? []) stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }, id)
        stream({ type: 'content_block_stop', index }, id)
      } else if (block.type === 'thinking') {
        stream({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } }, id)
        stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.text } }, id)
        stream({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } }, id)
        stream({ type: 'content_block_stop', index }, id)
      } else if (block.type === 'tool_use') {
        const callId = block.id ?? `toolu_fake_${modelCalls}_${index}_${attempt}`
        stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: callId, name: block.name, input: {}, caller: { type: 'direct' } } }, id)
        const json = JSON.stringify(block.input ?? {})
        stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '' } }, id)
        stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } }, id)
        out({ type: 'assistant', message: { model, id, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: callId, name: block.name, input: block.input ?? {} }] }, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID() })
        // As the pin answers a call to a name none of its tools has (recorded/misnamed, BL-2368): its own error
        // result at once, before the block's stop, with no hook and no MCP call. `unlisted-pre` and
        // `unlisted-mcp` stand for a Claude Code that tried to run such a call; the other faults for any
        // other record of it.
        const listed = block.name === 'EndConversation' || mcpTools.some(t => `mcp__batshit__${t.name}` === block.name)
        const ownAnswer = !listed && block.fault !== 'unlisted-pre' && block.fault !== 'unlisted-mcp'
        const noSuchTool = `<tool_use_error>Error: No such tool available: ${block.name}</tool_use_error>`
        // `lateRecord` stands for an executor that answers it only after a write call queued ahead of it (inferred, not recorded).
        const record = (content) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content, ...(block.fault === 'unlisted-not-error' ? {} : { is_error: true }), tool_use_id: callId }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), timestamp: new Date().toISOString(), tool_use_result: `Error: No such tool available: ${block.name}` })
        const answerOwn = () => {
          if (block.fault === 'unlisted-no-record') return { id: callId, name: block.name, input: block.input ?? {}, content: noSuchTool }
          record(block.fault === 'unlisted-other-result' ? 'Listed the folder: a.txt' : noSuchTool)
          if (block.fault === 'unlisted-twice') record(noSuchTool)
          return { id: callId, name: block.name, input: block.input ?? {}, content: noSuchTool }
        }
        let own = null
        if (ownAnswer) own = block.lateRecord ? chain.then(answerOwn) : Promise.resolve(answerOwn())
        stream({ type: 'content_block_stop', index }, id)
        const call = { id: callId, name: block.name, input: block.input ?? {}, fault: block.fault }
        calls.push(call)
        if (block.name !== 'EndConversation') dispatched.push(own ?? dispatch(call))
        await sleep(turn.gapMs ?? 5)
      }
    }
    if (attempt === 0 && turn.retryAfterIndex !== undefined) { await sleep(5); continue }
    stream({ type: 'message_delta', delta: { stop_reason: turn.stop_reason ?? (calls.length ? 'tool_use' : 'end_turn') }, ...(scenario.noUsage ? {} : { usage: { input_tokens: 3, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 42, ...(turn.thinkingTokens !== undefined ? { output_tokens_details: { thinking_tokens: turn.thinkingTokens } } : {}) } }) }, id)
    stream({ type: 'message_stop' }, id)
    out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: randomUUID(), session_id: sessionId })
    return { calls, dispatched }
  }
}

// Dispatch: read-only calls together, anything else one at a time (P0 §3).
let chain = Promise.resolve()
function dispatch(call) {
  const tool = mcpTools.find(t => `mcp__batshit__${t.name}` === call.name)
  const run = () => executeCall(call)
  if (tool?.annotations?.readOnlyHint) return run()
  const result = chain.then(run)
  chain = result.then(() => undefined, () => undefined)
  return result
}
async function executeCall(call) {
  // A call that reached the MCP server with no PreToolUse admission (no call tag), as a broken Claude Code might send it.
  if (call.fault === 'unlisted-mcp') {
    const answer = await rpc('tools/call', { name: call.name.replace(/^mcp__batshit__/, ''), arguments: call.input, _meta: { 'claudecode/toolUseId': call.id, progressToken: nextId } })
    const text = answer.result?.content?.map(item => item.text).join(' ') ?? 'MCP error'
    out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: call.id, type: 'tool_result', content: text, is_error: true }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), timestamp: new Date().toISOString() })
    return { id: call.id, name: call.name, input: call.input, content: text }
  }
  const pre = call.fault === 'pre-hook-fail'
    ? { blocked: true, reason: 'hook failed; blocking because onFailure is "block"' }
    : await hookOutcome('PreToolUse', { tool_name: call.name, tool_input: call.fault === 'pre-input-differs' ? { ...call.input, city: 'Atlantis' } : call.input, tool_use_id: call.id }, call.name)
  let content, isError
  if (pre.blocked || pre.json?.hookSpecificOutput?.permissionDecision !== 'allow') {
    content = [{ type: 'text', text: `PreToolUse hook blocked: ${pre.reason ?? 'denied'}` }]; isError = true
  } else if (call.fault === 'own-result') {
    content = [{ type: 'text', text: 'Claude Code wrote this result itself.' }]; isError = true
  } else {
    let args = pre.json.hookSpecificOutput.updatedInput ?? call.input
    if (call.fault === 'pre-input-differs') args = { ...call.input, __batshit_call: call.id }
    if (call.fault === 'alter-args') args = { ...args, city: 'Atlantis' }
    const bare = call.name.replace(/^mcp__batshit__/, '')
    const meta = { 'claudecode/toolUseId': call.fault === 'meta-mismatch' ? 'toolu_someone_else' : call.id, progressToken: nextId }
    if (call.fault === 'duplicate-call') void rpc('tools/call', { name: bare, arguments: args, _meta: meta })
    const answer = await rpc('tools/call', { name: bare, arguments: args, _meta: meta })
    content = answer.result?.content ?? [{ type: 'text', text: 'MCP error' }]; isError = Boolean(answer.result?.isError) || Boolean(answer.error)
    // As the pin records MCP image content: an Anthropic image block.
    content = content.map(item => item.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: call.fault === 'reencode-image' ? 'image/jpeg' : item.mimeType, data: call.fault === 'reencode-image' ? 'resized' : item.data } } : item)
    if (call.fault === 'record-different') { content = [{ type: 'text', text: 'MCP error -32000: Connection closed' }]; isError = true }
  }
  // As the pin records an error result: its text as one plain string with is_error (recorded/error-result).
  const recorded = isError ? content.filter(item => item.type === 'text').map(item => item.text).join(' ') : content
  if (call.fault !== 'no-record') out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: call.id, type: 'tool_result', content: recorded, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID(), timestamp: new Date().toISOString() })
  return { id: call.id, name: call.name, input: call.input, content }
}

// ---- the conversation ----
let initPrinted = 0
for (;;) {
  const input = await nextInput()
  if (input === null) break
  if (input.type === 'control_request' && input.request?.subtype === 'initialize') {
    if (scenario.noControlResponse) continue
    out({ type: 'control_response', response: { subtype: 'success', request_id: input.request_id, response: { account: scenario.account ?? { email: 'person@example.com', organization: 'Org', subscriptionType: 'Claude Max', apiProvider: 'firstParty' }, models: scenario.models ?? MODELS, pid: process.pid, claude_code_version: scenario.controlVersion ?? VERSION, current_permission_mode: 'dontAsk' } } })
    continue
  }
  if (input.type !== 'user') continue
  const prompt = (input.message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  log({ kind: 'prompt', prompt, content: input.message?.content })
  // `gateFailsToStart`: the hook never ran (a wrong path); `onFailure: "block"` blocks the prompt anyway.
  const gate = scenario.gateFailsToStart ? { blocked: true, reason: 'hook failed; blocking because onFailure is "block"' } : await hookOutcome('UserPromptSubmit', { prompt })
  out(initEvent()); initPrinted++
  if (scenario.modelCallInHandshake && initPrinted === 1) { log({ kind: 'model-call-injected' }); stream({ type: 'message_start', message: { id: 'msg_x', model, usage: {} } }) }
  if (gate.blocked) { out(resultEvent({ result: `UserPromptSubmit operation blocked by hook:\n${gate.reason}\n\nOriginal prompt: ${prompt}` })); continue }
  replayUser(input.message?.content)
  for (const [turnIndex, turn] of (scenario.turns ?? []).entries()) {
    const { calls, dispatched, apiError, resultSubtype } = await modelCall(turn)
    if (apiError) {
      out(resultEvent({ is_error: true, result: apiError.text, stop_reason: null, ...(apiError.status ? { api_error_status: apiError.status } : {}), ...(apiError.kind ? { api_error: apiError.kind } : {}) }))
      break
    }
    if (resultSubtype) {
      const { result: _unused, ...base } = resultEvent({})
      out({ ...base, subtype: resultSubtype, is_error: true, errors: [`[ede_diagnostic] result_type=${resultSubtype}`, 'Error: /Users/someone/secret/path.ts:12 Prompt is too long'] })
      break
    }
    // At its output limit the pin asks the model again by itself when the message has no call (its
    // output-limit recovery; the next turn here stands for that call). A message with calls has them
    // run as usual (its streaming executor took each one as its block ended), then goes on.
    if (turn.stop_reason === 'max_tokens' && !calls.length) { log({ kind: 'output-limit-recovery' }); continue }
    if (calls.some(c => c.name === 'EndConversation')) {
      out({ type: 'user', message: { role: 'user', content: [{ tool_use_id: calls.find(c => c.name === 'EndConversation').id, type: 'tool_result', content: 'Conversation ended.' }] }, session_id: sessionId, uuid: randomUUID() })
      out(resultEvent({ result: 'ended' }))
      break
    }
    if (!calls.length) { out(resultEvent({ result: 'done' })); break }
    const done = await Promise.all(dispatched)
    const batchCalls = scenario.batchIdsOverride ? scenario.batchIdsOverride.map(id => ({ tool_use_id: id })) : done.map(d => ({ tool_name: d.name, tool_input: d.input, tool_use_id: d.id, tool_response: d.content }))
    const batch = await hookOutcome('PostToolBatch', { tool_calls: batchCalls })
    if (batch.blocked) { log({ kind: 'batch-blocked', reason: batch.reason }); out(resultEvent({ result: '' })); break }
    // As the pin's hook executor does: an additionalContext over 10,000 characters is saved to a file and
    // Claude sees a 2,000-character preview and a path.
    const rawNote = batch.json?.hookSpecificOutput?.additionalContext ?? null
    const note = typeof rawNote === 'string' && rawNote.length > 10_000 ? `<persisted-output>\nOutput too large. Preview (first 2KB):\n${rawNote.slice(0, 2000)}\n</persisted-output>` : rawNote
    log({ kind: 'batch-passed', note, nextTurn: turnIndex + 1 })
    // As the pin's query loop does right after the PostToolBatch hooks: user messages already on stdin join
    // the next model call (after the results and the note), each echoed with --replay-user-messages.
    // `lateSteer` stands for a message whose stdin read lost the race with the hook's answer.
    if (!scenario.lateSteer) {
      const queued = []
      for (let i = 0; i < inbox.length;) { if (inbox[i].type === 'user') queued.push(...inbox.splice(i, 1)); else i++ }
      if (queued.length) log({ kind: 'queued-user', beforeCall: modelCalls + 1, content: queued.map(m => m.message?.content) })
      for (const message of queued) replayUser(message.message?.content)
    }
  }
}
log({ kind: 'exit', modelCalls })
mcp.stdin.end()
// A clean exit removes the messaging socket, as the real binary does; `leaveSocketOnExit` stands for a socket
// at that path that is not this run's (a reused pid), which Batshit must leave alone.
if (messagingServer && !scenario.leaveSocketOnExit) await new Promise(resolve => messagingServer.close(resolve))
process.exit(0)
