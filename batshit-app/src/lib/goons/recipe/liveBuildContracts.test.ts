import { describe, expect, it } from "vitest";
import {
  GOON_LIVE_BUILD_CONTRACT,
  GOON_LIVE_BUILD_TOLERANCES,
  canonicalGoonLiveBuildReceiptContent,
  createGoonLiveBuildReceipt,
  goonLiveBuildReceiptSha256,
  parseGoonLiveBuildReceipt,
  parseGoonLiveBuildReceiptContent,
  verifyGoonLiveBuildReceipt,
  type GoonLiveBuildReceiptContent,
} from "./liveBuildContracts";

const hash = (hexCharacter: string): string => hexCharacter.repeat(64);

function validContent(): GoonLiveBuildReceiptContent {
  return {
    contract: GOON_LIVE_BUILD_CONTRACT,
    source: {
      revisionId: "recipe-revision-7",
      revision: 7,
      packageSha256: hash("0"),
      modelSha256: hash("1"),
      manifestSha256: hash("2"),
      definitionSha256: hash("3"),
      neutralRecipeSha256: hash("4"),
      basisSha256: hash("5"),
    },
    state: {
      contract: "appearance-dial-values/v2",
      sha256: hash("6"),
    },
    baker: {
      id: "batshit.recipe-baker",
      version: "1.0.0",
      resolverVersion: "appearance-resolver/v1",
      schemaVersion: "goon-recipe-baker/v1",
    },
    inventory: {
      kept: [
        "node:/Body/morph:/blink",
        "node:/Body/morph:/corrective-knee",
        "node:/Body/morph:/expression-anger",
        "node:/Body/morph:/expression-happy",
        "node:/Body/morph:/expression-sad",
        "node:/Body/morph:/jaw-open",
        "node:/Body/morph:/look-left",
        "node:/Body/morph:/viseme-aa",
        "node:/hips",
      ],
      removed: ["manifest:/appearanceDials", "morph:identity-height"],
      liveMorphTargets: [
        "node:/Body/morph:/blink",
        "node:/Body/morph:/corrective-knee",
        "node:/Body/morph:/expression-anger",
        "node:/Body/morph:/expression-happy",
        "node:/Body/morph:/expression-sad",
        "node:/Body/morph:/jaw-open",
        "node:/Body/morph:/look-left",
        "node:/Body/morph:/viseme-aa",
      ],
      retainedDynamicMorphs: ["node:/Body/morph:/blink"],
      retainedCorrectiveMorphs: ["node:/Body/morph:/corrective-knee"],
    },
    proofs: {
      neutralPositionSha256: hash("7"),
      skeletonRestSha256: hash("8"),
      followerSha256: hash("9"),
      rootSha256: hash("a"),
      groundingSha256: hash("b"),
      performanceSha256: hash("c"),
      pivotSha256: hash("d"),
      attachmentSha256: hash("e"),
      validationReportSha256: hash("f"),
      liveManifestProvenanceSha256: hash("0"),
    },
    output: {
      package: { sha256: hash("a"), bytes: 10_000 },
      model: { sha256: hash("b"), bytes: 8_000 },
      manifest: { sha256: hash("c"), bytes: 2_000 },
      counts: {
        meshes: 3,
        vertices: 12_000,
        nodes: 84,
        bones: 63,
        morphTargets: 8,
        dynamicMorphTargets: 1,
        correctiveMorphTargets: 1,
        recipeMorphTargets: 0,
      },
    },
    cost: {
      inputBytes: 20_000,
      meshesProcessed: 3,
      verticesProcessed: 12_000,
      morphTargetsProcessed: 42,
    },
    validation: {
      maxWeightScalarError: 8e-8,
      maxVertexErrorMeters: 8e-7,
      maxJointErrorMeters: 7e-7,
      maxNodeTranslationErrorMeters: 6e-7,
      maxPivotErrorMeters: 5e-7,
      maxScaleError: 4e-7,
      maxRotationErrorRadians: 3e-7,
      maxGroundingErrorMeters: 2e-7,
      maxFinalPositionErrorMeters: 8e-7,
      rmsFinalPositionErrorMeters: 4e-7,
    },
  };
}

function cloneContent(): GoonLiveBuildReceiptContent {
  return structuredClone(validContent());
}

describe("goon-live-build/v1 receipt", () => {
  it("creates, parses, and verifies a deterministic immutable receipt", async () => {
    const first = await createGoonLiveBuildReceipt(validContent());
    const second = await createGoonLiveBuildReceipt(cloneContent());

    expect(first).toEqual(second);
    expect(first.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseGoonLiveBuildReceipt(first)).toEqual(first);
    await expect(verifyGoonLiveBuildReceipt(first)).resolves.toEqual(first);
  });

  it("canonicalizes object-key order without changing content identity", async () => {
    const content = validContent();
    const reordered = {
      validation: { ...content.validation },
      cost: { ...content.cost },
      output: { ...content.output },
      proofs: { ...content.proofs },
      inventory: { ...content.inventory },
      baker: { ...content.baker },
      state: { ...content.state },
      source: {
        basisSha256: content.source.basisSha256,
        neutralRecipeSha256: content.source.neutralRecipeSha256,
        definitionSha256: content.source.definitionSha256,
        manifestSha256: content.source.manifestSha256,
        modelSha256: content.source.modelSha256,
        packageSha256: content.source.packageSha256,
        revision: content.source.revision,
        revisionId: content.source.revisionId,
      },
      contract: content.contract,
    };

    expect(canonicalGoonLiveBuildReceiptContent(reordered)).toBe(
      canonicalGoonLiveBuildReceiptContent(content),
    );
    await expect(goonLiveBuildReceiptSha256(reordered)).resolves.toBe(
      await goonLiveBuildReceiptSha256(content),
    );
  });

  it("hashes only validated deterministic content, never the receipt hash itself", async () => {
    const receipt = await createGoonLiveBuildReceipt(validContent());
    expect(await goonLiveBuildReceiptSha256(receipt)).toBe(
      receipt.receiptSha256,
    );
    expect(
      await goonLiveBuildReceiptSha256({
        ...receipt,
        receiptSha256: hash("f"),
      }),
    ).toBe(receipt.receiptSha256);
  });

  it.each(["createdAt", "jobId", "status"])(
    "rejects transient or unknown %s data",
    (key) => {
      const value = { ...validContent(), [key]: "transient" };
      expect(() => parseGoonLiveBuildReceiptContent(value)).toThrow(
        /must contain exactly/,
      );
    },
  );

  it("rejects missing and unknown nested identity fields", () => {
    const missingSource = validContent() as GoonLiveBuildReceiptContent & {
      source: Record<string, unknown>;
    };
    delete missingSource.source.modelSha256;

    const extraBaker = validContent() as GoonLiveBuildReceiptContent & {
      baker: Record<string, unknown>;
    };
    extraBaker.baker.buildHost = "local";

    expect(() => parseGoonLiveBuildReceiptContent(missingSource)).toThrow(
      /source must contain exactly/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(extraBaker)).toThrow(
      /baker must contain exactly/,
    );
  });

  it("rejects wrong contract identities and malformed hashes", () => {
    const wrongContract = validContent() as GoonLiveBuildReceiptContent & {
      contract: string;
    };
    wrongContract.contract = "goon-live-build/v2";
    const uppercaseHash = validContent();
    uppercaseHash.source.packageSha256 = hash("a").toUpperCase();

    expect(() => parseGoonLiveBuildReceiptContent(wrongContract)).toThrow(
      /must equal goon-live-build\/v1/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(uppercaseHash)).toThrow(
      /lowercase SHA-256/,
    );
  });

  it("requires sorted, unique, disjoint keep/remove inventories", () => {
    const unsorted = validContent();
    unsorted.inventory.kept = [
      "node:hips",
      "morph:blink",
      "morph:corrective-knee",
    ];
    const duplicate = validContent();
    duplicate.inventory.removed = [
      "morph:identity-height",
      "morph:identity-height",
    ];
    const overlap = validContent();
    overlap.inventory.removed = [
      "manifest:/appearanceDials",
      "node:/Body/morph:/blink",
    ];
    const missingRetained = validContent();
    missingRetained.inventory.retainedDynamicMorphs = [
      "node:/Body/morph:/not-kept",
    ];
    const categoryOverlap = validContent();
    categoryOverlap.inventory.retainedCorrectiveMorphs = [
      "node:/Body/morph:/blink",
    ];
    const missingAppearanceRemoval = validContent();
    missingAppearanceRemoval.inventory.removed = ["morph:identity-height"];
    const incompleteLiveInventory = validContent();
    incompleteLiveInventory.inventory.liveMorphTargets =
      incompleteLiveInventory.inventory.liveMorphTargets.slice(1);

    expect(() => parseGoonLiveBuildReceiptContent(unsorted)).toThrow(
      /must be sorted/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(duplicate)).toThrow(
      /must be sorted/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(overlap)).toThrow(
      /both kept and removed/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(missingRetained)).toThrow(
      /retained but absent from liveMorphTargets/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(categoryOverlap)).toThrow(
      /cannot be both dynamic and corrective/,
    );
    expect(() =>
      parseGoonLiveBuildReceiptContent(missingAppearanceRemoval),
    ).toThrow(/must include manifest:\/appearanceDials/);
    expect(() =>
      parseGoonLiveBuildReceiptContent(incompleteLiveInventory),
    ).toThrow(/absent from liveMorphTargets|must exactly inventory/);
  });

  it("requires zero Recipe morphs and matching retained morph counts", () => {
    const recipeMorph = validContent() as unknown as {
      output: { counts: { recipeMorphTargets: number } };
    };
    recipeMorph.output.counts.recipeMorphTargets = 1;
    const mismatched = validContent();
    mismatched.output.counts.dynamicMorphTargets = 0;

    expect(() => parseGoonLiveBuildReceiptContent(recipeMorph)).toThrow(
      /must be exactly 0/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(mismatched)).toThrow(
      /inventories do not match output counts/,
    );
  });

  it("enforces finite validation metrics and the locked strict tolerances", () => {
    const nonFinite = validContent();
    nonFinite.validation.maxJointErrorMeters = Number.NaN;
    const overTolerance = validContent();
    overTolerance.validation.maxRotationErrorRadians =
      GOON_LIVE_BUILD_TOLERANCES.rotationRadians + Number.EPSILON;
    const overWeightTolerance = validContent();
    overWeightTolerance.validation.maxWeightScalarError =
      GOON_LIVE_BUILD_TOLERANCES.weightScalar + Number.EPSILON;
    const invalidRms = validContent();
    invalidRms.validation.maxFinalPositionErrorMeters = 2e-7;
    invalidRms.validation.rmsFinalPositionErrorMeters = 3e-7;

    expect(() => parseGoonLiveBuildReceiptContent(nonFinite)).toThrow(
      /numbers must be finite/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(overTolerance)).toThrow(
      /finite number between 0 and 0\.000001/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(overWeightTolerance)).toThrow(
      /finite number between 0 and 1e-7/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(invalidRms)).toThrow(
      /may not exceed maxFinalPositionErrorMeters/,
    );
  });

  it("rejects invalid byte sizes and non-integer counts", () => {
    const zeroBytes = validContent();
    zeroBytes.output.model.bytes = 0;
    const fractionalCount = validContent();
    fractionalCount.output.counts.vertices = 1.5;

    expect(() => parseGoonLiveBuildReceiptContent(zeroBytes)).toThrow(
      /output\.model\.bytes must be a safe integer >= 1/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(fractionalCount)).toThrow(
      /counts\.vertices must be a safe integer >= 0/,
    );
  });

  it("requires versioned state identity and distinct source/output assets", () => {
    const unversionedState = validContent();
    unversionedState.state.contract = "recipe-state";
    const duplicateSourceHash = validContent();
    duplicateSourceHash.source.modelSha256 =
      duplicateSourceHash.source.packageSha256;
    const duplicateOutputHash = validContent();
    duplicateOutputHash.output.manifest.sha256 =
      duplicateOutputHash.output.model.sha256;

    expect(() => parseGoonLiveBuildReceiptContent(unversionedState)).toThrow(
      /must be a versioned contract id/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(duplicateSourceHash)).toThrow(
      /source package, model, and manifest hashes must be distinct/,
    );
    expect(() => parseGoonLiveBuildReceiptContent(duplicateOutputHash)).toThrow(
      /output package, model, and manifest hashes must be distinct/,
    );
  });

  it("rejects tampering after receipt creation", async () => {
    const receipt = await createGoonLiveBuildReceipt(validContent());
    receipt.source.revision = 8;

    await expect(verifyGoonLiveBuildReceipt(receipt)).rejects.toThrow(
      /receiptSha256 mismatch/,
    );
  });
});
