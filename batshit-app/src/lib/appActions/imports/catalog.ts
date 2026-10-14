import type { AppActionDescriptor } from '../family'
import type { SuppliedFileActionId } from './contracts'

const base = {
  owner: 'developer_bytes', callers: ['developer'], risk: 'confirm',
  undo: 'No automatic retry or deletion. Use the existing owner UI to cancel a draft or manage saved objects.'
} as const
const identifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' }
const sessionIdentifier = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$', not: { const: '__create__' } }
export const SUPPLIED_FILE_ACTION_CATALOG = [
  {
    ...base, id: 'clip.import_files', label: 'Import Clip Files',
    effects: ['upload supplied files using saved compression settings', 'save Clips', 'optionally attach to the captured session'],
    postcondition: 'Each Clip is read back through its authenticated owner; attachment is separately read back for the exact session.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['sessionId', 'attach'], properties: {
      sessionId: { anyOf: [sessionIdentifier, { type: 'null' }] }, attach: { type: 'boolean' }
    } }
  },
  {
    ...base, id: 'avatar.import_file', label: 'Import an Avatar Image',
    effects: ['upload supplied image for the captured settings entity', 'stage avatar through the existing settings save owner'],
    postcondition: 'Upload, staged draft, successful settings save and rendered readiness are separate facts; upload deletes no old picture.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['entityType', 'entityId'], properties: {
      entityType: { type: 'string', enum: ['user', 'group', 'agent', 'subagent'] }, entityId: identifier
    } }
  }
] as const satisfies readonly AppActionDescriptor<SuppliedFileActionId>[]
