import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
  getClaudeConfigOverrideValidationError,
} from '$lib/server/services/claudeSettings'
import {
  getCodexConfigOverrideValidationError,
} from '$lib/server/services/codexSettings'
import { syncManagedCliSubagentProfile } from '$lib/server/services/cliSubagentProfileSync'
import { runTrackedN8nCompatibilitySync } from '$lib/server/services/n8nParameterCompatibility'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { redis } from '$lib/server/redis'
import type { AgentRow, SubagentRow } from '$lib/types/database'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'
import {
  canonicalizeSubagentRecord,
  isCliSubagentType,
  isN8nSubnodeSubagentType,
  isWorkflowBackedSubagentType,
  normalizeSubagentType,
} from '$lib/utils/subagentType'

// GET /api/subagents/[id] - Get a specific subagent
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		const subagentData = await service.json.get(`subagent:${params.id}`)
		
		if (!subagentData) {
			return json({ error: 'Subagent not found' }, { status: 404 })
		}

		const subagent = canonicalizeSubagentRecord(
			subagentData as Record<string, any>
		) as SubagentRow

		// Verify ownership
		if (subagent.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		return json({ subagent: resolveUploadUrlsForBrowserInPayload(subagent) })
	} catch (error) {
		console.error('Failed to get subagent:', error)
		return json({ error: 'Failed to get subagent' }, { status: 500 })
	}
}

// PUT /api/subagents/[id] - Update a subagent
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		const existingData = await service.json.get(`subagent:${params.id}`)
		
		if (!existingData) {
			return json({ error: 'Subagent not found' }, { status: 404 })
		}

		const existing = canonicalizeSubagentRecord(
			existingData as Record<string, any>
		) as SubagentRow

		// Verify ownership
		if (existing.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		const updates = await request.json()
		if (isN8nSubnodeSubagentType(existing.subagentType)) {
			return json(
				{
					error: 'This Subagent uses the retired n8n Subnode type and can only be deleted.',
					code: 'subagent_type_retired'
				},
				{ status: 409 }
			)
		}
		if (Object.prototype.hasOwnProperty.call(updates, 'subagentType')) {
			const requestedSubagentType =
				typeof updates.subagentType === 'string'
					? updates.subagentType.trim().toLowerCase()
					: ''
			if (!['n8n-workflow', 'api', 'cli'].includes(requestedSubagentType)) {
				return json(
					{ error: 'Subagent type must be n8n Workflow, API, or CLI.', code: 'subagent_type_invalid' },
					{ status: 400 }
				)
			}
		}
		const nextType = normalizeSubagentType(existing, updates.subagentType)
		if (isN8nSubnodeSubagentType(nextType)) {
			return json(
				{
					error: 'n8n Subnode Subagents were removed from Batshit.',
					code: 'subagent_type_retired'
				},
				{ status: 400 }
			)
		}
		const webhookUrl =
			typeof updates.webhook_url === 'string'
				? updates.webhook_url.trim()
				: typeof updates.webhookUrl === 'string'
					? updates.webhookUrl.trim()
					: existing.webhook_url?.trim() || existing.webhookUrl?.trim() || ''

		if (isWorkflowBackedSubagentType(nextType) && !webhookUrl) {
			return json(
				{ error: 'Production webhook URL is required for n8n Workflow Subagents.' },
				{ status: 400 }
			)
		}

		const codexValidationError = getCodexConfigOverrideValidationError(updates.codex_settings ?? null)
		if (codexValidationError) {
			return json({ error: codexValidationError }, { status: 400 })
		}

		const claudeValidationError = getClaudeConfigOverrideValidationError(updates.claude_settings ?? null)
		if (claudeValidationError) {
			return json({ error: claudeValidationError }, { status: 400 })
		}
		
		// Update subagent
		const updated = canonicalizeSubagentRecord({
			...existing,
			...updates,
			...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_ref')
				? { avatar_icon_ref: normalizeOptionalIconRefInput(updates.avatar_icon_ref, 'avatar_icon_ref') }
				: {}),
			...(Object.prototype.hasOwnProperty.call(updates, 'avatar_icon_fit')
				? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(updates.avatar_icon_fit, 'avatar_icon_fit') }
				: {}),
			subagentType: nextType,
			webhook_url: isWorkflowBackedSubagentType(nextType) ? webhookUrl || undefined : undefined,
			webhookUrl: isWorkflowBackedSubagentType(nextType) ? webhookUrl || undefined : undefined,
			workflowName:
				isWorkflowBackedSubagentType(nextType)
					? (typeof updates.workflowName === 'string'
							? updates.workflowName.trim() || undefined
							: existing.workflowName)
					: undefined,
			id: existing.id, // Preserve ID
			user_id: existing.user_id, // Preserve user ID
			created_at: existing.created_at, // Preserve creation date
			updated_at: new Date().toISOString()
		}) as SubagentRow
		const storageUpdated = normalizeUploadUrlsForStorageInPayload(updated)

		// Save to Redis
		await service.json.set(`subagent:${params.id}`, '$', storageUpdated)

		if (isCliSubagentType(storageUpdated.subagentType)) {
			await syncManagedCliSubagentProfile(locals.user.id, storageUpdated)
		}

		let compatibilityWarning: string | null = null
		if (isWorkflowBackedSubagentType(storageUpdated.subagentType)) {
			try {
				await runTrackedN8nCompatibilitySync({
					userId: locals.user.id,
					trigger: 'workflow-subagent-save'
				})
			} catch (error) {
				compatibilityWarning =
					error instanceof Error ? error.message : 'Failed to sync n8n parameter support'
				console.warn('[subagents] updated workflow subagent but parameter sync failed', error)
			}
		}

		return json({
			subagent: resolveUploadUrlsForBrowserInPayload(storageUpdated),
			compatibilityWarning
		})
	} catch (error) {
		console.error('Failed to update subagent:', error)
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to update subagent' },
			{ status: (error as any)?.status ?? 500 }
		)
	}
}

// DELETE /api/subagents/[id] - Delete a subagent
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		const existingData = await service.json.get(`subagent:${params.id}`)
		
		if (!existingData) {
			return json({ error: 'Subagent not found' }, { status: 404 })
		}

		const existing = canonicalizeSubagentRecord(
			existingData as Record<string, any>
		) as SubagentRow

		// Verify ownership
		if (existing.user_id !== locals.user.id) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}

		// Remove from user's subagent set
		await service.sRem(`user:${locals.user.id}:subagents`, params.id)
		
		// Delete the subagent data
		await service.del(`subagent:${params.id}`)

		// Also remove any agent-subagent associations
		const agentIds = await service.sMembers(`user:${locals.user.id}:agents`)
		for (const agentId of agentIds) {
			await service.sRem(`agent:${agentId}:subagents`, params.id)

			const agentRecord = (await service.get(`agent:${agentId}`)) as AgentRow | null
			if (!agentRecord?.assigned_subagent_ids?.length) continue

			const filtered = agentRecord.assigned_subagent_ids.filter((id) => id !== params.id)
			if (filtered.length === agentRecord.assigned_subagent_ids.length) {
				continue
			}

			const updatedAgent: AgentRow = {
				...agentRecord,
				assigned_subagent_ids: filtered,
				updated_at: new Date().toISOString()
			}
			await service.set(`agent:${agentId}`, updatedAgent)
		}

		return json({ success: true })
	} catch (error) {
		console.error('Failed to delete subagent:', error)
		return json({ error: 'Failed to delete subagent' }, { status: 500 })
	}
}
