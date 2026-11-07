// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { inspectAlibabaVoiceInventory, inspectAsyncVoiceInventory, inspectGoogleVoiceInventory, inspectOpenaiVoiceInventory, inspectStepfunVoiceInventory } from '../services/builtinVoiceCatalogInventory'

const code = (id: string) => `<code>${id}</code>`
const table = (headers: string[], rows: string[][]) => `<table><thead><tr>${headers.map(header => `<th>${header}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`
const googleSpeech = () => `<div class="devsite-article-body"><h2 id="supported-models">Supported models</h2>${table(['Model','Single speaker','Multi-speaker','Voice design','Voice replication'], [
  [`A new model (${code('Exact.New.TTS')})`, 'yes','yes','yes','yes'],
  ['<a href="/gemini-api/docs/models/do-not-invent-this-ID">Human label only</a>','yes','yes','no','no']
])}<h2 id="other">Other</h2>${code('outside-section')}</div>`
const googleTranscribe = () => `<div class="devsite-article-body"><p>Transcribe files with ${code('Exact.Recorded-ID')}.</p><p>Upload a file and pass it to ${code('Exact.Recorded-ID')}.</p><h2 id="overview">Overview</h2><p>${code('not-a-model')}</p></div>`
const openaiWorkflow = () => `<article><h2 id="choose-a-transcription-workflow">Choose a transcription workflow</h2>${table(['Workflow','Use when','Recommended model'], [
  ['File transcription','completed audio',code('Future.File')], ['Realtime transcription','live audio',code('Future.Live')]
])}<h2 id="other">Other</h2>${code('outside-section')}</article>`
const alibaba = () => `<article><h2 id="supported-models">Supported models</h2>${['singapore','beijing'].map(region => `<section id="${region}"><ul>
  <li><strong>Qwen-Audio-TTS</strong>: ${code('Future.Audio')}, ${code('Future.Audio.Case')}</li>
  <li><strong>CosyVoice</strong>: ${code('separate-integration')}</li>
  <li><strong>Qwen3-TTS</strong>: ${code('qwen3-tts-flash')}, ${code('qwen3-tts-flash-realtime')}</li>
</ul></section>`).join('')}<h2 id="languages">Languages</h2>${code('outside-section')}</article>`
const asyncModels = () => `<div class="markdown-body"><h2 id="text-to-speech-models">Text-to-Speech Models</h2>${table(['Model','Tier','Languages','Best For'], [[code('Exact.Async.TTS'),'Standard','en','speech']])}<h2 id="speech-to-text-models">Speech-to-Text Models</h2>${table(['Model','Languages','Best For'], [[code('Exact.Async.ASR'),'en','text']])}<h2 id="other">Other</h2>${code('outside-section')}</div>`
const stepfun = () => `<main><article><h3 id="cookbook-3-1-准备文本与请求">Prepare request</h3><div class="whitespace-pre">MODEL = "Future.Step.TTS"</div><div class="whitespace-pre">VOICE = "not-a-model"</div><h3 id="other">Other</h3><div class="whitespace-pre">MODEL = "outside-section"</div></article></main>`

describe('finite candidate-only provider inventory selectors', () => {
  it('reads Google exact table code IDs without deriving IDs from labels, URLs, navigation or scripts', () => {
    const source = `<nav>${code('nav-id')}</nav><script>MODEL = 'script-id'</script>${googleSpeech()}`
    expect(inspectGoogleVoiceInventory(source, 'speech')).toEqual([{ modelId: 'Exact.New.TTS', lane: 'tts-batch' }])
    expect(inspectGoogleVoiceInventory(googleTranscribe(), 'transcribe')).toEqual([{ modelId: 'Exact.Recorded-ID', lane: 'stt-recorded' }])
    expect(() => inspectGoogleVoiceInventory(googleTranscribe().replace('Exact.Recorded-ID', 'Conflicting.Recorded'), 'transcribe')).toThrow('structure')
  })

  it('reads only the exact OpenAI Speech model section, leaving the Realtime replacement out', () => {
    const markdown = '# Speech\n\nUse `Realtime.Successor` with another API.\n\n### Text-to-speech models\n\nUse `Exact.Mini` and `Exact.Legacy`.\n\n```json\n{"model":"example-only"}\n```\n\n### Voice options\n\n`voice-id`\n'
    expect(inspectOpenaiVoiceInventory(markdown, 'speech')).toEqual([{ modelId: 'Exact.Mini', lane: 'tts-batch' }, { modelId: 'Exact.Legacy', lane: 'tts-batch' }])
    expect(inspectOpenaiVoiceInventory('### Text-to-speech models\n\n`Same` and `Same`\n', 'speech')).toEqual([{ modelId: 'Same', lane: 'tts-batch' }])
    expect(inspectOpenaiVoiceInventory('<article><h3 id="text-to-speech-models">Models</h3><p>'+code('Exact.Mini')+'</p><h3 id="voice-options">Voices</h3>'+code('voice-id')+'</article>', 'speech')).toEqual([{ modelId: 'Exact.Mini', lane: 'tts-batch' }])
  })

  it('classifies OpenAI recorded and realtime candidates by the exact workflow cell, preserving case', () => {
    expect(inspectOpenaiVoiceInventory(openaiWorkflow(), 'transcribe')).toEqual([{ modelId: 'Future.File', lane: 'stt-recorded' }, { modelId: 'Future.Live', lane: 'stt-direct-realtime' }])
    const markdown = '## Choose a transcription workflow\n\n| Workflow | Use when | Recommended model |\n| --- | --- | --- |\n| [File transcription](/file) | recording | `Future.File` |\n| Realtime transcription | live | `Future.Live` |\n\n## Other\n'
    expect(inspectOpenaiVoiceInventory(markdown, 'transcribe')).toEqual(inspectOpenaiVoiceInventory(openaiWorkflow(), 'transcribe'))
    const markdownHtml = '## Choose a transcription workflow\n\n'+table(['Workflow','Use when','Recommended model'], [
      ['[File transcription](/file)','recording','[`Future.File`](/model/file)'], ['[Realtime transcription](/realtime)','live','[`Future.Live`](/model/live)']
    ])+'\n\n## Other\n'
    expect(inspectOpenaiVoiceInventory(markdownHtml, 'transcribe')).toEqual(inspectOpenaiVoiceInventory(openaiWorkflow(), 'transcribe'))
    expect(() => inspectOpenaiVoiceInventory(markdownHtml.replace('## Other', markdown.slice(markdown.indexOf('|'), markdown.indexOf('## Other'))+'\n## Other'), 'transcribe')).toThrow('structure')
    expect(() => inspectOpenaiVoiceInventory(openaiWorkflow().replace('Realtime transcription','Unknown transport'), 'transcribe')).toThrow('structure')
  })

  it('carries only named OpenAI shutdown notices into exact lane metadata, including models absent from the current inventory', () => {
    const speech = 'The `Old.Speech` and `Another.Old` models are deprecated and will shut down on **January 6, 2027**. Migrate to `Realtime.Replacement` with another API.\n\n### Text-to-speech models\n\n`Current.Speech`\n'
    expect(inspectOpenaiVoiceInventory(speech, 'speech')).toEqual([
      { modelId: 'Current.Speech', lane: 'tts-batch' },
      { modelId: 'Old.Speech', lane: 'tts-batch', release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' },
      { modelId: 'Another.Old', lane: 'tts-batch', release: 'deprecated', shutdownAt: '2027-01-06T00:00:00.000Z' }
    ])
    const recorded = openaiWorkflow().replace('<h2 id="other">', '<h2 id="existing-integrations-with-deprecated-models">Existing integrations with deprecated models</h2><div><p>'+code('Old.Recorded')+', and '+code('/v1/audio/translations')+' are deprecated and will shut down on <strong>February 26, 2027</strong>. Use '+code('Later.Replacement')+' instead.</p></div><h2 id="other">')
    expect(inspectOpenaiVoiceInventory(recorded, 'transcribe')).toEqual([
      { modelId: 'Future.File', lane: 'stt-recorded' }, { modelId: 'Future.Live', lane: 'stt-direct-realtime' },
      { modelId: 'Old.Recorded', lane: 'stt-recorded', release: 'deprecated', shutdownAt: '2027-02-26T00:00:00.000Z' }
    ])
    const recordedMarkdown = '## Choose a transcription workflow\n\n| Workflow | Use when | Recommended model |\n| --- | --- | --- |\n| File transcription | recording | `Current.File` |\n| Realtime transcription | live | `Current.Live` |\n\n## Existing integrations with deprecated models\n\n`Old.Recorded`, and `/v1/audio/translations` are deprecated and will shut down on **February 26, 2027**. See `Later.Replacement`.\n\n## Other\n'
    expect(inspectOpenaiVoiceInventory(recordedMarkdown, 'transcribe').at(-1)).toEqual({ modelId: 'Old.Recorded', lane: 'stt-recorded', release: 'deprecated', shutdownAt: '2027-02-26T00:00:00.000Z' })
  })

  it('refuses malformed or ambiguous named notices and ignores unrelated/later dates', () => {
    const source = (date: string) => 'The `Old.Speech` models are deprecated and will shut down on **'+date+'**.\n\n### Text-to-speech models\n\n`Current.Speech`\n'
    for (const date of ['February 30, 2027','January 0, 2027','2027-01-06']) expect(() => inspectOpenaiVoiceInventory(source(date), 'speech')).toThrow('structure')
    expect(() => inspectOpenaiVoiceInventory(source('January 6, 2027').replace('Old.Speech','bad id'), 'speech')).toThrow('structure')
    expect(() => inspectOpenaiVoiceInventory(source('January 6, 2027').replace('### Text-to-speech models','The `Other.Old` models are deprecated and will shut down on **January 6, 2027**.\n\n### Text-to-speech models'), 'speech')).toThrow('structure')
    expect(inspectOpenaiVoiceInventory('Unrelated `Id` documentation was updated January 6, 2027.\n\n### Text-to-speech models\n\n`Current.Speech`\n\n## Later notices\n\nThe `Unrelated.Id` models are deprecated and will shut down on **January 6, 2027**.\n', 'speech')).toEqual([{ modelId: 'Current.Speech', lane: 'tts-batch' }])
  })

  it('conserves Alibaba exact region/family IDs while keeping a known realtime transport separate', () => {
    expect(inspectAlibabaVoiceInventory(alibaba())).toEqual([
      { modelId: 'Future.Audio', lane: 'tts-batch' }, { modelId: 'Future.Audio.Case', lane: 'tts-batch' },
      { modelId: 'qwen3-tts-flash', lane: 'tts-batch' }, { modelId: 'qwen3-tts-flash-realtime', lane: 'tts-direct-stream' }
    ])
    expect(() => inspectAlibabaVoiceInventory(alibaba().replace('id="beijing"','id="changed-region"'))).toThrow('structure')
  })

  it('keeps Async TTS and separate ASR inventory candidates without granting a profile', () => {
    const observed = inspectAsyncVoiceInventory(asyncModels())
    expect(observed).toEqual([{ modelId: 'Exact.Async.TTS', lane: 'tts-batch' }, { modelId: 'Exact.Async.ASR', lane: 'stt-recorded' }])
    expect(JSON.stringify(observed)).not.toContain('compatibilityProfileId')
    expect(JSON.stringify(observed)).not.toContain('qualified')
  })

  it('reads Async exact Markdown tables from the two named sections without inferring compatibility', () => {
    const markdown = '# Models\n\n## Text-to-Speech Models\n\n| Model | Tier | Languages | Best For |\n| --- | --- | --- | --- |\n| `Exact.Async.TTS` | Pro | en | speech |\n\n### Details\n\n`not-a-model`\n\n## Speech-to-Text Models\n\n| Model | Languages | Best For |\n| --- | --- | --- |\n| `Exact.Async.ASR` | en | text |\n\n## Other\n\n`outside-section`\n'
    const expected = [{ modelId: 'Exact.Async.TTS', lane: 'tts-batch' }, { modelId: 'Exact.Async.ASR', lane: 'stt-recorded' }]
    expect(inspectAsyncVoiceInventory(markdown)).toEqual(expected)
    expect(JSON.stringify(inspectAsyncVoiceInventory(markdown))).not.toContain('qualified')
    for (const invalid of [
      markdown.replace('## Text-to-Speech Models', '### Text-to-Speech Models'),
      markdown.replace('Exact.Async.TTS', 'bad id'),
      markdown.replace('## Other', '## Text-to-Speech Models\n\n## Other'),
      markdown.replace('### Details', '| Model | Tier | Languages | Best For |\n| --- | --- | --- | --- |\n| `Another` | Pro | en | speech |\n\n### Details'),
      markdown.replace('### Details', table(['Model','Tier','Languages','Best For'], [[code('Another'),'Pro','en','speech']])+'\n\n### Details'),
      markdown.replace('| Model | Languages | Best For |', '| Model | Languages | Something Else |')
    ]) expect(() => inspectAsyncVoiceInventory(invalid)).toThrow('structure')
  })

  it('reads StepFun one literal request MODEL assignment without running the cookbook', () => {
    expect(inspectStepfunVoiceInventory(stepfun())).toEqual([{ modelId: 'Future.Step.TTS', lane: 'tts-batch' }])
    expect(() => inspectStepfunVoiceInventory(stepfun().replace('MODEL = "Future.Step.TTS"', 'MODEL = derive_model()'))).toThrow('structure')
    expect(() => inspectStepfunVoiceInventory(stepfun().replace('VOICE = "not-a-model"', 'MODEL = "Second"'))).toThrow('structure')
  })

  it('refuses duplicate tables, roots, identities, invalid IDs and oversized source data', () => {
    expect(() => inspectGoogleVoiceInventory(googleSpeech()+googleSpeech(), 'speech')).toThrow('structure')
    expect(() => inspectAsyncVoiceInventory(asyncModels().replace('</tbody>', '<tr><td>'+code('Exact.Async.TTS')+'</td><td>Standard</td><td>en</td><td>speech</td></tr></tbody>'))).toThrow('structure')
    expect(() => inspectAsyncVoiceInventory(asyncModels().replace('Exact.Async.TTS', 'bad id'))).toThrow('structure')
    expect(() => inspectGoogleVoiceInventory(' '.repeat(2 * 1024 * 1024 + 1), 'speech')).toThrow('structure')
    expect(() => inspectOpenaiVoiceInventory('# Speech\n'+'x'.repeat(2 * 1024 * 1024), 'speech')).toThrow('structure')
    const duplicate = table(['Workflow','Use when','Recommended model'], [['File transcription','recording',code('Other')]])
    expect(() => inspectOpenaiVoiceInventory(openaiWorkflow().replace('<h2 id="other">',duplicate+'<h2 id="other">'), 'transcribe')).toThrow('structure')
  })
})
