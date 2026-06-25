const NON_SPEECH_TRANSCRIPT_MARKER_PATTERN =
  /\s*(?:\[(?:BLANK[_\s-]?AUDIO|NO[_\s-]?AUDIO|NO[_\s-]?SPEECH|SILENCE)\]|\((?:BLANK[_\s-]?AUDIO|NO[_\s-]?AUDIO|NO[_\s-]?SPEECH|SILENCE)\)|<\|(?:NO[_\s-]?SPEECH|SILENCE)\|>)\s*/gi

export function stripNonSpeechTranscriptMarkers(value: string): string {
  return value.replace(NON_SPEECH_TRANSCRIPT_MARKER_PATTERN, ' ')
}

export function cleanSpeechTranscript(value: string): string {
  return stripNonSpeechTranscriptMarkers(value).replace(/\s+/g, ' ').trim()
}
