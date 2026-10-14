import type { AppActionDescriptor } from './family'

/** The local API remains developer convenience; remote identity is server-owned. */
export const APP_ACTIONS_VERSION = 'app-actions/v1' as const
export const SETTINGS_TABS = [
  'agents', 'groups', 'models', 'projects', 'tools', 'artifacts', 'slash-commands',
  'memory', '3d-goons', 'voice', 'icons', 'theme', 'clips', 'local-ai',
  'api-keys', 'admin', 'dev', 'user'
] as const
export const TOOLS_TABS = ['gateway-settings', 'cli-tools', 'tool-grid', 'zip-options'] as const
export type SettingsTab = typeof SETTINGS_TABS[number]
export type ToolsTab = typeof TOOLS_TABS[number]
export type SettingsTarget = {
  tab: SettingsTab
  agentId?: string
  modelId?: string
  artifactId?: string
  toolsTab?: ToolsTab
}
export type ActionId = 'settings.open' | 'settings.close' | 'goon.show' | 'goon.hide' | 'execution.open'
export type ActionArgs = SettingsTarget | Record<string, never>
export type ActionRequest = {
  requestId: string
  catalogVersion: typeof APP_ACTIONS_VERSION
  documentId: string
  documentEpoch: string
  expectedSessionId: string | null
  actionId: ActionId
  args: ActionArgs
  expiresAt: number
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false } as const
export const APP_ACTION_CATALOG = [
  {
    id: 'settings.open', label: 'Open Settings', effects: ['settings view'],
    inputSchema: {
      type: 'object', required: ['tab'], additionalProperties: false,
      properties: {
        tab: { type: 'string', enum: SETTINGS_TABS },
        agentId: { type: 'string', maxLength: 128, description: 'Exact existing Primary Agent for the agents tab. For your own settings, pass the acting Primary Agent ID. Omit only for an intentional generic Agents view; omission does not select you.' },
        modelId: { type: 'string', maxLength: 128, description: 'Existing saved preset, models tab only' },
        artifactId: { type: 'string', maxLength: 128, description: 'Existing Artifact, artifacts tab only' },
        toolsTab: { type: 'string', enum: TOOLS_TABS }
      }
    }
  },
  { id: 'settings.close', label: 'Close Settings', effects: ['settings view'], inputSchema: emptySchema },
  { id: 'goon.show', label: 'Show Goon Dock', effects: ['ordinary Dock visible', 'Artifact rail closed', 'save dockOpen only'], inputSchema: emptySchema },
  { id: 'goon.hide', label: 'Hide Goon Dock', effects: ['ordinary Dock hidden', 'save dockOpen only'], inputSchema: emptySchema },
  { id: 'execution.open', label: 'Open Execution Viewer', effects: ['current session viewer'], inputSchema: emptySchema }
] as const

/** Derive policy metadata from the five owners, never maintain a second catalog. */
export const P1_APP_ACTION_DESCRIPTORS: readonly AppActionDescriptor<ActionId>[] = APP_ACTION_CATALOG.map(action => ({
  ...action, owner: 'browser', callers: ['developer', 'agent'], risk: 'safe', actsAsAgent: true,
  undo: action.id === 'execution.open' ? 'Close the Execution Viewer with its usual control.'
    : action.id.startsWith('settings.') ? 'Use the inverse Settings view action.' : 'Use the inverse ordinary Dock visibility action.',
  postcondition: action.id.startsWith('goon.') ? 'Read ordinary Dock visibility and dockOpen save outcome independently.'
    : action.id === 'execution.open' ? 'Read mounted Viewer state for the bound selected session.'
      : action.id === 'settings.open' ? 'Read mounted Settings tab and any explicitly supplied entity/tools target. A tab-only receipt confirms the tab, not the selected agent.'
        : 'Read mounted guarded Settings view and exact target.'
}))

export class AppActionRefusal extends Error {
  constructor(public reason: string) { super(reason) }
}
export function refuse(reason: string): never { throw new AppActionRefusal(reason) }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) refuse('invalid_arguments')
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && value !== '__create__'
}

/** Produce a detached, canonical payload. No selector, callback or extra effectful key survives. */
export function parseActionRequest(value: unknown): ActionRequest {
  if (!record(value)) refuse('invalid_request')
  exactKeys(value, ['requestId', 'catalogVersion', 'documentId', 'documentEpoch', 'expectedSessionId', 'actionId', 'args', 'expiresAt'])
  if (!identifier(value.requestId) || !identifier(value.documentId) || !identifier(value.documentEpoch)) refuse('invalid_request')
  if (value.catalogVersion !== APP_ACTIONS_VERSION) refuse('stale_catalog')
  if (value.expectedSessionId !== null && !identifier(value.expectedSessionId)) refuse('invalid_request')
  if (!APP_ACTION_CATALOG.some(action => action.id === value.actionId)) refuse('unsupported_action')
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) refuse('invalid_request')
  if (!record(value.args)) refuse('invalid_arguments')
  const args: Record<string, unknown> = {}
  if (value.actionId === 'settings.open') {
    exactKeys(value.args, ['tab', 'agentId', 'modelId', 'artifactId', 'toolsTab'])
    if (!SETTINGS_TABS.includes(value.args.tab as SettingsTab)) refuse('unsupported_target')
    args.tab = value.args.tab
    for (const [key, tab] of [['agentId', 'agents'], ['modelId', 'models'], ['artifactId', 'artifacts']] as const) {
      if (Object.hasOwn(value.args, key)) {
        if (value.args.tab !== tab || !identifier(value.args[key])) refuse('invalid_arguments')
        args[key] = value.args[key]
      }
    }
    if (Object.hasOwn(value.args, 'toolsTab')) {
      if (value.args.tab !== 'tools' || !TOOLS_TABS.includes(value.args.toolsTab as ToolsTab)) refuse('unsupported_target')
      args.toolsTab = value.args.toolsTab
    }
  } else exactKeys(value.args, [])
  return {
    requestId: value.requestId, catalogVersion: APP_ACTIONS_VERSION,
    documentId: value.documentId, documentEpoch: value.documentEpoch,
    expectedSessionId: value.expectedSessionId as string | null,
    actionId: value.actionId as ActionId, args: args as ActionArgs, expiresAt: value.expiresAt
  }
}
