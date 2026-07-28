const RESERVED_RUNTIME_NODE_CHARS = /[\[\]\.:/]/g

export function sanitizeCustomRuntimeNodeName(name: string) {
  return name
    .trim()
    .replace(/\s/g, '_')
    .replace(RESERVED_RUNTIME_NODE_CHARS, '')
}
