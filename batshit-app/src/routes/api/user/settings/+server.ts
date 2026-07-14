import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { RedisService } from '$lib/server/redis'
import { invalidateUserSettingsCache } from '$lib/services/databaseRedis.server'
import { normalizeVoiceSettings } from '$lib/utils/voiceSchema'
import { normalizeOptionalIconRefInput } from '$lib/server/icons/iconRefInput'
import { normalizeOptionalAvatarIconFitInput } from '$lib/server/icons/avatarIconFitInput'
import { mergeGoonsSettingsPatch } from '$lib/goons/resolve'

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
		const redis = new RedisService()
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

			const nextGoonsSettings =
				data.goons_settings_patch !== undefined
					? mergeGoonsSettingsPatch((existing as any).goons_settings, data.goons_settings_patch)
					: data.goons_settings !== undefined ?
						data.goons_settings : (existing as any).goons_settings

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
					data.global_zip_settings : (existing as any).global_zip_settings,
				global_auto_compact_settings:
					data.global_auto_compact_settings !== undefined ?
						data.global_auto_compact_settings : (existing as any).global_auto_compact_settings,
				global_tool_grid_settings:
					data.global_tool_grid_settings !== undefined ?
						data.global_tool_grid_settings : (existing as any).global_tool_grid_settings,
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
						voice_settings: stripEngineRegistryFromVoiceSettings(
							data.voice_settings !== undefined ?
								data.voice_settings : (existing as any).voice_settings
						),
				goons_settings: nextGoonsSettings
			}
			
			const settings = await redis.updateUserSettings(locals.user.id, updateData)
			invalidateUserSettingsCache(locals.user.id)
			
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
			error: error instanceof Error ? error.message : 'Failed to update settings' 
		}, { status: getErrorStatus(error) })
	}
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) {
		return json({ error: 'Not authenticated' }, { status: 401 })
	}
	
	try {
		const redis = new RedisService()
		const settings = await redis.getUserSettings(locals.user.id)
		
		return json({ settings: sanitizeSettingsResponse(settings) }, NO_STORE_RESPONSE)
	} catch (error) {
		console.error('Error getting user settings:', error)
		return json({ 
			error: error instanceof Error ? error.message : 'Failed to get settings' 
		}, { status: 500 })
	}
}
