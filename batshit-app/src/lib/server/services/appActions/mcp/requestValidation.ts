/** P5 input data only. This leaf grants no identity, permission or effect consent. */
export class McpWorkflowInputRefusal extends Error {
  readonly status = 400
  constructor(readonly code: string) { super(code); this.name = 'McpWorkflowInputRefusal' }
}
export function invalidMcpInput(code = 'INVALID_MCP_ARGUMENTS'): never { throw new McpWorkflowInputRefusal(code) }
export function mcpObject(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalidMcpInput()
  return value as Record<string, unknown>
}
export function mcpText(value: unknown, maximum = 128): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || !value.isWellFormed() || /[\x00-\x1f\x7f]/.test(value)) invalidMcpInput('INVALID_MCP_TEXT')
  return value
}
export function mcpRevision(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) invalidMcpInput('INVALID_MCP_REVISION')
  return value
}
export function mcpInteger(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalidMcpInput('INVALID_MCP_NUMBER')
  return value
}
export function mcpList<T>(value: unknown, maximum: number, parse: (item: unknown) => T, allowEmpty = true): readonly T[] {
  if (!Array.isArray(value) || value.length > maximum || !allowEmpty && !value.length) invalidMcpInput('INVALID_MCP_LIST')
  return Object.freeze(value.map(parse))
}
export function uniqueMcpRows<T>(rows: readonly T[], key: (row: T) => string): readonly T[] {
  if (new Set(rows.map(key)).size !== rows.length) invalidMcpInput('DUPLICATE_MCP_IDENTITY')
  return rows
}
/** Validate all nested text before serialization, including unknown tool argument keys. */
export function boundedMcpJson(value: unknown, maximumBytes = 16_384): string {
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    if (depth > 32) invalidMcpInput('MCP_JSON_DEPTH')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'string') { if (!item.isWellFormed()) invalidMcpInput('INVALID_MCP_TEXT'); return }
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || seen.has(item)) invalidMcpInput('INVALID_MCP_JSON')
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) invalidMcpInput('INVALID_MCP_JSON')
    seen.add(item)
    for (const [key, child] of Object.entries(item)) {
      if (!key.isWellFormed()) invalidMcpInput('INVALID_MCP_TEXT')
      visit(child, depth + 1)
    }
    seen.delete(item)
  }
  visit(value, 0)
  const serialized = JSON.stringify(value)
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > maximumBytes) invalidMcpInput('MCP_JSON_BUDGET')
  return serialized
}
