import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'

// GET /api/agents/[id]/fix - Fix double-encoded agent data
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		const storage = await service.readAgentRecordStorage(params.id!)

		if (storage.type === 'none') {
			return json({ error: 'Agent not found' }, { status: 404 })
		}
		if (storage.type === 'other') {
			return json({ error: 'The agent record is not stored as JSON and cannot be fixed here.' }, { status: 409 })
		}

		let agentData: Record<string, any>
		if (storage.type === 'json') {
			// Already an object
			agentData = storage.record as Record<string, any>
		} else if (storage.raw.startsWith('"{')) {
			// It's double-encoded, parse it twice
			agentData = JSON.parse(JSON.parse(storage.raw))
		} else {
			// Normal JSON string, parse once
			agentData = JSON.parse(storage.raw)
		}

		// Verify ownership
		if (agentData?.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		// BL-770: a record already stored as a JSON object is left alone. Writing it back whole took
		// back any save made between this read and the write.
		if (storage.type === 'json') {
			return json({ success: true, message: 'Agent data is already stored correctly', agent: agentData })
		}

		// Only a record still stored as the same string is replaced, in one step inside Redis (a
		// string key cannot take a JSON write; the old `set` here failed with the wrong-type error).
		if (!(await service.replaceStringAgentRecord(params.id!, storage.raw, agentData))) {
			return json({ error: 'The agent record changed while it was being fixed. Try again.' }, { status: 409 })
		}

		return json({ 
			success: true, 
			message: 'Agent data fixed',
			agent: agentData 
		})
	} catch (error) {
		console.error('Failed to fix agent:', error)
		return json({ error: 'Failed to fix agent' }, { status: 500 })
	}
}
