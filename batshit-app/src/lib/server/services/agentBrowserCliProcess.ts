import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'

export type AgentBrowserCliChild = ChildProcessByStdio<null, Readable, Readable>
export type AgentBrowserCliSpawnOptions = {
  cwd: string
  env: NodeJS.ProcessEnv
  stdio: ['ignore', 'pipe', 'pipe']
}
export type AgentBrowserCliTestSpawner = (
  command: string,
  args: string[],
  options: AgentBrowserCliSpawnOptions
) => AgentBrowserCliChild

let testSpawner: AgentBrowserCliTestSpawner | null = null
let testShell: string | null = null

/**
 * BL-2340: a broken fake must never fall through to an installed browser in Vitest.
 * Process tests supply a callback that admits only their exact owned fixture. The ordinary
 * runner still owns its environment, output, Stop and timeout; no live-browser flag is added.
 */
export function spawnAgentBrowserCliProcess(
  command: string,
  args: string[],
  options: AgentBrowserCliSpawnOptions
): AgentBrowserCliChild {
  if (process.env.VITEST === 'true') {
    if (!testSpawner) {
      throw new Error('Vitest refuses native Agent Browser execution without an exact test-owned child fixture.')
    }
    return testSpawner(command, args, options)
  }
  return spawn(command, args, options)
}

/** In-process test injection only; production execution cannot install this fixture seam. */
export function __setAgentBrowserCliTestSpawner(spawner: AgentBrowserCliTestSpawner | null): void {
  if (process.env.VITEST !== 'true') throw new Error('Agent Browser child fixture injection is available only under Vitest.')
  testSpawner = spawner
}

/** The existing browser Bash fixture fixes its shell and PATH before any command runs. */
export function assertAgentBrowserTestShell(shell: string): void {
  if (process.env.VITEST === 'true' && (testShell === null || shell !== testShell)) {
    throw new Error('Vitest refuses Agent Browser Bash without the exact test-owned shell fixture.')
  }
}

export function __setAgentBrowserTestShell(shell: string | null): void {
  if (process.env.VITEST !== 'true') throw new Error('Agent Browser shell fixture injection is available only under Vitest.')
  testShell = shell
}
