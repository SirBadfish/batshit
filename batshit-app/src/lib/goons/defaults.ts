import type { GoonCueMap, GoonEmojiMap } from '$lib/types/goons'

export const DEFAULT_GOON_CUES: GoonCueMap = {
  base_stand: {
    name: 'base_stand',
    kind: 'mood',
    playback: 'loop',
    description: 'Standing idle (default)'
  },
  base_sit: {
    name: 'base_sit',
    kind: 'mood',
    posture: 'sit',
    playback: 'loop',
    description: 'Sitting idle'
  },
  calm: {
    name: 'calm',
    kind: 'mood',
    playback: 'loop',
    description: 'Calm idle',
    animationName: 'base_stand',
    expressionTargets: [{ preset: 'relaxed', weight: 1 }]
  },
  happy: {
    name: 'happy',
    kind: 'mood',
    playback: 'loop',
    description: 'Happy idle',
    animationName: 'base_stand',
    expressionTargets: [{ preset: 'happy', weight: 1 }]
  },
  focused: {
    name: 'focused',
    kind: 'mood',
    playback: 'loop',
    description: 'Focused idle',
    animationName: 'base_stand',
    expressionTargets: [{ preset: 'neutral', weight: 1 }]
  },
  wave: {
    name: 'wave',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Friendly wave',
    mask: 'upper'
  },
  nod: {
    name: 'nod',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Nod yes',
    mask: 'head'
  },
  shake_head: {
    name: 'shake_head',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Shake head no',
    mask: 'head'
  },
  shrug: {
    name: 'shrug',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Shrug',
    mask: 'upper'
  },
  point: {
    name: 'point',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Point',
    mask: 'upper'
  },
  thinking_beat: {
    name: 'thinking_beat',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Short thinking beat',
    blocking: true,
    durationMs: 900
  },
  laugh: {
    name: 'laugh',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Short laugh beat',
    blocking: true,
    durationMs: 1200
  },
  smile: {
    name: 'smile',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Smile',
    expressionTargets: [{ preset: 'happy', weight: 1 }]
  },
  smirk: {
    name: 'smirk',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Smirk',
    expressionTargets: [{ preset: 'relaxed', weight: 1 }]
  },
  surprised: {
    name: 'surprised',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Surprised',
    expressionTargets: [{ preset: 'surprised', weight: 1 }]
  },
  sad: {
    name: 'sad',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Sad',
    expressionTargets: [{ preset: 'sad', weight: 1 }]
  },
  angry: {
    name: 'angry',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Angry',
    expressionTargets: [{ preset: 'angry', weight: 1 }]
  },
  blink: {
    name: 'blink',
    kind: 'emote',
    playback: 'oneshot',
    description: 'Blink',
    expressionTargets: [{ preset: 'blink', weight: 1 }]
  }
}

export const DEFAULT_GOON_EMOJI_MAP: GoonEmojiMap = {
  '👋': 'wave',
  '🙂': 'smile',
  '😊': 'smile',
  '😏': 'smirk',
  '😢': 'sad',
  '😡': 'angry',
  '😮': 'surprised',
  '😲': 'surprised',
  '🤔': 'thinking_beat',
  '😂': 'laugh',
  '🤣': 'laugh',
  '😉': 'smirk'
}
