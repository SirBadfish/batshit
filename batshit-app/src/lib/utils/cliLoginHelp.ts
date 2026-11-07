import { isClaudePlanConnection } from './claudePlanConnection'

/** The sign-in help the Claude Plan card shows beside its login command. */
export function formatCliLoginHelp(setupContext: string | undefined, setupWorkingDirectory?: string) {
  if (setupContext === "docker") {
    return setupWorkingDirectory?.trim()
      ? "Open Terminal, go to the Batshit Docker folder shown below, then run this login command once."
      : "Open Terminal, go to your Batshit Docker install folder, then run this login command once.";
  }

  return "Open Terminal and run this once.";
}

/** Claude Code's login prompt (the Claude plan's) can hide pasted input on Windows. */
export function formatCliLoginNote(option: { id?: string | null } | null | undefined) {
  if (!isClaudePlanConnection(option?.id)) return null;

  return 'Claude Code on Windows may hide pasted auth-code input. At "Paste code here if prompted", paste the browser code, then press Enter even if no text appears.';
}
