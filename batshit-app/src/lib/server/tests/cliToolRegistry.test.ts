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

    const approved = await executeCliTool({
      userId,
      agentId,
      toolId: 'confirm_echo',
      input: {
        query: 'approved'
      },
      allowRisky: true
    })

    expect(approved.success).toBe(true)
    if (approved.success) {
      expect(approved.parsedOutput).toEqual({ echo: 'approved' })
    }
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
