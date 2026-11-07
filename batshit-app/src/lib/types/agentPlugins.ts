export interface AgentPluginSkillDescriptor {
  commandId: string
  skillId: string
  name: string
  invocation: string
}

export interface AgentPluginDescriptor {
  id: string
  name: string
  description: string
  version: string
  builtIn: boolean
  skills: AgentPluginSkillDescriptor[]
  enabled_for_all_agents: boolean
  enabled_agent_ids: string[]
  installing?: boolean
  removing?: boolean
  revision: string
}
