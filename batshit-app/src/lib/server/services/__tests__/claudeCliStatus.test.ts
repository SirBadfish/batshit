import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  buildClaudeLoginCommands,
  getClaudeCliExecutableCandidates,
  isClaudeStatusAuthenticated,
  resolveClaudeCliExecutableDetailed
} from '../claudeCliStatus'
import { MANAGED_CLI_PINNED_VERSIONS } from '../managedCliInstaller'

let isolatedInstallsRoot: string
let previousInstallsRoot: string | undefined

beforeEach(async () => {
  isolatedInstallsRoot = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-status-installs-'))
  previousInstallsRoot = process.env.BATSHIT_MANAGED_INSTALLS_ROOT
  process.env.BATSHIT_MANAGED_INSTALLS_ROOT = isolatedInstallsRoot
})

afterEach(async () => {
  if (previousInstallsRoot === undefined) {
    delete process.env.BATSHIT_MANAGED_INSTALLS_ROOT
  } else {
    process.env.BATSHIT_MANAGED_INSTALLS_ROOT = previousInstallsRoot
  }
  await rm(isolatedInstallsRoot, { recursive: true, force: true })
})

async function seedManagedClaudeInstall(): Promise<string> {
  const version = MANAGED_CLI_PINNED_VERSIONS.claude
  const versionRoot = path.join(isolatedInstallsRoot, 'cli', 'claude', version)
  const executablePath = path.join(versionRoot, 'claude')
  await mkdir(versionRoot, { recursive: true })
  await writeFile(executablePath, '#!/bin/sh\nexit 0\n')
  await chmod(executablePath, 0o755)
  await writeFile(
    path.join(versionRoot, 'batshit-managed-cli.json'),
    JSON.stringify({ runtime: 'claude', version, executablePath })
  )
  return executablePath
}

describe('buildClaudeLoginCommands', () => {
  it('uses native Claude login commands outside Docker', () => {
    expect(buildClaudeLoginCommands({ containerized: false })).toEqual({
      context: 'native',
      loginCommand: 'claude auth login',
      statusCommand: 'claude auth status --text'
    })
  })

  it('uses Docker Compose app exec commands inside Docker', () => {
    expect(
      buildClaudeLoginCommands({
        containerized: true,
        n8nApiUrl: 'http://host.docker.internal:5678'
      })
    ).toEqual({
      context: 'docker',
      loginCommand: 'docker compose --env-file .env.docker exec app claude auth login',
      statusCommand: 'docker compose --env-file .env.docker exec app claude auth status --text'
    })
  })

  it('adds the n8n profile when bundled n8n is the runtime target', () => {
    expect(
      buildClaudeLoginCommands({
        containerized: true,
        n8nApiUrl: 'http://n8n:5678',
        runAsUser: 'batshit-cli',
        runAsUid: 10001,
        runAsGid: 10001,
        runAsHome: '/home/batshit-cli'
      }).loginCommand
    ).toBe(
      'docker compose --env-file .env.docker --profile n8n exec --user batshit-cli --env HOME=/home/batshit-cli --env USER=batshit-cli --env LOGNAME=batshit-cli --env SHELL=/bin/sh app claude auth login'
    )
  })

  it('embeds the managed executable path in Docker exec commands', () => {
    expect(
      buildClaudeLoginCommands({
        containerized: true,
        executablePath: '/home/batshit-cli/.batshit/installs/cli/bin/claude',
        runAsUser: 'batshit-cli',
        runAsHome: '/home/batshit-cli'
      }).statusCommand
    ).toBe(
      'docker compose --env-file .env.docker exec --user batshit-cli --env HOME=/home/batshit-cli --env USER=batshit-cli --env LOGNAME=batshit-cli --env SHELL=/bin/sh app /home/batshit-cli/.batshit/installs/cli/bin/claude auth status --text'
    )
  })
})

describe('isClaudeStatusAuthenticated', () => {
  it('does not treat the logged-out Claude status text as authenticated', () => {
    expect(isClaudeStatusAuthenticated('Not logged in - please run /login')).toBe(false)
  })

  it('accepts logged-in Claude status text', () => {
    expect(isClaudeStatusAuthenticated('Logged in as user@example.com')).toBe(true)
  })

  it('accepts the JSON auth status from Claude Code', () => {
    expect(
      isClaudeStatusAuthenticated(
        JSON.stringify({
          loggedIn: true,
          authMethod: 'claudeai',
          apiProvider: 'firstParty'
        })
      )
    ).toBe(true)
  })

  it('accepts the lowercase loggedin JSON auth status from Claude Code', () => {
    expect(
      isClaudeStatusAuthenticated(
        JSON.stringify({
          loggedin: true,
          authmethod: 'claude.ai',
          apiprovider: 'firstparty',
          subscriptiontype: 'max'
        })
      )
    ).toBe(true)
  })

  it('rejects the logged-out JSON auth status from Claude Code', () => {
    expect(
      isClaudeStatusAuthenticated(
        JSON.stringify({
          loggedIn: false,
          authMethod: 'none',
          apiProvider: 'firstParty'
        })
      )
    ).toBe(false)
  })
})

describe('resolveClaudeCliExecutableDetailed (resolution order)', () => {
  it('prefers an explicit env override even when a managed install exists', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-status-'))
    try {
      const envExecutable = path.join(tmp, 'claude-env')
      await writeFile(envExecutable, '#!/bin/sh\nexit 0\n')
      await chmod(envExecutable, 0o755)
      await seedManagedClaudeInstall()

      const resolution = resolveClaudeCliExecutableDetailed(
        { PATH: '', BATSHIT_CLAUDE_CLI_PATH: envExecutable },
        path.join(tmp, 'home')
      )
      expect(resolution).toEqual({ executable: envExecutable, source: 'env' })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('prefers the managed install over PATH', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-status-'))
    try {
      const pathExecutable = path.join(tmp, 'claude')
      await writeFile(pathExecutable, '#!/bin/sh\nexit 0\n')
      await chmod(pathExecutable, 0o755)
      const managedExecutable = await seedManagedClaudeInstall()

      const resolution = resolveClaudeCliExecutableDetailed({ PATH: tmp }, path.join(tmp, 'home'))
      expect(resolution.executable).toBe(managedExecutable)
      expect(resolution.source).toBe('managed')
      expect(resolution.managedVersion).toBe(MANAGED_CLI_PINNED_VERSIONS.claude)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('falls back to PATH, then well-known locations, then not-found', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-status-'))
    try {
      const pathExecutable = path.join(tmp, 'claude')
      await writeFile(pathExecutable, '#!/bin/sh\nexit 0\n')
      await chmod(pathExecutable, 0o755)

      expect(resolveClaudeCliExecutableDetailed({ PATH: tmp }, path.join(tmp, 'home'))).toEqual({
        executable: pathExecutable,
        source: 'path'
      })

      const home = path.join(tmp, 'home')
      const wellKnown = path.join(home, '.local', 'bin', 'claude')
      await mkdir(path.dirname(wellKnown), { recursive: true })
      await writeFile(wellKnown, '#!/bin/sh\nexit 0\n')
      await chmod(wellKnown, 0o755)

      expect(resolveClaudeCliExecutableDetailed({ PATH: '' }, home)).toEqual({
        executable: wellKnown,
        source: 'well-known'
      })

      expect(
        resolveClaudeCliExecutableDetailed({ PATH: '' }, path.join(tmp, 'empty-home'))
      ).toEqual({ executable: 'claude', source: 'not-found' })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('getClaudeCliExecutableCandidates', () => {
  it('includes the official native installer location first', () => {
    const candidates = getClaudeCliExecutableCandidates('/Users/example')
    expect(candidates[0]).toBe('/Users/example/.local/bin/claude')
    expect(candidates).toContain('/opt/homebrew/bin/claude')
    expect(candidates).toContain('/usr/local/bin/claude')
  })
})
