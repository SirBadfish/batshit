import { describe, expect, it } from "vitest";

import {
  CREATE_AGENT_SENTINEL,
  requireHydratedAgentDetail,
} from "./agentDetailSaveGuard";

describe("requireHydratedAgentDetail", () => {
  it("accepts an empty persisted prompt as a hydrated agent detail", () => {
    expect(requireHydratedAgentDetail("bob", "", "the agent prompt")).toBe(
      "bob",
    );
  });

  it("accepts a non-empty persisted prompt", () => {
    expect(
      requireHydratedAgentDetail("alice", "Existing prompt", "the agent prompt"),
    ).toBe("alice");
  });

  it("rejects a detail that has not hydrated", () => {
    expect(() =>
      requireHydratedAgentDetail("bob", null, "the agent prompt"),
    ).toThrow(
      "Agent details are still loading. Wait for the selected agent to finish loading before saving the agent prompt.",
    );
  });

  it.each([null, CREATE_AGENT_SENTINEL])(
    "rejects an unavailable selected agent id (%s)",
    (agentId) => {
      expect(() =>
        requireHydratedAgentDetail(agentId, "", "the agent prompt"),
      ).toThrow("Select an agent before saving the agent prompt.");
    },
  );
});
