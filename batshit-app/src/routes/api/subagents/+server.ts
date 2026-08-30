import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
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
import type { SubagentRow } from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer' // Story 6.9c
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

// GET /api/subagents - List all subagents for the current user
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		
		// Get all subagent IDs for the user
		const subagentIds = await service.sMembers(`user:${locals.user.id}:subagents`)
		
		if (!subagentIds || subagentIds.length === 0) {
			return json({ subagents: [] })
		}

		// Get all subagent data
		const subagents: SubagentRow[] = []
		for (const id of subagentIds) {
			// Story 6.9c: Use json.get for Redis 8 Stack (no need to parse)
			const subagentData = await service.json.get(`subagent:${id}`, '$')
			if (subagentData) {
				// json.get returns array when using JSONPath '$', so extract first element
				const subagent = Array.isArray(subagentData) ? subagentData[0] : subagentData
				if (subagent) {
					subagents.push(
						resolveUploadUrlsForBrowserInPayload(
							canonicalizeSubagentRecord(subagent as Record<string, any>) as SubagentRow
						)
					)
				}
			}
		}

		// Sort by displayName
		subagents.sort((a, b) => a.displayName.localeCompare(b.displayName))

		return json({ subagents })
	} catch (error) {
		console.error('Failed to get subagents:', error)
		return json({ error: 'Failed to get subagents' }, { status: 500 })
	}
}

// POST /api/subagents - Create a new subagent
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const body = await request.json()
		const { id: providedId, displayName, description, ...settings } = body

		if (!displayName) {
			return json({ error: 'Display name is required' }, { status: 400 })
		}

		const requestedSubagentType =
			typeof body.subagentType === 'string' ? body.subagentType.trim().toLowerCase() : ''
		if (
			Object.prototype.hasOwnProperty.call(body, 'subagentType') &&
			!['n8n-workflow', 'api', 'cli'].includes(requestedSubagentType)
		) {
			return json(
				{ error: 'Subagent type must be n8n Workflow, API, or CLI.', code: 'subagent_type_invalid' },
				{ status: 400 }
			)
		}
		const subagentType = normalizeSubagentType(undefined, body.subagentType)
		if (isN8nSubnodeSubagentType(subagentType)) {
			return json(
				{
					error: 'n8n Subnode Subagents were removed from Batshit.',
					code: 'subagent_type_retired'
				},
				{ status: 400 }
			)
		}
		const webhookUrl =
			typeof body.webhook_url === 'string'
				? body.webhook_url.trim()
				: typeof body.webhookUrl === 'string'
					? body.webhookUrl.trim()
					: ''

		if (isWorkflowBackedSubagentType(subagentType) && !webhookUrl) {
			return json(
				{ error: 'Production webhook URL is required for n8n Workflow Subagents.' },
				{ status: 400 }
			)
		}

		const codexValidationError = getCodexConfigOverrideValidationError(body.codex_settings ?? null)
		if (codexValidationError) {
			return json({ error: codexValidationError }, { status: 400 })
		}

		const claudeValidationError = getClaudeConfigOverrideValidationError(body.claude_settings ?? null)
		if (claudeValidationError) {
			return json({ error: claudeValidationError }, { status: 400 })
		}

		const service = redis

		// Story 6.9c: Use provided ID or generate from displayName
		const id = providedId?.trim() || sanitizeId(displayName)

		// Story 6.9c: Check for ID collision
		const exists = await service.exists(`subagent:${id}`)
		if (exists) {
			return json({
				error: `Subagent slug '${id}' is already taken. Choose another slug or delete/rename the original subagent.`
			}, { status: 400 })
		}

		// Create subagent object
		const subagent = canonicalizeSubagentRecord({
			id,
			user_id: locals.user.id,
			displayName,
			description,
			...settings,
			...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_ref')
				? { avatar_icon_ref: normalizeOptionalIconRefInput(body.avatar_icon_ref, 'avatar_icon_ref') }
				: {}),
			...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_fit')
				? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(body.avatar_icon_fit, 'avatar_icon_fit') }
				: {}),
			subagentType,
			webhook_url: isWorkflowBackedSubagentType(subagentType) ? webhookUrl || undefined : undefined,
			webhookUrl: isWorkflowBackedSubagentType(subagentType) ? webhookUrl || undefined : undefined,
			workflowName:
				isWorkflowBackedSubagentType(subagentType) && typeof body.workflowName === 'string'
					? body.workflowName.trim() || undefined
					: undefined,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString()
		}) as SubagentRow
		const storageSubagent = normalizeUploadUrlsForStorageInPayload(subagent)

		// Story 6.9c: Save to Redis with slug-based key
		await service.json.set(`subagent:${id}`, '$', storageSubagent) // Use json.set for objects
		await service.sAdd(`user:${locals.user.id}:subagents`, id)

		if (isCliSubagentType(storageSubagent.subagentType)) {
			await syncManagedCliSubagentProfile(locals.user.id, storageSubagent)
		}

		let compatibilityWarning: string | null = null
		if (isWorkflowBackedSubagentType(storageSubagent.subagentType)) {
			try {
				await runTrackedN8nCompatibilitySync({
					userId: locals.user.id,
					trigger: 'workflow-subagent-save'
				})
			} catch (error) {
				compatibilityWarning =
					error instanceof Error ? error.message : 'Failed to sync n8n parameter support'
				console.warn('[subagents] saved workflow subagent but parameter sync failed', error)
			}
		}

		return json({
			subagent: resolveUploadUrlsForBrowserInPayload(storageSubagent),
			compatibilityWarning
		})
	} catch (error) {
		console.error('Failed to create subagent:', error)
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to create subagent' },
			{ status: (error as any)?.status ?? 500 }
		)
	}
}
