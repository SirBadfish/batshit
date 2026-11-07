// @vitest-environment node
/**
 * SA-139 P2: binding the one qualified Claude Code executable, its strict child environment and the
 * projection of `claude auth status --json`. Every executable here is a small shell script; the real
 * `claude` binary is never run and no model call is made. The hook-policy check reads only temp
 * folders passed to it, never the real system policy paths.
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  ClaudePlanExecutableError,
  assertClaudePlanExecutableUnchanged,
  bindClaudePlanExecutable,
  buildClaudePlanBaseEnv,
  checkClaudeCodeHookPolicy,
  clearClaudePlanExecutableCacheForTests,
  checkClaudePlanExecutable,
  CLAUDE_PLAN_AUTH_STATUS_ARGS,
  parseClaudeCodeVersion,
  projectClaudePlanAuthStatus,
  readClaudePlanAuthStatus
} from '../claudePlanExecutable'

const QUALIFIED = ['2.1.296']
const PLAN_JSON = '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","email":"a@b.c"}'
const folders: string[] = []

afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

beforeEach(() => clearClaudePlanExecutableCacheForTests())

function scratch(): string {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'sa139-exe-'))
  folders.push(folder)
  return folder
}

/**
 * A `#!/bin/sh` script that answers `--version` and, optionally, the sign-in read. It answers the sign-in
 * only in the run's shape, `--setting-sources "" auth status --json` (S11); a bare `auth status` gets no answer.
 */
const AUTH_SHAPE = '[ "$#" -eq 5 ] && [ -z "$2" ] && [ "$3" = auth ] && [ "$4" = status ] && [ "$5" = --json ] || exit 9'
function script(options: { version?: string; auth?: string; authExit?: number; mode?: number } = {}): string {
  const file = path.join(scratch(), 'claude')
  const body = [
    '#!/bin/sh',
    'case "$1" in',
    `  --version) echo '${options.version ?? '2.1.296 (Claude Code)'}' ;;`,
    `  --setting-sources) ${AUTH_SHAPE}; echo '${options.auth ?? PLAN_JSON}'; exit ${options.authExit ?? 0} ;;`,
    'esac',
    ''
  ].join('\n')
  writeFileSync(file, body)
  chmodSync(file, options.mode ?? 0o755)
  return file
}

const bind = (executable: string, qualifiedVersions: readonly string[] = QUALIFIED) =>
  bindClaudePlanExecutable({ resolution: { executable, source: 'env' }, runAs: {}, qualifiedVersions })

async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try { await run() } catch (error) { return error instanceof ClaudePlanExecutableError ? error.code : `other:${String(error)}` }
  return undefined
}

describe('parseClaudeCodeVersion', () => {
  it('reads the documented `<version> (Claude Code)` line', () => {
    expect(parseClaudeCodeVersion('2.1.296 (Claude Code)\n')).toBe('2.1.296')
  })

  it('reads anything else as unreadable', () => {
    for (const output of ['2.1.296', 'Claude Code 2.1.296', '', 'nonsense']) expect(parseClaudeCodeVersion(output), output).toBeNull()
  })
})

describe('bindClaudePlanExecutable', () => {
  it('binds the version, sha256, real path and size of the file', async () => {
    const file = script()
    const bound = await bind(file)
    expect(bound.version).toBe('2.1.296')
    expect(bound.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(bound.sha256).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'))
    expect(bound.realPath).toBe(realpathSync(file))
    expect(bound.size).toBe(readFileSync(file).length)
    expect(bound.source).toBe('env')
  })

  it('records the real path when bound through a symlink', async () => {
    const file = script()
    const link = path.join(scratch(), 'claude-link')
    symlinkSync(file, link)
    const bound = await bind(link)
    expect(bound.requestedPath).toBe(link)
    expect(bound.realPath).toBe(realpathSync(file))
  })

  it('refuses a missing install as not_found', async () => {
    expect(await codeOf(() => bindClaudePlanExecutable({ resolution: { executable: 'claude', source: 'not-found' }, runAs: {} }))).toBe('not_found')
  })

  it('refuses a missing path or a file without execute permission as not_executable', async () => {
    expect(await codeOf(() => bind(path.join(scratch(), 'nope')))).toBe('not_executable')
    expect(await codeOf(() => bind(script({ mode: 0o644 })))).toBe('not_executable')
  })

  it('refuses output that is not a Claude Code version as version_unreadable', async () => {
    expect(await codeOf(() => bind(script({ version: 'nonsense' })))).toBe('version_unreadable')
  })

  it('refuses a version outside the qualified list, and binds when it is listed', async () => {
    const file = script({ version: '2.1.303 (Claude Code)' })
    expect(await codeOf(() => bindClaudePlanExecutable({ resolution: { executable: file, source: 'env' }, runAs: {} }))).toBe('version_unqualified')
    expect((await bind(file, ['2.1.303'])).version).toBe('2.1.303')
  })
})

describe('checkClaudePlanExecutable (display readiness: no evidence hash; lead, 2026-10-27)', () => {
  it('binds path, identity and qualified version without hashing, reusing the version per identity; admission still hashes', async () => {
    const calls = path.join(scratch(), 'calls')
    const file = path.join(scratch(), 'claude')
    writeFileSync(file, ['#!/bin/sh', 'case "$1" in', `  --version) echo v >> '${calls}'; echo '2.1.296 (Claude Code)' ;;`, `  --setting-sources) ${AUTH_SHAPE}; echo '${PLAN_JSON}' ;;`, 'esac', ''].join('\n'))
    chmodSync(file, 0o755)
    const check = (qualifiedVersions: readonly string[] = QUALIFIED) =>
      checkClaudePlanExecutable({ resolution: { executable: file, source: 'env' }, runAs: {}, qualifiedVersions })
    const versionReads = () => readFileSync(calls, 'utf8').trim().split('\n').length
    const checked = await check()
    expect(checked).toMatchObject({ version: '2.1.296', realPath: realpathSync(file), source: 'env' })
    expect('sha256' in checked).toBe(false)
    await check()
    expect(versionReads()).toBe(1)
    expect(await readClaudePlanAuthStatus(checked, {})).toEqual({ state: 'plan', subscriptionType: 'max' })
    expect((await bind(file)).sha256).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'))
    expect(versionReads()).toBe(1)
    expect(await codeOf(() => check(['2.1.303']))).toBe('version_unqualified')
  })
})

describe('assertClaudePlanExecutableUnchanged', () => {
  it('passes right after binding', async () => {
    await expect(assertClaudePlanExecutableUnchanged(await bind(script()))).resolves.toBeUndefined()
  })

  it('throws changed after the file is rewritten', async () => {
    const file = script()
    const bound = await bind(file)
    writeFileSync(file, '#!/bin/sh\necho "2.1.296 (Claude Code)"\n# replaced\n')
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    expect(await codeOf(() => assertClaudePlanExecutableUnchanged(bound))).toBe('changed')
  })
})

describe('buildClaudePlanBaseEnv', () => {
  it('carries exactly the allowlisted keys, with PATH starting at the running node', () => {
    const env = buildClaudePlanBaseEnv({})
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER'])
    expect(env.PATH.startsWith(path.dirname(process.execPath))).toBe(true)
    expect(env.TMPDIR).toBe(os.tmpdir())
  })

  it('never passes the app environment through', () => {
    const secrets = { ANTHROPIC_API_KEY: 'sk-test', BATSHIT_TOKEN: 'bt-test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' }
    const saved = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]))
    Object.assign(process.env, secrets)
    try {
      const env = buildClaudePlanBaseEnv({})
      for (const key of Object.keys(secrets)) expect(env, key).not.toHaveProperty(key)
      expect(Object.values(env)).not.toContain('sk-test')
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('uses the run-as identity for HOME, USER, LOGNAME and a fixed TMPDIR', () => {
    const env = buildClaudePlanBaseEnv({ uid: 1234, home: '/home/x', user: 'x', shell: '/bin/sh' })
    expect(env).toMatchObject({ HOME: '/home/x', USER: 'x', LOGNAME: 'x', SHELL: '/bin/sh', TMPDIR: '/tmp' })
  })
})

describe('projectClaudePlanAuthStatus', () => {
  const plan = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'a@b.c' }
  const refusedCode = (raw: unknown) => { const status = projectClaudePlanAuthStatus(raw); return status.state === 'refused' ? status.code : status.state }

  it('keeps only the plan facts, never the email', () => {
    const status = projectClaudePlanAuthStatus(plan)
    expect(status).toEqual({ state: 'plan', subscriptionType: 'max' })
    expect(status).not.toHaveProperty('email')
  })

  it('refuses each way of not being on a first-party Claude plan', () => {
    expect(refusedCode({ ...plan, loggedIn: false })).toBe('signed_out')
    expect(refusedCode({ ...plan, authMethod: 'api_key' })).toBe('api_key')
    expect(refusedCode({ ...plan, authMethod: 'api_key_helper' })).toBe('api_key')
    expect(refusedCode({ ...plan, authMethod: 'oauth_token' })).toBe('oauth_token')
    expect(refusedCode({ ...plan, authMethod: 'third_party' })).toBe('third_party')
    expect(refusedCode({ ...plan, apiProvider: 'bedrock' })).toBe('not_first_party')
    expect(refusedCode({ ...plan, subscriptionType: '' })).toBe('unreadable')
    expect(refusedCode('nope')).toBe('unreadable')
    expect(refusedCode(null)).toBe('unreadable')
    expect(refusedCode([plan])).toBe('unreadable')
  })
})

describe('readClaudePlanAuthStatus', () => {
  it('reads a plan answer from the bound binary, leaving out user, project and local settings as the run does (S11)', async () => {
    const bound = await bind(script())
    expect(await readClaudePlanAuthStatus(bound, {})).toEqual({ state: 'plan', subscriptionType: 'max' })
    expect(CLAUDE_PLAN_AUTH_STATUS_ARGS).toEqual(['--setting-sources', '', 'auth', 'status', '--json'])
  })

  it('reads a signed-out answer that exits non-zero as signed_out', async () => {
    const bound = await bind(script({ auth: '{"loggedIn":false}', authExit: 1 }))
    const status = await readClaudePlanAuthStatus(bound, {})
    expect(status).toMatchObject({ state: 'refused', code: 'signed_out' })
  })
})

describe('checkClaudeCodeHookPolicy', () => {
  /** A temp policy folder; `files` maps a path under it to its content. */
  function policyDir(files: Record<string, string> = {}): string {
    const dir = scratch()
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, content)
    }
    return dir
  }
  const check = (dir: string | null) => checkClaudeCodeHookPolicy({ policyDir: dir, managedPreferences: [] })

  it('finds nothing when the folder holds no policy files', async () => {
    expect(await check(policyDir())).toBeNull()
  })

  it('names disableAllHooks and the file when managed-settings.json sets it', async () => {
    const dir = policyDir({ 'managed-settings.json': '{"disableAllHooks": true}' })
    const message = await check(dir)
    expect(message).toContain('disableAllHooks')
    expect(message).toContain(path.join(dir, 'managed-settings.json'))
  })

  it('names allowManagedHooksOnly set by a managed-settings.d drop-in', async () => {
    const dir = policyDir({ 'managed-settings.d/20-x.json': '{"allowManagedHooksOnly": true}' })
    const message = await check(dir)
    expect(message).toContain('allowManagedHooksOnly')
    expect(message).toContain(path.join(dir, 'managed-settings.d', '20-x.json'))
  })

  it('counts only the boolean true', async () => {
    expect(await check(policyDir({ 'managed-settings.json': '{"disableAllHooks": false, "allowManagedHooksOnly": false}' }))).toBeNull()
    expect(await check(policyDir({ 'managed-settings.json': '{"disableAllHooks": "true"}' }))).toBeNull()
    expect(await check(policyDir({ 'managed-settings.json': '{"allowManagedHooksOnly": 1}' }))).toBeNull()
  })

  it('ignores a hidden drop-in and a drop-in that is not .json', async () => {
    const dir = policyDir({
      'managed-settings.d/.x.json': '{"disableAllHooks": true}',
      'managed-settings.d/20-x.txt': '{"disableAllHooks": true}',
      'managed-settings.d/20-x.json.bak': '{"disableAllHooks": true}'
    })
    expect(await check(dir)).toBeNull()
  })

  it('skips a file that is not valid JSON and still reads the next one', async () => {
    expect(await check(policyDir({ 'managed-settings.json': '{ not json' }))).toBeNull()
    const dir = policyDir({
      'managed-settings.json': '{ not json',
      'managed-settings.d/10-bad.json': '[1, 2',
      'managed-settings.d/20-x.json': '{"disableAllHooks": true}'
    })
    expect(await check(dir)).toContain(path.join(dir, 'managed-settings.d', '20-x.json'))
  })

  it('reads nothing from a document that is not an object', async () => {
    expect(await check(policyDir({ 'managed-settings.json': 'true', 'managed-settings.d/20-x.json': 'null' }))).toBeNull()
  })

  it('reads no folder and no preferences when told none', async () => {
    expect(await checkClaudeCodeHookPolicy({ policyDir: null, managedPreferences: [] })).toBeNull()
  })

  it.skipIf(process.platform !== 'darwin')('names allowManagedHooksOnly from a managed-preferences plist, and finds nothing for a missing plist', async () => {
    const plist = path.join(scratch(), 'com.anthropic.claudecode.plist')
    writeFileSync(plist, [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict><key>allowManagedHooksOnly</key><true/></dict></plist>',
      ''
    ].join('\n'))
    const message = await checkClaudeCodeHookPolicy({ policyDir: null, managedPreferences: [plist] })
    expect(message).toContain('allowManagedHooksOnly')
    expect(message).toContain(plist)
    expect(await checkClaudeCodeHookPolicy({ policyDir: null, managedPreferences: [path.join(scratch(), 'missing.plist')] })).toBeNull()
  })
})

describe('buildClaudePlanBaseEnv proxies (Faye S7)', () => {
  const PROXY = { HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', https_proxy: 'http://p', ANTHROPIC_BASE_URL: 'https://relay', BATSHIT_TOKEN: 'x' }

  it('passes the standard proxy names by name in the Docker app container only', () => {
    const docker = buildClaudePlanBaseEnv({}, { ...PROXY, BATSHIT_CONTAINERIZED: 'true', LANG: 'C.UTF-8' })
    expect(docker).toMatchObject({ HTTPS_PROXY: 'http://proxy:3128', HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', https_proxy: 'http://p', LANG: 'C.UTF-8' })
    expect(docker).not.toHaveProperty('ANTHROPIC_BASE_URL')
    expect(docker).not.toHaveProperty('BATSHIT_TOKEN')
    const native = buildClaudePlanBaseEnv({}, { ...PROXY })
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'ANTHROPIC_BASE_URL', 'BATSHIT_TOKEN']) expect(native).not.toHaveProperty(name)
  })
})
