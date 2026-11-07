import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { redis } from '$lib/server/redis'

/**
 * The Bash tool's workspace root (moved from `nativeTools.ts` for SA-137): the configured root,
 * else the chat's project path, else the user's Default Project Directory, each an existing
 * directory by its real path. SA-137's live file reads admit the same root at turn start, so the
 * compile and the Bash tool never resolve two different roots.
 */

/** An existing directory's real path, or null. */
export async function resolveExistingDirectory(candidatePath: string): Promise<string | null> {
  const trimmed = candidatePath.trim()
  if (!trimmed) return null

  const resolved = path.resolve(trimmed)
  try {
    const info = await stat(resolved)
    if (!info.isDirectory()) return null
    try {
      return await realpath(resolved)
    } catch {
      return resolved
    }
  } catch {
    return null
  }
}

export async function resolveBashWorkspaceRoot(options: {
  userId?: string
  projectPath?: string | null
  workspaceRoot?: string | null
}): Promise<{ workspaceRoot: string } | { blocked: true; reason: string }> {
  const explicitWorkspaceRoot =
    typeof options.workspaceRoot === 'string' ? options.workspaceRoot.trim() : ''
  if (explicitWorkspaceRoot) {
    const resolved = await resolveExistingDirectory(explicitWorkspaceRoot)
    if (!resolved) {
      return {
        blocked: true,
        reason: `Configured workspace root is not a valid directory: ${path.resolve(explicitWorkspaceRoot)}`
      }
    }
    return { workspaceRoot: resolved }
  }

  const explicitProjectPath =
    typeof options.projectPath === 'string' ? options.projectPath.trim() : ''
  if (explicitProjectPath) {
    const resolved = await resolveExistingDirectory(explicitProjectPath)
    if (!resolved) {
      return {
        blocked: true,
        reason:
          `Active project path is invalid: ${path.resolve(explicitProjectPath)}. ` +
          'Select a valid project in the Projects sidebar.'
      }
    }
    return { workspaceRoot: resolved }
  }

  if (options.userId) {
    try {
      const preferences = await redis.getProjectPreferences(options.userId)
      const defaultWorkspacePath = preferences?.default_workspace_path?.trim() ?? ''
      if (defaultWorkspacePath) {
        const resolved = await resolveExistingDirectory(defaultWorkspacePath)
        if (!resolved) {
          return {
            blocked: true,
            reason:
              `Default Project Directory is invalid: ${path.resolve(defaultWorkspacePath)}. ` +
              'Update it in Settings -> Projects.'
          }
        }
        return { workspaceRoot: resolved }
      }
    } catch (error) {
      console.error('[Native Tools] Failed to load project preferences for bash workspace:', error)
      return {
        blocked: true,
        reason: 'Unable to load Project preferences for bash workspace resolution.'
      }
    }
  }

  return {
    blocked: true,
    reason:
      'No active project is selected and no Default Project Directory is configured. ' +
      'Set a Default Project Directory in Settings -> Projects, or select a project in the sidebar.'
  }
}
