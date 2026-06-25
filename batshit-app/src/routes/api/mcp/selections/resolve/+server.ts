import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { resolveMCPSelections } from '$lib/server/services/mcpSelectionResolver'
import { asSchema } from 'ai'

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid request body' }, { status: 400 })
  }

  const agentId = typeof body.agentId === 'string' ? body.agentId : null
  if (!agentId) {
    return json({ error: 'agentId is required' }, { status: 400 })
  }

  const agents = await redis.getAgents(locals.user.id)
  const agent = agents.find((entry) => entry.id === agentId)
  if (!agent) {
    return json({ error: 'Agent not found' }, { status: 404 })
  }

  const includeToolSchemas = body.includeToolSchemas === true

  try {
    const resolution = await resolveMCPSelections({
      userId: locals.user.id,
      agentId,
      agent,
      selectedGateways: Array.isArray(body.selectedGateways) ? body.selectedGateways : null,
      toolSelections: body.mcpToolSelections ?? null,
      includeGatewayToolMap: true
    })

    const toolDefinitions = (() => {
      if (!includeToolSchemas) return undefined
      const tools = resolution.tools && typeof resolution.tools === 'object' ? resolution.tools : {}

      const output: Array<Record<string, any>> = []

      for (const [toolName, tool] of Object.entries(tools)) {
        const entry: Record<string, any> = { name: toolName }

        const description = (tool as any)?.description
        if (typeof description === 'string' && description.trim().length > 0) {
          entry.description = description
        } else {
          entry.description = null
        }

        try {
          const schema = asSchema((tool as any).inputSchema).jsonSchema as Record<string, any>
          const { $schema: _schema, ...rest } = schema ?? {}
          entry.parameters = rest
        } catch {
          entry.parameters = null
        }

        // OpenAI logs show `strict: false` for function tools.
        // We mirror that shape in toolDefinitions so Execution Viewer token estimation
        // is closer to what providers actually receive (and bill).
        entry.strict = false

        output.push(entry)
      }

      return output.sort((a, b) => String(a.name).localeCompare(String(b.name)))
    })()

    return json({
      resolvedGateways: resolution.resolvedGateways ?? null,
      defaultGateways: resolution.defaultGateways,
      resolvedToolSelections: resolution.resolvedToolSelections ?? null,
      gatewayToolMap: resolution.gatewayToolMap,
      ...(toolDefinitions ? { toolDefinitions } : {})
    })
  } catch (error) {
    console.error('[MCP Selection Resolver] Failed to resolve selections:', error)
    return json({ error: 'Failed to resolve MCP selections' }, { status: 500 })
  }
}
