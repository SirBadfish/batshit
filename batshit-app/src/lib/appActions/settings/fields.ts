import { SETTINGS_TABS, type SettingsTab } from '../catalog'
import type { AppActionDescriptor } from '../family'

export type SettingsScalar = string | number | boolean
export type SettingsFieldAccess = 'read_only' | 'own_agent' | 'masked' | 'human_only' | 'unavailable'
export type SettingsFieldDescriptor = {
  id: string
  label: string
  type: 'string' | 'integer' | 'boolean' | 'enum'
  access: SettingsFieldAccess
  reason?: string
}

// This is a field allowlist, never a JSON-path interpreter. New fields require an
// explicit projection and owner review. Sensitive blocks are named, never copied.
export const SETTINGS_FIELDS = {
  agents: [
    { id: 'displayName', label: 'Agent name', type: 'string', access: 'own_agent' },
    { id: 'agentType', label: 'Primary Agent type', type: 'enum', access: 'read_only' },
    { id: 'permissions', label: 'Permissions and access', type: 'string', access: 'human_only' }
  ],
  groups: [{ id: 'entityCount', label: 'Saved groups', type: 'integer', access: 'read_only' }],
  models: [
    { id: 'entityCount', label: 'Saved models', type: 'integer', access: 'read_only' },
    { id: 'connections', label: 'Provider connections', type: 'string', access: 'masked' }
  ],
  projects: [
    { id: 'entityCount', label: 'Saved projects', type: 'integer', access: 'read_only' },
    { id: 'paths', label: 'Workspace paths and exclusions', type: 'string', access: 'masked' }
  ],
  tools: [
    { id: 'zipViewMode', label: 'AI zip layout', type: 'enum', access: 'read_only' },
    { id: 'toolNotes', label: 'Tool Notes', type: 'boolean', access: 'read_only' },
    { id: 'credentialsAndAccess', label: 'Gateway credentials and tool access', type: 'string', access: 'human_only' }
  ],
  artifacts: [{ id: 'entityCount', label: 'Saved artifacts', type: 'integer', access: 'read_only' }],
  'slash-commands': [{ id: 'skills', label: 'Skills and Prompts', type: 'string', access: 'unavailable', reason: 'Use the existing scoped Fabric skill controls.' }],
  memory: [
    { id: 'enabled', label: 'Agent Memory', type: 'boolean', access: 'read_only' },
    { id: 'onMyMind', label: 'On My Mind budget', type: 'integer', access: 'own_agent' },
    { id: 'triggers', label: 'Trigger budget', type: 'integer', access: 'own_agent' },
    { id: 'recalled', label: 'Recall budget', type: 'integer', access: 'own_agent' },
    { id: 'triggerLingerTurns', label: 'STM Trigger Linger Default', type: 'integer', access: 'own_agent' },
    { id: 'recallLingerTurns', label: 'Recall Linger Default', type: 'integer', access: 'own_agent' },
    { id: 'embeddingConfiguration', label: 'Memory System configuration', type: 'string', access: 'human_only' }
  ],
  '3d-goons': [
    { id: 'entityCount', label: 'Saved Goons', type: 'integer', access: 'read_only' },
    { id: 'dockOpen', label: 'Saved Goon Dock preference', type: 'boolean', access: 'read_only' },
    { id: 'desktop', label: 'Desktop Mode', type: 'string', access: 'human_only' }
  ],
  voice: [
    { id: 'lipSyncMode', label: '3D Goon Lip Sync mode', type: 'enum', access: 'read_only' },
    { id: 'providersAndDevices', label: 'Providers, engines and devices', type: 'string', access: 'masked' }
  ],
  icons: [{ id: 'library', label: 'Icon Library', type: 'string', access: 'unavailable', reason: 'Icon inspection requires its existing library owner.' }],
  theme: [{ id: 'theme', label: 'Themes', type: 'string', access: 'unavailable', reason: 'Themes is a placeholder; theme modification is not implemented.' }],
  clips: [
    { id: 'compressImages', label: 'Compress images', type: 'boolean', access: 'read_only' },
    { id: 'compressionQuality', label: 'Image quality', type: 'integer', access: 'read_only' },
    { id: 'maxImageSize', label: 'Maximum image size', type: 'enum', access: 'read_only' },
    { id: 'forceJpeg', label: 'Force JPEG', type: 'boolean', access: 'read_only' },
    { id: 'tunnel', label: 'Tunnel access', type: 'string', access: 'human_only' }
  ],
  'local-ai': [{ id: 'programs', label: 'Local AI programs and models', type: 'string', access: 'unavailable', reason: 'The Local AI owner has not supplied a masked inspection adapter.' }],
  'api-keys': [{ id: 'credentials', label: 'API keys and connections', type: 'string', access: 'human_only', reason: 'No key, token, account, environment or connection value is exposed.' }],
  admin: [{ id: 'administration', label: 'Administration', type: 'string', access: 'human_only', reason: 'Backup, restore, runtime, security and native controls stay with Admin.' }],
  dev: [{ id: 'developerControls', label: 'Developer controls', type: 'string', access: 'human_only', reason: 'The Settings Dev gate does not grant agents developer authority.' }],
  user: [
    { id: 'displayName', label: 'User display name', type: 'string', access: 'read_only' },
    { id: 'profileAndSession', label: 'Private profile and session', type: 'string', access: 'masked' }
  ]
} as const satisfies Record<SettingsTab, readonly SettingsFieldDescriptor[]>

const subject = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' }
const revision = { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }
const budget = { type: 'integer', minimum: 0, maximum: 20_000 }
const linger = { type: 'integer', minimum: 0, maximum: 8 }
const ownReadSchema = { type: 'object', additionalProperties: false, required: ['subjectAgentId'], properties: { subjectAgentId: subject } }

export const SETTINGS_ACTION_DESCRIPTORS: readonly AppActionDescriptor[] = [
  {
    id: 'settings.inspect', label: 'Inspect masked Settings', owner: 'server', callers: ['developer', 'agent'],
    risk: 'safe', effects: [], undo: 'No saved or visible change.',
    postcondition: 'Explicit admitted fields or an unavailable/human-only reason; no raw records, secrets or provider probes.',
    actsAsAgent: true,
    inputSchema: { type: 'object', additionalProperties: false, required: ['tab'], properties: { tab: { type: 'string', enum: [...SETTINGS_TABS] }, subjectAgentId: subject } }
  },
  {
    id: 'settings.agent.memory.read', label: 'Read own Agent Memory settings', owner: 'server', callers: ['agent'],
    risk: 'safe', effects: [], undo: 'No change.', actsAsAgent: true,
    postcondition: 'Current own Primary Agent settings, resolved by memoryControl, and a conditional revision.', inputSchema: ownReadSchema
  },
  {
    id: 'settings.agent.memory.update', label: 'Change own Agent Memory budgets or linger', owner: 'server', callers: ['agent'],
    risk: 'confirm', effects: ['Save only the five admitted own-agent memory preferences.', 'Change future memory context selection; existing linger records are not rewritten.'],
    undo: 'A separate confirmed inverse is offered only when every previous changed value is representable and the saved revision remains current.',
    postcondition: 'Atomic owner/revision check and field-only save; saved, readback and visible state reported separately.', actsAsAgent: true,
    inputSchema: { type: 'object', additionalProperties: false, required: ['subjectAgentId', 'expectedRevision', 'changes'], properties: {
      subjectAgentId: subject, expectedRevision: revision,
      changes: { type: 'object', additionalProperties: false, minProperties: 1, properties: { onMyMind: budget, triggers: budget, recalled: budget, triggerLingerTurns: linger, recallLingerTurns: linger } }
    } }
  },
  {
    id: 'settings.agent.identity.read', label: 'Read own agent display name', owner: 'server', callers: ['agent'],
    risk: 'safe', effects: [], undo: 'No change.', actsAsAgent: true,
    postcondition: 'Only the own Primary Agent display name and its conditional revision.', inputSchema: ownReadSchema
  },
  {
    id: 'settings.agent.identity.update', label: 'Change own agent display name', owner: 'server', callers: ['agent'],
    risk: 'safe', effects: ['Save the own Primary Agent displayName only; agent id and access remain unchanged.'],
    undo: 'A separate conditional change can restore a valid previous name while the returned revision remains current.',
    postcondition: 'Atomic owner/revision check and displayName save; saved, readback and visible state reported separately.', actsAsAgent: true,
    inputSchema: { type: 'object', additionalProperties: false, required: ['subjectAgentId', 'expectedRevision', 'changes'], properties: {
      subjectAgentId: subject, expectedRevision: revision,
      changes: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 200 } } }
    } }
  }
]
