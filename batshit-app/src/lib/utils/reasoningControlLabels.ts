/** Shared display labels; this module imports neither the resolver nor its preview. */
export function reasoningValueText(value: unknown): string {
  if (value === true) return 'On'
  if (value === false) return 'Off'
  const literal = String(value)
  return literal === 'xhigh' ? 'Extra High' : literal === 'between_tools' ? 'Between tools (lowest)' : literal
}
export function reasoningValueLabel(value: unknown): string {
  const literal = reasoningValueText(value)
  return literal[0]?.toUpperCase() + literal.slice(1)
}
