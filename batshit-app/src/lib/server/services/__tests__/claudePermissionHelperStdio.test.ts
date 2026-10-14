import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const script = path.resolve(process.cwd(), 'scripts/claude-permission-mcp.cjs')
const preload = path.resolve(process.cwd(), 'src/lib/test-utils/fixtures/claude-permission-fake-redis.cjs')
const children: ChildProcessWithoutNullStreams[] = []
const tempDirs: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.stdin.end()
    if (child.exitCode !== null || child.signalCode !== null) continue
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    })
    if (timer) clearTimeout(timer)
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startHelper(withSession = true, extraEnv: Record<string, string> = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-permission-stdio-'))
  tempDirs.push(dir)
  const capture = path.join(dir, 'redis.jsonl')
  const child = spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_OPTIONS: `--require ${preload}`,
      BL502_CAPTURE: capture,
      REDIS_URL: 'redis://127.0.0.1:1/0',
      BATSHIT_SESSION_ID: withSession ? 'launch-session' : '',
      BATSHIT_MESSAGE_ID: 'launch-message',
      BATSHIT_CLAUDE_PERMISSION_MODE: 'default',
      ...extraEnv
    }
  }) as ChildProcessWithoutNullStreams
  children.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  const send = (id: number, method: string, params: unknown = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }
  send(1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bl502-test', version: '1' }
  })
  await waitFor(() => stdout.includes('batshit-claude-approvals'), stderr)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const call = (id: number, args: Record<string, unknown>) => send(id, 'tools/call', { name: 'batshit_permission_prompt', arguments: args })
  const response = (id: number) => waitFor(() => stdout.split('\n').some((line) => {
    try { return JSON.parse(line)?.id === id } catch { return false }
  }), stderr).then(() => stdout.split('\n').map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).find((entry) => entry?.id === id))
  const records = async () => {
    try { return (await readFile(capture, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) }
    catch { return [] }
  }
  return { child, call, response, records, get stderr() { return stderr } }
}

async function waitFor(predicate: () => boolean, stderr: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for helper output. stderr: ${stderr}`)
}

describe('Claude permission MCP callback boundary', () => {
  it('denies malformed and unknown callbacks before publishing or waiting', async () => {
    const helper = await startHelper()
    const cases = [
      { toolName: 'Bash', toolInput: { command: 'echo x' }, toolUseId: 'forged' },
      { tool_name: 'Bash', input: [], tool_use_id: 'bad-input' },
      { tool_name: 'Bash', input: {}, tool_use_id: '   ' }
    ]
    for (let i = 0; i < cases.length; i++) {
      helper.call(10 + i, cases[i])
      const result = await helper.response(10 + i)
      expect(result.result?.structured_content?.behavior).toBe('deny')
    }
    expect(await helper.records()).toEqual([])

    helper.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 19, method: 'tools/call',
      params: { name: 'unknown_mcp_dispatch', arguments: { tool_name: 'Bash', input: {}, tool_use_id: 'unknown-dispatch' } }
    })}\n`)
    const unknownDispatch = await helper.response(19)
    expect(unknownDispatch.error || unknownDispatch.result?.structured_content?.behavior).toBeTruthy()
    expect(await helper.records()).toEqual([])
  })

  it('uses the launch session and fresh approval id for an authentic callback', async () => {
    const helper = await startHelper()
    helper.call(44, {
      tool_name: 'Bash', input: { command: 'echo approval' }, tool_use_id: 'toolu_real_123',
      sessionId: 'victim-session', approvalId: 'attacker-id', requestId: 'attacker-request', id: 'attacker-id-field'
    })
    const result = await helper.response(44)
    expect(result.result?.structured_content?.behavior).toBe('deny')
    const records = await helper.records()
    expect(records).toHaveLength(4)
    expect(records.filter((entry: any) => entry.method === 'publish').every((entry: any) => entry.channel === 'batshit:sse:launch-session')).toBe(true)
    const event = records.find((entry: any) => entry.payload?.type === 'tool-call')?.payload
    expect(event.args).toMatchObject({ toolName: 'Bash', toolInput: { command: 'echo approval' }, toolUseId: 'toolu_real_123' })
    const approvalId = event.args.approvalId
    expect(approvalId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(['attacker-id', 'attacker-request', 'attacker-id-field', '44']).not.toContain(approvalId)
    const wait = records.find((entry: any) => entry.method === 'brPop')
    expect(wait.key).toBe(`toolApprovalResponse:launch-session:${approvalId}`)
  })

  it('refuses to route via a caller session when launch session context is missing', async () => {
    const helper = await startHelper(false)
    helper.call(45, { tool_name: 'Bash', input: { command: 'echo x' }, tool_use_id: 'toolu_missing', sessionId: 'victim-session' })
    const result = await helper.response(45)
    expect(result.result?.structured_content?.behavior).toBe('deny')
    expect(await helper.records()).toEqual([])
  })

  it('returns the exact callback input on auto-allow without publishing an approval event', async () => {
    const helper = await startHelper()
    const input = { futureField: ['preserved'], nested: { exact: true } }
    helper.call(46, { tool_name: 'Read', input, tool_use_id: 'toolu_read' })
    const result = await helper.response(46)
    expect(result.result?.structured_content).toEqual({ behavior: 'allow', updatedInput: input })
    expect(await helper.records()).toEqual([])
  })

  it('routes an unfamiliar future native tool name through the normal prompt decision', async () => {
    const helper = await startHelper()
    helper.call(47, { tool_name: 'FutureClaudeTool2027', input: { futureField: true }, tool_use_id: 'toolu_future' })
    const result = await helper.response(47)
    expect(result.result?.structured_content?.behavior).toBe('deny')
    const records = await helper.records()
    expect(records.filter((entry: any) => entry.method === 'publish')).toHaveLength(3)
    expect(records.find((entry: any) => entry.payload?.type === 'tool-call')?.payload?.args?.toolName).toBe('FutureClaudeTool2027')
  })

  /**
   * BL-496 (A5): one clock. The card says when it ends, and that is when the helper's own wait
   * ends: ten minutes, which Claude Code 2.1.280 was measured to keep the call open for.
   */
  it('puts the card’s own clock on the card: asked, and asked plus the ten-minute wait', async () => {
    const helper = await startHelper()
    helper.call(48, { tool_name: 'Bash', input: { command: 'echo clock' }, tool_use_id: 'toolu_clock' })
    await helper.response(48)
    const records = await helper.records()
    const card = records.find((entry: any) => entry.payload?.type === 'tool-call')?.payload
    const requestedAtMs = Date.parse(card.requestedAt)
    expect(Number.isFinite(requestedAtMs)).toBe(true)
    expect(Date.parse(card.expiresAt) - requestedAtMs).toBe(600_000)
    expect(records.find((entry: any) => entry.method === 'brPop').timeout).toBe(600)
    // A person's deny is a deny, with words for the model.
    const result = records.find((entry: any) => entry.payload?.type === 'tool-result')?.payload
    expect(result).toMatchObject({ approvalStatus: 'denied', result: { behavior: 'deny', message: 'test denial' } })
    expect(result.expiryReason).toBeUndefined()
  })

  /**
   * BL-496 (A6): measured on 2.1.280, a deny with no `message` is not a deny to Claude Code: it
   * reports "The permission prompt tool returned an invalid permission result". So the wait that
   * nobody answers denies WITH words, and says it expired.
   */
  it('a card nobody answered is denied with words for the model and ends as expired', async () => {
    const helper = await startHelper(true, { BL502_BRPOP_MODE: 'timeout' })
    helper.call(49, { tool_name: 'Bash', input: { command: 'echo late' }, tool_use_id: 'toolu_late' })
    const response = await helper.response(49)
    const expectedWords =
      'Nobody answered this approval in 10 minutes, so it was denied. Do not try it again now. Tell the user what you need.'
    expect(response.result?.structured_content).toEqual({ behavior: 'deny', message: expectedWords })
    const result = (await helper.records()).find((entry: any) => entry.payload?.type === 'tool-result')?.payload
    expect(result).toMatchObject({
      approvalStatus: 'expired',
      expiryReason: 'unanswered',
      result: { behavior: 'deny', message: expectedWords }
    })
  })

  it('the test knob only shortens the wait, and the card says the shorter time', async () => {
    const helper = await startHelper(true, { BATSHIT_TEST_CLAUDE_APPROVAL_WAIT_SECONDS: '20', VITEST: 'true' })
    helper.call(50, { tool_name: 'Bash', input: { command: 'echo short' }, tool_use_id: 'toolu_short' })
    await helper.response(50)
    const records = await helper.records()
    const card = records.find((entry: any) => entry.payload?.type === 'tool-call')?.payload
    expect(Date.parse(card.expiresAt) - Date.parse(card.requestedAt)).toBe(20_000)
    expect(records.find((entry: any) => entry.method === 'brPop').timeout).toBe(20)

    const longer = await startHelper(true, { BATSHIT_TEST_CLAUDE_APPROVAL_WAIT_SECONDS: '5000', VITEST: 'true' })
    longer.call(51, { tool_name: 'Bash', input: { command: 'echo long' }, tool_use_id: 'toolu_long' })
    await longer.response(51)
    expect((await longer.records()).find((entry: any) => entry.method === 'brPop').timeout).toBe(600)
  })

  /** Review finding 7: an app's environment cannot shorten a real approval; only a test run can. */
  it('ignores the test knob outside a test run', async () => {
    const helper = await startHelper(true, { BATSHIT_TEST_CLAUDE_APPROVAL_WAIT_SECONDS: '20', VITEST: '', NODE_ENV: 'production' })
    helper.call(52, { tool_name: 'Bash', input: { command: 'echo real' }, tool_use_id: 'toolu_real' })
    await helper.response(52)
    const records = await helper.records()
    expect(records.find((entry: any) => entry.method === 'brPop').timeout).toBe(600)
    const card = records.find((entry: any) => entry.payload?.type === 'tool-call')?.payload
    expect(Date.parse(card.expiresAt) - Date.parse(card.requestedAt)).toBe(600_000)
  })

  /** Review finding 4: a wait that failed is not a person's deny, and not an unanswered card. */
  it('a failed wait denies with its own words and ends the card as a failed wait', async () => {
    const helper = await startHelper(true, { BL502_BRPOP_MODE: 'throw' })
    helper.call(53, { tool_name: 'Bash', input: { command: 'echo fail' }, tool_use_id: 'toolu_fail' })
    const response = await helper.response(53)
    const words =
      'Batshit could not read the answer to this approval, so it was denied. Do not try it again now. Tell the user the approval could not be read.'
    expect(response.result?.structured_content).toEqual({ behavior: 'deny', message: words })
    const result = (await helper.records()).find((entry: any) => entry.payload?.type === 'tool-result')?.payload
    expect(result).toMatchObject({ approvalStatus: 'expired', expiryReason: 'wait_failed' })
  })
})
