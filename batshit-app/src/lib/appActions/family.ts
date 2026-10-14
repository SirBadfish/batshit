/** Policy metadata shared by discovery and the explicit owning adapters; never authority. */
export type AppActionCaller = 'developer' | 'agent' | 'speech'
export type AppActionRisk = 'safe' | 'confirm' | 'restricted'
export type AppActionDescriptor<Id extends string = string> = {
  id: Id
  label: string
  owner: 'browser' | 'server' | 'developer_bytes'
  callers: readonly AppActionCaller[]
  risk: AppActionRisk
  effects: readonly string[]
  undo: string
  postcondition: string
  inputSchema: Readonly<Record<string, unknown>>
  actsAsAgent?: boolean
}
