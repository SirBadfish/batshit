export const CREATE_AGENT_SENTINEL = "__create__";

export function requireHydratedAgentDetail(
  selectedAgentId: string | null,
  persistedSignature: string | null,
  label: string,
): string {
  if (!selectedAgentId || selectedAgentId === CREATE_AGENT_SENTINEL) {
    throw new Error(`Select an agent before saving ${label}.`);
  }

  if (persistedSignature === null) {
    throw new Error(
      `Agent details are still loading. Wait for the selected agent to finish loading before saving ${label}.`,
    );
  }

  return selectedAgentId;
}
