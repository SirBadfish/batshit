import type { Project } from '$lib/stores/projects.svelte'
import { PROJECT_DEFAULT_EXCLUSIONS, PROJECT_SECURITY_EXCLUSIONS } from './exclusions'
import { DEFAULT_PROJECT_ICON_REF } from '$lib/icons/iconCatalog'

/**
 * BL-2373: the user's Default Project Path (`default_workspace_path`, Settings > Projects) is a
 * real Project in the browser: the Projects sidebar lists it first, Settings > Projects shows it
 * in Saved Projects, and an agent on Default shows it selected. It is BUILT from that one setting
 * and never stored: no project record, no Redis key, nothing to back up or sweep. Its id cannot be
 * a saved project's (`project_<timestamp>`), and no server route ever receives it: chat sends the
 * path, and an agent on Default keeps `default_project_id: null`.
 */
export const DEFAULT_PROJECT_ID = '__default_project__'
export const DEFAULT_PROJECT_NAME = 'Default Project'

/** The exclusions a new project gets with Default Exclusions on: always-excluded plus recommended. */
const DEFAULT_PROJECT_EXCLUSIONS: string[] = [...PROJECT_SECURITY_EXCLUSIONS, ...PROJECT_DEFAULT_EXCLUSIONS]

export function isDefaultProjectId(id: unknown): boolean {
  return id === DEFAULT_PROJECT_ID
}

/** The saved Default Project Path when it is a usable absolute path, else null (no Default Project). */
export function normalizeDefaultProjectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || !trimmed.startsWith('/')) return null
  return trimmed
}

/** The Default Project for a saved Default Project Path, or null when the path is blank. */
export function buildDefaultProject(defaultProjectPath: unknown): Project | null {
  const rootPath = normalizeDefaultProjectPath(defaultProjectPath)
  if (!rootPath) return null
  return {
    id: DEFAULT_PROJECT_ID,
    user_id: '',
    name: DEFAULT_PROJECT_NAME,
    root_path: rootPath,
    custom_exclusions: [...DEFAULT_PROJECT_EXCLUSIONS],
    icon_ref: DEFAULT_PROJECT_ICON_REF,
    is_default_project: true,
    created_at: '',
    updated_at: ''
  }
}
