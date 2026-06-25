function isSubagentStep(step: any): boolean {
  if (!step || typeof step !== 'object') return false

  const names = [
    step.toolName,
    step.originalToolName,
    step.subagentName,
    step.operationKind,
    step.rendererFamily
  ]

  if (step.isSubagent === true || step.toolProvider === 'subagent') {
    return true
  }

  if (step.toolArgs && typeof step.toolArgs === 'object' && 'Prompt__User_Message_' in step.toolArgs) {
    return true
  }

  return names.some(
    (name) => typeof name === 'string' && name.toLowerCase().includes('subagent')
  )
}

function extractPlainText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 5) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const extracted = extractPlainText(entry, depth + 1)
      if (extracted) return extracted
    }
    return ''
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const candidates = [
      record.output,
      record.result,
      record.value,
      record.content,
      record.text,
      record.message
    ]

    for (const candidate of candidates) {
      const extracted = extractPlainText(candidate, depth + 1)
      if (extracted) return extracted
    }
  }

  return ''
}

export function stripLeadingSubagentEchoText(text: string, intermediateSteps: any[] | undefined | null): string {
  if (typeof text !== 'string' || !text) return ''
  if (!Array.isArray(intermediateSteps) || intermediateSteps.length === 0) return text

  for (const step of intermediateSteps) {
    if (!isSubagentStep(step)) continue

    const output = extractPlainText(step.toolResult)
    if (!output || output.length > 200) continue
    if (!text.startsWith(output)) continue

    const nextChar = text.charAt(output.length)
    if (!nextChar) continue

    // Only strip the prefix when the raw subagent output is glued directly onto
    // the assistant reply with no delimiter, e.g. "ORBITSubagent returned...".
    if (/[A-Za-z0-9]/.test(nextChar)) {
      return text.slice(output.length).trimStart()
    }
  }

  return text
}
