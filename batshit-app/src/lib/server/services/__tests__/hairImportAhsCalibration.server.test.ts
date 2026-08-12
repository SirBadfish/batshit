import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseHairImportAhsCalibration } from "../hairImportAhsCalibration.server";

const TEMPLATE_PATH = path.resolve(
  process.cwd(),
  "../docs/user-docs/user-templates/batshit-anime-hair-studio/Batshit-Base-Female-Hair-Template-v1.ahs",
);

async function templateBytes() {
  return new Uint8Array(await readFile(TEMPLATE_PATH));
}

describe("Anime Hair Studio calibration", () => {
  it("recognizes the versioned Batshit template and returns its deterministic fit", async () => {
    const result = await parseHairImportAhsCalibration({
      bytes: await templateBytes(),
      filename: "renamed-template.ahs",
    });

    expect(result).toMatchObject({
      contract: "hair-import-ahs-calibration/v1",
      recognition: "batshit-template",
      projectVersion: 1,
      requiresVisualReview: false,
      sourceCalibration: {
        contract: "hair-import-source-calibration/v1",
        mode: "registered-template/v1",
      },
    });
    expect(result.recommendedTransform?.uniformScale).toBeCloseTo(
      0.06499761904761901,
      12,
    );
    expect(result.recommendedTransform?.translation).toEqual([
      -0.000001000000000001,
      1.5027458333333332,
      0.04487804761904763,
    ]);
  });

  it("keeps the fingerprint stable across resaves and Hair-only edits", async () => {
    const original = JSON.parse(
      new TextDecoder().decode(await templateBytes()),
    );
    const edited = structuredClone(original);
    edited.metadata.savedAt = "2099-01-01T00:00:00.000Z";
    edited.metadata.strandCount = 1;
    edited.state.locks = [{ id: "new-hair-lock", points: [[0, 0, 0]] }];
    edited.state.selectedStrandIds = ["new-hair-lock"];

    const [before, after] = await Promise.all([
      parseHairImportAhsCalibration({
        bytes: new TextEncoder().encode(JSON.stringify(original)),
        filename: "before.ahs",
      }),
      parseHairImportAhsCalibration({
        bytes: new TextEncoder().encode(JSON.stringify(edited)),
        filename: "after.ahs",
      }),
    ]);

    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.recognition).toBe("batshit-template");
  });

  it("invalidates recognition when scalp calibration changes", async () => {
    const project = JSON.parse(
      new TextDecoder().decode(await templateBytes()),
    );
    project.state.scalpBuilderEditedPoints[0].z += 0.001;

    const result = await parseHairImportAhsCalibration({
      bytes: new TextEncoder().encode(JSON.stringify(project)),
      filename: "changed-scalp.ahs",
    });

    expect(result.recognition).toBe("unrecognized");
    expect(result.recommendedTransform).toBeNull();
    expect(result.sourceCalibration).toBeNull();
  });

  it("rejects malformed and unsupported project envelopes clearly", async () => {
    await expect(
      parseHairImportAhsCalibration({
        bytes: new TextEncoder().encode("not-json"),
        filename: "broken.ahs",
      }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      parseHairImportAhsCalibration({
        bytes: new TextEncoder().encode(
          JSON.stringify({
            application: "Anime Hair Studio",
            format: "anime-hair-studio-project",
            version: 2,
            state: {},
          }),
        ),
        filename: "future.ahs",
      }),
    ).rejects.toThrow(/version 1/);
  });
});
