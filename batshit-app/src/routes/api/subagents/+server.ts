import { withoutSkillReadSettings } from '$lib/utils/skillSessions'
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { createSubjectPopulation, SubjectPopulationError } from '$lib/server/services/subjectPopulation'
import { PresetReferenceWriteError } from '$lib/server/services/modelPresetReferenceGuard'
import { withSettingsRecordReplacement } from '$lib/server/services/appActions/settings/lifecycle'
import { CODEX_CLI_RETIRED_CODE, CODEX_CLI_RETIRED_ERROR, CODEX_CLI_SUBAGENT_RETIRED_DETAILS,
	CLAUDE_CLI_PRESET_REFUSAL, namesClaudeCliModel, namesRetiredCodexCliModel } from '$lib/utils/cliRuntimeIdentity'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import type { SubagentRow } from '$lib/types/database'
import { resolveNewAgentId } from '$lib/server/services/agentIdRules' // Story 6.9c, BL-283
import {
	normalizeUploadUrlsForStorageInPayload,
	resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'
import {
	canonicalizeSubagentRecord,
	isRetiredN8nSubagentType,
	normalizeSubagentType,
	retiredSubagentRefusal,
} from '$lib/utils/subagentType'
import {
	getSubagentTimeoutValidationError,
	normalizeSubagentTimeoutSeconds,
} from '$lib/utils/subagentTimeout'
import { getSubagentMaxToolStepsValidationError, normalizeSubagentMaxToolSteps } from '$lib/utils/subagentToolSteps'

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
				// SA-139 R2 (D14): a record of a removed n8n Subagent type is never listed. A leftover
				// CLI Subagent (R5) is listed, so its Delete is reachable; every other use refuses it.
				if (subagent && !isRetiredN8nSubagentType(normalizeSubagentType(subagent as Record<string, any>))) {
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
		const body = withoutSkillReadSettings(await request.json()) as Record<string, any>
		// A duplicate never inherits a Primary's management authority.
		delete body.app_action_policy
		const { id: providedId, displayName, description, ...settings } = body

		if (!displayName) {
			return json({ error: 'Display name is required' }, { status: 400 })
		}

		const requestedSubagentType =
			typeof body.subagentType === 'string' ? body.subagentType.trim().toLowerCase() : ''
		// SA-139 R2 (D14): a request for a removed n8n Subagent type (by type, legacy alias or
		// workflow target) is refused, never created as an API Subagent.
		const requestedStoredType = normalizeSubagentType(body, body.subagentType)
		if (isRetiredN8nSubagentType(requestedStoredType)) {
			return json(
				{
					error: 'n8n Workflow Subagents were removed from Batshit. n8n workflows still work as tools.',
					code: 'subagent_type_retired'
				},
				{ status: 400 }
			)
		}
		// SA-139 R5 (D14): a request for the removed CLI Subagent type (Claude Code CLI or Codex
		// CLI, by type or by a typeless record's lane) is refused, never created as an API Subagent.
		const retired = retiredSubagentRefusal(body, body.subagentType, { request: true })
		if (retired) return json(retired, { status: 409 })
		if (Object.prototype.hasOwnProperty.call(body, 'subagentType') && requestedSubagentType !== 'api') {
			return json(
				{ error: 'The Subagent type must be API.', code: 'subagent_type_invalid' },
				{ status: 400 }
			)
		}
		// The removed CLI lanes' presets are never stored on a Subagent (it would only fail at its
		// first run), and neither are their settings blocks.
		if (namesRetiredCodexCliModel(body)) {
			return json(
				{ error: CODEX_CLI_RETIRED_ERROR, code: CODEX_CLI_RETIRED_CODE, details: CODEX_CLI_SUBAGENT_RETIRED_DETAILS },
				{ status: 409 }
			)
		}
		if (namesClaudeCliModel(body)) {
			return json({ error: CLAUDE_CLI_PRESET_REFUSAL }, { status: 400 })
		}
		delete settings.codex_settings
		delete settings.claude_settings
		delete settings.expectedCliPromotion

		const timeoutValidationError = getSubagentTimeoutValidationError(body.timeout_seconds)
		if (timeoutValidationError) {
			return json({ error: timeoutValidationError }, { status: 400 })
		}

		const maxToolStepsValidationError = getSubagentMaxToolStepsValidationError(body.max_tool_steps)
		if (maxToolStepsValidationError) {
			return json({ error: maxToolStepsValidationError }, { status: 400 })
		}

		const service = redis

		// Story 6.9c: Use provided ID or generate from displayName. BL-283: an id the delete or
		// the avatar pictures cannot live with is refused.
		const requestedId = resolveNewAgentId('subagent', providedId, displayName)
		if (!requestedId.ok) {
			return json({ error: requestedId.error, code: requestedId.code }, { status: 400 })
		}
		const id = requestedId.id

		// Story 6.9c: Check for ID collision
		const exists = await service.exists(`subagent:${id}`)
		if (exists) {
			return json({
				error: `Subagent slug '${id}' is already taken. Choose another slug or delete/rename the original subagent.`
			}, { status: 400 })
		}
		// BL-187 (2026-09-25): a skill's or artifact's access list names ids with no kind, so a
		// Subagent sharing a Primary Agent's id would share its access. Refuse the id instead.
		if (await service.exists(`agent:${id}`)) {
			return json({
				error: `A Primary Agent already uses the id '${id}'. Give this Subagent another name, so their skill and artifact access stay separate.`
			}, { status: 400 })
		}

		// Create subagent object
		const subagent = canonicalizeSubagentRecord({
			id,
			user_id: locals.user.id,
			displayName,
			description,
			...settings,
			timeout_seconds: normalizeSubagentTimeoutSeconds(body.timeout_seconds),
			max_tool_steps: normalizeSubagentMaxToolSteps(body.max_tool_steps),
			...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_ref')
				? { avatar_icon_ref: normalizeOptionalIconRefInput(body.avatar_icon_ref, 'avatar_icon_ref') }
				: {}),
			...(Object.prototype.hasOwnProperty.call(body, 'avatar_icon_fit')
				? { avatar_icon_fit: normalizeOptionalAvatarIconFitInput(body.avatar_icon_fit, 'avatar_icon_fit') }
				: {}),
			subagentType: 'api',
			webhook_url: undefined,
			webhookUrl: undefined,
			workflowName: undefined,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString()
		}) as SubagentRow
		const proposedSubagent = normalizeUploadUrlsForStorageInPayload(subagent)

		// Story 6.9c: Save to Redis with slug-based key
		const { record: storageSubagent } = await withSettingsRecordReplacement(`subagent:${id}`, () =>
			service.execute(client => createSubjectPopulation(client, { userId: locals.user!.id, subjectId: id,
				kind: 'subagent', mode: 'create', record: proposedSubagent })))

		return json({
			subagent: resolveUploadUrlsForBrowserInPayload(storageSubagent)
		})
	} catch (error) {
		console.error('Failed to create subagent:', error)
		if (error instanceof SubjectPopulationError || error instanceof PresetReferenceWriteError) return json({ error: error.message, code: error.code }, { status: error.status })
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to create subagent' },
			{ status: (error as any)?.status ?? 500 }
		)
	}
}
