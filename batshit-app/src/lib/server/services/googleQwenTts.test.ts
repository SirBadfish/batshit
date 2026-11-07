import { describe, expect, it, vi, afterEach } from 'vitest'
import { buildGemini38TtsRequest, parseGemini38TtsAudio } from './gemini38Tts'
import { buildQwenAudioTtsRequest, getQwenAudioTtsVoices, parseQwenAudioEndpoint } from '$lib/data/qwenAudioTts'
import { downloadQwenAudio, qwenAudioResultUrl } from './qwenAudioTtsResponse'
import { inspectGemini38TtsSources, inspectQwenAudioTtsSources } from './builtinVoiceCatalogGoogleQwenSources'
import { readBoundedSpeechJson, speechProviderStatusError } from './boundedSpeechJson'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const wav = Buffer.from('RIFF0000WAVEtest')
const endpoint = 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const model = 'qwen-audio-3.1-tts-flash'
afterEach(() => vi.unstubAllGlobals())

describe('Gemini 3.8 unary speech', () => {
  it('uses the Interactions single-speaker request and the final raw REST audio block', () => {
    expect(buildGemini38TtsRequest('gemini-3.8-flash-lite-tts', 'Hello', 'Kore')).toEqual({
      model: 'gemini-3.8-flash-lite-tts', input: [{ type: 'user_input', content: [{ type: 'text', text: 'Hello' }] }],
      response_format: { type: 'audio', mime_type: 'audio/wav' }, generation_config: { speech_config: [{ voice: 'Kore' }] }
    })
    expect(parseGemini38TtsAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: wav.toString('base64') }] }] })).toEqual(new Uint8Array(wav))
    expect(() => parseGemini38TtsAudio({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: 'YmFk' }] }] })).toThrow('invalid WAV')
    expect(() => parseGemini38TtsAudio({ steps: [] })).toThrow('invalid speech audio')
  })
})

describe('Qwen Audio regional unary speech', () => {
  it('keeps model, voice, endpoint and supported options together', () => {
    const request = buildQwenAudioTtsRequest({ model, text: 'Hello', voiceId: 'longanhuan_v3.1', common: { endpoint, language: 'ja', instructions: 'Speak softly.' } })
    expect(request.region).toBe('singapore')
    expect(request.body.input).toEqual({ text: 'Hello', voice: 'longanhuan_v3.1', format: 'wav', sample_rate: 24000, language_hints: ['ja'], instruction: 'Speak softly.' })
    expect(getQwenAudioTtsVoices('qwen-audio-3.0-tts-plus', 'singapore')).toContain('longanlingxin')
    expect(() => buildQwenAudioTtsRequest({ model, text: 'Hello', voiceId: 'Cherry', common: { endpoint } })).toThrow('voice supported by this model and region is required')
    expect(() => buildQwenAudioTtsRequest({ model, text: 'Hello', voiceId: 'longanhuan_v3.1', common: { endpoint, language: 'English' } })).toThrow('language hint')
    expect(() => buildQwenAudioTtsRequest({ model, text: 'Hello', voiceId: 'longanhuan_v3.1', common: { endpoint, speed: 2 } })).toThrow('speed')
  })
  it('refuses credential-bearing, arbitrary or altered endpoints', () => {
    for (const value of [undefined, 'http://workspace-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', endpoint + '?next=evil', endpoint.replace('workspace-123.', 'attacker.example.'), endpoint.replace('workspace-123.', 'u:p@workspace-123.')]) {
      expect(() => parseQwenAudioEndpoint(value)).toThrow()
    }
  })
  it('rejects incomplete or foreign results and refuses redirects while downloading bounded WAV', async () => {
    const good = 'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/output.wav?signature=test'
    expect(qwenAudioResultUrl({ output: { finish_reason: 'stop', audio: { url: good } } }, 'singapore')).toBe(good)
    expect(() => qwenAudioResultUrl({ output: { finish_reason: null, audio: { url: good } } }, 'singapore')).toThrow()
    expect(() => qwenAudioResultUrl({ output: { finish_reason: 'stop', audio: { url: 'https://example.com/audio.wav' } } }, 'singapore')).toThrow()
    expect(() => qwenAudioResultUrl({ output: { finish_reason: 'stop', audio: { url: good.replace('https:', 'http:') } } }, 'singapore')).toThrow()
    const signed = 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/pre/result.wav?OSSAccessKeyId=test&Expires=123&Signature=abc%2Bdef'
    expect(qwenAudioResultUrl({ output: { finish_reason: 'stop', audio: { url: signed } } }, 'beijing')).toBe(signed.replace('http:', 'https:'))
    expect(() => qwenAudioResultUrl({ output: { finish_reason: 'stop', audio: { url: signed } } }, 'singapore')).toThrow()
    const fetchMock = vi.fn(async () => new Response(wav, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await downloadQwenAudio(good)).toEqual(new Uint8Array(wav))
    expect(fetchMock).toHaveBeenCalledWith(good, expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(`failed ${good}`) }))
    await expect(downloadQwenAudio(good)).rejects.toThrow(/^Failed to download Qwen Audio speech\.$/)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`failed ${good}`)) } }))))
    await expect(downloadQwenAudio(good)).rejects.toThrow(/^Failed to download Qwen Audio speech\.$/)
  })
})

describe('fixed public source admission', () => {
  it('does not admit IDs from missing, forged or unrelated documents', () => {
    expect(inspectGemini38TtsSources('<html>gemini-3.8-flash-tts</html>')).toEqual({ status: 'insufficient', modelIds: [] })
    expect(inspectQwenAudioTtsSources({ models: model, api: endpoint, voices: 'longanhuan_v3.1', ossHttps: '', ossV1: '', ossV4: '' })).toEqual({ status: 'insufficient', modelIds: [] })
  })
  it('distinguishes a documented incompatible operation from incomplete source text', () => {
    const google = '<div class="devsite-article-body"><h2 id="audio-output-formats">Formats</h2><table><tr><th>Format</th><th>mime_type value</th><th>Description</th></tr><tr><td>WAV</td><td>audio/l16</td><td>PCM</td></tr></table><h2 id="single-speaker">Speech</h2></div>'
    expect(inspectGemini38TtsSources(google).status).toBe('changed')
    const qwenApi = '<div class="icms-help-docs-content"><h2 id="endpoint">Endpoint</h2><div><section id="china-beijing"><code>POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/Changed</code></section><section id="singapore"><code>POST https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer</code></section></div><h2 id="request-headers">Headers</h2></div>'
    expect(inspectQwenAudioTtsSources({ models: '', api: qwenApi, voices: '', ossHttps: '', ossV1: '', ossV4: '' }).status).toBe('changed')
  })
  it.skipIf(!process.env.VOICE_SOURCE_PROOF_DIR)('qualifies the captured official scopes and refuses changed request contracts', () => {
    const dir = process.env.VOICE_SOURCE_PROOF_DIR as string
    const read = (file: string) => readFileSync(join(dir, file), 'utf8')
    const google = read('google-speech.html')
    const qwen = { models: read('alibaba-models.html'), api: read('alibaba-http.html'), voices: read('alibaba-voices.html'),
      ossHttps: read('alibaba-oss-https.html'), ossV1: read('alibaba-oss-v1.html'), ossV4: read('alibaba-oss-v4.html') }
    expect(inspectGemini38TtsSources(google).modelIds).toEqual(['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'])
    expect(inspectGemini38TtsSources(google.replaceAll('audio/wav', 'audio/other')).status).toBe('changed')
    expect(inspectGemini38TtsSources(google.replaceAll('generativelanguage.googleapis.com/v1beta/interactions', 'generativelanguage.googleapis.com/v1beta/other')).status).toBe('changed')
    expect(inspectQwenAudioTtsSources(qwen).modelIds).toHaveLength(4)
    expect(inspectQwenAudioTtsSources({ ...qwen, api: qwen.api.replaceAll('SpeechSynthesizer', 'ChangedOperation') }).status).toBe('changed')
    const extraRequired = qwen.api.replaceAll('<p><strong>model</strong> <code>string</code><strong>(required)</strong></p>', '$&<p><strong>new_required</strong> <code>string</code><strong>(required)</strong></p>')
    expect(inspectQwenAudioTtsSources({ ...qwen, api: extraRequired }).status).toBe('changed')
    const wrongTextType = qwen.api.replaceAll('<p><strong>text</strong> <code>string</code><strong>(required)</strong></p>', '<p><strong>text</strong> <code>object</code><strong>(required)</strong></p>')
    expect(inspectQwenAudioTtsSources({ ...qwen, api: wrongTextType }).status).toBe('changed')
    expect(inspectQwenAudioTtsSources({ ...qwen, ossV1: qwen.ossV1.replaceAll('CanonicalizedResource', 'ChangedResource') }).status).toBe('insufficient')
  })
  it('bounds and validates provider JSON before parsing', async () => {
    await expect(readBoundedSpeechJson(new Response('{"ok":true}'), 100)).resolves.toEqual({ ok: true })
    await expect(readBoundedSpeechJson(new Response('{"too":"long"}'), 4)).rejects.toThrow('size limit')
    await expect(readBoundedSpeechJson(new Response('{bad}'), 100)).rejects.toThrow()
    await expect(readBoundedSpeechJson(new Response(new ReadableStream({ start(controller) { controller.error(new Error('secret-key signed-url?Signature=secret')) } })), 100)).rejects.toThrow(/^Speech provider returned invalid or incomplete JSON\.$/)
    const err = speechProviderStatusError(new Response('secret-key signed-url?Signature=secret', { status: 429 }), 'Speech failed.')
    expect(err.message).toBe('Speech failed.')
    expect(err.status).toBe(429)
  })
})
