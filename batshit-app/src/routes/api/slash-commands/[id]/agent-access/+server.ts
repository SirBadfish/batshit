import { json, type RequestHandler } from '@sveltejs/kit'

import { redis } from '$lib/server/redis'
import {
  isOwnAgentOrSubagent,
  parseAgentAccessChange,
  setSlashCommandAgentAccess,
  slashCommandKey
} from '$lib/server/services/agentAccessLists'
import type { SlashCommandRow } from '$lib/types/database'

/**
 * PUT /api/slash-commands/[id]/agent-access: turn ONE agent or Subagent on or off for one Skill or
 * Prompt, body `{ agentId, enabled }` (Settings > Agents > Access, BL-544). The id is added to or
 * taken out of `enabled_agent_ids` as stored at that moment, in one step inside Redis; the other
 * agents' entries and the Enable For All Agents switch stay as they are. Answers the command as
 * stored and whether this call changed it.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user?.id
  if (!userId) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  const commandId = String(params.id ?? '').trim()
  if (!commandId) {
    return json({ error: 'Slash command id is required' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Send { agentId, enabled } as JSON.' }, { status: 400 })
  }
  const change = parseAgentAccessChange(body)
  if ('error' in change) {
    return json({ error: change.error }, { status: 400 })
  }

  try {
    if (change.enabled && !(await isOwnAgentOrSubagent(userId, change.agentId))) {
      return json(
        { error: `There is no agent or Subagent "${change.agentId}" to turn this on for.` },
        { status: 404 }
      )
    }

    const answer = await setSlashCommandAgentAccess(userId, commandId, change.agentId, change.enabled)
    if (answer === 'MISSING') {
      return json({ error: 'Slash command not found' }, { status: 404 })
    }
    const slashCommand = (await redis.json.get(slashCommandKey(userId, commandId))) as SlashCommandRow | null
    if (!slashCommand) {
      return json({ error: 'Slash command not found' }, { status: 404 })
    }
    return json({ slashCommand, changed: answer === 'OK' })
  } catch (error) {
    console.error('Error changing slash command agent access:', error)
    return json({ error: 'Failed to change who may use this command' }, { status: 500 })
  }
}
