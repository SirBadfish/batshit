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
  '🙂': 'smile',
  '😊': 'smile',
  '😏': 'smirk',
  '😢': 'sad',
  '😡': 'angry',
  '😮': 'surprised',
  '😲': 'surprised',
  '😉': 'smirk'
}
