import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { SubagentRow } from '$lib/types/database'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'
import { syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import {
	canonicalizeSubagentRecord,
	isSubagentCompatibleWithPrimaryAgent,
} from '$lib/utils/subagentType'

// GET /api/agents/[id]/subagents - Get all subagents assigned to an agent
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		
		// Verify agent ownership
		const agentData = await service.get(`agent:${params.id}`)
		if (!agentData) {
			return json({ error: 'Agent not found' }, { status: 404 })
		}

		const agent = agentData
		if (agent.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		// Get assigned subagent IDs
		const subagentIds = await service.sMembers(`agent:${params.id}:subagents`)
		
		if (!subagentIds || subagentIds.length === 0) {
			return json({ subagents: [] })
		}

		// Get subagent data
		const subagents: SubagentRow[] = []
		for (const id of subagentIds) {
			const subagentData = await service.json.get(`subagent:${id}`)
			if (subagentData) {
				const subagent = canonicalizeSubagentRecord(
					subagentData as Record<string, any>
				) as SubagentRow
				subagents.push(subagent)
			}
		}

		return json({ subagents })
	} catch (error) {
		console.error('Failed to get agent subagents:', error)
		return json({ error: 'Failed to get agent subagents' }, { status: 500 })
	}
}

// POST /api/agents/[id]/subagents - Assign subagents to an agent
export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		
		// Verify agent ownership
		const agentData = await service.get(`agent:${params.id}`)
		if (!agentData) {
			return json({ error: 'Agent not found' }, { status: 404 })
		}

		const agent = agentData
		if (agent.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		const { subagentIds } = await request.json()
		
		if (!Array.isArray(subagentIds)) {
			return json({ error: 'subagentIds must be an array' }, { status: 400 })
		}

		const primaryAgentType = normalizePrimaryAgentType(agent)
		for (const subagentId of subagentIds) {
			const subagentData = await service.json.get(`subagent:${subagentId}`)
			if (!subagentData) {
				return json(
					{ error: `Subagent "${subagentId}" was not found.` },
					{ status: 400 }
				)
			}

			const subagent = canonicalizeSubagentRecord(
				subagentData as Record<string, any>
			) as SubagentRow
			if (subagent.user_id !== locals.user.id) {
				return json({ error: 'Unauthorized' }, { status: 403 })
			}
			if (!isSubagentCompatibleWithPrimaryAgent(primaryAgentType, subagent)) {
				return json(
					{
						error: `${agent.displayName || 'This primary agent'} cannot use ${subagent.displayName || subagent.id}.`,
					},
					{ status: 400 }
				)
			}
		}

		// Clear existing associations
		await service.del(`agent:${params.id}:subagents`)
		
		// Add new associations
		if (subagentIds.length > 0) {
			for (const subagentId of subagentIds) {
				await service.sAdd(`agent:${params.id}:subagents`, subagentId)
			}
		}

		// Update agent's assigned_subagent_ids field
		agent.assigned_subagent_ids = subagentIds
		agent.assignedSubagents = subagentIds
		agent.updated_at = new Date().toISOString()
		await service.set(`agent:${params.id}`, agent)

		// Keep Mode 4 managed profiles in sync when subagent assignments change.
		// This ensures Codex/Claude stdio subagent bridge entries are added/removed immediately.
		try {
			await syncAgentCodexProfiles(locals.user.id)
			await syncAgentClaudeProfiles(locals.user.id)
		} catch (syncError) {
			console.warn('Subagent assignment saved but profile sync failed:', syncError)
		}

		return json({ success: true, subagentIds })
	} catch (error) {
		console.error('Failed to assign subagents:', error)
		return json({ error: 'Failed to assign subagents' }, { status: 500 })
	}
}
