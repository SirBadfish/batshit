import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', () => ({
  redis: {
    getProjectPreferences: vi.fn()
  }
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn()
  },
  normalizeApiKeyServiceName: (value: string) => value.trim().toLowerCase(),
  INFRA_API_KEY_SERVICES: new Set<string>()
}))

import {
  buildManagedStdioEnvironmentPlan,
  buildManagedStdioPlaceholderName,
  resolveStdioGatewayProcessConfig,
  sanitizeStdioGatewayConfig,
  validateStdioGatewayConfig
} from '../mcpGatewayStdio'

describe('mcpGatewayStdio', () => {
  it('rejects inline shell snippets in stdio configs', () => {
    const validation = validateStdioGatewayConfig({
      command: 'bash',
      args: ['-lc', 'node server.js']
    })

    expect(validation.valid).toBe(false)
    expect(validation.error).toContain('argv-style launch args')
  })

  it('builds managed env placeholders without storing raw secrets', () => {
    const plan = buildManagedStdioEnvironmentPlan({
      id: 'gw_stdio',
      name: 'Local STDIO',
      type: 'stdio',
      enabled: true,
      stdioConfig: {
        command: 'node',
        envRefs: [
          {
            envVar: 'GITHUB_TOKEN',
            savedKeyRef: 'github'
          }
        ]
      },
      created_at: new Date().toISOString()
    })

    const placeholder = buildManagedStdioPlaceholderName('gw_stdio', 'GITHUB_TOKEN')
    expect(plan.placeholders).toEqual([{ placeholder, savedKeyRef: 'github' }])
    expect(plan.env).toEqual({
      GITHUB_TOKEN: `\${${placeholder}}`
    })
  })

  it('sanitizes timeout values and env refs', () => {
    const config = sanitizeStdioGatewayConfig({
      command: 'node',
      args: [' server.js ', '', '--watch'],
      envRefs: [
        { envVar: 'GITHUB_TOKEN', savedKeyRef: 'github' },
        { envVar: 'GITHUB_TOKEN', savedKeyRef: 'github' }
      ],
      startupTimeoutMs: 50,
      toolCallTimeoutMs: 999999
    })

    expect(config).toMatchObject({
      command: 'node',
      args: ['server.js', '--watch'],
      startupTimeoutMs: 1000,
      toolCallTimeoutMs: 300000
    })
    expect(config?.envRefs).toEqual([{ envVar: 'GITHUB_TOKEN', savedKeyRef: 'github' }])
  })

  it('rewrites imported filesystem roots to the Docker workspace in container runtime', async () => {
    const previousContainerized = process.env.BATSHIT_CONTAINERIZED
    const previousWorkdir = process.env.BATSHIT_CODEX_WORKDIR
    const previousRewriteDisabled = process.env.BATSHIT_DOCKER_STDIO_PATH_REWRITE_DISABLED

    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CODEX_WORKDIR = '/tmp'
    delete process.env.BATSHIT_DOCKER_STDIO_PATH_REWRITE_DISABLED

    try {
      const resolved = await resolveStdioGatewayProcessConfig({
        gateway: {
          id: 'gw-filesystem',
          name: 'Filesystem',
          type: 'stdio',
          enabled: true,
          stdioConfig: {
            command: process.execPath,
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/definitely/missing/batshit']
          },
          created_at: new Date().toISOString()
        }
      })

      expect(resolved.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])

      const windowsResolved = await resolveStdioGatewayProcessConfig({
        gateway: {
          id: 'gw-filesystem-windows',
          name: 'Filesystem Windows Import',
          type: 'stdio',
          enabled: true,
          stdioConfig: {
            command: process.execPath,
            args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\Josh\\batshit']
          },
          created_at: new Date().toISOString()
        }
      })

      expect(windowsResolved.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/tmp'])
    } finally {
      if (previousContainerized === undefined) delete process.env.BATSHIT_CONTAINERIZED
      else process.env.BATSHIT_CONTAINERIZED = previousContainerized
      if (previousWorkdir === undefined) delete process.env.BATSHIT_CODEX_WORKDIR
      else process.env.BATSHIT_CODEX_WORKDIR = previousWorkdir
      if (previousRewriteDisabled === undefined) delete process.env.BATSHIT_DOCKER_STDIO_PATH_REWRITE_DISABLED
      else process.env.BATSHIT_DOCKER_STDIO_PATH_REWRITE_DISABLED = previousRewriteDisabled
    }
  })
})
