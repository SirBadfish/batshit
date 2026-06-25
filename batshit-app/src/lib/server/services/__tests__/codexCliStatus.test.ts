import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  buildCodexLoginCommands,
  getCodexCliExecutableCandidates,
  isCodexLoginStatusAuthenticated,
  resolveDockerComposeWorkingDirectory,
  resolveCodexCliExecutable,
  resolveCodexCliExecutableDetailed
} from '../codexCliStatus'
import { MANAGED_CLI_PINNED_VERSIONS } from '../managedCliInstaller'

let isolatedInstallsRoot: string
let previousInstallsRoot: string | undefined

beforeEach(async () => {
  // Keep resolution tests independent of any real managed install on this machine.
  isolatedInstallsRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-installs-'))
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

async function seedManagedInstall(runtime: 'codex' | 'claude'): Promise<string> {
  const version = MANAGED_CLI_PINNED_VERSIONS[runtime]
  const versionRoot = path.join(isolatedInstallsRoot, 'cli', runtime, version)
  const executablePath = path.join(versionRoot, runtime)
  await mkdir(versionRoot, { recursive: true })
  await writeFile(executablePath, '#!/bin/sh\nexit 0\n')
  await chmod(executablePath, 0o755)
  await writeFile(
    path.join(versionRoot, 'batshit-managed-cli.json'),
    JSON.stringify({ runtime, version, executablePath })
  )
  return executablePath
}

describe('buildCodexLoginCommands', () => {
  it('uses native Codex login commands outside Docker', () => {
    expect(buildCodexLoginCommands({ containerized: false })).toEqual({
      context: 'native',
      loginCommand: 'codex login',
      statusCommand: 'codex login status'
    })
  })

  it('uses Docker Compose app exec commands inside Docker', () => {
    expect(
      buildCodexLoginCommands({
        containerized: true,
        n8nApiUrl: 'http://host.docker.internal:5678'
      })
    ).toEqual({
      context: 'docker',
      loginCommand: 'docker compose --env-file .env.docker exec app codex login --device-auth',
      statusCommand: 'docker compose --env-file .env.docker exec app codex login status'
    })
  })

  it('adds the n8n profile when bundled n8n is the runtime target', () => {
    expect(
      buildCodexLoginCommands({
        containerized: true,
        n8nApiUrl: 'http://n8n:5678'
      }).loginCommand
    ).toBe('docker compose --env-file .env.docker --profile n8n exec app codex login --device-auth')
  })

  it('adds the n8n profile when Compose profiles advertise it', () => {
    expect(
      buildCodexLoginCommands({
        containerized: true,
        composeProfiles: 'n8n'
      }).statusCommand
    ).toBe('docker compose --env-file .env.docker --profile n8n exec app codex login status')
  })
})

describe('isCodexLoginStatusAuthenticated', () => {
  it('does not treat "Not logged in" as authenticated', () => {
    expect(isCodexLoginStatusAuthenticated('Not logged in')).toBe(false)
  })

  it('accepts the logged-in Codex status text', () => {
    expect(isCodexLoginStatusAuthenticated('Logged in using ChatGPT')).toBe(true)
  })
})

describe('resolveDockerComposeWorkingDirectory', () => {
  it('uses the explicit Docker project folder before the workspace mount', () => {
    expect(
      resolveDockerComposeWorkingDirectory({
        BATSHIT_DOCKER_PROJECT_DIR: 'C:\\dev\\batshit',
        BATSHIT_WORKSPACE_MOUNT: 'D:\\workspace'
      })
    ).toBe('C:\\dev\\batshit')
  })

  it('falls back to the workspace mount and unwraps quoted env values', () => {
    expect(
      resolveDockerComposeWorkingDirectory({
        BATSHIT_WORKSPACE_MOUNT: '"C:\\dev\\batshit"'
      })
    ).toBe('C:\\dev\\batshit')
  })
})

describe('resolveCodexCliExecutable', () => {
  it('prefers a configured executable path', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-'))
    const executable = path.join(tmp, 'codex-custom')
    try {
      await writeFile(executable, '#!/bin/sh\nexit 0\n')
      await chmod(executable, 0o755)

      expect(
        resolveCodexCliExecutable(
          { PATH: '', BATSHIT_CODEX_CLI_PATH: executable },
          path.join(tmp, 'home')
        )
      ).toBe(executable)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('resolves codex from PATH before fallback candidates', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-'))
    const executable = path.join(tmp, 'codex')
    try {
      await writeFile(executable, '#!/bin/sh\nexit 0\n')
      await chmod(executable, 0o755)

      expect(resolveCodexCliExecutable({ PATH: tmp }, path.join(tmp, 'home'))).toBe(executable)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('keeps the Codex desktop app binary as the last native Mac fallback', () => {
    const candidates = getCodexCliExecutableCandidates('/Users/example')

    expect(candidates).toContain('/Applications/Codex.app/Contents/Resources/codex')
    expect(candidates.at(-1)).toBe('/Applications/Codex.app/Contents/Resources/codex')
    expect(candidates.indexOf('/usr/local/bin/codex')).toBeLessThan(
      candidates.indexOf('/Applications/Codex.app/Contents/Resources/codex')
    )
  })
})

describe('resolveCodexCliExecutableDetailed (resolution order)', () => {
  it('prefers an explicit env override even when a managed install exists', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-'))
    try {
      const envExecutable = path.join(tmp, 'codex-env')
      await writeFile(envExecutable, '#!/bin/sh\nexit 0\n')
      await chmod(envExecutable, 0o755)
      await seedManagedInstall('codex')

      const resolution = resolveCodexCliExecutableDetailed(
        { PATH: '', BATSHIT_CODEX_CLI_PATH: envExecutable },
        path.join(tmp, 'home')
      )
      expect(resolution).toEqual({ executable: envExecutable, source: 'env' })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('prefers the managed install over PATH', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-'))
    try {
      const pathExecutable = path.join(tmp, 'codex')
      await writeFile(pathExecutable, '#!/bin/sh\nexit 0\n')
      await chmod(pathExecutable, 0o755)
      const managedExecutable = await seedManagedInstall('codex')

      const resolution = resolveCodexCliExecutableDetailed({ PATH: tmp }, path.join(tmp, 'home'))
      expect(resolution.executable).toBe(managedExecutable)
      expect(resolution.source).toBe('managed')
      expect(resolution.managedVersion).toBe(MANAGED_CLI_PINNED_VERSIONS.codex)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('falls back to PATH when no override or managed install exists', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-'))
    try {
      const pathExecutable = path.join(tmp, 'codex')
      await writeFile(pathExecutable, '#!/bin/sh\nexit 0\n')
      await chmod(pathExecutable, 0o755)

      const resolution = resolveCodexCliExecutableDetailed({ PATH: tmp }, path.join(tmp, 'home'))
      expect(resolution).toEqual({ executable: pathExecutable, source: 'path' })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  it('only reaches well-known/not-found when env, managed, and PATH all miss', async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'codex-cli-status-'))
    try {
      // Some well-known candidates are absolute machine paths (e.g. the Codex
      // desktop app), so dev machines can legitimately resolve 'well-known'.
      const resolution = resolveCodexCliExecutableDetailed({ PATH: '' }, path.join(tmp, 'home'))
      expect(['well-known', 'not-found']).toContain(resolution.source)
      if (resolution.source === 'not-found') {
        expect(resolution.executable).toBe('codex')
      } else {
        expect(getCodexCliExecutableCandidates(path.join(tmp, 'home'))).toContain(
          resolution.executable
        )
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('buildCodexLoginCommands with managed executable paths', () => {
  it('embeds the managed executable path in native commands', () => {
    expect(
      buildCodexLoginCommands({
        containerized: false,
        executablePath: '/home/batshit-cli/.batshit/installs/cli/bin/codex'
      })
    ).toEqual({
      context: 'native',
      loginCommand: '/home/batshit-cli/.batshit/installs/cli/bin/codex login',
      statusCommand: '/home/batshit-cli/.batshit/installs/cli/bin/codex login status'
    })
  })

  it('embeds the managed executable path in Docker exec commands', () => {
    expect(
      buildCodexLoginCommands({
        containerized: true,
        executablePath: '/home/batshit-cli/.batshit/installs/cli/bin/codex'
      }).loginCommand
    ).toBe(
      'docker compose --env-file .env.docker exec app /home/batshit-cli/.batshit/installs/cli/bin/codex login --device-auth'
    )
  })
})
