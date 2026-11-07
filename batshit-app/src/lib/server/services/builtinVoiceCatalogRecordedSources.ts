import { createHash } from 'node:crypto'
import { lexer, type Tokens } from 'marked'
import { inspectAsyncVoiceInventory, inspectOpenaiVoiceInventory } from './builtinVoiceCatalogInventory'
import { voiceSourceSection, voiceSourceTable } from './builtinVoiceCatalogDocuments'
import { inspectAsyncRecordedOperation } from './builtinVoiceCatalogAsyncOperation'

type SourceState = { state: 'matches' | 'changed' | 'insufficient' }
const state = (value: SourceState['state']): SourceState => ({ state: value })
const bounded = (body: string) => typeof body === 'string' && body.isWellFormed() && !body.includes('\0') && Buffer.byteLength(body, 'utf8') <= 1024 * 1024
const blocks = (section: string) => lexer(section).filter((token): token is Tokens.Code => token.type === 'code').map(token => token.text)
const one = <T>(values: T[], predicate: (value: T) => boolean) => values.filter(predicate).length === 1
/** Lock the complete selected normative scope; code examples and unrelated page sections do not affect it. */
const scopeDigest = (section: string) => createHash('sha256').update(lexer(section)
  .filter(token => ['paragraph', 'list', 'blockquote'].includes(token.type))
  .map(token => token.raw.replace(/\r\n/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trimEnd()).join('\n')).digest('hex')

/** Fixed source-bound facts only; a discovered model name cannot grant compatibility. */
export function inspectOpenaiRecordedOperation(fileBody: string): SourceState {
  try {
    if (!bounded(fileBody)) return state('insufficient')
    const quickstart = voiceSourceSection(fileBody, 'Quickstart'), context = voiceSourceSection(fileBody, 'Add transcription context')
    const languages = voiceSourceSection(fileBody, 'Supported languages')
    if (scopeDigest(quickstart) !== '32fa7dc887cf0ebef5c0721e7c1456d42d058efb717ff4c7e3f2e9ec8602310b' ||
      scopeDigest(context) !== 'cc7bc1c9b02c32db8a4fc1c857e85b8b947777426106c3cd02e480761dbf3ce7' ||
      scopeDigest(languages) !== '8427186068f4bfc1cef5d4b3f9da9ceac4ede3f0f4940cad6570e2fe570154dd') return state('insufficient')
    const examples = blocks(quickstart)
    const request = one(examples, value => value.includes('--request POST') && value.includes('https://api.openai.com/v1/audio/transcriptions') &&
      value.includes('Authorization: Bearer $OPENAI_API_KEY') && value.includes('multipart/form-data') && value.includes('--form file=@') && value.includes('--form model=gpt-transcribe') &&
      [...value.matchAll(/--[a-z-]+/g)].map(match => match[0]).join(',') === '--request,--url,--header,--header,--form,--form')
    const response = one(examples, value => {
      try { const parsed = JSON.parse(value); return typeof parsed.text === 'string' && Array.isArray(parsed.languages) && parsed.languages.length === 1 && typeof parsed.languages[0]?.code === 'string' }
      catch { return false }
    })
    return state(request && response && one(blocks(context), value => value.includes("-F 'languages[]=en'")) ? 'matches' : 'insufficient')
  } catch { return state('insufficient') }
}

export function inspectOpenaiRecordedSource(workflowBody: string, fileBody: string): SourceState {
  const operation = inspectOpenaiRecordedOperation(fileBody)
  if (operation.state !== 'matches') return operation
  try {
    if (!bounded(workflowBody)) return state('insufficient')
    return state(inspectOpenaiVoiceInventory(workflowBody, 'transcribe').some(item => item.modelId === 'gpt-transcribe' && item.lane === 'stt-recorded') ? 'matches' : 'insufficient')
  } catch { return state('insufficient') }
}

export function inspectElevenMedicalSource(modelsBody: string): SourceState {
  try {
    if (!bounded(modelsBody)) return state('insufficient')
    const rows = voiceSourceTable(modelsBody, ['Model ID', 'Description', 'Languages'])
    if (!one(rows, row => row[0].trim() === '`scribe_v2_medical`' && row[1].includes('Speech recognition'))) return state('insufficient')
    const section = voiceSourceSection(modelsBody, 'Scribe v2 Medical')
    return state(scopeDigest(section) === 'ab09bc7f81215cd101bdce652a15cd274a4fdcbc2dbe54c706b0f203441d5b50' ? 'matches' : 'insufficient')
  } catch { return state('insufficient') }
}

export function inspectAsyncRecordedSource(modelsBody: string, endpointBody: string): SourceState {
  try {
    if (!bounded(modelsBody) || !bounded(endpointBody)) return state('insufficient')
    const operation = inspectAsyncRecordedOperation(endpointBody)
    if (operation !== 'matches') return state(operation)
    const inventory = inspectAsyncVoiceInventory(modelsBody)
    return state(inventory.some(item => item.modelId === 'async_asr_v1.0' && item.lane === 'stt-recorded') ? 'matches' : 'insufficient')
  } catch { return state('insufficient') }
}
