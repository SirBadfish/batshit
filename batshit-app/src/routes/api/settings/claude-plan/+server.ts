import { json, type RequestHandler } from '@sveltejs/kit'
import { requireUser } from '$lib/server/services/routeSecurity'
import { readClaudePlanDisplayStatus } from '$lib/server/services/claudePlanReadiness'

/**
 * SA-139 (D1, D2): the Claude plan connection card's status. A read for the signed-in user: the
 * qualified Claude Code executable, its Claude plan sign-in, the existing Docker-aware sign-in command,
 * and whether this build can run the connection. It installs nothing, signs in to nothing and makes no
 * model call. `?fresh=1` (Check Again) looks again instead of reusing the short-lived display read.
 * The card words each status itself; Claude Code's reasons and paths stay in the server log.
 */
const SIGN_IN_CODES = new Set(['signed_out', 'not_plan', 'status_unreadable'])

export const GET: RequestHandler = async ({ locals, url }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  try {
    const status = await readClaudePlanDisplayStatus({ fresh: url.searchParams.get('fresh') === '1' })
    if (status.state === 'ready') {
      const version = /\d+\.\d+\.\d+/.exec(status.version ?? '')?.[0]
      return json({ state: 'ready', installed: true, ...(version ? { version } : {}) }, { headers: { 'cache-control': 'no-store' } })
    }
    console.debug(`[claude-plan] Status ${status.code}: ${status.reason}`)
    return json({ state: 'unavailable', installed: status.installed, code: status.code,
      ...(SIGN_IN_CODES.has(status.code) && status.setupCommand ? { setupCommand: status.setupCommand, setupContext: status.setupContext,
        ...(status.setupWorkingDirectory ? { setupWorkingDirectory: status.setupWorkingDirectory } : {}) } : {}) }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[claude-plan] Status read failed:', error)
    return json({ error: 'Batshit could not read Claude Code status. Try again.' }, { status: 500, headers: { 'cache-control': 'no-store' } })
  }
}
