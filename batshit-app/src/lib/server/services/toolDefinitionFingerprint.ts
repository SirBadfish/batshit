import { asSchema } from 'ai'
import { createHash } from 'node:crypto'

export class ToolDefinitionUnavailableError extends Error {
  readonly code = 'TOOL_DEFINITIONS_UNAVAILABLE'
  constructor() { super('The registered tool definitions could not be serialized. Nothing was sent.'); this.name = 'ToolDefinitionUnavailableError' }
}

/** One serialization owner for the real registered definitions and provider cache key. */
export function serializeRegisteredTools(tools?: Record<string, any>) {
  try {
    return Object.entries(tools ?? {}).map(([name, definition]) => {
      const schema = (value: any) => {
        if (!value) return null
        const result = asSchema(value).jsonSchema
        if (result === undefined) throw new ToolDefinitionUnavailableError()
        return result
      }
      return {
        name,
        type: definition?.type ?? 'function',
        id: definition?.id ?? null,
        args: definition?.args ?? null,
        title: definition?.title ?? null,
        description: typeof definition?.description === 'string' ? definition.description : null,
        inputSchema: schema(definition?.inputSchema),
        outputSchema: schema(definition?.outputSchema),
        strict: definition?.strict ?? null,
        providerOptions: definition?.providerOptions ?? null,
        inputExamples: definition?.inputExamples ?? null
      }
    })
  } catch { throw new ToolDefinitionUnavailableError() }
}

export function fingerprintRegisteredTools(tools?: Record<string, any>): string {
  try {
    // Preserve array/definition/property order: the provider reads those bytes in order.
    // Execution callbacks and private run/approval handles are deliberately not serialized.
    const serialized = JSON.stringify(serializeRegisteredTools(tools))
    return createHash('sha256').update(serialized, 'utf8').digest('hex')
  } catch { throw new ToolDefinitionUnavailableError() }
}
