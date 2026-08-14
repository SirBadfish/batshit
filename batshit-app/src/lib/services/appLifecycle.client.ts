type AppShutdownEvent = Readonly<{
  schemaVersion: 'app-lifecycle/v1'
  type: 'shutdown-started'
  reason: 'app-quit' | 'window-close'
}>

type AppLifecycleBridge = Readonly<{
  isShuttingDown(): boolean
  onShutdown(listener: (event: AppShutdownEvent) => void): () => void
}>

type ElectronLifecycleWindow = Window & {
  zero?: {
    lifecycle?: AppLifecycleBridge
  }
}

let intentionalShutdownStarted = false

const expectedShutdownNotificationPatterns = [
  /\bfailed to (?:load|fetch|get)\b/i,
  /\b(?:sessions?|folders?|projects?|agents?|clips?|conversation|messages?|settings)\b.*\bfailed to (?:load|fetch|get)\b/i,
  /\b(?:load|fetch) failed\b/i,
  /\bconnection (?:lost|closed|failed)\b/i,
  /\bfailed to establish connection\b/i
]

function getLifecycleBridge(): AppLifecycleBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as ElectronLifecycleWindow).zero?.lifecycle
  if (
    !bridge ||
    typeof bridge.isShuttingDown !== 'function' ||
    typeof bridge.onShutdown !== 'function'
  ) {
    return null
  }
  return bridge
}

export function isIntentionalAppShutdown(): boolean {
  if (intentionalShutdownStarted) return true
  const bridge = getLifecycleBridge()
  if (!bridge) return false

  try {
    intentionalShutdownStarted = bridge.isShuttingDown() === true
  } catch {
    return false
  }
  return intentionalShutdownStarted
}

export function isExpectedIntentionalShutdownNotification(message: unknown): boolean {
  if (!isIntentionalAppShutdown() || typeof message !== 'string') return false
  return expectedShutdownNotificationPatterns.some((pattern) => pattern.test(message))
}

export function runUnlessExpectedIntentionalShutdownNotification<T>(
  message: unknown,
  run: () => T,
  suppressedValue: T
): T {
  return isExpectedIntentionalShutdownNotification(message) ? suppressedValue : run()
}

export function onIntentionalAppShutdown(
  listener: (event: AppShutdownEvent) => void
): () => void {
  const bridge = getLifecycleBridge()
  if (!bridge) return () => {}

  let delivered = false
  const handleShutdown = (event: AppShutdownEvent) => {
    if (delivered) return
    delivered = true
    intentionalShutdownStarted = true
    listener(event)
  }

  let unsubscribe = () => {}
  try {
    unsubscribe = bridge.onShutdown(handleShutdown)
    if (bridge.isShuttingDown() === true) {
      handleShutdown({
        schemaVersion: 'app-lifecycle/v1',
        type: 'shutdown-started',
        reason: 'app-quit'
      })
    }
  } catch {
    unsubscribe()
    return () => {}
  }

  return unsubscribe
}
