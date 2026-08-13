import type { DesktopGoonPreferences } from '$lib/types/goons'

export const LIVE_SETTINGS_EVENTS = {
  artifactUpdated: 'batshit:artifact-updated',
  artifactDeleted: 'batshit:artifact-deleted',
  artifactDraftPreview: 'batshit:artifact-draft-preview',
  localAiSettingsUpdated: 'batshit:local-ai-settings-updated',
  modelConnectionsUpdated: 'batshit:model-connections-updated',
  projectPreferencesUpdated: 'batshit:project-preferences-updated',
  desktopGoonPreferencesUpdated: 'batshit:desktop-goon-preferences-updated',
  sessionClipStateChanged: 'batshit:session-clip-state-changed',
  slashCommandsUpdated: 'batshit:slash-commands-updated'
} as const

export type ArtifactUpdatedDetail = {
  artifactId: string
}

export type ArtifactDeletedDetail = {
  artifactId: string
}

export type ArtifactDraftPreviewDetail = {
  artifactId: string | null
}

export type ModelConnectionsUpdatedDetail = {
  source: 'api-keys' | 'custom-providers' | 'local-ai' | 'saved-models' | 'runtime' | 'unknown'
}

export type ProjectPreferencesUpdatedDetail = {
  defaultWorkspacePath: string | null
}

export type DesktopGoonPreferencesUpdatedDetail = {
  preferences: DesktopGoonPreferences
  source: 'settings' | 'desktop-controls' | 'runtime'
}

export type SessionClipStateChangedDetail = {
  sessionId: string
  clipId?: string
  source: 'artifact-share' | 'clip-manager' | 'upload' | 'runtime' | 'unknown'
}

export type SlashCommandsUpdatedDetail = {
  source: 'agent-access' | 'settings' | 'skill-source' | 'bootstrap' | 'runtime' | 'unknown'
  commandId?: string
}

function dispatchLiveSettingsEvent<T>(name: string, detail?: T) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

export function dispatchArtifactUpdated(artifactId: string) {
  dispatchLiveSettingsEvent<ArtifactUpdatedDetail>(LIVE_SETTINGS_EVENTS.artifactUpdated, {
    artifactId
  })
}

export function dispatchArtifactDeleted(artifactId: string) {
  dispatchLiveSettingsEvent<ArtifactDeletedDetail>(LIVE_SETTINGS_EVENTS.artifactDeleted, {
    artifactId
  })
}

export function dispatchArtifactDraftPreview(artifactId: string | null) {
  dispatchLiveSettingsEvent<ArtifactDraftPreviewDetail>(LIVE_SETTINGS_EVENTS.artifactDraftPreview, {
    artifactId
  })
}

export function dispatchLocalAiSettingsUpdated() {
  dispatchLiveSettingsEvent(LIVE_SETTINGS_EVENTS.localAiSettingsUpdated)
  dispatchModelConnectionsUpdated('local-ai')
}

export function dispatchModelConnectionsUpdated(
  source: ModelConnectionsUpdatedDetail['source'] = 'unknown'
) {
  dispatchLiveSettingsEvent<ModelConnectionsUpdatedDetail>(
    LIVE_SETTINGS_EVENTS.modelConnectionsUpdated,
    { source }
  )
}

export function dispatchProjectPreferencesUpdated(detail: ProjectPreferencesUpdatedDetail) {
  dispatchLiveSettingsEvent<ProjectPreferencesUpdatedDetail>(
    LIVE_SETTINGS_EVENTS.projectPreferencesUpdated,
    detail
  )
}

export function dispatchDesktopGoonPreferencesUpdated(detail: DesktopGoonPreferencesUpdatedDetail) {
  dispatchLiveSettingsEvent<DesktopGoonPreferencesUpdatedDetail>(
    LIVE_SETTINGS_EVENTS.desktopGoonPreferencesUpdated,
    detail
  )
}

export function dispatchSessionClipStateChanged(detail: SessionClipStateChangedDetail) {
  dispatchLiveSettingsEvent<SessionClipStateChangedDetail>(
    LIVE_SETTINGS_EVENTS.sessionClipStateChanged,
    detail
  )
}

export function dispatchSlashCommandsUpdated(
  detail: SlashCommandsUpdatedDetail = { source: 'unknown' }
) {
  dispatchLiveSettingsEvent<SlashCommandsUpdatedDetail>(
    LIVE_SETTINGS_EVENTS.slashCommandsUpdated,
    detail
  )
}
