import type { ModelPurpose } from '$lib/types/savedModels'

function normalize(value?: string | null) {
  return value?.toLowerCase().trim() ?? ''
}

function toTagSet(tags?: Iterable<string> | null): Set<string> {
  const set = new Set<string>()
  if (!tags) return set
  for (const tag of tags) {
    const normalized = normalize(tag)
    if (normalized) set.add(normalized)
  }
  return set
}

function hasAnyTag(tags: Set<string>, candidates: string[]) {
  for (const candidate of candidates) {
    if (tags.has(candidate)) return true
  }
  return false
}

function looksLikeImageOnlyModel(value: string): boolean {
  if (!value) return false

  if (value.includes('gpt-image')) return true
  if (value.includes('dall-e') || value.includes('dalle')) return true
  if (value.includes('imagen')) return true
  if (value.includes('stable-diffusion') || value.includes('sdxl') || value.includes('flux')) return true
  if (value.includes('midjourney') || value.includes('firefly') || value.includes('photon')) return true

  // Many dedicated image endpoints include a `-image` segment.
  return /(^|[-_])image($|[-_])/.test(value)
}

function looksLikeVisualOnlyModel(value: string): boolean {
  if (!value) return false
  if (looksLikeImageOnlyModel(value)) return true

  // Video / 3D / media generation signals.
  if (value.includes('video') || value.includes('vidu') || value.includes('sora') || value.includes('kling')) return true
  if (value.includes('runway') || value.includes('pika')) return true
  if (value.includes('3d') || value.includes('mesh') || value.includes('pointcloud') || value.includes('voxel')) return true
  if (value.includes('avatar') || value.includes('animation')) return true

  return false
}

function looksLikeUtilityModel(value: string): boolean {
  if (!value) return false
  if (value.includes('embedding') || value.includes('embed')) return true
  if (value.includes('rerank') || value.includes('re-rank') || value.includes('ranker')) return true
  if (value.includes('classifier') || value.includes('classification')) return true
  if (value.includes('moderation')) return true
  if (value.includes('similarity') || value.includes('vector')) return true
  if (value.includes('ocr')) return true
  return false
}

function looksLikeAudioOnlyModel(value: string): boolean {
  if (!value) return false

  // Speech-to-text + text-to-speech style endpoints (avoid classifying "audio preview" chat models).
  if (value.includes('whisper')) return true
  if (value.includes('speech-to-text') || value.includes('speechtotext')) return true
  if (value.includes('text-to-speech') || value.includes('texttospeech')) return true
  if (value.includes('transcription') || value.includes('transcribe')) return true
  if (value.includes('stt')) return true

  // Common TTS naming.
  if (value.startsWith('tts') || value.includes('/tts') || value.includes('-tts')) return true

  return false
}

export function inferModelPurpose({
  id,
  name,
  modelType,
  tags
}: {
  id?: string | null
  name?: string | null
  modelType?: string | null
  tags?: Iterable<string> | null
}): ModelPurpose {
  const normalizedId = normalize(id)
  const normalizedName = normalize(name)
  const normalizedType = normalize(modelType)
  const tagSet = toTagSet(tags)

  // Strong signals: embeddings / utilities.
  if (normalizedType.includes('embedding')) return 'utility'
  if (normalizedType.includes('rerank') || normalizedType.includes('ranker')) return 'utility'
  if (normalizedType.includes('classifier') || normalizedType.includes('classification')) return 'utility'
  if (hasAnyTag(tagSet, ['embedding', 'embeddings', 'text-embedding', 'textembedding', 'rerank', 'reranker', 'ranker', 'classifier', 'classification', 'moderation'])) {
    return 'utility'
  }
  if (looksLikeUtilityModel(normalizedId) || looksLikeUtilityModel(normalizedName)) return 'utility'

  // Strong signals: audio-only endpoints (speech-to-text, text-to-speech).
  if (normalizedType.includes('audio') || normalizedType.includes('speech') || normalizedType.includes('transcription')) {
    return 'audio'
  }
  if (looksLikeAudioOnlyModel(normalizedName) || looksLikeAudioOnlyModel(normalizedId)) return 'audio'
  if (hasAnyTag(tagSet, ['tts', 'stt', 'transcription', 'speech-to-text', 'text-to-speech'])) {
    return 'audio'
  }

  // Strong signals: dedicated visual / media models (image, video, 3D).
  if (normalizedType && normalizedType.includes('image') && !normalizedType.includes('vision')) {
    return 'visual'
  }
  if (normalizedType && (normalizedType.includes('video') || normalizedType.includes('3d'))) {
    return 'visual'
  }
  if (looksLikeVisualOnlyModel(normalizedName) || looksLikeVisualOnlyModel(normalizedId)) return 'visual'

  return 'chat'
}
