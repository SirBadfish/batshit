import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

// Use only system shell paths. A workspace-controlled PATH or SHELL must not choose the
// interpreter for an agent command.
const LOCAL_COMMAND_SHELLS = ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash'] as const

/** Select one installed shell for a local command; the caller keeps it for any retries. */
export async function resolveLocalCommandShell(): Promise<string> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Local shell execution requires macOS or Linux. Select Docker Sandbox on this platform.')
  }

  for (const shellPath of LOCAL_COMMAND_SHELLS) {
    try {
      const details = await stat(shellPath)
      if (!details.isFile()) continue
      await access(shellPath, constants.X_OK)
      return shellPath
    } catch {
      // Try the next trusted system path when this shell is absent or cannot execute.
    }
  }

  throw new Error(
    `Local shell execution needs an executable zsh or bash at ${LOCAL_COMMAND_SHELLS.join(', ')}. Install bash or select a sandbox backend.`
  )
}
