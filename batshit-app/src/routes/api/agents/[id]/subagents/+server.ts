import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import type { SubagentRow } from '$lib/types/database'
import { normalizePrimaryAgentType, retiredPrimaryAgentRefusal } from '$lib/utils/primaryAgentType'
import {
	canonicalizeSubagentRecord,
	isRetiredSubagentType,
	isSubagentCompatibleWithPrimaryAgent,
	retiredSubagentRefusal,
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
				// SA-139 R2/R5 (D14): a record of a removed Subagent type (n8n, or the CLI Subagent) is
				// never listed as an assignment; it never runs, and the next save of the list drops it.
				if (!isRetiredSubagentType(subagent.subagentType)) subagents.push(subagent)
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
		// SA-139 R4 (D14): a leftover agent of a removed type can only be deleted.
		const retired = retiredPrimaryAgentRefusal(agent)
		if (retired) {
			return json({ error: retired.error, code: retired.code, details: retired.details }, { status: 409 })
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
			// SA-139 R2/R5 (D14): a removed Subagent type is never assigned; refused by type, readably,
			// before the list is replaced.
			const retired = retiredSubagentRefusal(subagent)
			if (retired) return json(retired, { status: 409 })
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

		// BL-770: write only the two assignment fields, by path (updateAgent's script stamps
		// updated_at). It wrote the whole record it read above, taking back any save made meanwhile.
		await service.updateAgent(params.id!, {
			assigned_subagent_ids: subagentIds,
			assignedSubagents: subagentIds
		} as any)

		return json({ success: true, subagentIds })
	} catch (error) {
		console.error('Failed to assign subagents:', error)
		return json({ error: 'Failed to assign subagents' }, { status: 500 })
	}
}
