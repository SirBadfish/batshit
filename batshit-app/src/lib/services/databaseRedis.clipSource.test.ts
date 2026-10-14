import { afterEach, expect, it, vi } from 'vitest'
import { databaseService } from './databaseRedis.server'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { decideReplyImageOrigins, emptyRunDelivery } from '$lib/server/services/imageAddressTurnRecord'

useRedisTestServer()
afterEach(()=>vi.restoreAllMocks())
const id='cool_tool_1779416343000_aaaaaa'
const removed='https://removed-by-clip.example/image.png'
const kept='https://actually-delivered.example/picture.png'
const open='{{batshit-clip|id:clip_probe|name:document}}'
const close='{{/batshit-clip}}'

for(const active of [false,true]) for(const crossSource of [false,true]) {
  it(`reports only final history bytes after Clip cleanup (active=${active}, cross-source=${crossSource})`,async()=>{
    vi.spyOn(redis,'getZip').mockResolvedValue({id,type:'cool_tool',tokens:30,metadata:{operationKind:'read_file',sessionId:'probe'},
      content:JSON.stringify({toolName:'read_file',toolCallId:'call',toolInput:{path:crossSource?open:'/tmp/result'},
        toolResult:{content:`${crossSource?'':open}${removed}${close}\nKept: ${kept}`,lines:2}})} as any)
    const result=await (databaseService as any).compileChatHistory(
      [{id:'old',role:'assistant',content:`{{batshit-zip:${id}}}`,metadata:{zipIds:[id]}}],
      {zip_ai_view_mode:'inline'},{},{activeClipIds:new Set(active?['clip_probe']:[]),zipOwner:{sessionId:'probe'},
        zipState:{isUnzipped:()=>true,isRezipped:()=>false,getRezippedSource:()=>undefined,getUnzippedInfo:()=>undefined}},
      {selfAgentId:null,agentNames:new Map()})
    expect(result.chatHistory).not.toContain(removed)
    expect(result.chatHistory).toContain(kept)
    for(const piece of result.addressSources) expect(result.chatHistory).toContain(piece.text)
    const record=decideReplyImageOrigins({messageId:'new',version:1,lane:'api',replyTexts:[`<img src="${removed}"><img src="${kept}">`],
      compiled:{pieces:result.addressSources,nonTextInputs:0,unaccountedInputs:0},addenda:[],
      run:{...emptyRunDelivery(false),observed:true},steers:[],storedRecords:{}})
    expect(record.addresses[removed]).toMatchObject({state:'blocked',rule:4,evidence:{inRecord:false}})
    expect(record.addresses[kept]).toMatchObject({state:'as_read',rule:1,evidence:{inRecord:true}})
  })
}

it('keeps tool provenance aligned when an agent summary trims expanded history', async () => {
  const pad = 'zip_1779416343001_cccccc'
  const summaryUrl = 'https://summary-only.example/picture.png'
  vi.spyOn(redis, 'getZip').mockImplementation(async (key) => key === pad
    ? { id: pad, type: 'all_other', content: ' '.repeat(160), tokens: 40,
        metadata: { sessionId: 'probe' } } as any
    : { id, type: 'cool_tool', tokens: 40, metadata: { operationKind: 'read_file', sessionId: 'probe' },
        content: JSON.stringify({ toolName: 'read_file', toolCallId: 'call', toolInput: { path: '/tmp/result' },
          toolResult: { content: 'x'.repeat(150), lines: 1 } }) } as any)
  const result = await (databaseService as any).compileChatHistory(
    [{ id: 'old', role: 'assistant', content: `{{batshit-zip:${pad}}}{{batshit-zip:${id}}}`,
      metadata: { zipIds: [pad, id], zipControl: { toolNotes: [{ summary: summaryUrl, toolName: 'Tool' }] } } }],
    { zip_ai_view_mode: 'inline' }, {},
    { activeClipIds: new Set(), zipOwner: { sessionId: 'probe' },
      zipState: { isUnzipped: () => true, isRezipped: () => false,
        getRezippedSource: () => undefined, getUnzippedInfo: () => undefined } },
    { selfAgentId: null, agentNames: new Map() })
  expect(result.chatHistory).toContain(summaryUrl)
  const toolPieces = result.addressSources.filter((piece: any) => piece.source === 'tool_result')
  expect(toolPieces.map((piece: any) => piece.text).join('')).toBe('x'.repeat(150))
  expect(toolPieces.every((piece: any) => !piece.text.includes(summaryUrl))).toBe(true)
  const record = decideReplyImageOrigins({ messageId: 'new', version: 1, lane: 'api',
    replyTexts: [`<img src="${summaryUrl}">`],
    compiled: { pieces: result.addressSources, nonTextInputs: 0, unaccountedInputs: 0 }, addenda: [],
    run: { ...emptyRunDelivery(false), observed: true }, steers: [], storedRecords: {} })
  expect(record.addresses[summaryUrl]).toMatchObject({ state: 'blocked', rule: 4, evidence: { inRecord: false } })
})
