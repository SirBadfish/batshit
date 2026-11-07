/** Only the accepted-send owner's no-path raw read, over this fixture's existing client/store. */
export function sendHandlerFixtureClient(client: any, sessionIds: () => readonly string[]) {
  const rawSession = async (command: unknown): Promise<string | null> => {
    if (!Array.isArray(command) || command.length !== 2 || command[0] !== 'JSON.GET' ||
        typeof command[1] !== 'string' || !sessionIds().some(id => id && command[1] === `session:${id}`)) {
      const target = Array.isArray(command) && command[0] === 'JSON.GET'
        ? ` (${JSON.stringify(command.slice(1, 3))})` : ''
      throw new Error(`Unsupported raw command in the send-handler fixture${target}.`)
    }
    const key = command[1]
    const storage = await client.type(key)
    if (storage === 'none') return null
    if (storage !== 'ReJSON-RL') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
    // `$` distinguishes a missing key from a stored JSON null. Strip exactly its
    // one match wrapper; a document which is itself a list keeps that list intact.
    const roots = await client.json.get(key, { path: '$' })
    if (roots === null) return null
    if (!Array.isArray(roots) || roots.length !== 1) throw new Error('The send-handler fixture needs one exact JSON root.')
    return JSON.stringify(roots[0])
  }
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (property === 'sendCommand') return rawSession
      const value = Reflect.get(client, property, client)
      return typeof value === 'function' ? value.bind(client) : value
    },
    has(_target, property) { return property === 'sendCommand' || property in client },
    ownKeys() { return [...new Set([...Reflect.ownKeys(client), 'sendCommand'])] },
    getOwnPropertyDescriptor(_target, property) {
      if (property === 'sendCommand' || Reflect.has(client, property)) return { configurable: true, enumerable: true }
    }
  })
}

/** The production strict compiler read's error contract, never the tolerant facade getter. */
export async function readSendHandlerSessionForCompile(execute: (operation: (client: any) => Promise<any>) => Promise<any>, sessionId: string) {
  try {
    const row = await execute(client => client.json.get(`session:${sessionId}`))
    return row || null
  } catch (error) {
    throw new Error(`SESSION_UNAVAILABLE: failed to read session:${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
