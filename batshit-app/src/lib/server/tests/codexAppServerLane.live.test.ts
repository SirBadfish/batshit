/**
 * LIVE smoke for the codex app-server lane — talks to the real `codex` binary
 * with the operator's ChatGPT auth and spends a small amount of model usage.
 *
 * Skipped unless BATSHIT_LIVE_CODEX=1. Run explicitly:
 *   BATSHIT_LIVE_CODEX=1 npx vitest run src/lib/server/tests/codexAppServerLane.live.test.ts
 *
 * Uses an isolated CODEX_HOME under /tmp with a symlinked auth.json (the
 * managed-home pattern); never touches ~/.codex itself.
 */
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { startCodexAppServerRun } from '../services/codexAppServerLane'

const LIVE = process.env.BATSHIT_LIVE_CODEX === '1'
const MODEL = 'gpt-5.6-sol'

function setupLiveEnv() {
  const root = mkdtempSync(join(tmpdir(), 'batshit-appserver-lane-live-'))
  const codexHome = join(root, 'codex-home')
  const workspace = join(root, 'workspace')
  mkdirSync(codexHome, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const realAuth = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(realAuth)) throw new Error('No ~/.codex/auth.json — cannot run live smoke')
  symlinkSync(realAuth, join(codexHome, 'auth.json'))
  writeFileSync(join(workspace, 'notes.txt'), 'The live smoke magic word is kumquat.\n')
  const executable =
    process.env.BATSHIT_CODEX_CLI_PATH ?? execSync('which codex', { encoding: 'utf8' }).trim()
  return {
    executable,
    env: { ...process.env, CODEX_HOME: codexHome },
    root,
    workspace,
  }
}

describe.runIf(LIVE)('codex app-server lane (LIVE)', () => {
  it(
    'completes a managed-style turn with mid-run usage and mapped events',
    { timeout: 120_000 },
    async () => {
      const { executable, env, root, workspace } = setupLiveEnv()
      const run = startCodexAppServerRun({
        executable,
        env,
        cwd: workspace,
        threadParams: {
          ephemeral: true,
          cwd: workspace,
          model: MODEL,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        },
        prompt:
          'Use the shell to read notes.txt, then reply with the magic word and nothing else.',
      })

      const events: any[] = []
      try {
        for await (const event of run.events) events.push(event)
      } finally {
        await run.cleanup().catch(() => undefined)
        rmSync(root, { recursive: true, force: true })
      }

      const types = events.map((e) => e.type)
      expect(types[0]).toBe('thread.started')
      expect(types).toContain('turn.started')
      expect(types).toContain('item.started')
      expect(types).toContain('item.completed')
      expect(types.at(-1)).toBe('turn.completed')
      const terminal = events.at(-1)
      expect(terminal.usage.input_tokens).toBeGreaterThan(0)
      const finalMessage = events
        .filter((e) => e.type === 'item.completed' && e.item?.type === 'agent_message')
        .at(-1)
      expect(String(finalMessage?.item?.text ?? '').toLowerCase()).toContain('kumquat')
      const commandItems = events.filter(
        (e) => e.type === 'item.completed' && e.item?.type === 'command_execution',
      )
      expect(commandItems.length).toBeGreaterThan(0)
      expect(commandItems[0].item.aggregated_output).toContain('kumquat')
    },
  )

  it(
    'accepts a mid-turn steer on the pinned app-server wire',
    { timeout: 120_000 },
    async () => {
      const { executable, env, root, workspace } = setupLiveEnv()
      const run = startCodexAppServerRun({
        executable,
        env,
        cwd: workspace,
        threadParams: {
          ephemeral: true,
          cwd: workspace,
          model: MODEL,
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        },
        prompt: 'Run the shell command `sleep 2`, then reply with ORIGINAL and nothing else.',
      })

      const events: any[] = []
      let steerResult: Awaited<ReturnType<typeof run.steer>> | null = null
      try {
        for await (const event of run.events) {
          events.push(event)
          if (
            !steerResult &&
            event.type === 'item.started' &&
            event.item?.type === 'command_execution'
          ) {
            steerResult = await run.steer({
              steerIds: ['live-pin-steer'],
              text: '[The user said, mid-reply: reply with PINEAPPLE and nothing else.]',
            })
          }
        }
      } finally {
        await run.cleanup().catch(() => undefined)
        rmSync(root, { recursive: true, force: true })
      }

      expect(steerResult).toMatchObject({ accepted: true })
      const finalMessage = events
        .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
        .at(-1)
      expect(String(finalMessage?.item?.text ?? '').toUpperCase()).toContain('PINEAPPLE')
    },
  )

  it('refuses a live run when the context guard threshold is below its supported floor', () => {
    const { executable, env, root, workspace } = setupLiveEnv()
    try {
      expect(() =>
        startCodexAppServerRun({
          executable,
          env,
          cwd: workspace,
          threadParams: {
            ephemeral: true,
            cwd: workspace,
            model: MODEL,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
          },
          prompt: 'This run must be rejected before the Codex process starts.',
          contextGuardThreshold: 0.01,
        }),
      ).toThrow(/threshold must be from 0\.5/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
