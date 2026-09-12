import { beforeEach, describe, expect, it } from 'vitest'

vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import {
  createCliTool,
  executeCliTool,
  findCliTools,
  listCliTools,
  validateCliTool
} from '$lib/server/services/cliToolRegistry'

useRedisTestServer()

const userId = 'cli-tools-user'
const agentId = 'cli-tools-agent'

async function seedAgent(defaultTools?: string[] | null) {
  await redis.createAgent({
    id: agentId,
    user_id: userId,
    displayName: 'CLI Tester',
    agentType: 'batshit',
    batshitMode: 'direct',
    ...(Array.isArray(defaultTools) ? { defaultTools } : {})
  })
}

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('cliToolRegistry', () => {
  beforeEach(async () => {
    await seedAgent()
  })

  it('creates and lists sanitized CLI tool records', async () => {
    await createCliTool(userId, {
      toolId: 'repo_snapshot',
      title: 'Repo Snapshot',
      description: 'Capture a quick repo snapshot.',
      tags: ['git', 'snapshot'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [{ kind: 'literal', value: '--version' }],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' }
        }
      },
      outputMode: 'text',
      parseMode: 'text',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false
    })

    const tools = await listCliTools(userId)
    expect(tools).toHaveLength(1)
    expect(tools[0].toolId).toBe('repo_snapshot')
    expect(tools[0].title).toBe('Repo Snapshot')
  })

  it('derives toolId from title and allows literal-only no-input manifests', async () => {
    const tool = await createCliTool(userId, {
      title: 'Git Status Snapshot',
      description: 'Runs a literal-only git status command.',
      tags: ['git'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        { kind: 'literal', value: 'process.stdout.write("ok")' }
      ],
      inputSchema: {
        type: 'object',
        properties: {}
      },
      outputMode: 'text',
      parseMode: 'text',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false
    })

    expect(tool.toolId).toBe('git_status_snapshot')
    expect(tool.inputSchema.properties).toEqual({})
  })

  it('rejects write-capable manifests without allowed paths', async () => {
    await expect(
      createCliTool(userId, {
        toolId: 'danger_write',
        title: 'Danger Write',
        description: 'Writes files',
        tags: [],
        origin: 'manual',
        status: 'active',
        executable: process.execPath,
        argsTemplate: [{ kind: 'literal', value: '--version' }],
        inputSchema: {
          type: 'object',
          properties: {
            targetPath: { type: 'string', format: 'path' }
          }
        },
        outputMode: 'text',
        parseMode: 'text',
        cwdPolicy: 'none',
        timeoutMs: 60000,
        riskLevel: 'safe',
        allowNetwork: false,
        allowWrite: true
      })
    ).rejects.toThrow('write-capable CLI tools must declare at least one allowed path')
  })

  it('finds only the CLI tools selected for the active agent', async () => {
    await createCliTool(userId, {
      toolId: 'repo_snapshot',
      title: 'Repo Snapshot',
      description: 'Capture a quick repo snapshot.',
      tags: ['git'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [{ kind: 'literal', value: '--version' }],
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputMode: 'text',
      parseMode: 'text',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false
    })
    await createCliTool(userId, {
      toolId: 'local_screenshot',
      title: 'Local Screenshot',
      description: 'Take a screenshot.',
      tags: ['image'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [{ kind: 'literal', value: '--version' }],
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      outputMode: 'text',
      parseMode: 'text',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false
    })

    await redis.updateAgent(agentId, { defaultTools: ['local_screenshot'] })

    const result = await findCliTools({
      userId,
      agentId,
      query: 'screenshot'
    })

    expect(result.totalMatches).toBe(1)
    expect(result.results[0].toolId).toBe('local_screenshot')
  })

  it('validates and executes JSON CLI tools through the selected agent scope', async () => {
    await createCliTool(userId, {
      toolId: 'json_echo',
      title: 'JSON Echo',
      description: 'Echoes input as JSON.',
      tags: ['json'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        {
          kind: 'literal',
          value: 'process.stdout.write(JSON.stringify({ echo: process.argv[1] }))'
        },
        { kind: 'input', field: 'query', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', required: true }
        },
        required: ['query']
      },
      outputMode: 'json',
      parseMode: 'json',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false,
      validationInput: {
        query: 'hello'
      }
    })

    await seedAgent(['json_echo'])

    const validation = await validateCliTool(userId, 'json_echo', { persist: false })
    expect(validation.success).toBe(true)

    const execution = await executeCliTool({
      userId,
      agentId,
      toolId: 'json_echo',
      input: {
        query: 'batshit'
      }
    })

    expect(execution.success).toBe(true)
    if (execution.success) {
      expect(execution.parsedOutput).toEqual({ echo: 'batshit' })
      expect(execution.exitCode).toBe(0)
    }
  })

  it('requires explicit approval before executing non-safe CLI tools', async () => {
    await createCliTool(userId, {
      toolId: 'confirm_echo',
      title: 'Confirm Echo',
      description: 'Echoes input after approval.',
      tags: ['json'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        {
          kind: 'literal',
          value: 'process.stdout.write(JSON.stringify({ echo: process.argv[1] }))'
        },
        { kind: 'input', field: 'query', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', required: true }
        },
        required: ['query']
      },
      outputMode: 'json',
      parseMode: 'json',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'confirm',
      allowNetwork: false,
      allowWrite: false
    })

    await seedAgent(['confirm_echo'])

    const blocked = await executeCliTool({
      userId,
      agentId,
      toolId: 'confirm_echo',
      input: {
        query: 'blocked'
      }
    })

    expect(blocked.success).toBe(false)
    if (!blocked.success) {
      expect(blocked.code).toBe('REQUIRES_APPROVAL')
      expect(blocked.requiresApproval).toBe(true)
      expect(blocked.riskLevel).toBe('confirm')
    }

    // SA-116 DL-116-14: the flag is not read any more. Until this story a non-safe CLI tool
    // ran the moment the MODEL passed `allowRisky: true` — the identical hole `useControl`
    // had, in a second file, with a different spelling.
    const stillBlocked = await executeCliTool({
      userId,
      agentId,
      toolId: 'confirm_echo',
      input: { query: 'approved' },
      allowRisky: true
    })
    expect(stillBlocked.success).toBe(false)
    if (!stillBlocked.success) expect(stillBlocked.code).toBe('REQUIRES_APPROVAL')

    // The card block travels out to the caller so send-routed persists it like any other.
    if (!blocked.success) {
      expect(blocked.approvalRequest).toEqual(
        expect.objectContaining({
          controlId: 'cli_tool:confirm_echo',
          controlTitle: 'Confirm Echo',
          riskLevel: 'confirm',
          inputSummary: { query: 'blocked' }
        })
      )
    }

    // The user clicks Approve on the card that names THIS call.
    const { decideApproval } = await import('$lib/server/services/controlApprovals')
    const approvalId = !blocked.success ? blocked.approvalRequest?.approvalId : undefined
    expect(typeof approvalId).toBe('string')
    await decideApproval({ userId, approvalId, approved: true })

    // The approval names the input the user saw, so the approved call must carry it too.
    const approved = await executeCliTool({
      userId,
      agentId,
      toolId: 'confirm_echo',
      input: { query: 'blocked' },
      approval: { kind: 'sdk', approvalId: approvalId as string }
    })

    expect(approved.success).toBe(true)
    if (approved.success) {
      expect(approved.parsedOutput).toEqual({ echo: 'blocked' })
    }

    // Consume-once: the same call again earns a new card rather than a second free run.
    const replay = await executeCliTool({
      userId,
      agentId,
      toolId: 'confirm_echo',
      input: { query: 'blocked' },
      approval: { kind: 'sdk', approvalId: approvalId as string }
    })
    expect(replay.success).toBe(false)
    if (!replay.success) expect(replay.code).toBe('REQUIRES_APPROVAL')
  })

  /**
   * SA-116 F-P2-5 — the `cli:` half of DL-116-14, end to end.
   *
   * Every other approval test starts inside `executeCliTool`, so the BROKER half was proved
   * by reading only. It is the half that can silently break: `resolveBrokerRiskApprovalTarget`
   * decides what the card says and what the record hashes, `executeCliTool` decides what the
   * click unlocks, and if those two shape the input differently the record can never match
   * the call it was raised for — every Approve would earn a second card and nothing would
   * ever run. This walks the real chain: resolver → record → click → run → consumed.
   */
  it('F-P2-5: a cli: ref pauses, the click unlocks that exact call, and the record reads consumed', async () => {
    const { resolveBrokerRiskApprovalTarget } = await import(
      '$lib/server/services/nativeTools'
    )
    const { createPendingApproval, decideApproval, getControlApproval, hashControlInput } =
      await import('$lib/server/services/controlApprovals')

    await createCliTool(userId, {
      toolId: 'broker_confirm_echo',
      title: 'Broker Confirm Echo',
      description: 'Echoes input after approval, reached through the broker.',
      tags: ['json'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        {
          kind: 'literal',
          value: 'process.stdout.write(JSON.stringify({ echo: process.argv[1] }))'
        },
        { kind: 'input', field: 'query', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', required: true } },
        required: ['query']
      },
      outputMode: 'json',
      parseMode: 'json',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'confirm',
      allowNetwork: false,
      allowWrite: false
    })
    await seedAgent(['broker_confirm_echo'])

    // 1. The model's raw broker input, exactly as `native_batshit_tool_use` receives it.
    const brokerInput = {
      ref: 'cli:broker_confirm_echo',
      input: { query: 'from-the-broker' }
    }
    const target = await resolveBrokerRiskApprovalTarget({
      userId,
      agentId,
      input: brokerInput,
      allowedFamilies: ['cli'],
      selectedCliToolIds: ['broker_confirm_echo']
    })
    expect(target).not.toBeNull()
    expect(target?.controlId).toBe('cli_tool:broker_confirm_echo')
    expect(target?.controlTitle).toBe('Broker Confirm Echo')
    expect(target?.riskLevel).toBe('confirm')
    expect(target?.input).toEqual({ query: 'from-the-broker' })

    // 2. The record the persist site creates from that target.
    const record = await createPendingApproval({
      userId,
      agentId,
      sessionId: 'session-broker-cli',
      messageId: 'msg_assistant_broker',
      controlId: target!.controlId,
      controlTitle: target!.controlTitle,
      riskLevel: target!.riskLevel,
      lane: 'api',
      input: target!.input,
      scopeKey: target!.scopeKey
    })

    // The claim that matters: the hash the RESOLVER produced is the hash the EXECUTOR will
    // look for. A drift here is invisible until every click stops working.
    expect(record.inputHash).toBe(hashControlInput({ query: 'from-the-broker' }))

    // 3. The click.
    const decided = await decideApproval({ userId, approvalId: record.id, approved: true })
    expect(decided?.status).toBe('approved')

    // 4. The run, through the same path `nativeCliToolUse` uses.
    const approved = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session-broker-cli',
      toolId: 'broker_confirm_echo',
      input: target!.input,
      approval: { kind: 'sdk', approvalId: record.id }
    })
    expect(approved.success).toBe(true)
    if (approved.success) expect(approved.parsedOutput).toEqual({ echo: 'from-the-broker' })

    // 5. Consumed — once, and visibly.
    await expect(getControlApproval(record.id)).resolves.toMatchObject({ status: 'consumed' })

    const replay = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session-broker-cli',
      toolId: 'broker_confirm_echo',
      input: target!.input,
      approval: { kind: 'sdk', approvalId: record.id }
    })
    expect(replay.success).toBe(false)
    if (!replay.success) expect(replay.code).toBe('REQUIRES_APPROVAL')
  })

  /* ------------------------------------------------------------------ *
   * PR #106 review — the CLI-tool path on the shared approval contract.
   * ------------------------------------------------------------------ */

  async function seedConfirmEcho() {
    await createCliTool(userId, {
      toolId: 'confirm_echo',
      title: 'Confirm Echo',
      description: 'Echoes input after approval.',
      tags: ['json'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        { kind: 'literal', value: 'process.stdout.write(JSON.stringify({ echo: process.argv[1] }))' },
        { kind: 'input', field: 'query', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', required: true } },
        required: ['query']
      },
      outputMode: 'json',
      parseMode: 'json',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'confirm',
      allowNetwork: false,
      allowWrite: false
    })
    await seedAgent(['confirm_echo'])
  }

  it('F-7: validates the input BEFORE raising a card, so a click is never spent on a call that cannot run', async () => {
    await seedConfirmEcho()
    const sessionId = 'session_f7'

    const invalid = await executeCliTool({
      userId,
      agentId,
      sessionId,
      toolId: 'confirm_echo',
      input: {},
      actorType: 'in-process'
    })

    expect(invalid.success).toBe(false)
    if (invalid.success) return
    expect(invalid.code).toBe('INPUT_VALIDATION_FAILED')
    expect(invalid.requiresApproval).toBeUndefined()
    expect(invalid.approvalRequest).toBeUndefined()
    // No pause was recorded for it either — nothing to consume on the retry.
    const indexed = await redis.execute(async (client) => client.zCard(`control_approvals:${sessionId}`))
    expect(indexed).toBe(0)
  })

  it('F-5: the approval lane comes from the actor, so every caller gets a card it can answer', async () => {
    await seedConfirmEcho()

    const inProcess = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session_f5',
      toolId: 'confirm_echo',
      input: { query: 'x' },
      actorType: 'in-process'
    })
    expect(inProcess.success).toBe(false)
    if (!inProcess.success) expect(inProcess.approvalRequest?.lane).toBe('api')

    const helper = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session_f5',
      messageId: 'msg_helper',
      toolId: 'confirm_echo',
      input: { query: 'y' },
      actorType: 'agent'
    })
    expect(helper.success).toBe(false)
    if (!helper.success) expect(helper.approvalRequest?.lane).toBe('cli')

    // A caller with no chat to click in — a service-token call, or a helper call whose
    // message id went missing — is `service`, never a silent `api` pause that persists no card.
    const service = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session_f5',
      toolId: 'confirm_echo',
      input: { query: 'z' },
      actorType: 'service'
    })
    expect(service.success).toBe(false)
    if (!service.success) expect(service.approvalRequest?.lane).toBe('service')
  })

  it('F-6: the pause tells the managed CLI lane to retry after the resume turn, and the API lane not to', async () => {
    await seedConfirmEcho()

    const cli = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session_f6',
      messageId: 'msg_cli',
      toolId: 'confirm_echo',
      input: { query: 'a' },
      actorType: 'agent'
    })
    expect(cli.success).toBe(false)
    if (!cli.success) {
      expect(cli.error).toContain('When the user clicks Approve you are resumed')
      expect(cli.error).not.toContain('Do not retry it yourself')
    }

    const api = await executeCliTool({
      userId,
      agentId,
      sessionId: 'session_f6',
      toolId: 'confirm_echo',
      input: { query: 'b' },
      actorType: 'in-process'
    })
    expect(api.success).toBe(false)
    if (!api.success) expect(api.error).toContain('Do not retry it yourself')
  })

  it('falls back to global CLI Tool Grid discoverability when the agent has no explicit CLI overrides', async () => {
    await createCliTool(userId, {
      toolId: 'json_echo',
      title: 'JSON Echo',
      description: 'Echoes input as JSON.',
      tags: ['json'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '-e' },
        {
          kind: 'literal',
          value: 'process.stdout.write(JSON.stringify({ echo: process.argv[1] }))'
        },
        { kind: 'input', field: 'query', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', required: true }
        },
        required: ['query']
      },
      outputMode: 'json',
      parseMode: 'json',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false
    })

    await redis.updateUserSettings(userId, {
      global_tool_grid_settings: {
        cli: {
          discoverableToolIds: ['json_echo'],
          dcmDisplayDefaults: {
            version: 1,
            groups: {},
            tools: {}
          }
        }
      }
    })

    const result = await findCliTools({
      userId,
      agentId,
      query: 'echo'
    })

    expect(result.totalMatches).toBe(1)
    expect(result.results[0].toolId).toBe('json_echo')

    const execution = await executeCliTool({
      userId,
      agentId,
      toolId: 'json_echo',
      input: {
        query: 'global'
      }
    })

    expect(execution.success).toBe(true)
    if (execution.success) {
      expect(execution.parsedOutput).toEqual({ echo: 'global' })
    }
  })

  it('blocks CLI path inputs that escape allowedPaths', async () => {
    await createCliTool(userId, {
      toolId: 'path_writer',
      title: 'Path Writer',
      description: 'Pretends to write to a path.',
      tags: ['write'],
      origin: 'manual',
      status: 'active',
      executable: process.execPath,
      argsTemplate: [
        { kind: 'literal', value: '--version' },
        { kind: 'option', flag: '--path', field: 'targetPath', required: true }
      ],
      inputSchema: {
        type: 'object',
        properties: {
          targetPath: { type: 'string', required: true, format: 'path' }
        },
        required: ['targetPath']
      },
      outputMode: 'text',
      parseMode: 'text',
      cwdPolicy: 'none',
      timeoutMs: 60000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: true,
      allowedPaths: ['/tmp/batshit-cli-tools']
    })

    await seedAgent(['path_writer'])

    const execution = await executeCliTool({
      userId,
      agentId,
      toolId: 'path_writer',
      input: {
        targetPath: '/Users/example/not-allowed.txt'
      }
    })

    expect(execution.success).toBe(false)
    if (!execution.success) {
      expect(execution.code).toBe('POLICY_BLOCKED')
      expect(execution.error).toContain('allowed paths')
    }
  })
})
