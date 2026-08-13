export const DEFAULT_DESKTOP_CONTROLS_SHORTCUT = 'CommandOrControl+Shift+G'

export type DesktopShortcutPlatform = 'darwin' | 'win32' | 'linux'

export type DesktopShortcutKeyEvent = {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
}

export type DesktopShortcutCaptureResult =
  | { kind: 'recorded'; accelerator: string }
  | { kind: 'cancelled' }
  | { kind: 'reset' }
  | { kind: 'ignored' }
  | { kind: 'invalid'; message: string }

const SPECIAL_KEY_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  Enter: 'Enter',
  Return: 'Enter',
  Tab: 'Tab',
  ' ': 'Space'
})

const CODE_KEY_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  Semicolon: ';',
  Equal: '=',
  Comma: ',',
  Minus: '-',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  BracketLeft: '[',
  Backslash: '\\',
  BracketRight: ']',
  Quote: "'"
})

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift', 'OS'])

function resolveKeyToken(event: DesktopShortcutKeyEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.key)) return event.key
  if (event.code === 'Equal' && event.shiftKey) return 'Plus'
  return SPECIAL_KEY_TOKENS[event.key] ?? CODE_KEY_TOKENS[event.code] ?? null
}

export function captureDesktopShortcut(
  event: DesktopShortcutKeyEvent,
  platform: DesktopShortcutPlatform
): DesktopShortcutCaptureResult {
  if (event.repeat) return { kind: 'ignored' }
  if (event.key === 'Escape') return { kind: 'cancelled' }
  if (
    (event.key === 'Backspace' || event.key === 'Delete') &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  ) {
    return { kind: 'reset' }
  }
  if (MODIFIER_KEYS.has(event.key)) return { kind: 'ignored' }

  const modifiers: string[] = []
  if (platform === 'darwin') {
    if (event.metaKey) modifiers.push('CommandOrControl')
    if (event.ctrlKey) modifiers.push('Control')
  } else {
    if (event.ctrlKey) modifiers.push('CommandOrControl')
    if (event.metaKey) modifiers.push('Super')
  }
  if (event.altKey) modifiers.push('Alt')
  if (event.shiftKey) modifiers.push('Shift')

  if (modifiers.length === 0) {
    return {
      kind: 'invalid',
      message: 'Include Command, Control, Option, or Shift in the shortcut.'
    }
  }

  const key = resolveKeyToken(event)
  if (!key) {
    return {
      kind: 'invalid',
      message: 'That key cannot be used as a Desktop Controls shortcut.'
    }
  }

  return { kind: 'recorded', accelerator: [...modifiers, key].join('+') }
}

const MAC_TOKEN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CommandOrControl: '⌘',
  Command: '⌘',
  Cmd: '⌘',
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Super: '◆',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Space: 'Space'
})

const STANDARD_TOKEN_LABELS: Readonly<Record<string, string>> = Object.freeze({
  CommandOrControl: 'Ctrl',
  Command: 'Command',
  Cmd: 'Command',
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
  Super: 'Super',
  Up: 'Up',
  Down: 'Down',
  Left: 'Left',
  Right: 'Right',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Space: 'Space'
})

export function formatDesktopShortcut(
  accelerator: string,
  platform: DesktopShortcutPlatform
): string {
  const tokens = accelerator
    .split('+')
    .map((token) => token.trim())
    .filter(Boolean)
  const labels = platform === 'darwin' ? MAC_TOKEN_LABELS : STANDARD_TOKEN_LABELS
  const rendered = tokens.map((token) => labels[token] ?? token)
  return rendered.join(platform === 'darwin' ? ' ' : ' + ')
}

export function detectDesktopShortcutPlatform(): DesktopShortcutPlatform {
  if (typeof navigator === 'undefined') return 'linux'
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase()
  if (platform.includes('mac')) return 'darwin'
  if (platform.includes('win')) return 'win32'
  return 'linux'
}
