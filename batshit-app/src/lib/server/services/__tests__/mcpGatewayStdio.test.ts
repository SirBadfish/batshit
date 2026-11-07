import { fileURLToPath } from 'node:url'
import { access, constants, mkdtemp, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
  assertSavedInstalledStdioConfig, resolveInstalledStdioLaunch, assertInstalledStdioLaunchCurrent, stdioCommandNeedsInstallation,
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

  it('keeps installed saved launch checks separate from ordinary normalization and key resolution', async () => {
    const gateway = { id: 'saved-installed', slug: 'installed', name: 'Installed', type: 'stdio' as const, enabled: false,
      created_at: '2026-10-21T00:00:00Z', stdioConfig: { command: process.execPath, args: [fileURLToPath(import.meta.url)],
        cwdPolicy: 'none' as const, envRefs: [{ envVar: 'SERVER_TOKEN', savedKeyRef: 'server-token' }], startupTimeoutMs: 1000, toolCallTimeoutMs: 1000 } }
    const launch = await resolveInstalledStdioLaunch(gateway)
    expect(launch).toMatchObject({ command: process.execPath, args: gateway.stdioConfig.args })
    expect(launch).not.toHaveProperty('env'); expect(launch.files).toHaveLength(2)
    expect(() => assertInstalledStdioLaunchCurrent(launch)).not.toThrow()
    const { apiKeyService } = await import('$lib/services/apiKey.server')
    expect(apiKeyService.retrieve).not.toHaveBeenCalled()
    for (const command of ['npx','npm','pnpm','yarn','uvx','bunx','pipx']) {
      expect(stdioCommandNeedsInstallation(command)).toBe(true)
      expect(() => assertSavedInstalledStdioConfig({ ...gateway, stdioConfig: { ...gateway.stdioConfig, command } })).toThrow('cohort')
    }
    for (const change of [{ args: ['-e','require("server")'] }, { args: ['relative.cjs'] }, { args: ['/opt/server.cjs','--eval=x'] },
      { cwdPolicy: 'project' as const }, { command: '/bin/sh', args: ['/opt/server.sh'] }, { args: [' /opt/server.cjs '] },
      { envRefs: [{ envVar: 'SERVER_TOKEN', savedKeyRef: ' Server-Token ' }] }, { startupTimeoutMs: 0 }]) {
      expect(() => assertSavedInstalledStdioConfig({ ...gateway, stdioConfig: { ...gateway.stdioConfig, ...change } })).toThrow()
    }
    await expect(resolveInstalledStdioLaunch({ ...gateway, stdioConfig: { ...gateway.stdioConfig, args: ['/definitely/missing/server.cjs'] } })).rejects.toThrow()
    await expect(resolveInstalledStdioLaunch({ ...gateway, stdioConfig: { ...gateway.stdioConfig, command: '/tmp' } })).rejects.toThrow()
  })
  it('refuses saved bootstrap/eval wrappers and resolved wrapper/runner/interpreter aliases before launch', async () => {
    const source = { id: 'saved-alias', slug: 'saved-alias', name: 'Saved alias', type: 'stdio' as const, enabled: true,
      created_at: '2026-10-21T00:00:00Z', stdioConfig: { command: '/usr/bin/env', args: ['npx','--yes','a-server'], cwdPolicy: 'none' as const, envRefs: [] } }
    for (const args of [['npx','--yes','a-server'], ['node','-eprocess.exit(0)']]) {
      expect(() => assertSavedInstalledStdioConfig({ ...source, stdioConfig: { ...source.stdioConfig, args } })).toThrow('Wrappers')
    }
    for (const args of [['tool','run','a-server'], ['run','a-server']]) {
      expect(() => assertSavedInstalledStdioConfig({ ...source, stdioConfig: { ...source.stdioConfig, command: '/installed/uv', args } })).toThrow('Wrappers')
    }
    expect(() => assertSavedInstalledStdioConfig({ ...source, stdioConfig: { ...source.stdioConfig, command: process.execPath, args: ['/installed/server.cjs','-eprocess.exit(0)'] } })).toThrow('inline execution')
    const aliasRoot = await mkdtemp(path.join(os.tmpdir(), 'batshit-stdio-alias-test-'))
    const alias = path.join(aliasRoot, 'installed-alias')
    const expectResolvedAliasRefusal = async (name: string, args: string[], reason: string) => {
      const target = path.join(aliasRoot, name)
      // Empty, private X_OK files test only resolved-name refusal. They are never run,
      // copied from an installation, or evidence that a server is installed.
      await writeFile(target, '', { flag: 'wx', mode: 0o700 })
      await symlink(target, alias, 'file')
      const gateway = { ...source, stdioConfig: { ...source.stdioConfig, command: alias, args } }
      expect(() => assertSavedInstalledStdioConfig(gateway)).not.toThrow()
      let refusal: unknown
      try {
        await resolveInstalledStdioLaunch(gateway)
      } catch (error) { refusal = error }
      // Check actual filesystem prerequisites before judging the captured rejection.
      // An early access failure cannot stand in for a resolved-identity refusal.
      expect(constants.X_OK).toBeTypeOf('number')
      await expect(access(alias, constants.X_OK)).resolves.toBeUndefined()
      expect(await realpath(alias)).toBe(await realpath(target))
      expect((await stat(alias)).isFile()).toBe(true)
      expect(refusal).toBeInstanceOf(Error)
      expect(() => { throw refusal }).toThrow(reason)
      await unlink(alias)
    }
    try {
      for (const name of ['env', 'npx-cli.js', 'nohup', 'sh']) {
        await expectResolvedAliasRefusal(name, ['npx','--yes','a-server'], 'Wrappers')
      }
      await expectResolvedAliasRefusal('uv', ['tool','run','a-server'], 'Wrappers')
      await expectResolvedAliasRefusal('node', ['relative-server.cjs'], 'absolute installed local server entry')
      const { apiKeyService } = await import('$lib/services/apiKey.server')
      expect(apiKeyService.retrieve).not.toHaveBeenCalled()
    } finally { await rm(aliasRoot, { recursive: true, force: true }) }
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
