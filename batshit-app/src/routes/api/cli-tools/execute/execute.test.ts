import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  executeCliTool: vi.fn(),
  resolveNativeToolUser: vi.fn()
}))

vi.mock('$lib/server/services/cliToolRegistry', () => ({
  executeCliTool: mocks.executeCliTool
}))

vi.mock('$lib/server/services/nativeToolAuth', () => ({
  resolveNativeToolUser: mocks.resolveNativeToolUser
}))

import { POST } from './+server'

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/cli-tools/execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('/api/cli-tools/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'service',
      projectPath: null
    })
    mocks.executeCliTool.mockResolvedValue({
      success: true,
      toolId: 'tool-1'
    })
  })

  it('passes service-token projectPath into CLI tool execution', async () => {
    const response = await POST({
      request: request({
        userId: 'user-1',
        agentId: 'agent-1',
        toolId: 'tool-1',
        input: { path: 'README.md' },
        selectedToolIds: ['tool-1'],
        allowRisky: true,
        projectPath: '/Users/example/batshit'
      }),
      locals: {}
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.executeCliTool).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent-1',
      toolId: 'tool-1',
      input: { path: 'README.md' },
      selectedToolIds: ['tool-1'],
      allowRisky: true,
      projectPath: '/Users/example/batshit'
    })
  })

  it('ignores body projectPath for session-authenticated CLI tool execution', async () => {
    mocks.resolveNativeToolUser.mockResolvedValue({
      userId: 'user-1',
      auth: 'session',
      projectPath: null
    })

    const response = await POST({
      request: request({
        userId: 'user-1',
        toolId: 'tool-1',
        projectPath: '/Users/example/batshit'
      }),
      locals: {
        user: {
          id: 'user-1'
        }
      }
    } as any)

    expect(response.status).toBe(200)
    expect(mocks.executeCliTool).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: null
      })
    )
  })
})
