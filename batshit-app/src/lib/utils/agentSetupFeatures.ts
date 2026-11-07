/** Exact shipped feature definitions only. Neither a custom id prefix nor tags grant exemption. */
export const AGENT_SETUP_FEATURES = [
  { id: 'memory', label: 'Memory', controls: [
    'sys.memory.save', 'sys.memory.search', 'sys.memory.list', 'sys.memory.update',
    'sys.memory.supersede', 'sys.memory.unsupersede', 'sys.memory.move_lane',
    'sys.memory.recall', 'sys.memory.delete', 'sys.memory.close_episode',
    'sys.memory.hold_episode'
  ] },
  { id: 'dm', label: 'Agent DMs', controls: [
    'sys.dm.send', 'sys.dm.list', 'sys.dm.read', 'sys.dm.claim', 'sys.dm.done', 'sys.dm.blocked', 'sys.dm.agents'
  ] },
  { id: 'schedule', label: 'Schedules', controls: ['sys.schedule.list', 'sys.schedule.create', 'sys.schedule.update', 'sys.schedule.delete'] },
  { id: 'judge', label: 'Judge Juice', controls: ['sys.judge.ask'] },
  { id: 'whiteboard', label: 'Whiteboard', controls: ['sys.whiteboard.update'] },
  { id: 'zip', label: 'Fetch Zip', controls: ['sys.zip.fetch'] },
  { id: 'skill', label: 'Skills', controls: ['sys.skill.save', 'sys.skill.import'] }
] as const
export type AgentSetupFeature = (typeof AGENT_SETUP_FEATURES)[number]['id']
