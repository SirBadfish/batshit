import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

// These tests exercise loader/derivation logic against stubbed fetch
// responses. The network guard (scheme/private-address/DNS enforcement) has
// its own dedicated suite in skillImportNetworkGuard.test.ts; here it is
// routed through the tests' global fetch stubs so fixtures keep working.
vi.mock('../skillImportNetworkGuard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../skillImportNetworkGuard')>()
  return {
    ...actual,
    assertSafeRemoteImportUrl: vi.fn(async (rawUrl: string) => new URL(rawUrl.trim())),
    guardedFetchText: vi.fn(async (rawUrl: string) => {
      const response = await (globalThis.fetch as typeof fetch)(rawUrl)
      if (!response?.ok) return null
      const text = await response.text()
      if (!text.trim()) return null
      return { text, contentType: response.headers?.get?.('content-type') || '' }
    })
  }
})

import { importSkillDefinition, parseAllowlistedInstallCommand } from '../skillImport'

const tempDirs: string[] = []
const execFile = promisify(execFileCb)

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (!dir) continue
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('parseAllowlistedInstallCommand', () => {
  it('parses npx install commands with --skill path', () => {
    const parsed = parseAllowlistedInstallCommand(
      'npx skills add vercel-labs/skills --skill skills/artifacts-general'
    )

    expect(parsed.packageName).toBe('skills')
    expect(parsed.source).toBe('vercel-labs/skills')
    expect(parsed.sourceType).toBe('github')
    expect(parsed.skillPath).toBe('skills/artifacts-general')
  })

  it('parses GitHub URL installs with bare --skill names', () => {
    const parsed = parseAllowlistedInstallCommand(
      'npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser'
    )

    expect(parsed.packageName).toBe('skills')
    expect(parsed.source).toBe('https://github.com/vercel-labs/agent-browser')
    expect(parsed.sourceType).toBe('github')
    expect(parsed.skillPath).toBe('agent-browser')
  })

  it('rejects chained shell commands', () => {
    expect(() =>
      parseAllowlistedInstallCommand('npx skills add owner/repo --skill foo; rm -rf /')
    ).toThrow(/chained\/shell operators/i)
  })

  it('rejects unsupported flags', () => {
    expect(() =>
      parseAllowlistedInstallCommand('npx skills add owner/repo --unsafe true')
    ).toThrow(/unsupported flag/i)
  })
})

describe('importSkillDefinition', () => {
  it('imports local SKILL.md with dependencies and script/reference detection', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-import-test-'))
    tempDirs.push(tempRoot)

    const skillDir = path.join(tempRoot, 'artifacts-general')
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await fs.mkdir(path.join(skillDir, 'references'), { recursive: true })
    await fs.mkdir(path.join(skillDir, 'assets'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'scripts', 'run.sh'), 'echo "artifact build"\n', 'utf8')
    await fs.writeFile(path.join(skillDir, 'references', 'guide.md'), '# Guide\n', 'utf8')
    await fs.writeFile(path.join(skillDir, 'assets', 'logo.bin'), Buffer.from([0, 1, 2, 3]))

    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
description: Build artifact workflows safely
dependencies: [n8n_mcp, web_search]
---
# Artifacts General

Use this workflow to build and iterate artifact prototypes.
`,
      'utf8'
    )

    const result = await importSkillDefinition({
      sourceType: 'local',
      source: skillDir
    })

    expect(result.skill.id).toBe('artifacts_general')
    expect(result.skill.displayName).toBe('Artifacts General')
    expect(result.skill.description).toContain('Build artifact workflows safely')
    expect(result.skill.dependencies.map((dep) => dep.id)).toEqual(['n8n_mcp', 'web_search'])
    expect(result.skill.hasScripts).toBe(true)
    expect(result.skill.hasReferences).toBe(true)
    expect(result.skill.hasAssets).toBe(true)
    expect(result.skill.bundleManifest?.file_count).toBe(3)
    expect(result.skill.bundleManifest?.script_count).toBe(1)
    expect(result.skill.bundleManifest?.reference_count).toBe(1)
    expect(result.skill.bundleManifest?.asset_count).toBe(1)
    expect(result.skill.standardsStatus).toBe('degraded')
    expect(result.skill.standardsIssues.length).toBeGreaterThan(0)
    expect(result.skill.trustLevel).toBe('untrusted')
    expect(
      result.warnings.some((warning) =>
        warning.includes('references additional assets')
      )
    ).toBe(true)
  })

  it('honors skillPath for URL imports and surfaces source reference warning', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://example.com/repo/skills/artifacts-general/SKILL.md') {
        return new Response(
          '# Artifacts General\n\nUse this skill for artifact-building workflows.',
          { status: 200 }
        )
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const result = await importSkillDefinition({
      sourceType: 'url',
      source: 'https://example.com/repo',
      skillPath: 'skills/artifacts-general'
    })

    expect(result.skill.sourceRef).toBe('https://example.com/repo/skills/artifacts-general/SKILL.md')
    expect(
      result.warnings.some((warning) =>
        warning.includes('Source reference: https://example.com/repo/skills/artifacts-general/SKILL.md')
      )
    ).toBe(true)
  })

  it('parses optional standards fields from frontmatter', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-import-test-'))
    tempDirs.push(tempRoot)

    const skillDir = path.join(tempRoot, 'skills', 'agent-browser')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: agent-browser
description: Browser automation skill for Batshit
license: MIT
compatibility: batshit>=0.0.1
allowed-tools: native_bash_execute native_dynamic_mcp_use
metadata:
  author: Batshit
  category: browser
---
# Agent Browser

Use this skill for browser automation workflows.
`,
      'utf8'
    )

    const result = await importSkillDefinition({
      sourceType: 'local',
      source: skillDir
    })

    expect(result.skill.name).toBe('agent-browser')
    expect(result.skill.license).toBe('MIT')
    expect(result.skill.compatibility).toBe('batshit>=0.0.1')
    expect(result.skill.allowedTools).toEqual(['native_bash_execute', 'native_dynamic_mcp_use'])
    expect(result.skill.metadata).toEqual({ author: 'Batshit', category: 'browser' })
    expect(result.skill.standardsStatus).toBe('full')
    expect(result.skill.standardsIssues).toEqual([])
  })

  it('parses allowed-tools values that include spaces inside Bash(...) entries', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-import-test-'))
    tempDirs.push(tempRoot)

    const skillDir = path.join(tempRoot, 'skills', 'agent-browser-spaced')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: agent-browser-spaced
description: Browser automation skill with spaced allowed-tools entries
allowed-tools: Bash(npx agent-browser:*), Bash(agent-browser:*)
---
# Agent Browser Spaced

Use this skill for browser automation workflows.
`,
      'utf8'
    )

    const result = await importSkillDefinition({
      sourceType: 'local',
      source: skillDir
    })

    expect(result.skill.allowedTools).toEqual(['Bash(npx agent-browser:*)', 'Bash(agent-browser:*)'])
  })

  it('falls back to skills/<name> path for GitHub imports when --skill uses a bare name', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md') {
        return new Response(
          '# Agent Browser\n\nUse this skill for browser automation workflows.',
          { status: 200 }
        )
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const result = await importSkillDefinition({
      sourceType: 'github',
      source: 'https://github.com/vercel-labs/agent-browser',
      skillPath: 'agent-browser'
    })

    expect(result.skill.id).toBe('agent_browser')
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/main/agent-browser/SKILL.md')
      )
    ).toBe(true)
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/main/skills/agent-browser/SKILL.md')
      )
    ).toBe(true)
  })

  it('falls back to skills/<name> path for local imports when skillPath is a bare name', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-import-test-'))
    tempDirs.push(tempRoot)

    const skillDir = path.join(tempRoot, 'skills', 'agent-browser')
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      '# Agent Browser\n\nUse this skill for browser automation workflows.',
      'utf8'
    )

    const result = await importSkillDefinition({
      sourceType: 'local',
      source: tempRoot,
      skillPath: 'agent-browser'
    })

    expect(result.skill.id).toBe('agent_browser')
    expect(result.skill.sourceRef).toBe(`${tempRoot}#agent-browser`)
  })

  it('imports git source with bundled files from a local repository clone path', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-git-source-'))
    tempDirs.push(repoRoot)

    const skillDir = path.join(repoRoot, 'skills', 'git-skill')
    await fs.mkdir(path.join(skillDir, 'scripts'), { recursive: true })
    await fs.writeFile(path.join(skillDir, 'scripts', 'run.sh'), 'echo "from git"\n', 'utf8')
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
description: Imported from git source
---
# Git Skill
`,
      'utf8'
    )

    await execFile('git', ['init'], { cwd: repoRoot })
    await execFile('git', ['add', '.'], { cwd: repoRoot })
    await execFile(
      'git',
      ['-c', 'user.email=test@batshit.ai', '-c', 'user.name=Batshit Room Test', 'commit', '-m', 'init'],
      { cwd: repoRoot }
    )

    const result = await importSkillDefinition({
      sourceType: 'git',
      source: repoRoot,
      skillPath: 'skills/git-skill'
    })

    expect(result.skill.id).toBe('git_skill')
    expect(result.skill.hasScripts).toBe(true)
    expect(result.skill.bundleManifest?.script_count).toBe(1)
    expect(result.warnings.some((warning) => warning.includes('Imported from git URL'))).toBe(true)
  })

  it('supports install-command end-to-end import path (parse + fetch)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://raw.githubusercontent.com/vercel-labs/agent-browser/main/skills/agent-browser/SKILL.md') {
        return new Response(
          '# Agent Browser\n\nUse this skill for browser automation workflows.',
          { status: 200 }
        )
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const result = await importSkillDefinition({
      source: 'placeholder',
      installCommand: 'npx skills add https://github.com/vercel-labs/agent-browser --skill agent-browser'
    })

    expect(result.skill.id).toBe('agent_browser')
    expect(result.skill.sourceRef).toBe('https://github.com/vercel-labs/agent-browser')
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/main/skills/agent-browser/SKILL.md')
      )
    ).toBe(true)
  })
})
