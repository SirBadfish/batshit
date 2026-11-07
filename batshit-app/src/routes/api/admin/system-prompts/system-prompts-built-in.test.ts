// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { GET as list } from './+server'
import { GET as getOne, POST as save } from './[id]/+server'
import { POST as reset } from './[id]/reset/+server'
import { builtInOnlyPrompt, builtInPartsFor, formatBuiltInText } from '$lib/server/services/systemPromptBuiltIns'

/**
 * Josh (2026-10-23): Admin shows every system prompt an agent gets. The list says which stored
 * prompts have built-in text and lists the built-in-only section read-only; a stored prompt's detail
 * carries its built-in text; a built-in-only section can be read but never saved or reset.
 */
useRedisTestServer()

const admin = { user: { id: 'admin-builtin', is_admin: true } } as unknown as App.Locals
const event = (extra: Record<string, unknown> = {}) => ({ locals: admin, ...extra }) as any

describe('Admin system prompts: built-in text', () => {
  it('the list flags the stored prompts with built-in text and ends with the read-only Working Context entry', async () => {
    const body = await (await list(event())).json()
    const byId = new Map<string, any>(body.prompts.map((prompt: any) => [prompt.id, prompt]))
    expect(byId.get('tool_guidance_zip')?.hasBuiltInText).toBe(true)
    // Decision 11, option A: the memory guidance is all stored text, so it has no built-in part.
    expect(byId.get('tool_guidance_memory')?.hasBuiltInText).toBe(false)
    expect(byId.get('api_primary')?.hasBuiltInText).toBe(false)
    expect(byId.get('working_context')).toMatchObject({ label: 'Maintaining Your Working Context', readOnly: true, hasBuiltInText: true, redisKey: '' })
    expect(body.prompts.at(-1)).toMatchObject({ id: 'agent_setup', label: 'Agent Setup', readOnly: true, hasBuiltInText: true, redisKey: '' })
  })

  it('a stored prompt’s detail carries its built-in text; one without has none', async () => {
    const zip = await (await getOne(event({ params: { id: 'tool_guidance_zip' } }))).json()
    expect(zip.prompt.value).toContain('{{ $api_tool_zip_guidance }}')
    expect(zip.prompt.builtInText).toBe(formatBuiltInText(builtInPartsFor('tool_guidance_zip')))
    const primary = await (await getOne(event({ params: { id: 'api_primary' } }))).json()
    expect(primary.prompt.hasBuiltInText).toBe(false)
    expect(primary.prompt).not.toHaveProperty('builtInText')
  })

  it('a save and a reset answer with the built-in flag, so the Built-in Text button stays (review F1)', async () => {
    const original = (await (await getOne(event({ params: { id: 'tool_guidance_zip' } }))).json()).prompt.value
    const saved = await (await save(event({ params: { id: 'tool_guidance_zip' }, request: new Request('http://x', { method: 'POST', body: JSON.stringify({ value: `${original}\nAdmin note.` }) }) }))).json()
    expect(saved.prompt.hasBuiltInText).toBe(true)
    const reverted = await (await reset(event({ params: { id: 'tool_guidance_zip' } }))).json()
    expect(reverted.prompt.hasBuiltInText).toBe(true)
    const primary = await (await reset(event({ params: { id: 'api_primary' } }))).json()
    expect(primary.prompt.hasBuiltInText).toBe(false)
  })

  it.each(['working_context', 'agent_setup'])('the built-in-only %s reads as its text and refuses a save or a reset', async id => {
    const detail = await (await getOne(event({ params: { id } }))).json()
    expect(detail.prompt.readOnly).toBe(true)
    expect(detail.prompt.value).toBe(formatBuiltInText(builtInOnlyPrompt(id)!.parts))
    const saved = await save(event({ params: { id }, request: new Request('http://x', { method: 'POST', body: JSON.stringify({ value: 'x' }) }) }))
    expect(saved.status).toBe(400)
    expect((await saved.json()).error).toBe('This section is built into Batshit and is read-only.')
    const resetAnswer = await reset(event({ params: { id } }))
    expect(resetAnswer.status).toBe(400)
  })

  it('stays admin only', async () => {
    const user = { user: { id: 'plain', is_admin: false } } as unknown as App.Locals
    expect((await list({ locals: user } as any)).status).toBe(403)
    expect((await getOne({ locals: user, params: { id: 'working_context' } } as any)).status).toBe(403)
  })
})
