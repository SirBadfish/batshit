import {
  asLanguageCode,
  stt,
  type APIConnectOptions
} from '@livekit/agents'
import type { AudioFrame } from '@livekit/rtc-node'
import type {
  VoiceRealtimeSttEvent,
  VoiceRealtimeSttEventType,
  VoiceRealtimeSttSessionContract
} from '../../../batshit-app/src/lib/types/voiceRealtimeStt.js'

type BatshitRealtimeSttEventType = VoiceRealtimeSttEventType

type BatshitRealtimeSttEvent = Partial<VoiceRealtimeSttEvent> & {
  type?: VoiceRealtimeSttEventType | string
  text?: string | null
  utterance?: string | null
  language_code?: string | null
  message?: string | null
}

type BatshitRealtimeSttContract = VoiceRealtimeSttSessionContract

type RuntimeWebSocket = {
  readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void
  removeEventListener(type: string, listener: (event: any) => void): void
}

type RuntimeWebSocketConstructor = {
  new (url: string, protocols?: string | string[]): RuntimeWebSocket
  CONNECTING: number
  OPEN: number
  CLOSING: number
  CLOSED: number
}

function getWebSocketConstructor(): RuntimeWebSocketConstructor {
  const ctor = (globalThis as typeof globalThis & { WebSocket?: RuntimeWebSocketConstructor })
    .WebSocket
  if (!ctor) {
    throw new Error('Batshit realtime STT bridge requires a Node runtime with WebSocket support.')
  }
  return ctor
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function eventTranscript(event: BatshitRealtimeSttEvent): string {
  return stringValue(event.transcript) || stringValue(event.text) || stringValue(event.utterance)
}

function eventLanguage(event: BatshitRealtimeSttEvent, fallback?: string | null): string {
  return stringValue(event.language) || stringValue(event.language_code) || stringValue(fallback) || ''
}

function buildSpeechData(
  text: string,
  event: BatshitRealtimeSttEvent,
  language?: string | null
): stt.SpeechData {
  return {
    text,
    language: asLanguageCode(eventLanguage(event, language)),
    startTime: 0,
    endTime: 0,
    confidence: numberValue(event.confidence) ?? 1
  }
}

function buildWebSocketUrl(contract: BatshitRealtimeSttContract): string {
  const endpoint = stringValue(contract.providerConfig.endpoint)
  if (!endpoint) {
    throw new Error('Batshit realtime STT contract did not include a WebSocket endpoint.')
  }

  const url = new URL(endpoint)
  for (const [key, value] of Object.entries(contract.providerConfig.query ?? {})) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        url.searchParams.append(key, String(entry))
      }
    } else {
      url.searchParams.set(key, String(value))
    }
  }
  return url.toString()
}

function assertContractSupported(contract: BatshitRealtimeSttContract) {
  if (!contract.ready || !contract.launchSupported) {
    throw new Error(
      contract.launchBlockedReason ||
        `Batshit realtime STT provider "${contract.voiceProviderId}" is not launch-supported.`
    )
  }
  if (contract.providerConfig.method !== 'websocket' || !contract.clientMayConnectDirectly) {
    throw new Error(
      `Batshit realtime STT provider "${contract.voiceProviderId}" cannot be used by the LiveKit sidecar because it does not expose a direct WebSocket contract.`
    )
  }
  if (contract.providerConfig.auth || (contract.providerConfig.headers ?? []).length > 0) {
    throw new Error(
      `Batshit realtime STT provider "${contract.voiceProviderId}" needs provider-specific auth headers, so it requires a dedicated sidecar adapter before LiveKit bridge mode can use it.`
    )
  }
  if (contract.secretsExposed !== false) {
    throw new Error('Batshit realtime STT contracts must not expose provider secrets to the sidecar.')
  }
}

function closeMessage(contract: BatshitRealtimeSttContract): string | null {
  const firstMessage = contract.providerConfig.messages?.[0]
  if (!firstMessage) return null
  return JSON.stringify(firstMessage)
}

function messageToString(data: unknown): string | null {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  }
  return null
}

function frameToPcmBytes(frame: AudioFrame, targetChannels: number): Uint8Array {
  if (frame.channels === targetChannels) {
    return new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength)
  }

  if (targetChannels !== 1 || frame.channels <= 1) {
    throw new Error(
      `Batshit realtime STT bridge cannot convert ${frame.channels} input channels to ${targetChannels} target channels.`
    )
  }

  const mono = new Int16Array(frame.samplesPerChannel)
  for (let sample = 0; sample < frame.samplesPerChannel; sample += 1) {
    let sum = 0
    for (let channel = 0; channel < frame.channels; channel += 1) {
      sum += frame.data[sample * frame.channels + channel] ?? 0
    }
    mono[sample] = Math.max(-32768, Math.min(32767, Math.round(sum / frame.channels)))
  }
  return new Uint8Array(mono.buffer)
}

function closeSocket(
  socket: RuntimeWebSocket,
  openState: number,
  connectingState: number,
  code = 1000,
  reason = 'closed'
) {
  if (socket.readyState !== openState && socket.readyState !== connectingState) return
  try {
    socket.close(code, reason)
  } catch {
    // Socket may already be closing during LiveKit room teardown.
  }
}

async function openSocket(
  url: string
): Promise<{
  socket: RuntimeWebSocket
  openState: number
  connectingState: number
}> {
  const WebSocketCtor = getWebSocketConstructor()
  const socket = new WebSocketCtor(url)

  await new Promise<void>((resolve, reject) => {
    const handleOpen = () => {
      cleanup()
      resolve()
    }
    const handleError = (event: any) => {
      cleanup()
      reject(event?.error instanceof Error ? event.error : new Error('WebSocket open failed.'))
    }
    const cleanup = () => {
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('error', handleError)
    }
    socket.addEventListener('open', handleOpen, { once: true })
    socket.addEventListener('error', handleError, { once: true })
  })

  return {
    socket,
    openState: WebSocketCtor.OPEN,
    connectingState: WebSocketCtor.CONNECTING
  }
}

export class BatshitRealtimeStt extends stt.STT {
  label = 'batshit.realtime-stt'

  constructor(readonly contract: BatshitRealtimeSttContract) {
    assertContractSupported(contract)
    super({
      streaming: true,
      interimResults: contract.realtimeEvents?.includes('partial') ?? true,
      alignedTranscript: false
    })
  }

  get model(): string {
    return this.contract.model || this.contract.voiceProviderId
  }

  get provider(): string {
    return this.contract.voiceProviderId
  }

  protected async _recognize(): Promise<stt.SpeechEvent> {
    throw new Error('Batshit realtime STT bridge only supports streaming transcription.')
  }

  stream(options?: { connOptions?: APIConnectOptions }): BatshitRealtimeSttStream {
    return new BatshitRealtimeSttStream(this, this.contract, options?.connOptions)
  }
}

class BatshitRealtimeSttStream extends stt.SpeechStream {
  label = 'batshit.realtime-stt.stream'
  private finalTranscripts: string[] = []

  constructor(
    owner: BatshitRealtimeStt,
    private readonly contract: BatshitRealtimeSttContract,
    connOptions?: APIConnectOptions
  ) {
    super(owner, contract.audio.sampleRate, connOptions)
  }

  protected async run(): Promise<void> {
    const url = buildWebSocketUrl(this.contract)
    const { socket, openState, connectingState } = await openSocket(url)
    const closePayload = closeMessage(this.contract)
    const handleAbort = () => closeSocket(socket, openState, connectingState, 1000, 'aborted')
    this.abortSignal.addEventListener('abort', handleAbort, { once: true })

    try {
      await Promise.race([
        this.forwardInput(socket, openState, closePayload),
        this.receiveEvents(socket, openState, connectingState)
      ])
    } finally {
      this.abortSignal.removeEventListener('abort', handleAbort)
      closeSocket(socket, openState, connectingState)
      this.close()
    }
  }

  private async forwardInput(
    socket: RuntimeWebSocket,
    openState: number,
    closePayload: string | null
  ): Promise<void> {
    for await (const input of this.input) {
      if (input === BatshitRealtimeSttStream.FLUSH_SENTINEL) {
        continue
      }
      if (socket.readyState !== openState) return
      socket.send(frameToPcmBytes(input, this.contract.audio.channels))
    }

    if (socket.readyState === openState && closePayload) {
      socket.send(closePayload)
    }
  }

  private async receiveEvents(
    socket: RuntimeWebSocket,
    openState: number,
    connectingState: number
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const handleMessage = (event: any) => {
        try {
          const content = messageToString(event?.data)
          if (!content) return
          const parsed = JSON.parse(content)
          const events = Array.isArray(parsed) ? parsed : [parsed]
          for (const entry of events) {
            this.handleRealtimeEvent(entry as BatshitRealtimeSttEvent)
          }
        } catch (error) {
          cleanup()
          closeSocket(socket, openState, connectingState, 1011, 'event_error')
          reject(error)
        }
      }
      const handleClose = () => {
        cleanup()
        resolve()
      }
      const handleError = (event: any) => {
        cleanup()
        reject(event?.error instanceof Error ? event.error : new Error('WebSocket error.'))
      }
      const cleanup = () => {
        socket.removeEventListener('message', handleMessage)
        socket.removeEventListener('close', handleClose)
        socket.removeEventListener('error', handleError)
      }
      socket.addEventListener('message', handleMessage)
      socket.addEventListener('close', handleClose, { once: true })
      socket.addEventListener('error', handleError, { once: true })
    })
  }

  private handleRealtimeEvent(event: BatshitRealtimeSttEvent): void {
    const type = stringValue(event.type).toLowerCase()
    if (type === 'speech_start') {
      this.finalTranscripts = []
      this.queue.put({ type: stt.SpeechEventType.START_OF_SPEECH })
      return
    }

    if (type === 'partial') {
      const transcript = eventTranscript(event)
      if (!transcript) return
      this.queue.put({
        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
        alternatives: [buildSpeechData(transcript, event, this.contract.language)]
      })
      return
    }

    if (type === 'final') {
      const transcript = eventTranscript(event)
      if (!transcript) return
      this.finalTranscripts.push(transcript)
      this.queue.put({
        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
        alternatives: [buildSpeechData(transcript, event, this.contract.language)]
      })
      return
    }

    if (type === 'endpoint') {
      const transcript = eventTranscript(event) || this.finalTranscripts.join(' ').trim()
      this.queue.put({
        type: stt.SpeechEventType.END_OF_SPEECH,
        ...(transcript
          ? { alternatives: [buildSpeechData(transcript, event, this.contract.language)] }
          : {})
      })
      this.finalTranscripts = []
      return
    }

    if (type === 'error') {
      throw new Error(
        stringValue(event.error) ||
          stringValue(event.message) ||
          `Batshit realtime STT provider "${this.contract.voiceProviderId}" returned an error.`
      )
    }

    if (type === 'end') {
      this.queue.close()
    }
  }
}

export type { BatshitRealtimeSttContract }
