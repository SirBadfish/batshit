export type FinishZipInput = {
  streamedMessageContent?: string | null
  sanitizedFinishText?: string | null
  forwardedToActiveSse: boolean
}

export type FinishZipDecision = {
  content: string
  processXmlZips: boolean
}

export function selectFinishZipInput({
  streamedMessageContent,
  sanitizedFinishText,
  forwardedToActiveSse
}: FinishZipInput): FinishZipDecision {
  const streamed = streamedMessageContent || ''
  const finished = sanitizedFinishText || ''
  const content = streamed || finished

  return {
    content,
    processXmlZips: !(forwardedToActiveSse && streamed.trim().length > 0)
  }
}
