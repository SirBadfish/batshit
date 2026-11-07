import { describe, expect, it } from 'vitest'
import { inspectCartesia36Source, inspectElevenV4Source, inspectInworldFlashSource, inspectStep3Source } from '../services/builtinVoiceCatalogSpeechSources'

describe('speech source qualification', () => {
  it('requires the StepAudio 3 endpoint, controls, binary response and documented preset together', () => {
    const api = '### Endpoint\n\n`POST https://api.stepfun.ai/v1/audio/speech`\n\n### Request body\n\n`stepaudio-3-tts` `input` 1,000 characters `voice` `response_format` `wav`, `mp3`, `flac`, `opus`, `pcm` `speed` 0.5 to 2.0 `volume` 0.1 to 2.0 `instruction` 500 characters `sample_rate` `8000`, `16000`, `22050`, `24000`, `48000`\n\n### Response\n\naudio file (a binary stream)\n'
    const cookbook = '<main><article>stepaudio-3-tts zixinnansheng /audio/speech Authorization Bearer application/json</article></main>'
    // These deliberately incomplete operation excerpts cannot issue a rule.
    expect(inspectStep3Source(api, cookbook)).toBe(false)
    expect(inspectStep3Source(api.replace('500 characters', '100 characters'), cookbook)).toBe(false)
    expect(inspectStep3Source(api, cookbook.replace('zixinnansheng', 'other'))).toBe(false)
  })

  it('requires Flash model, request/response facts and its steering exception', () => {
    const models = '| Name | Model ID | Description | Supported languages |\n| - | - | - | - |\n| Flash | `inworld-tts-2-flash` | Flash | en |\n'
    const speech = '## Request and response\n\nPOST https://api.inworld.ai/tts/v1/voice Authorization: Basic Content-Type: application/json 2,000 UTF-16 code units `audioContent` Base64-encoded audio\n\n## API reference\n\n`voiceId` `modelId` `audioEncoding` `sampleRateHertz` `LINEAR16` `MP3` `OGG_OPUS` `language` `timestampType` `applyTextNormalization` Only supported by `inworld-tts-2`. The field is ignored on other models.\n'
    const steering = '# Steering\n\n`inworld-tts-2-flash` steering is not supported; instruction tags are ignored; non-verbal sounds remain.\n\n## How instructions work\n'
    expect(inspectInworldFlashSource(models, speech, steering)).toBe(false)
    expect(inspectInworldFlashSource(models, speech.replace('The field is ignored on other models.', 'The field is supported.'), steering)).toBe(false)
    expect(inspectInworldFlashSource(models, speech, steering.replace('instruction tags are ignored', 'tags are supported'))).toBe(false)
  })

  it('never grants Cartesia or Eleven from model IDs or malformed sources alone', () => {
    expect(inspectCartesia36Source('sonic-3.6 sonic-3.6-2026-08-27', '2026-08-14')).toEqual([])
    expect(inspectElevenV4Source('eleven_v4', 'Stability Similarity', 'POST /text-to-speech')).toBe(false)
  })
})
