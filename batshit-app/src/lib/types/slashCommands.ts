export type SlashCommandSource = 'batshit'
export type SlashCommandScope = 'global' | 'managed' | 'project'

export interface SlashCommandDescriptor {
  id: string
  name: string
  invocation: string
  description?: string
  source: SlashCommandSource
  displayName?: string
  argumentHint?: string
  plugin?: string
  scope?: SlashCommandScope
}
