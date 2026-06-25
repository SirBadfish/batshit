export function parseJsonLike<T = unknown>(value: T): T {
  if (typeof value !== 'string') {
    return value
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return value
  }

  const startsWith = trimmed[0]
  const endsWith = trimmed[trimmed.length - 1]

  const looksLikeJson =
    (startsWith === '{' && endsWith === '}') ||
    (startsWith === '[' && endsWith === ']')

  if (looksLikeJson) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return value
    }
  }

  if (startsWith === '"' && endsWith === '"') {
    try {
      const unquoted = JSON.parse(trimmed)
      return parseJsonLike(unquoted as T)
    } catch {
      return value
    }
  }

  return value
}

function extractChatMessage(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (depth > 6) {
    return ''
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => extractChatMessage(entry, depth + 1))
      .filter((part) => part.trim().length > 0)

    return parts.length > 0 ? Array.from(new Set(parts)).join('\n\n') : ''
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>

    for (const key of ['value', 'text', 'prompt', 'message']) {
      if (typeof obj[key] === 'string') {
        return obj[key] as string
      }
    }

    for (const key of ['content', 'messages', 'parts']) {
      if (key in obj) {
        const message = extractChatMessage(obj[key], depth + 1)
        if (message) return message
      }
    }
  }

  return ''
}

export function normalizeToolArgs(raw: unknown): Record<string, any> {
  const parsed = parseJsonLike(raw)

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const normalized: Record<string, any> = { ...(parsed as Record<string, any>) }

    if (normalized.toolInput && typeof normalized.toolInput === 'object') {
      Object.assign(normalized, normalized.toolInput)
      delete normalized.toolInput
    }

    if (normalized.input && typeof normalized.input === 'object') {
      Object.assign(normalized, normalized.input)
      delete normalized.input
    }

    if (!normalized.filePath) {
      if (typeof normalized.file_path === 'string') {
        normalized.filePath = normalized.file_path
      } else if (typeof normalized.path === 'string') {
        normalized.filePath = normalized.path
      }
    }

    if (normalized.subagent && typeof normalized.subagent === 'object') {
      const subagent = normalized.subagent as Record<string, any>
      if (typeof subagent.id === 'string' && !normalized.subagentId) {
        normalized.subagentId = subagent.id
      }
      const subagentDisplay =
        subagent.displayName || subagent.display_name || subagent.name
      if (typeof subagentDisplay === 'string' && !normalized.subagentName) {
        normalized.subagentName = subagentDisplay
      }
    }

    if (normalized.chatInput !== undefined) {
      const parsedChatInput = parseJsonLike(normalized.chatInput)
      normalized.chatInput = parsedChatInput

      if (normalized.Prompt__User_Message_ === undefined) {
        const extracted = extractChatMessage(parsedChatInput)
        if (extracted.trim().length > 0) {
          normalized.Prompt__User_Message_ = extracted
        } else if (typeof parsedChatInput === 'string') {
          normalized.Prompt__User_Message_ = parsedChatInput
        } else {
          try {
            normalized.Prompt__User_Message_ = JSON.stringify(parsedChatInput)
          } catch {
            normalized.Prompt__User_Message_ = ''
          }
        }
      }
    }

    if (
      normalized.prompt !== undefined &&
      normalized.Prompt__User_Message_ === undefined
    ) {
      const parsedPrompt = parseJsonLike(normalized.prompt)
      normalized.prompt = parsedPrompt
      const extracted = extractChatMessage(parsedPrompt)
      if (extracted.trim().length > 0) {
        normalized.Prompt__User_Message_ = extracted
      } else if (typeof parsedPrompt === 'string') {
        normalized.Prompt__User_Message_ = parsedPrompt
      }
    }

    return normalized
  }

  if (typeof parsed === 'string') {
    return { value: parsed }
  }

  return {}
}
