type RealtimePcmAudioPlayerOptions = {
  sampleRate: number
  channels: number
}

const PCM_BYTES_PER_SAMPLE = 2
const INITIAL_SCHEDULE_DELAY_SEC = 0.04

function clampSample(value: number): number {
  return Math.max(-1, Math.min(1, value / 32768))
}

function pcm16ToAudioBuffer(
  context: AudioContext,
  pcm: Uint8Array,
  options: RealtimePcmAudioPlayerOptions
): AudioBuffer {
  const channels = Math.max(1, Math.floor(options.channels))
  const frameCount = Math.floor(pcm.byteLength / (PCM_BYTES_PER_SAMPLE * channels))
  const buffer = context.createBuffer(channels, Math.max(1, frameCount), options.sampleRate)
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)

  for (let channel = 0; channel < channels; channel += 1) {
    const channelData = buffer.getChannelData(channel)
    for (let frame = 0; frame < frameCount; frame += 1) {
      const offset = (frame * channels + channel) * PCM_BYTES_PER_SAMPLE
      channelData[frame] = clampSample(view.getInt16(offset, true))
    }
  }

  return buffer
}

export class RealtimePcmAudioPlayer {
  readonly audio: HTMLAudioElement

  private readonly context: AudioContext
  private readonly destination: MediaStreamAudioDestinationNode
  private readonly options: RealtimePcmAudioPlayerOptions
  private scheduledAtSec = 0
  private activeSources = new Set<AudioBufferSourceNode>()
  private finished = false
  private finishResolve: (() => void) | null = null

  constructor(options: RealtimePcmAudioPlayerOptions) {
    this.options = {
      sampleRate: Math.max(8000, Math.floor(options.sampleRate)),
      channels: Math.max(1, Math.floor(options.channels))
    }
    this.context = new AudioContext()
    this.destination = this.context.createMediaStreamDestination()
    this.audio = new Audio()
    this.audio.srcObject = this.destination.stream
    this.audio.volume = 1
  }

  async start(): Promise<void> {
    await this.context.resume()
    await this.audio.play()
  }

  enqueue(pcm: Uint8Array): void {
    if (this.finished || pcm.byteLength === 0) return

    const audioBuffer = pcm16ToAudioBuffer(this.context, pcm, this.options)
    const source = this.context.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.destination)

    const earliestStart = this.context.currentTime + INITIAL_SCHEDULE_DELAY_SEC
    const startAt = Math.max(this.scheduledAtSec, earliestStart)
    this.scheduledAtSec = startAt + audioBuffer.duration
    this.activeSources.add(source)
    source.onended = () => {
      this.activeSources.delete(source)
      this.resolveFinishIfReady()
    }
    source.start(startAt)
  }

  async finish(): Promise<void> {
    this.finished = true
    this.resolveFinishIfReady()
    if (this.activeSources.size === 0) return

    await new Promise<void>((resolve) => {
      this.finishResolve = resolve
      this.resolveFinishIfReady()
    })
  }

  stop(): void {
    this.finished = true
    for (const source of this.activeSources) {
      try {
        source.stop()
      } catch {
        // Already stopped sources can be ignored during user interruption.
      }
    }
    this.activeSources.clear()
    this.audio.pause()
    try {
      this.destination.disconnect()
    } catch {
      // Media stream destinations do not always expose an outgoing graph edge.
    }
    void this.context.close().catch(() => {})
    this.finishResolve?.()
    this.finishResolve = null
  }

  private resolveFinishIfReady(): void {
    if (!this.finished || this.activeSources.size > 0) return
    this.finishResolve?.()
    this.finishResolve = null
  }
}
