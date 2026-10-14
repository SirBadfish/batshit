import os from 'node:os'
import path from 'node:path'

/** Shared installs, tools, workspaces and runtime records retain this root. */
export function getDefaultBatshitHomeDir(): string {
  return path.join(os.homedir(), '.batshit')
}

/** Lane-owned skill, voice, portable-skill and managed-profile files. No migration. */
export function getBatshitHomeDir(): string {
  const configured = process.env.BATSHIT_HOME_DIR?.trim()
  if (!configured) return getDefaultBatshitHomeDir()
  if (!path.isAbsolute(configured)) {
    throw new Error('BATSHIT_HOME_DIR must name an absolute folder.')
  }
  return path.resolve(configured)
}

/** The existing override names the parent home; both CLI lanes append agents. */
export function getManagedAgentRootDir(runtimeRoot = process.env.BATSHIT_AGENT_RUNTIME_ROOT): string {
  const configured = runtimeRoot?.trim()
  return path.join(configured ? path.resolve(configured) : getBatshitHomeDir(), 'agents')
}
