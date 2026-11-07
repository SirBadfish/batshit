import { publishUserEvent } from '$lib/server/ssePublisher'
import { readTypedFileToolsHost } from '$lib/server/services/typedFileToolsHost.server'
import { readToolOperationsSnapshot, saveToolOperationalSettings, ToolOperationsInvalid, ToolOperationsUnconfirmed } from '$lib/server/toolOperationalSettingsOwner'
import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { RedisService } from '$lib/server/redis'
import { invalidateUserSettingsCache } from '$lib/services/databaseRedis.server'
import { normalizeVoiceSettings, shouldStopVoiceRuntimeOnShutdown } from '$lib/utils/voiceSchema'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { normalizeGlobalChatSettings } from '$lib/utils/steerControl'
import { validateJevJuiceGlobalZipFields } from '$lib/utils/jevJuiceControl'
import { validateTypedFileToolsGlobalField } from '$lib/utils/typedFileToolsGrant'
import { validateLiveFileReadsGlobalField } from '$lib/utils/liveFileReads'
import { withoutSkillReadSettings } from '$lib/utils/skillSessions'
import { normalizeAppearanceSettings } from '$lib/appearance/appLook'
import { PresetReferenceWriteError } from '$lib/server/services/modelPresetReferenceGuard'

const NO_STORE_RESPONSE = {
	headers: {
		'Cache-Control': 'no-store'
	}
}

function stripEngineRegistryFromVoiceSettings(value: unknown) {
	const normalized = normalizeVoiceSettings(value)
	const { byoProviders: _ignored, ...rest } = normalized
	return rest
}

function sanitizeSettingsResponse(settings: any) {
	if (!settings) return settings
	return {
		...settings,
		voice_settings: stripEngineRegistryFromVoiceSettings(settings.voice_settings)
	}
}

function getErrorStatus(error: unknown) {
	const status = (error as { status?: unknown } | null)?.status
	return typeof status === 'number' && status >= 400 && status < 600 ? status : 500
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const data = await request.json()
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Settings changes must be an object.' }, { status: 400 })
		if ('global_api_reasoning_retention' in data || 'global_api_reasoning_retention_patch' in data) {
			return json({ error: 'Reasoning Retention is configured per agent in Agent Settings → Core.' }, { status: 400 })
		}
		const redis = new RedisService()
    if (Object.hasOwn(data, 'tool_operations_patch')) {
      if (Object.keys(data).some(key => !['tool_operations_patch', 'expectedToolOperations'].includes(key))) throw new ToolOperationsInvalid('Save global tool options separately from other settings. Nothing was saved.')
      try {
        const saved = await saveToolOperationalSettings(locals.user.id, data.expectedToolOperations, data.tool_operations_patch)
        invalidateUserSettingsCache(locals.user.id)
        await publishUserEvent(locals.user.id, { type: 'user_settings_changed', family: 'tool-operations' })
        return json({ success: true, toolOperations: { revision: saved.revision, values: saved.values, host: { containerized: readTypedFileToolsHost().containerized } } }, NO_STORE_RESPONSE)
      } catch (error) {
        // A possibly issued command can change runtime defaults even when its reply is lost.
        if (error instanceof ToolOperationsUnconfirmed) {
          invalidateUserSettingsCache(locals.user.id)
          await publishUserEvent(locals.user.id, { type: 'user_settings_changed', family: 'tool-operations' })
        }
        throw error
      }
    }
    if (Object.hasOwn(data, 'expectedToolOperations')) throw new ToolOperationsInvalid('No global tool option changes were supplied.')
		const avatarIconRef = normalizeOptionalIconRefInput(data.avatar_icon_ref, 'avatar_icon_ref')
		const avatarIconFit = normalizeOptionalAvatarIconFitInput(data.avatar_icon_fit, 'avatar_icon_fit')
		
		// Check if this is a settings update (not a profile update)
		const profileFields = new Set(['displayName', 'avatar_url', 'avatar_icon_ref', 'avatar_icon_fit'])
		const isSettingsUpdate = Object.keys(data).some(key => 
			!profileFields.has(key)
		)
		
		if (isSettingsUpdate) {
			// Settings update - merge with existing settings
			const existing = (await redis.getUserSettings(locals.user.id)) || {}
			const nextDisplayName =
				typeof data.displayName === 'string' ? data.displayName.trim() : (existing as any).displayName

			if (typeof data.displayName === 'string') {
				if (!nextDisplayName || nextDisplayName.length === 0) {
					return json({ error: 'Display name is required' }, { status: 400 })
				}
				if (nextDisplayName.length > 14) {
					return json({ error: 'Display name must be 14 characters or less' }, { status: 400 })
				}
			}

			// SA-120 P5 (LS-054): `global_zip_settings` is stored whole, so a mistyped Judge Juice
			// switch is refused here rather than saved and quietly read as OFF.
			const jevJuiceError = validateJevJuiceGlobalZipFields(data.global_zip_settings)
			if (jevJuiceError) {
				return json({ error: jevJuiceError }, { status: 400 })
			}
			// SA-137 P4a: the same block carries Live File Reads; a mistyped value is refused, never
			// saved and quietly read as "not set".
			const liveFileReadsError = validateLiveFileReadsGlobalField(data.global_zip_settings)
			if (liveFileReadsError) {
				return json({ error: liveFileReadsError }, { status: 400 })
			}
			// SA-136 D1: `global_tool_grid_settings` is stored whole too; a mistyped typed file tools
			// grant is refused, never saved and quietly read as "inherit".
			const typedFileToolsError = validateTypedFileToolsGlobalField(data.global_tool_grid_settings)
			if (typedFileToolsError) {
				return json({ error: typedFileToolsError }, { status: 400 })
			}

			// The app's look: one of the named looks or nothing is saved (never stored and quietly
			// read as the default).
			const appearanceSettings = data.appearance_settings !== undefined ? normalizeAppearanceSettings(data.appearance_settings) : undefined

			// Actual patch merge/validation belongs to the lower writer's captured current root.
			const nextGoonsSettings = data.goons_settings
			const nextVoiceSettings = data.voice_settings

			// Build update object preserving existing values (but allow profile fields when provided)
			const updateData: any = {
				displayName: nextDisplayName,
				avatar_url: data.avatar_url !== undefined ? data.avatar_url : (existing as any).avatar_url,
				avatar_icon_ref: avatarIconRef !== undefined ? avatarIconRef : (existing as any).avatar_icon_ref,
				avatar_icon_fit: avatarIconFit !== undefined ? avatarIconFit : (existing as any).avatar_icon_fit,
				// Legacy setting (keeping for now)
				always_show_zip_borders: data.always_show_zip_borders !== undefined ? 
					data.always_show_zip_borders : (existing as any).always_show_zip_borders,
				// New visual indicator settings
				show_zipped_badges: data.show_zipped_badges !== undefined ? 
					data.show_zipped_badges : (existing as any).show_zipped_badges,
				zipped_badges_hover_only: data.zipped_badges_hover_only !== undefined ? 
					data.zipped_badges_hover_only : (existing as any).zipped_badges_hover_only,
				show_zipped_borders: data.show_zipped_borders !== undefined ? 
					data.show_zipped_borders : (existing as any).show_zipped_borders,
				zipped_borders_hover_only: data.zipped_borders_hover_only !== undefined ? 
					data.zipped_borders_hover_only : (existing as any).zipped_borders_hover_only,
				show_unzipped_badges: data.show_unzipped_badges !== undefined ? 
					data.show_unzipped_badges : (existing as any).show_unzipped_badges,
				unzipped_badges_hover_only: data.unzipped_badges_hover_only !== undefined ? 
					data.unzipped_badges_hover_only : (existing as any).unzipped_badges_hover_only,
				show_unzipped_borders: data.show_unzipped_borders !== undefined ? 
					data.show_unzipped_borders : (existing as any).show_unzipped_borders,
				unzipped_borders_hover_only: data.unzipped_borders_hover_only !== undefined ? 
					data.unzipped_borders_hover_only : (existing as any).unzipped_borders_hover_only,
				// Global zip settings
				global_zip_settings: data.global_zip_settings !== undefined ? 
					withoutSkillReadSettings(data.global_zip_settings) : withoutSkillReadSettings((existing as any).global_zip_settings),
				global_auto_compact_settings:
					data.global_auto_compact_settings !== undefined ?
						data.global_auto_compact_settings : (existing as any).global_auto_compact_settings,
				global_tool_grid_settings:
					data.global_tool_grid_settings !== undefined ?
						data.global_tool_grid_settings : (existing as any).global_tool_grid_settings,
				// SA-114 P3 (DL-114-01): what a send does while the agent is still replying.
				global_chat_settings:
					data.global_chat_settings !== undefined ?
						normalizeGlobalChatSettings(data.global_chat_settings)
						: (existing as any).global_chat_settings,
				appearance_settings: appearanceSettings ?? (existing as any).appearance_settings,
				// Other settings
				ui_settings: data.ui_settings !== undefined ? 
					data.ui_settings : (existing as any).ui_settings,
				admin_settings: data.admin_settings !== undefined ?
					data.admin_settings : (existing as any).admin_settings,
				onboarding_settings: data.onboarding_settings !== undefined ?
					data.onboarding_settings : (existing as any).onboarding_settings,
				global_custom_system_prompt: data.global_custom_system_prompt !== undefined ? 
					data.global_custom_system_prompt : (existing as any).global_custom_system_prompt,
					upload_settings: data.upload_settings !== undefined ? 
						data.upload_settings : (existing as any).upload_settings,
						upload_provider: data.upload_provider !== undefined ? 
							data.upload_provider : (existing as any).upload_provider,
						show_zip_visual_indicators: data.show_zip_visual_indicators !== undefined ?
							data.show_zip_visual_indicators : (existing as any).ui_settings?.show_zip_visual_indicators,
				voice_settings: nextVoiceSettings,
				goons_settings: nextGoonsSettings
			}
			
			// Forward explicit intent only. Unsent groups belong to the lower writer's current root.
			for (const key of Object.keys(updateData)) if (!Object.hasOwn(data, key)) delete updateData[key]
			if (data.goons_settings_patch !== undefined) { updateData.goons_settings_patch = data.goons_settings_patch; if (data.goons_settings === undefined) delete updateData.goons_settings }
			if (data.voice_settings_patch !== undefined) { updateData.voice_settings_patch = data.voice_settings_patch; if (data.voice_settings === undefined) delete updateData.voice_settings }
			let settings
			try {
				settings = await redis.updateUserSettings(locals.user.id, updateData)
			} catch (error) {
				// A write whose outcome is unknown may have landed: every window re-reads its look.
				if (appearanceSettings && error instanceof PresetReferenceWriteError && error.outcome === 'unknown') {
					invalidateUserSettingsCache(locals.user.id)
					await publishUserEvent(locals.user.id, { type: 'user_settings_changed', family: 'appearance' })
				}
				throw error
			}
			invalidateUserSettingsCache(locals.user.id)
			// Every open window (the Mac app and a browser tab) repaints in the saved look.
			if (appearanceSettings) await publishUserEvent(locals.user.id, { type: 'user_settings_changed', family: 'appearance' })


			// LiveKit's "Stop with Batshit" reaches this Batshit's running LiveKit launch records only
			// once the save is confirmed (BL-1301); a failed save changes no record. The save stands
			// either way: what the records did not take is logged here and shown in the LiveKit row.
			const liveKitStop = (value: unknown) => shouldStopVoiceRuntimeOnShutdown(normalizeVoiceSettings(value).voiceRuntimes?.livekit?.startup)
			if ((data.voice_settings !== undefined || data.voice_settings_patch !== undefined) && liveKitStop((existing as any).voice_settings) !== liveKitStop((settings as any)?.voice_settings)) {
				const { syncLiveKitStopPreference } = await import('$lib/server/services/liveKitSidecarRuntime')
				await syncLiveKitStopPreference(locals.user.id).then(
					(result) => {
						if (!result.complete) console.warn('[user/settings] LiveKit Stop with Batshit did not reach every launch record:', result.problems)
					},
					(error) => console.warn('[user/settings] LiveKit Stop with Batshit did not reach its launch records:', error)
				)
			}

			return json({ success: true, settings: sanitizeSettingsResponse(settings) })
		}
		
		// Otherwise, it's a regular user profile update
		const { displayName, avatar_url } = data
		
		// Validate display name only for profile updates
		if (!displayName || displayName.trim().length === 0) {
			return json({ error: 'Display name is required' }, { status: 400 })
		}
		
		if (displayName.trim().length > 14) {
			return json({ error: 'Display name must be 14 characters or less' }, { status: 400 })
		}
		
		const settings = await redis.updateUserSettings(locals.user.id, {
			displayName: displayName.trim(),
			avatar_url,
			...(avatarIconRef !== undefined ? { avatar_icon_ref: avatarIconRef } : {}),
			...(avatarIconFit !== undefined ? { avatar_icon_fit: avatarIconFit } : {})
		})
		invalidateUserSettingsCache(locals.user.id)
		
		return json({ success: true, settings: sanitizeSettingsResponse(settings) })
	} catch (error) {
		console.error('Error updating user settings:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to update settings',
      ...(typeof (error as any)?.code === 'string' ? { code: (error as any).code } : {})
		}, { status: getErrorStatus(error) })
	}
}

export const GET: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const redis = new RedisService()
    if (url?.searchParams.get('toolOperations') === '1') {
      const source = await redis.execute(client => readToolOperationsSnapshot(client, locals.user!.id))
      return json({ toolOperations: { revision: source.revision, values: source.values, host: { containerized: readTypedFileToolsHost().containerized } } }, NO_STORE_RESPONSE)
    }
		const settings = await redis.getUserSettings(locals.user.id)
		
		return json({ settings: sanitizeSettingsResponse(settings) }, NO_STORE_RESPONSE)
	} catch (error) {
		console.error('Error getting user settings:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to get settings' 
		}, { status: 500 })
	}
}
