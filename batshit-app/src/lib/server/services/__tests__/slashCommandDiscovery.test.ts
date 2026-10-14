import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * BL-1240: the chat bar's `/` menu reads Claude Code command and Codex prompt files. Their
 * frontmatter now goes through the shared reader (block descriptions, no keys made from a
 * block's lines) while this reader keeps its own value rules (`[file-path]` stays text).
 *
 * SAFETY: `node:os`'s `homedir()` is replaced before the module under test loads and throws
 * until the throwaway HOME exists, so no test reads the real `~/.claude` or `~/.codex`.
 */

const fake = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!fake.home) {
      throw new Error('slashCommandDiscovery.test: os.homedir() was called before the throwaway HOME existed')
    }
    return fake.home
  }
  return { ...actual, homedir, default: { ...actual, homedir } }
})

let discovery: typeof import('../slashCommandDiscovery')
let caseIndex = 0

beforeAll(async () => {
  const actualOs = await vi.importActual<typeof import('node:os')>('node:os')
  const tmpRoot = await realpath(actualOs.tmpdir())
  fake.home = await realpath(await mkdtemp(path.join(tmpRoot, 'bl1240-home-')))
  expect(fake.home).not.toBe(actualOs.homedir())

  // Both overrides would move the managed agents folder away from the throwaway HOME.
  vi.stubEnv('BATSHIT_HOME_DIR', '')
  vi.stubEnv('BATSHIT_AGENT_RUNTIME_ROOT', '')
  vi.resetModules()
  const { getManagedAgentRootDir } = await import('../batshitHome')
  expect(getManagedAgentRootDir()).toBe(path.join(fake.home, '.batshit', 'agents'))
  discovery = await import('../slashCommandDiscovery')
})

afterAll(async () => {
  vi.unstubAllEnvs()
  if (fake.home) await rm(fake.home, { recursive: true, force: true })
})

/** A fresh project folder and agent id per test, so the module's 30-second cache never answers. */
async function freshCase() {
  caseIndex += 1
  const projectPath = path.join(fake.home, `project-${caseIndex}`)
  const agentId = `agent-${caseIndex}`
  const managedRoot = path.join(fake.home, '.batshit', 'agents', `batshit_agent_agent-${caseIndex}`)
  return { projectPath, agentId, managedRoot }
}

async function writeFileIn(dir: string, name: string, contents: string) {
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, name), contents, 'utf8')
}

describe('slashCommandDiscovery frontmatter (BL-1240)', () => {
  it('reads a continued prompt description without changing invocation or bracket hints (BL-1239)', async () => {
    const { projectPath, agentId } = await freshCase()
    await writeFileIn(path.join(projectPath, '.codex', 'prompts'), 'continued.md', `---
description: "Read the full description
  invocation: /text-only"
argument-hint: [file-path]
metadata:
  notes: |-
    invocation: /nested-text
invocation: /actual
---
Read.
`)
    const commands = await discovery.discoverCodexCommands({ scope: 'managed', agentId, projectPath })
    expect(commands).toEqual([
      expect.objectContaining({
        invocation: '/actual',
        description: 'Read the full description invocation: /text-only',
        argumentHint: '[file-path]',
        source: 'codex', scope: 'project'
      })
    ])
  })

  it('shows the text of a folded Claude command description and keeps a bracket argument hint', async () => {
    const { projectPath, agentId } = await freshCase()
    await writeFileIn(
      path.join(projectPath, '.claude', 'commands'),
      'review.md',
      `---
description: >
  Review the open pull request: check tests,
  docs, and style.
argument-hint: [pr-number] [priority]
---
Review the pull request.
`
    )

    const commands = await discovery.discoverClaudeCommands({ scope: 'managed', agentId, projectPath })

    expect(commands).toEqual([
      expect.objectContaining({
        invocation: '/review',
        description: 'Review the open pull request: check tests, docs, and style.',
        argumentHint: '[pr-number] [priority]',
        source: 'claude',
        scope: 'project'
      })
    ])
  })

  it('reads a literal description of a managed Claude plugin command on one line, without keys from its lines', async () => {
    const { agentId, managedRoot } = await freshCase()
    await writeFileIn(
      path.join(managedRoot, '.claude', 'plugins', 'shipit', 'commands'),
      'deploy.md',
      `---
description: |
  Deploys the app.
    argument-hint: not a key
  Use it when: a release is tagged.
---
Deploy.
`
    )

    const commands = await discovery.discoverClaudeCommands({ scope: 'managed', agentId })

    expect(commands).toEqual([
      expect.objectContaining({
        invocation: '/shipit:deploy',
        description: 'Deploys the app. argument-hint: not a key Use it when: a release is tagged.',
        plugin: 'shipit',
        scope: 'managed'
      })
    ])
    expect(commands[0].argumentHint).toBeUndefined()
  })

  it('keeps a Codex prompt invocation when a block description holds an invocation line', async () => {
    const { projectPath, agentId, managedRoot } = await freshCase()
    const hijack = `---
description: |
  Summarize the diff.
  invocation: /hijack
---
Summarize.
`
    await writeFileIn(path.join(projectPath, '.codex', 'prompts'), 'summarize.md', hijack)
    await writeFileIn(path.join(managedRoot, '.codex', 'prompts'), 'recap.md', hijack)

    const commands = await discovery.discoverCodexCommands({ scope: 'managed', agentId, projectPath })

    expect(commands.map((command) => [command.invocation, command.scope, command.description])).toEqual([
      ['/prompts:summarize', 'project', 'Summarize the diff. invocation: /hijack'],
      ['/prompts:recap', 'managed', 'Summarize the diff. invocation: /hijack']
    ])
  })

  it('keeps a nested map line from overriding a Codex prompt invocation', async () => {
    const { agentId, managedRoot } = await freshCase()
    await writeFileIn(
      path.join(managedRoot, '.codex', 'prompts'),
      'notes.md',
      `---
description: Write release notes
metadata:
  invocation: /hijack
---
Notes.
`
    )

    const commands = await discovery.discoverCodexCommands({ scope: 'managed', agentId })

    expect(commands.map((command) => [command.invocation, command.description])).toEqual([
      ['/prompts:notes', 'Write release notes']
    ])
  })

  it('still honors a top-level Codex invocation', async () => {
    const { agentId, managedRoot } = await freshCase()
    await writeFileIn(
      path.join(managedRoot, '.codex', 'prompts'),
      'ship.md',
      `---
invocation: ship-it
description: "Ship it: tag and push"
argument-hint: [version]
---
Ship.
`
    )

    const commands = await discovery.discoverCodexCommands({ scope: 'managed', agentId })

    expect(commands).toEqual([
      expect.objectContaining({
        id: 'codex:/ship-it',
        invocation: '/ship-it',
        description: 'Ship it: tag and push',
        argumentHint: '[version]'
      })
    ])
  })

  it('keeps this reader\'s value rules: bracket text, JSON values and true stay as they were', async () => {
    const { projectPath, agentId } = await freshCase()
    const commandsDir = path.join(projectPath, '.claude', 'commands')
    await writeFileIn(commandsDir, 'a-bracket.md', '---\ndescription: true\nargument-hint: [file-path]\n---\nA.\n')
    await writeFileIn(commandsDir, 'b-json-list.md', '---\ndescription: Lists\nargument-hint: ["a", "b"]\n---\nB.\n')
    await writeFileIn(commandsDir, 'c-json-object.md', '---\ndescription: {"text": "object"}\n---\nC.\n')
    await writeFileIn(commandsDir, 'd-plain.md', "---\ndescription: 'Plain: quoted'\n---\nD.\n")

    const commands = await discovery.discoverClaudeCommands({ scope: 'managed', agentId, projectPath })
    const byName = Object.fromEntries(commands.map((command) => [command.name, command]))

    expect(byName['a-bracket']).toMatchObject({ description: 'true', argumentHint: '[file-path]' })
    expect(byName['b-json-list']).toMatchObject({ description: 'Lists' })
    expect(byName['b-json-list'].argumentHint).toBeUndefined()
    expect(byName['c-json-object'].description).toBeUndefined()
    expect(byName['d-plain']).toMatchObject({ description: 'Plain: quoted' })
  })

  it('reads a Windows-line-ending prompt and an all-indented frontmatter with an empty key', async () => {
    const { agentId, managedRoot } = await freshCase()
    const promptsDir = path.join(managedRoot, '.codex', 'prompts')
    await writeFileIn(
      promptsDir,
      'crlf.md',
      '---\r\ninvocation: crlf-go\r\ndescription: >\r\n  Folded on\r\n  Windows.\r\nargument-hint: [target]\r\n---\r\nGo.\r\n'
    )
    await writeFileIn(
      promptsDir,
      'indented.md',
      '---\n  description:\n  invocation: indented-go\n  argument-hint: [x]\n---\nGo.\n'
    )

    const commands = await discovery.discoverCodexCommands({ scope: 'managed', agentId })
    const byInvocation = Object.fromEntries(commands.map((command) => [command.invocation, command]))

    expect(Object.keys(byInvocation).sort()).toEqual(['/crlf-go', '/indented-go'])
    expect(byInvocation['/crlf-go']).toMatchObject({ description: 'Folded on Windows.', argumentHint: '[target]' })
    expect(byInvocation['/indented-go']).toMatchObject({ argumentHint: '[x]' })
    expect(byInvocation['/indented-go'].description).toBeUndefined()
  })
})
