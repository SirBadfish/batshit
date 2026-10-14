import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MessageContent from './MessageContent.svelte'
import { forgetImageOrigins, refreshImageOrigins } from '$lib/stores/imageAddressOrigins.svelte'
import { resetImageLoadConsentForTests } from '$lib/stores/imageLoadConsent.svelte'
import { sha256Hex } from '$lib/utils/sha256'
import { api } from '$lib/services/api'

const sessionId = 'origin-render-chat'
const messageId = 'reply'
const src = 'https://pictures.example.org/cat.png'
const zipId = 'image_1779416324513_abcdef1'
let fetcher: ReturnType<typeof vi.fn>
let zipData: Record<string, unknown> | null

beforeEach(() => {
  resetImageLoadConsentForTests()
  forgetImageOrigins(sessionId)
  zipData = null
  fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('/api/session-clips/state/')) return new Response('{"clips":[]}')
    if (url.includes('/api/zips/batch')) return new Response(JSON.stringify({ zips: zipData ? { [zipId]: zipData } : {} }))
    return new Response('{}', { status: 404 })
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => { forgetImageOrigins(sessionId); vi.unstubAllGlobals(); vi.restoreAllMocks() })

async function decide(content: string, inRecord: boolean) {
  const record = { messageId, version: 1, state: 'decided', lane: 'api', complete: true,
    textHashes: [sha256Hex(content)], addresses: { [src]: { state:inRecord?'as_read':'blocked', rule:inRecord?1:4, evidence: { inRecord, startInRecord: false, sharesChatRun: false, complete: true } } } }
  await refreshImageOrigins(sessionId, (async () => new Response(JSON.stringify({ records: { [messageId]: record } }))) as typeof fetch)
}
const metadata = { imageOriginExpected: true, imageOriginExpectedVersion: 1 }

describe('reply picture origin display', () => {
  it('keeps a stopped local stream pending when both record writes failed and the server end is missing', async () => {
    await refreshImageOrigins(sessionId,(async()=>new Response('{"records":{}}')) as typeof fetch)
    const props={role:'assistant',sessionId,messageId,content:`<img src="${src}">`,metadata:{}}
    const view=render(MessageContent,{...props,isStreaming:true})
    await waitFor(()=>expect(screen.getByText('Checking where this address came from.')).toBeTruthy())
    await view.rerender({...props,isStreaming:false})
    expect(screen.queryByRole('button',{name:'Load picture'})).toBeNull()
    expect(screen.getByText('Checking where this address came from.')).toBeTruthy()
  })
  it('gives genuine trusted zip hydration its own click box while the matching raw tag stays blocked', async () => {
    const content = `<img src="${src}" data-zip-id="${zipId}" data-zip-type="image">\n{{batshit-zip:${zipId}:::Hydrated}}`
    vi.spyOn(api, 'getZips').mockResolvedValue(new Map([[zipId, { id:zipId, type:'image', content:src, tokens:1, metadata:{sessionId} } as any]]))
    await decide(content, false)
    const view = render(MessageContent, { role:'assistant',sessionId,messageId,content,metadata:{...metadata,zipIds:[zipId]} })
    await waitFor(() => expect(screen.getByRole('button',{name:'Load picture'})).toBeTruthy())
    expect(screen.getByText('This address was not in what the agent read.')).toBeTruthy()
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
  })

  it('does not let a stale trusted compile replace a newer blocked raw reply', async () => {
    let finish!: (value:Map<string,any>)=>void
    const oldCompile = new Promise<Map<string,any>>((resolve)=>{finish=resolve})
    vi.spyOn(api, 'getZips').mockReturnValue(oldCompile)
    const oldContent = `{{batshit-zip:${zipId}:::Hydrated}}`
    const props = {role:'assistant',sessionId,messageId,metadata:{...metadata,zipIds:[zipId]}}
    const view = render(MessageContent,{...props,content:oldContent})
    await waitFor(()=>expect(api.getZips).toHaveBeenCalled())
    const raw = `<img src="${src}" data-zip-id="${zipId}" data-zip-type="image">`
    await decide(raw,false)
    await view.rerender({...props,content:raw})
    finish(new Map([[zipId,{id:zipId,type:'image',content:src,tokens:1,metadata:{sessionId}}]]))
    await waitFor(()=>expect(screen.getByText('This address was not in what the agent read.')).toBeTruthy())
    expect(screen.queryByRole('button',{name:'Load picture'})).toBeNull()
    expect(view.container.querySelectorAll('img')).toHaveLength(0)
  })

  it('holds streaming and missing decisions, then uses a matching server decision and explicit click', async () => {
    const content = `<img src="${src}">`
    const props = { role: 'assistant', sessionId, messageId, content, metadata }
    const view = render(MessageContent, { ...props, isStreaming: true })
    await waitFor(() => expect(screen.getByText('Checking where this address came from.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Load picture' })).toBeNull()
    await decide(content, true)
    await view.rerender({ ...props, isStreaming: false })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load picture' })).toBeTruthy())
    expect(view.container.querySelector('img')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Load picture' }))
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(src)
  })

  it('does not exempt raw attributes even when they name a trusted concrete zip', async () => {
    const content = `<img src="${src}" data-zip-id="${zipId}" data-zip-type="image">`
    await decide(content, false)
    render(MessageContent, { role: 'assistant', sessionId, messageId, content, metadata: { ...metadata, zipIds: [zipId] } })
    await waitFor(() => expect(screen.getByText('This address was not in what the agent read.')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Load picture' })).toBeNull()
    expect(document.querySelector(`img[src="${src}"]`)).toBeNull()
  })
})
