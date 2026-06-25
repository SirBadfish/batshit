import {
  buildTextGoonLipSyncTimeline,
  type GoonLipSyncAnalyzerId,
  type GoonLipSyncTimeline,
  type GoonLipSyncTimelineSource
} from '$lib/utils/goonLipSync'

export type GoonLipSyncAnalyzerRuntime = 'shared' | 'client' | 'server'

export type GoonLipSyncAnalyzerInput = {
  speakableText: string
  playbackRate?: number
  audioBytes?: Uint8Array
  mediaType?: string
  audioPath?: string | null
  durationMs?: number | null
}

export type GoonLipSyncAnalysis = {
  analyzerId: GoonLipSyncAnalyzerId
  runtime: GoonLipSyncAnalyzerRuntime
  source: GoonLipSyncTimelineSource
  timeline: GoonLipSyncTimeline | null
  warnings: string[]
}

export type GoonLipSyncAnalyzer = {
  id: GoonLipSyncAnalyzerId
  runtime: GoonLipSyncAnalyzerRuntime
  source: GoonLipSyncTimelineSource
  analyze(input: GoonLipSyncAnalyzerInput): Promise<GoonLipSyncAnalysis>
}

export function buildTextTimingLipSyncAnalysis(
  input: Pick<GoonLipSyncAnalyzerInput, 'speakableText' | 'playbackRate' | 'durationMs'>
): GoonLipSyncAnalysis {
  const timeline = buildTextGoonLipSyncTimeline(input.speakableText, input.playbackRate, input.durationMs)

  return {
    analyzerId: 'batshit-text-timing',
    runtime: 'shared',
    source: 'text-timing',
    timeline,
    warnings: timeline ? [] : ['No speakable text was available for the text-timing fallback lane.']
  }
}
