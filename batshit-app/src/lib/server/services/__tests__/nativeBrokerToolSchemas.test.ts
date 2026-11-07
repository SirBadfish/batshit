import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { z } from 'zod'
import { nativeToolService } from '../nativeTools'

/**
 * Josh (2026-10-23): the API lane's Tool Search and Tool Use offer the model only fields it uses.
 * `selectedToolIds` is server plumbing there, `selectedGateways` was a narrow-only filter no bench
 * run sent, `allowRisky` is ignored on every chat lane, and `params` / `includeSchema` repeat
 * `input` / `schemaMode`. Tool Use stays pass-through, so a model that still sends `params` is read
 * as before.
 */
async function apiBrokerTools() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-broker-schema-'))
  const { tools } = await nativeToolService.buildMode3NativeTools({
    userId: 'josh',
    projectPath: root,
    providerSettings: {
      nativeTools: {
        bashEnabled: false,
        fetchZipEnabled: true,
        dynamicMcpEnabled: true,
        webSearchEnabled: false,
        agentBrowserEnabled: false
      }
    },
    toolApprovalMode: 'none'
  } as any)
  return tools as Record<string, any>
}

const propertiesOf = (tool: any) => Object.keys((z.toJSONSchema(tool.inputSchema) as any).properties ?? {})

describe('the API lane broker tools offer only fields the model should send', () => {
  it('Tool Search drops includeSchema and the server plumbing', async () => {
    const tools = await apiBrokerTools()
    expect(tools.native_batshit_tool_search).toBeTruthy()
    const fields = propertiesOf(tools.native_batshit_tool_search)
    expect(fields).toEqual(expect.arrayContaining(['domain', 'query', 'family', 'families', 'limit', 'schemaMode']))
    for (const cut of ['includeSchema', 'selectedGateways', 'selectedToolIds']) expect(fields).not.toContain(cut)
  })

  it('Tool Use drops params, allowRisky and the server plumbing, and still reads a model’s params', async () => {
    const tools = await apiBrokerTools()
    const fields = propertiesOf(tools.native_batshit_tool_use)
    expect(fields).toEqual(expect.arrayContaining(['ref', 'input', 'dryRun']))
    for (const cut of ['params', 'allowRisky', 'selectedGateways', 'selectedToolIds']) expect(fields).not.toContain(cut)
    const parsed = tools.native_batshit_tool_use.inputSchema.parse({ ref: 'fabric:sys.zip.fetch', params: { zipId: 'z1' } })
    expect(parsed.params).toEqual({ zipId: 'z1' })
  })
})
