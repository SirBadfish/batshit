import { TYPED_FILE_TOOLS_REVISION_HEADER, makeTypedToolsSnapshot, namesTypedFileToolsWrite, requireTypedToolsExpected, typedToolsReadPaths } from '$lib/server/typedFileToolsSettingsGuard'
import { json } from '@sveltejs/kit'
import { publishUserEvent } from '$lib/server/ssePublisher'
import { MODEL_SELECTION_REVISION_HEADER } from '$lib/appActions/settings/modelSelectionBaseline'
import { INSTRUCTIONS_REVISION_HEADER } from '$lib/appActions/settings/instructionsBaseline'
import { instructionsReadPaths, makeInstructionsSnapshot, requireInstructionsExpected, instructionLeaves } from '$lib/server/instructionsGuard'
import { namesModelSelection, readModelSelectionSnapshot, requireModelSelectionRevision } from '$lib/server/modelSelectionGuard'
import type { RequestHandler } from './$types'
import { withSettingsRecordReplacement, acquireSettingsReplacementMutation, SettingsLifecycleRefusal } from '$lib/server/services/appActions/settings/lifecycle'
import { AgentArtifactCleanupError, removeRequiredArtifactAgentReferences } from '$lib/server/services/artifactAgentDeletionCleanup'
import { CODEX_CLI_RETIRED_CODE, CODEX_CLI_RETIRED_ERROR, CODEX_CLI_SUBAGENT_RETIRED_DETAILS,
  CLAUDE_CLI_PRESET_REFUSAL, namesClaudeCliModel, namesRetiredCodexCliModel } from '$lib/utils/cliRuntimeIdentity'
// The delete-only owners of a leftover CLI Subagent's managed profile folder (SA-139 R5 keeps them).
import {
	deleteManagedCliSubagentProfile,
	holdManagedCliSubagentProfileFolder,
	planManagedCliSubagentProfileDeletion
} from '$lib/server/services/cliSubagentProfileSync'
import {
	HostCommandDeleteRefusedError,
	hostOwnerResource,
	hostProfileResource,
	withHostCommandDeletion
} from '$lib/server/services/hostCommandOwnership'
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
	buildSubagentRunLockKey,
	buildSubagentThreadKey
} from '$lib/server/services/subagentThreads'
import { buildCliSubagentRuntimeId, resolveSubagentSlug } from '$lib/utils/subagentSlug'
import { agentClaudeProfileResource } from '$lib/server/services/claudeProfileManager'
import { buildSubagentWrites } from '$lib/server/subagentRecordUpdate'
import { redis } from '$lib/server/redis'
import { beginSlashCommandWrite, currentSlashCommandWriteRevision, captureSlashCommandWriteBasis, captureSkillSourceWriteBasis, removeExplicitSkillSourceAgentAccess, isSlashCommandMutationError, type SlashCommandWritePreparation } from '$lib/server/services/slashCommandRevision'
import { removeExplicitSlashCommandAgentAccess } from '$lib/server/services/agentAccessLists'
import { deleteSubagentPopulation, SubjectPopulationError } from '$lib/server/services/subjectPopulation'
import type { SubagentRow } from '$lib/types/database'
import { resolveUploadUrlsForBrowserInPayload } from '$lib/server/services/batshitServerUrls'
import {
  canonicalizeSubagentRecord,
  isRetiredN8nSubagentType,
  isRetiredSubagentType,
  normalizeSubagentType,
  retiredSubagentRefusal,
  retiredSubagentTypeMessage,
} from '$lib/utils/subagentType'
import { getSubagentTimeoutValidationError } from '$lib/utils/subagentTimeout'
import { getSubagentMaxToolStepsValidationError } from '$lib/utils/subagentToolSteps'

// GET /api/subagents/[id] - Get a specific subagent
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

	try {
		const service = redis
		const instructionPaths = instructionsReadPaths('subagent')
		const selection = await service.execute(client => readModelSelectionSnapshot(client, params.id!, 'subagent', undefined, [...instructionPaths, ...typedToolsReadPaths('subagent')]))
		const instructions = makeInstructionsSnapshot(params.id!, 'subagent', instructionPaths.map((path, index) => [path, selection.extraRaw[index]]), selection.lifecycle)
		let typedToolsRevision: string | undefined
    try { typedToolsRevision = makeTypedToolsSnapshot(params.id!, 'subagent', selection.extraRaw.slice(instructionPaths.length), selection.lifecycle).revision } catch { /* Only this grant waits for a valid explicit source. */ }
		const subagentData = selection.record
		
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
		// SA-139 R2 (D14): a record of a removed n8n Subagent type is never read for editing (the
		// list hides it too); only DELETE still acts on it. A leftover CLI Subagent (R5) is read so
		// its panel can show it with its Delete; every save, run and assignment refuses it.
		if (isRetiredN8nSubagentType(normalizeSubagentType(subagent, subagent.subagentType))) {
			return json({ error: retiredSubagentTypeMessage(subagent), code: 'subagent_type_retired' }, { status: 410 })
		}

		return json({ subagent: resolveUploadUrlsForBrowserInPayload(subagent) }, { headers: { ...(typedToolsRevision ? { [TYPED_FILE_TOOLS_REVISION_HEADER]: typedToolsRevision } : {}), [MODEL_SELECTION_REVISION_HEADER]: selection.revision,
      [INSTRUCTIONS_REVISION_HEADER]: JSON.stringify(instructions.revisions) } })
	} catch (error) {
		console.error('Failed to get subagent:', error)
		return json({ error: error instanceof Error ? error.message : 'Failed to get subagent',
			...((error as any)?.code ? { code: (error as any).code } : {}) }, { status: (error as any)?.status ?? 500 })
	}
}

// PUT /api/subagents/[id] - Update a subagent
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 })
	}

  let typedToolsAck: { revision: string; value: boolean } | undefined
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
		const expectedModelSelection = updates.expectedModelSelection
		delete updates.expectedModelSelection
		if (expectedModelSelection !== undefined) requireModelSelectionRevision(expectedModelSelection)
    const expectedTypedFileTools = updates.expectedTypedFileTools
    delete updates.expectedTypedFileTools
    if (expectedTypedFileTools !== undefined || namesTypedFileToolsWrite(updates)) requireTypedToolsExpected(expectedTypedFileTools)
		const expectedInstructions = updates.expectedInstructions
		delete updates.expectedInstructions
		if (expectedInstructions !== undefined || instructionLeaves(updates).length) requireInstructionsExpected(expectedInstructions, instructionLeaves(updates))
		// SA-139 R2/R5 (D14): a record of a removed Subagent type (n8n, or the CLI Subagent) is never
		// edited or turned into a live type, and a request for one is refused, before anything of
		// the save is read or written. Only DELETE still acts on a leftover.
		if (isRetiredN8nSubagentType(normalizeSubagentType(existing, existing.subagentType))) {
			return json(
				{
					error: `${retiredSubagentTypeMessage(existing)} It cannot be changed.`,
					code: 'subagent_type_retired'
				},
				{ status: 409 }
			)
		}
		const storedRetired = retiredSubagentRefusal(existing)
		if (storedRetired) return json(storedRetired, { status: 409 })
		if (Object.prototype.hasOwnProperty.call(updates, 'subagentType')) {
			const requestedSubagentType =
				typeof updates.subagentType === 'string'
					? updates.subagentType.trim().toLowerCase()
					: ''
			if (isRetiredN8nSubagentType(normalizeSubagentType(undefined, requestedSubagentType))) {
				return json(
					{
						error: 'n8n Workflow Subagents were removed from Batshit. n8n workflows still work as tools.',
						code: 'subagent_type_retired'
					},
					{ status: 400 }
				)
			}
			const requestedRetired = retiredSubagentRefusal(existing, requestedSubagentType)
			if (requestedRetired) return json(requestedRetired, { status: 409 })
			if (requestedSubagentType !== 'api') {
				return json(
					{ error: 'The Subagent type must be API.', code: 'subagent_type_invalid' },
					{ status: 400 }
				)
			}
		}
		// The removed CLI lanes' presets and settings blocks are never stored on a Subagent.
		if (['primary_model_provider', 'primary_model_name', 'primary_model_connection'].some(field => Object.hasOwn(updates, field))) {
			if (namesRetiredCodexCliModel(updates)) {
				return json(
					{ error: CODEX_CLI_RETIRED_ERROR, code: CODEX_CLI_RETIRED_CODE, details: CODEX_CLI_SUBAGENT_RETIRED_DETAILS },
					{ status: 409 }
				)
			}
			if (namesClaudeCliModel(updates)) return json({ error: CLAUDE_CLI_PRESET_REFUSAL }, { status: 400 })
		}
		delete updates.claude_settings
		delete updates.codex_settings
		// SA-139 R5: the Claude Code CLI Subagent's request-only save check is never stored, and a
		// save that still carries one is refused (the R4 Primary shape).
		if (Object.hasOwn(updates, 'expectedCliPromotion')) {
			delete updates.expectedCliPromotion
			return json(
				{
					error: 'This save carries a Claude Code CLI check (expectedCliPromotion), and the Claude Code CLI Subagent was removed from Batshit, so nothing was saved. Reload Settings and try again.'
				},
				{ status: 400 }
			)
		}
		const storedType = normalizeSubagentType(existing, existing.subagentType)
		const nextType = normalizeSubagentType(existing, updates.subagentType)
		if (isRetiredSubagentType(storedType) || isRetiredSubagentType(nextType)) {
			throw new Error('A removed Subagent type reached the Subagent save.')
		}
		if (namesModelSelection('subagent', updates)) requireModelSelectionRevision(expectedModelSelection)

		const timeoutValidationError = getSubagentTimeoutValidationError(updates.timeout_seconds)
		if (timeoutValidationError) {
			return json({ error: timeoutValidationError }, { status: 400 })
		}

		const maxToolStepsValidationError = getSubagentMaxToolStepsValidationError(updates.max_tool_steps)
		if (maxToolStepsValidationError) {
			return json({ error: maxToolStepsValidationError }, { status: 400 })
		}
		
		// BL-914: the save writes only what the request names, each field (and each key of the
		// provider and Tool Grid blocks) at its own path, in one step inside Redis
		// (`redis.updateSubagent`). It used to lay the body over the record it had read and write
		// that whole copy, so a partial block erased the keys it did not name, and two saves of
		// different fields that overlapped in time took back each other's field. The type fields
		// are derived only when the request names one of them (`buildSubagentWrites`).
		// BL-482: an emptied Custom System Prompt is removed (Settings sends `''`; `subagentRunner`
		// then adds no custom prompt block). BL-762: `slug`, like `id`, `user_id` and `created_at`,
		// is never written: changing it renames the Subagent's managed CLI profile folder
		// (`resolveSubagentSlug` reads it ahead of `id`/`displayName`).
		const writes = buildSubagentWrites({ body: updates, nextType })

		// BL-753: only over the record that is there, since a write landing after the Subagent's
		// delete would make it again, outside the user's Subagent list.
		const deletedMeanwhile = { error: 'Subagent not found: it was deleted while this edit was saved.' }
		const modelOptions = expectedModelSelection !== undefined ? { expectedModelSelection: expectedModelSelection as string } : {}
		const written = await service.updateSubagent(params.id!, writes, {
      onTypedFileToolsSaved(ack) { typedToolsAck = ack },
      ...(expectedTypedFileTools !== undefined ? { expectedTypedFileTools } : {}),
			...modelOptions,
      ...(expectedInstructions !== undefined ? { expectedInstructions } : {}) })
		if (!written) {
			return json(deletedMeanwhile, { status: 404 })
		}
    if (Object.hasOwn(writes, 'provider_specific_settings')) void publishUserEvent(locals.user.id, { type: 'subagent_settings_changed', agentId: params.id!, family: 'provider-settings' })
		if (instructionLeaves(writes).length) await publishUserEvent(locals.user.id, { type: 'subagent_settings_changed', agentId: params.id!, family: 'instructions' })
		// The record as it is now, after this save AND any other that landed: the answer goes on
		// from it, never from the body over an older read.
		const savedData = await service.json.get(`subagent:${params.id}`)
		if (!savedData) {
      if (typedToolsAck) return json({ success: true, typedFileToolsSaved: true, typedFileTools: typedToolsAck, readback: 'unavailable' })
      return json(deletedMeanwhile, { status: 404 })
    }
		const storageUpdated = canonicalizeSubagentRecord(savedData as Record<string, any>) as SubagentRow

		return json({
			subagent: resolveUploadUrlsForBrowserInPayload(storageUpdated),
      ...(typedToolsAck ? { typedFileTools: typedToolsAck } : {})
		})
	} catch (error) {
    if ((error as any)?.code === 'typed_file_tools_save_unconfirmed') void publishUserEvent(locals.user.id, { type: 'subagent_settings_changed', agentId: params.id!, family: 'provider-settings' })
		console.error('Failed to update subagent:', error)
		return json(
			{ error: error instanceof Error ? error.message : 'Failed to update subagent',
        ...(typedToolsAck ? { typedFileToolsSaved: true, typedFileTools: typedToolsAck } : {}),
				...((error as any)?.code ? { code: (error as any).code } : {}) },
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
		const preparation = beginSlashCommandWrite(userId)
		await captureSlashCommandWriteBasis(preparation, [])
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
			const deleteStopped = (notices: string[]) => withSettingsRecordReplacement(`subagent:${subagentId}`, async () => {
				const { sweepAppActionsSubjectReferences } = await import('$lib/server/services/appActions/settings/authority')
				await sweepAppActionsSubjectReferences(userId, { kind: 'subagent', id: subagentId! })
				return deleteStoppedSubagent(userId, subagentId, existing, notices, preparation)
			})
			// The profile, pictures, reference sweeps, and record are all inside this reservation.
			return await (process.platform === 'win32'
				? deleteStopped([])
				: withHostCommandDeletion(resources, deleteStopped))
		} finally {
			runStop.release()
		}
	} catch (error) {
		console.error('Failed to delete subagent:', error)
		if (error instanceof AgentArtifactCleanupError) return json({ error: error.message, code: error.code,
			outcome: error.outcome, subjectRetained: error.subjectRetained, cleanup: error.progress }, { status: error.status })
		if (isSlashCommandMutationError(error)) return json({ error: error.message, code: error.code }, { status: error.status })
		if (error instanceof SettingsLifecycleRefusal) return json({ error: error.message, code: error.code }, { status: error.status })
		if (error instanceof SubjectPopulationError) return json({ error: error.message, code: error.code }, { status: error.status })
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
async function deleteStoppedSubagent(userId: string, subagentId: string, existing: SubagentRow, notices: string[], preparation: SlashCommandWritePreparation) {
	// BL-753: the profile folder goes before the record (below), so the folder's turn is held
	// until the record is gone. An edit's profile sync queued meanwhile then finds no record and
	// writes nothing; one that ran before is removed by the folder removal behind it.
	const removed = await holdManagedCliSubagentProfileFolder(existing, () =>
		removeStoppedSubagent(userId, subagentId, existing, preparation)
	)
	if (removed instanceof Response) return removed
	const profileFolder = removed

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
	existing: SubagentRow,
	preparation: SlashCommandWritePreparation
): Promise<Response | Awaited<ReturnType<typeof deleteManagedCliSubagentProfile>>> {
	const service = redis
	// BL-157: the managed CLI profile folder (config, and the CLI's logs with the
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
			if (isSlashCommandMutationError(error)) throw error
			console.error(`[subagents] Could not remove ${subagentId} from ${label}:`, error)
			failedSteps.push(`${label} (${error instanceof Error ? error.message : String(error)})`)
		}
	}

	// This actual subject replacement retains its own custody only for an issued unknown.
	const runAliasCleanup = async (write: () => Promise<unknown>) => {
		const lease = acquireSettingsReplacementMutation(`subagent:${subagentId}`)
		try { await write(); lease.settle() }
		catch (error) {
			if (isSlashCommandMutationError(error) && error.outcome === 'unknown') lease.unknown()
			else lease.settle()
			throw error
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
		await runStep('plugin access lists', async () => {
			const { removeAgentPluginAgentReferences } = await import('$lib/server/services/agentPlugins')
			await removeAgentPluginAgentReferences(userId, subagentId, 'subagent')
		})
		await runStep('skill access lists', async (client) => {
			for (const key of (await client.keys(`slash_command:${userId}:*`)) as string[]) {
				const id = key.slice(`slash_command:${userId}:`.length)
				const basis = await captureSlashCommandWriteBasis(preparation, [id])
				await runAliasCleanup(() => removeExplicitSlashCommandAgentAccess(userId, id, subagentId, basis))
			}
		})
		// BL-392: a skill SOURCE's list too. Each rescan copies it onto every skill the source
		// provides, so the id left there gave those skills back to a same-name agent.
		await runStep('skill source access lists', async (client) => {
			for (const key of (await client.keys(`skill_source:${userId}:*`)) as string[]) {
				const id = key.slice(`skill_source:${userId}:`.length)
				const basis = await captureSkillSourceWriteBasis(preparation, id)
				await runAliasCleanup(() => removeExplicitSkillSourceAgentAccess(userId, id, subagentId, basis))
			}
		})
		await removeRequiredArtifactAgentReferences({ userId, id: subagentId, kind: 'subagent' }, () => {
			currentSlashCommandWriteRevision(preparation)
		})
	}

	// BL-391: its threads in the user's chats, all named for its SLUG: the stored exchanges and a
	// run lock. Ids (and so slugs)
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

	// One admitted physical population boundary, after the existing reference/profile cleanup.
	await service.execute(client => deleteSubagentPopulation(client, { userId, subjectId: subagentId,
		expectedCatalogueRevision: currentSlashCommandWriteRevision(preparation) }))

	return profileFolder
}
