import type { AudioLedGoonLipSyncResult, GoonLipSyncAnalyzerId } from '$lib/utils/goonLipSync'
import { analyzeGoonLipSyncWithRhubarbWasm } from '$lib/services/rhubarbWasmLipSync'

export async function analyzeAudioLedGoonLipSync(options: {
  analyzerId: Extract<GoonLipSyncAnalyzerId, 'rhubarb-wasm'>
  audioBuffer: ArrayBuffer
  mediaType: string
  text?: string | null
}): Promise<AudioLedGoonLipSyncResult> {
  return analyzeGoonLipSyncWithRhubarbWasm(options)
}
