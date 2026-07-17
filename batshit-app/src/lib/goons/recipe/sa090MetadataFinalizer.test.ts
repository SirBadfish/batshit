import { describe, expect, it } from "vitest";
import {
  parseArguments,
  sourceFields,
} from "../../../../../_private/tools/goons/finalize_sa090_recipe_metadata";

const BASE_ID = "batshit-base-f-v1";
const FIT_FAMILY = "batshit-base-f-v1";

function manifest(baseId = BASE_ID) {
  return {
    rig: { baseId, fitFamily: FIT_FAMILY },
    appearanceDials: {
      definitionSha256: "1".repeat(64),
      neutral: {
        id: "neutral-v1",
        recipeSha256: "2".repeat(64),
      },
    },
    recipeSource: { baseId },
  };
}

describe("SA-090 Recipe metadata finalizer identity pins", () => {
  it("requires an explicit expected base id", () => {
    expect(() =>
      parseArguments([
        "--check",
        "--glb",
        "avatar.glb",
        "--manifest",
        "avatar.json",
        "--fit-family",
        FIT_FAMILY,
      ]),
    ).toThrow(/--base-id ID/);
  });

  it("rejects a self-consistent manifest/source pair with the wrong base", () => {
    expect(() =>
      sourceFields(manifest("wrong-base"), BASE_ID, FIT_FAMILY),
    ).toThrow(
      /base-id input batshit-base-f-v1 disagrees with avatar\.json\.rig\.baseId wrong-base/,
    );
  });

  it("accepts the explicitly pinned base and fit family", () => {
    expect(sourceFields(manifest(), BASE_ID, FIT_FAMILY)).toMatchObject({
      baseId: BASE_ID,
      fitFamily: FIT_FAMILY,
      neutralId: "neutral-v1",
    });
  });
});
