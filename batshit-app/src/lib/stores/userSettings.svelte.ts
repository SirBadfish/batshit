import type { VoiceSettings } from '$lib/types/voice'
import type { GoonsSettings } from '$lib/types/goons'
import type { GlobalToolGridSettings } from '$lib/types/database'
import type { AvatarIconFit, IconRef } from '$lib/icons/iconTypes'
import type { GlobalAutoCompactSettings } from '$lib/utils/contextCompaction'

interface UserSettings {
  displayName?: string
  avatar_url?: string | null
  avatar_icon_ref?: IconRef | null
  avatar_icon_fit?: AvatarIconFit | null

  // DEPRECATED - will be removed
  always_show_zip_borders?: boolean

  // Visual indicator settings (8 granular controls)
  show_zipped_badges?: boolean
  zipped_badges_hover_only?: boolean
  show_zipped_borders?: boolean
  zipped_borders_hover_only?: boolean
  show_unzipped_badges?: boolean
  unzipped_badges_hover_only?: boolean
  show_unzipped_borders?: boolean
  unzipped_borders_hover_only?: boolean

  // Global zip configuration
  global_zip_settings?: Record<string, any>
  global_auto_compact_settings?: GlobalAutoCompactSettings
  global_tool_grid_settings?: GlobalToolGridSettings

  // Uploads
  upload_settings?: Record<string, any>
  upload_provider?: string
  default_workspace_path?: string
  voice_settings?: VoiceSettings
  goons_settings?: GoonsSettings

  ui_settings?: {
    compress_images: boolean
    compression_quality: number
    max_image_size: number
    force_jpeg: boolean
    upload_strategy: string
    show_zip_visual_indicators?: boolean  // DEPRECATED - replaced by 8 granular settings
  } | Record<string, any>  // Allow for flexible ui_settings format

  admin_settings?: {
    dcm_schema_hint_required_limit?: number
    dcm_schema_hint_optional_limit?: number
    dcm_schema_hint_max_chars?: number
    dcm_tool_name_threshold?: number
    goon_lip_sync_lab_enabled?: boolean
  }

  onboarding_settings?: {
    setup_completed_at?: string | null
    setup_skipped_at?: string | null
    last_seen_step?: 'api-keys' | 'models' | 'agents' | null
  }
}

// Create a state for user settings using Svelte 5 $state rune
let userSettingsStore = $state<UserSettings | null>(null)

// Helper function to update specific settings
export function updateUserSettings(updates: Partial<UserSettings>) {
  if (!userSettingsStore) return
  userSettingsStore = { ...userSettingsStore, ...updates }
}

// Export function to get the settings
export function getUserSettings(): UserSettings | null {
  return userSettingsStore
}

// Export function to set the settings
export function setUserSettings(settings: UserSettings | null) {
  userSettingsStore = settings
}
