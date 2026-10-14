import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { nativeToolService } from '../nativeTools'
import { stripNativeCommandAuthorityFromChildEnv } from '../cliChildEnv'

const PROTECTED_NAMES = [
  'BATSHIT_TOKEN',
  'BATSHIT_AGENT_TOKEN',
  'MCP_GATEWAY_AUTH_TOKEN',
  'DOCKER_MCP_AUTH_TOKEN',
  'DOCKER_MCP_GATEWAY_TOKEN',
  'BATSHIT_DOCKER_MCP_TOKEN',
  'BATSHIT_AUDIO2FACE_BRIDGE_TOKEN',
  'BATSHIT_N8N_INSTANCE_MCP_TOKEN',
  'BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN',
  'BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN',
  'BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN',
  'BATSHIT_HOST_VOICE_RECIPE_SIGNING_KEY',
  'BATSHIT_HOST_VOICE_RECIPE_KEY_FILE'
] as const
const TEST_ENV_NAMES = [...PROTECTED_NAMES, 'BL420_CUSTOM_TOOL_ENV', 'BATSHIT_AGENT_BROWSER_BIN', 'BL420_REPORT_PATH']

type ChildReport = {
  protectedPresent: string[]
  pathPresent: boolean
  homePresent: boolean
  customPreserved: boolean
}

let workspace: string | null = null
let previousEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  previousEnv = Object.fromEntries(TEST_ENV_NAMES.map((name) => [name, process.env[name]]))
  for (const name of PROTECTED_NAMES) process.env[name] = `bl420-sentinel-${name}`
  process.env.BL420_CUSTOM_TOOL_ENV = 'bl420-custom-sentinel'
})

afterEach(async () => {
  for (const name of TEST_ENV_NAMES) {
    const previous = previousEnv[name]
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
  if (workspace) await rm(workspace, { recursive: true, force: true })
  workspace = null
})

async function makeProbe() {
  workspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-env-'))
  const probe = path.join(workspace, 'probe.mjs')
  await writeFile(probe, `
import { writeFileSync } from 'node:fs'
if (process.argv[2] === '--version') {
  console.log('agent-browser 0.37.1')
  process.exit(0)
}
const protectedNames = ${JSON.stringify(PROTECTED_NAMES)}
const report = {
  protectedPresent: protectedNames.filter((name) => Object.hasOwn(process.env, name)),
  pathPresent: Boolean(process.env.PATH),
  homePresent: Boolean(process.env.HOME),
  customPreserved: process.env.BL420_CUSTOM_TOOL_ENV === 'bl420-custom-sentinel'
}
if (process.argv[2] === '--agent-browser') {
  writeFileSync(process.env.BL420_REPORT_PATH, JSON.stringify(report))
  console.log(JSON.stringify({ success: true, data: { title: 'Environment checked' } }))
} else {
  console.log(JSON.stringify(report))
}
`)
  return { dir: workspace, probe }
}

function expectSafeChild(report: ChildReport) {
  // The child reports names and booleans only; no credential value enters test output.
  expect(report).toEqual({
    protectedPresent: [],
    pathPresent: true,
    homePresent: true,
    customPreserved: true
  })
}

describe('BL-420 local native command child environments', () => {
  it('removes inherited authority in a real API Bash child while preserving ordinary tool environment', async () => {
    const { dir, probe } = await makeProbe()
    const result = await nativeToolService.nativeBashExecute({
      command: `"${process.execPath}" "${probe}"`,
      workspaceRoot: dir,
      cwd: dir,
      accessMode: 'dangerous',
      backend: 'local',
      requireApproval: false
    })

    expect(result.success).toBe(true)
    expectSafeChild(JSON.parse(result.stdout.trim()) as ChildReport)
  })

  it('removes inherited authority in a fake local Agent Browser child', async () => {
    const { dir, probe } = await makeProbe()
    const bin = path.join(dir, 'agent-browser')
    const reportPath = path.join(dir, 'agent-browser-env.json')
    await writeFile(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec "${process.execPath}" "${probe}" --version; fi\nexec "${process.execPath}" "${probe}" --agent-browser "$@"\n`)
    await chmod(bin, 0o755)
    process.env.BATSHIT_AGENT_BROWSER_BIN = bin
    process.env.BL420_REPORT_PATH = reportPath

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'get title',
      params: {},
      settings: { liveViewEnabled: false }
    } as any)

    expect(result.success).toBe(true)
    expectSafeChild(JSON.parse(await readFile(reportPath, 'utf8')) as ChildReport)
  })

  it('filters the final merged environment so an override cannot restore protected authority', async () => {
    const { dir, probe } = await makeProbe()
    const finalEnv = stripNativeCommandAuthorityFromChildEnv({
      ...process.env,
      ...Object.fromEntries(PROTECTED_NAMES.map((name) => [name, `bl420-override-${name}`])),
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BL420_CUSTOM_TOOL_ENV: 'bl420-custom-sentinel'
    })
    const child = spawnSync(process.execPath, [probe], { cwd: dir, env: finalEnv, encoding: 'utf8' })

    expect(child.status).toBe(0)
    expectSafeChild(JSON.parse(child.stdout.trim()) as ChildReport)
    expect(finalEnv.PATH).toBe(process.env.PATH)
    expect(finalEnv.HOME).toBe(process.env.HOME)
  })
})
