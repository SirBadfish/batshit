import type { AudioLedGoonLipSyncResult, GoonLipSyncAnalyzerId } from '$lib/utils/goonLipSync'
import { analyzeGoonLipSyncWithAudio2Face } from '$lib/services/audio2FaceLipSync'
import { analyzeGoonLipSyncWithRhubarbWasm } from '$lib/services/rhubarbWasmLipSync'

export async function analyzeAudioLedGoonLipSync(options: {
  analyzerId: Extract<GoonLipSyncAnalyzerId, 'rhubarb-wasm' | 'audio2face-3d'>
  audioBuffer: ArrayBuffer
  mediaType: string
  text?: string | null
}): Promise<AudioLedGoonLipSyncResult> {
  if (options.analyzerId === 'audio2face-3d') {
    return analyzeGoonLipSyncWithAudio2Face(options)
  }
  return analyzeGoonLipSyncWithRhubarbWasm(options)
}
