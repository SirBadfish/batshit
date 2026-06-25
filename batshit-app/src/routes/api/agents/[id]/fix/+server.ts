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
		
		// Get the potentially double-encoded data
		const rawData = await service.get(`agent:${params.id}`)
		
		if (!rawData) {
			return json({ error: 'Agent not found' }, { status: 404 })
		}

		let agentData;
		
		// Check if it's double-encoded
		if (typeof rawData === 'string' && rawData.startsWith('"{')) {
			// It's double-encoded, parse it twice
			agentData = JSON.parse(JSON.parse(rawData))
		} else if (typeof rawData === 'string') {
			// Normal JSON string, parse once
			agentData = JSON.parse(rawData)
		} else {
			// Already an object
			agentData = rawData
		}

		// Verify ownership
		if (agentData.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		// Save it back properly
		await service.set(`agent:${params.id}`, agentData)

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