import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import {
  getClaudeConfigOverrideValidationError,
} from '$lib/server/services/claudeSettings'
import {
  getCodexConfigOverrideValidationError,
} from '$lib/server/services/codexSettings'
import {
	deleteManagedCliSubagentProfile,
	holdManagedCliSubagentProfileFolder,
	planManagedCliSubagentProfileDeletion,
	syncManagedCliSubagentProfile
} from '$lib/server/services/cliSubagentProfileSync'
import {
	HostCommandDeleteRefusedError,
	hostOwnerResource,
	hostProfileResource,
	withHostCommandDeletion
} from '$lib/server/services/hostCommandOwnership'
import { runTrackedN8nCompatibilitySync } from '$lib/server/services/n8nParameterCompatibility'
import {
	AgentAvatarDeletionError,
	checkBatshitServerCanDeleteAvatars,
	deleteOwnerAvatars,
	isAvatarOwnerId
} from '$lib/server/services/agentAvatarDeletion'
import {
	SubagentDeleteRunRefusedError,
	stopSubagentRunsForDelete
} from '$lib/server/services/subagentRunRegistry'
import {
	buildSubagentN8nThreadIdKey,
	buildSubagentRunLockKey,
	buildSubagentThreadKey
} from '$lib/server/services/subagentThreads'
import { buildCliSubagentRuntimeId, resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { syncAgentCodexProfiles } from '$lib/server/services/codexProfileManager'
import { agentClaudeProfileResource, syncAgentClaudeProfiles } from '$lib/server/services/claudeProfileManager'
import { buildSubagentWrites } from '$lib/server/subagentRecordUpdate'
import { redis } from '$lib/server/redis'
import type { SubagentRow } from '$lib/types/database'
import { resolveUploadUrlsForBrowserInPayload } from '$lib/server/services/batshitServerUrls'
import {
  canonicalizeSubagentRecord,
  isCliSubagentType,
  isN8nSubnodeSubagentType,
  isWorkflowBackedSubagentType,
  normalizeSubagentType,
} from '$lib/utils/subagentType'
import { getSubagentTimeoutValidationError } from '$lib/utils/subagentTimeout'

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

		const timeoutValidationError = getSubagentTimeoutValidationError(updates.timeout_seconds)
		if (timeoutValidationError) {
			return json({ error: timeoutValidationError }, { status: 400 })
		}
		
		// BL-914: the save writes only what the request names, each field (and each key of the
		// Codex, Claude, provider and Tool Grid blocks) at its own path, in one step inside Redis
		// (`redis.updateSubagent`). It used to lay the body over the record it had read and write
		// that whole copy, so a partial block erased the keys it did not name, and two saves of
		// different fields that overlapped in time took back each other's field. The type fields
		// are derived only when the request names one of them (`buildSubagentWrites`).
		// BL-482: an emptied Custom System Prompt is removed (Settings sends `''`; `subagentRunner`
		// then adds no custom prompt block). BL-762: `slug`, like `id`, `user_id` and `created_at`,
		// is never written: changing it renames the Subagent's managed CLI profile folder
		// (`resolveSubagentSlug` reads it ahead of `id`/`displayName`).
		const writes = buildSubagentWrites({ body: updates, nextType, webhookUrl })

		// BL-753: only over the record that is there, since a write landing after the Subagent's
		// delete would make it again, outside the user's Subagent list.
		const deletedMeanwhile = { error: 'Subagent not found: it was deleted while this edit was saved.' }
		if (!(await service.updateSubagent(params.id!, writes))) {
			return json(deletedMeanwhile, { status: 404 })
		}
		// The record as it is now, after this save AND any other that landed: the answer, the
		// profile sync and the n8n check all go on from it, never from the body over an older read.
		const savedData = await service.json.get(`subagent:${params.id}`)
		if (!savedData) return json(deletedMeanwhile, { status: 404 })
		const storageUpdated = canonicalizeSubagentRecord(savedData as Record<string, any>) as SubagentRow

		if (isCliSubagentType(storageUpdated.subagentType)) {
			// Writes nothing when the delete removed the record before the sync's turn (BL-753).
			const synced = await syncManagedCliSubagentProfile(locals.user.id, storageUpdated)
			if (synced && !synced.written) return json(deletedMeanwhile, { status: 404 })
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

/**
 * The Subagent's id out of one list field of a record it is not the owner of, as a
 * path-scoped write of that ONE field (a whole-record write here would race the record's own
 * writers, the way `redis.deleteAgent` avoids it). Answers whether the list named it.
 */
async function removeIdFromList(client: any, key: string, field: string, id: string) {
	const record = await client.json.get(key)
	const list = record && typeof record === 'object' ? (record as Record<string, unknown>)[field] : null
	if (!Array.isArray(list) || !list.includes(id)) return false
	await client.json.set(
		key,
		`$.${field}`,
		list.filter((value) => value !== id)
	)
	return true
}

// DELETE /api/subagents/[id] - Delete a subagent, and everything that is only the Subagent's.
// Order (2026-09-25): batshit-server is checked before anything is deleted; then the
// Subagent's running delegated runs are stopped and waited for (BL-287, 2026-09-27); then the
// managed CLI profile folder (BL-157), the avatar pictures (BL-139), every place that names
// its id (assignments, BL-157; skill, skill source, and artifact access lists, BL-187, BL-392),
// and its threads in the user's chats (BL-391) go BEFORE the record, so when any of them fails
// the Subagent stays and a retry finishes the job.
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}
	const userId = locals.user.id
	const subagentId = params.id

	try {
		const service = redis
		const existingData = await service.json.get(`subagent:${subagentId}`)

		if (!existingData) {
			return json({ error: 'Subagent not found' }, { status: 404 })
		}

		const existing = canonicalizeSubagentRecord(
			existingData as Record<string, any>
		) as SubagentRow

		// Verify ownership
		if (existing.user_id !== userId) {
			return json({ error: 'Unauthorized' }, { status: 403 })
		}
		// The service health check cannot change the Subagent, and must still precede Stop.
		try {
			await checkBatshitServerCanDeleteAvatars()
		} catch (error) {
			if (error instanceof AgentAvatarDeletionError) {
				const retryNote = error.status === 503 ? ' Try again once batshit-server is running.' : ''
				return json(
					{
						error: `${error.message} It deletes the Subagent's avatar pictures, so nothing was deleted: the Subagent is still there.${retryNote}`,
						code: error.code
					},
					{ status: error.status }
				)
			}
			throw error
		}

		// A preparing run can have a durable pre-spawn record with no process identity or
		// cleanup callback yet. Stop and await the registered run before checking that record.
		let runStop: Awaited<ReturnType<typeof stopSubagentRunsForDelete>>
		try {
			runStop = await stopSubagentRunsForDelete(userId, subagentId)
		} catch (error) {
			if (error instanceof SubagentDeleteRunRefusedError) {
				return json({ error: error.message, code: error.code }, { status: error.status })
			}
			throw error
		}
		if (runStop.stopped > 0) {
			console.warn(
				`[subagents] Stopped ${runStop.stopped} running call(s) of ${subagentId} before deleting it (${runStop.waitedMs} ms)`
			)
		}
		try {
			const profilePlan = process.platform === 'win32'
				? null
				: await planManagedCliSubagentProfileDeletion(userId, existing)
			const resources = process.platform === 'win32' ? [] : [
				hostOwnerResource({ userId, kind: 'subagent', id: subagentId! }),
				...(profilePlan?.deleted ? [
					hostProfileResource(profilePlan.profileId),
					agentClaudeProfileResource(buildCliSubagentRuntimeId(resolveSubagentSlug(existing)))
				] : [])
			]
			const deleteStopped = (notices: string[]) => deleteStoppedSubagent(userId, subagentId, existing, notices)
			// The profile, pictures, reference sweeps, and record are all inside this reservation.
			return await (process.platform === 'win32'
				? deleteStopped([])
				: withHostCommandDeletion(resources, deleteStopped))
		} finally {
			runStop.release()
		}
	} catch (error) {
		console.error('Failed to delete subagent:', error)
		if (error instanceof HostCommandDeleteRefusedError) {
			const code = error.message.startsWith('Another deletion is still running')
				? 'subagent_delete_in_progress'
				: error.code
			return json({ error: error.message, code }, { status: error.status })
		}
		return json({ error: 'Failed to delete subagent' }, { status: 500 })
	}
}

/** Everything of the Subagent, once none of its runs is running (BL-287). */
async function deleteStoppedSubagent(userId: string, subagentId: string, existing: SubagentRow, notices: string[]) {
	// BL-753: the profile folder goes before the record (below), so the folder's turn is held
	// until the record is gone. An edit's profile sync queued meanwhile then finds no record and
	// writes nothing; one that ran before is removed by the folder removal behind it.
	const removed = await holdManagedCliSubagentProfileFolder(existing, () =>
		removeStoppedSubagent(userId, subagentId, existing)
	)
	if (removed instanceof Response) return removed
	const profileFolder = removed

	// Keep the primaries' managed Codex/Claude profiles in step with their assignments, as
	// the assignment route does.
	try {
		await syncAgentCodexProfiles(userId)
		await syncAgentClaudeProfiles(userId)
	} catch (syncError) {
		console.warn('[subagents] Subagent deleted but the primary profile sync failed:', syncError)
	}

	return json({
		success: true,
		...(notices[0] ? { notice: notices[0] } : {}),
		profileFolder:
			profileFolder.deleted || !profileFolder.sharedWith
				? null
				: {
						kept: profileFolder.profileId,
						sharedWith: profileFolder.sharedWith,
						sharedWithKind: profileFolder.sharedWithKind
					}
	})
}

/**
 * The Subagent's profile folder, pictures, references, and record, in that order. Answers the
 * profile folder's outcome, or the failure's response when the Subagent was kept.
 */
async function removeStoppedSubagent(
	userId: string,
	subagentId: string,
	existing: SubagentRow
): Promise<Response | Awaited<ReturnType<typeof deleteManagedCliSubagentProfile>>> {
	const service = redis
	// BL-157: the managed CLI profile folder (config, and Codex's `logs_2.sqlite` with the
	// Subagent's prompts). First, because it is the likelier to fail on the Mac and the
	// cheaper to lose: a Subagent that stays after a later failure gets it back at its next run.
	let profileFolder: Awaited<ReturnType<typeof deleteManagedCliSubagentProfile>>
	try {
		profileFolder = await deleteManagedCliSubagentProfile(userId, existing)
	} catch (error) {
		if (error instanceof HostCommandDeleteRefusedError) throw error
		const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '')
		return json(
			{
				error: `Could not delete this Subagent's managed CLI profile folder: ${reason}. The Subagent was not deleted.`,
				code: 'subagent_profile_delete_failed'
			},
			{ status: 500 }
		)
	}

	// BL-139: its avatar pictures, before the record (the pictures are found by the id, and a
	// failure keeps the Subagent). An id outside the owner id rule can have no picture stored
	// for it (the upload refuses such ids), and the sweep refuses to look, so it is skipped.
	if (isAvatarOwnerId(subagentId)) {
		try {
			await deleteOwnerAvatars(userId, {
				type: 'subagent',
				id: subagentId,
				avatar: existing.avatar,
				avatar_url: (existing as any).avatar_url
			})
		} catch (error) {
			if (error instanceof AgentAvatarDeletionError) {
				const retryNote = error.status === 503 ? ' Try again once batshit-server is running.' : ''
				return json(
					{ error: `${error.message} The Subagent was not deleted.${retryNote}`, code: error.code },
					{ status: error.status }
				)
			}
			throw error
		}
	} else {
		console.warn(
			`[subagents] ${subagentId} is outside the avatar owner id rule, so no avatar picture can be named for it; skipped the avatar sweep`
		)
	}

	// Every place outside its own records that names the Subagent, BEFORE the record goes:
	// each step has its own try/catch and is safe to run again, so a Redis error in one keeps
	// the Subagent and names the step, and a retry finishes the job (the record never goes
	// while a list still names it).
	const failedSteps: string[] = []
	const runStep = async (label: string, step: (client: any) => Promise<void>) => {
		try {
			await service.execute(step)
		} catch (error) {
			console.error(`[subagents] Could not remove ${subagentId} from ${label}:`, error)
			failedSteps.push(`${label} (${error instanceof Error ? error.message : String(error)})`)
		}
	}

	// Every agent that has it assigned: the assignment set and BOTH list fields (BL-157:
	// `assignedSubagents` is the one the profile managers and managed-execute also read).
	// These lists name Subagents only, so a same-id Primary Agent is never in them.
	await runStep('Primary Agent assignments', async (client) => {
		for (const agentId of (await client.sMembers(`user:${userId}:agents`)) as string[]) {
			await client.sRem(`agent:${agentId}:subagents`, subagentId)
			let changed = false
			for (const field of ['assigned_subagent_ids', 'assignedSubagents']) {
				if (await removeIdFromList(client, `agent:${agentId}`, field, subagentId)) changed = true
			}
			if (changed) {
				await client.json.set(`agent:${agentId}`, '$.updated_at', new Date().toISOString())
			}
		}
	})

	// BL-187: a skill's `enabled_agent_ids` and an artifact's `agent_allowlist` name ids with no
	// kind, so the Subagent's id left there would hand that access to the next agent or
	// Subagent created with the same id; `redis.deleteAgent` scrubs a primary's the same way.
	// A Primary Agent with the SAME id (a collision made before creation refused them) shares
	// those entries, and the lists cannot tell the two apart: keeping its access is the safe
	// side, so the scrub is skipped and said.
	let sharedWithPrimary = false
	await runStep('the check for a Primary Agent with the same id', async (client) => {
		sharedWithPrimary = (await client.exists(`agent:${subagentId}`)) > 0
	})
	if (failedSteps.length === 0 && sharedWithPrimary) {
		console.warn(
			`[subagents] Primary Agent ${subagentId} has the same id as the Subagent being deleted, so its skill and artifact access lists were left as they are`
		)
	} else if (failedSteps.length === 0) {
		await runStep('skill access lists', async (client) => {
			for (const key of (await client.keys(`slash_command:${userId}:*`)) as string[]) {
				await removeIdFromList(client, key, 'enabled_agent_ids', subagentId)
			}
		})
		// BL-392: a skill SOURCE's list too. Each rescan copies it onto every skill the source
		// provides, so the id left there gave those skills back to a same-name agent.
		await runStep('skill source access lists', async (client) => {
			for (const key of (await client.keys(`skill_source:${userId}:*`)) as string[]) {
				await removeIdFromList(client, key, 'enabled_agent_ids', subagentId)
			}
		})
		await runStep('artifact access lists', async (client) => {
			for (const artifactId of (await client.sMembers(`user:${userId}:artifacts`)) as string[]) {
				await removeIdFromList(client, `artifact:${artifactId}`, 'agent_allowlist', subagentId)
			}
		})
	}

	// BL-391: its threads in the user's chats, all named for its SLUG: the stored exchanges of an
	// API or CLI Subagent, an n8n Workflow Subagent's thread id, and a run lock. Ids (and so slugs)
	// come from display names, so a new Subagent with the deleted one's name found them and a
	// `resume` handed it the deleted one's exchanges. Another of the user's Subagents with the same
	// slug shares them, so then they stay. Its runs were stopped above and have ended, and no new
	// one starts until this delete is done (BL-287), so no call of it writes its thread or its
	// lock back.
	const threadSlug = resolveSubagentSlug(existing)
	let slugSharedWith: string | null = null
	await runStep('the check for a Subagent with the same slug', async (client) => {
		for (const otherId of (await client.sMembers(`user:${userId}:subagents`)) as string[]) {
			if (otherId === subagentId) continue
			const other = await client.json.get(`subagent:${otherId}`)
			if (other && resolveSubagentSlug(other as SubagentRow) === threadSlug) {
				slugSharedWith = otherId
				return
			}
		}
	})
	if (failedSteps.length === 0 && slugSharedWith) {
		console.warn(
			`[subagents] Subagent ${slugSharedWith} has the same slug (${threadSlug}) as ${subagentId}, so their chat threads were left as they are`
		)
	} else if (failedSteps.length === 0) {
		await runStep('chat threads', async (client) => {
			for (const sessionId of (await client.sMembers(`user:${userId}:sessions`)) as string[]) {
				await client.del([
					buildSubagentThreadKey(sessionId, threadSlug),
					buildSubagentN8nThreadIdKey(sessionId, threadSlug),
					buildSubagentRunLockKey(sessionId, threadSlug)
				])
			}
		})
	}

	if (failedSteps.length > 0) {
		return json(
			{
				error: `Could not remove this Subagent from ${failedSteps.join('; ')}. The Subagent was not deleted; try again.`,
				code: 'subagent_references_not_removed'
			},
			{ status: 500 }
		)
	}

	// Remove from user's subagent set
	await service.sRem(`user:${userId}:subagents`, subagentId)

	// Delete the subagent data
	await service.del(`subagent:${subagentId}`)

	return profileFolder
}
