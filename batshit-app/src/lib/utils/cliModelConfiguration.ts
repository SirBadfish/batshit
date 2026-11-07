/** The existing Claude argv condition; placeholders are omitted, aliases stay literal. */
export function claudeModelArguments(model: string | null | undefined): string[] {
  return model && !model.includes('claude-cli') ? ['--model', model] : []
}
