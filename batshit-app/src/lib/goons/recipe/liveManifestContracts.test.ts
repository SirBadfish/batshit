import { describe, expect, it } from "vitest";
import {
  GOON_LIVE_BUILD_CONTRACT,
  createGoonLiveBuildReceipt,
  type GoonLiveBuildReceipt,
  type GoonLiveBuildReceiptContent,
} from "./liveBuildContracts";
import {
  GOON_LIVE_MANIFEST_CONTRACT,
  canonicalGoonLiveManifestContent,
  createGoonLiveManifest,
  goonLiveManifestProvenanceSha256,
  parseGoonLiveManifest,
  parseGoonLiveManifestContent,
  parseGoonLiveManifestFromAvatarManifest,
  verifyGoonLiveAvatarManifestAgainstReceipt,
  verifyGoonLiveManifest,
  verifyGoonLiveManifestAgainstReceipt,
  type GoonLiveManifest,
  type GoonLiveManifestContent,
} from "./liveManifestContracts";

const hash = (hexCharacter: string): string => hexCharacter.repeat(64);

function validManifestContent(): GoonLiveManifestContent {
  const liveMorphTargets = [
    "node:/Body/morph:/blink",
    "node:/Body/morph:/corrective-knee",
    "node:/Body/morph:/expression-happy",
  ];
  return {
    contract: GOON_LIVE_MANIFEST_CONTRACT,
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
      kept: [...liveMorphTargets, "node:/hips"],
      removed: ["manifest:/appearanceDials", "morph:identity-height"],
      liveMorphTargets,
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
    },
    counts: {
      meshes: 3,
      vertices: 12_000,
      nodes: 84,
      bones: 63,
      morphTargets: liveMorphTargets.length,
      dynamicMorphTargets: 1,
      correctiveMorphTargets: 1,
      recipeMorphTargets: 0,
    },
  };
}

function cloneManifestContent(): GoonLiveManifestContent {
  return structuredClone(validManifestContent());
}

async function receiptFor(
  manifest: GoonLiveManifest,
  mutate?: (content: GoonLiveBuildReceiptContent) => void,
): Promise<GoonLiveBuildReceipt> {
  const content: GoonLiveBuildReceiptContent = {
    contract: GOON_LIVE_BUILD_CONTRACT,
    source: structuredClone(manifest.source),
    state: structuredClone(manifest.state),
    baker: structuredClone(manifest.baker),
    inventory: structuredClone(manifest.inventory),
    proofs: {
      ...structuredClone(manifest.proofs),
      liveManifestProvenanceSha256: manifest.provenanceSha256,
    },
    output: {
      package: { sha256: hash("a"), bytes: 10_000 },
      model: { sha256: hash("b"), bytes: 8_000 },
      manifest: { sha256: hash("c"), bytes: 2_000 },
      counts: structuredClone(manifest.counts),
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
  mutate?.(content);
  return createGoonLiveBuildReceipt(content);
}

describe("goon-live-manifest/v1", () => {
  it("creates, parses, and verifies deterministic self-hashed provenance", async () => {
    const first = await createGoonLiveManifest(validManifestContent());
    const second = await createGoonLiveManifest(cloneManifestContent());

    expect(first).toEqual(second);
    expect(first.provenanceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parseGoonLiveManifest(first)).toEqual(first);
    await expect(verifyGoonLiveManifest(first)).resolves.toEqual(first);
    expect(await goonLiveManifestProvenanceSha256(first)).toBe(
      first.provenanceSha256,
    );
  });

  it("canonicalizes key order and hashes only the embedded content", async () => {
    const content = validManifestContent();
    const reordered = {
      counts: { ...content.counts },
      proofs: { ...content.proofs },
      inventory: { ...content.inventory },
      baker: { ...content.baker },
      state: { ...content.state },
      source: { ...content.source },
      contract: content.contract,
    };

    expect(canonicalGoonLiveManifestContent(reordered)).toBe(
      canonicalGoonLiveManifestContent(content),
    );
    await expect(goonLiveManifestProvenanceSha256(reordered)).resolves.toBe(
      await goonLiveManifestProvenanceSha256(content),
    );
  });

  it.each([
    "output",
    "receiptSha256",
    "manifestSha256",
    "packageSha256",
    "createdAt",
    "jobId",
    "status",
  ])("rejects unknown, transient, or circular %s fields", (key) => {
    const value = { ...validManifestContent(), [key]: "forbidden" };
    expect(() => parseGoonLiveManifestContent(value)).toThrow(
      /must contain exactly/,
    );
  });

  it("rejects the receipt-only manifest provenance proof from the embedded block", () => {
    const value = validManifestContent() as GoonLiveManifestContent & {
      proofs: Record<string, unknown>;
    };
    value.proofs.liveManifestProvenanceSha256 = hash("0");
    expect(() => parseGoonLiveManifestContent(value)).toThrow(
      /proofs must contain exactly/,
    );
  });

  it("requires complete, sorted, disjoint, fully-qualified Live morph inventory", () => {
    const unsorted = cloneManifestContent();
    unsorted.inventory.liveMorphTargets.reverse();
    const malformed = cloneManifestContent();
    malformed.inventory.liveMorphTargets[0] = "morph:/blink";
    const overlap = cloneManifestContent();
    overlap.inventory.removed.push("node:/hips");
    const incomplete = cloneManifestContent();
    incomplete.inventory.liveMorphTargets.pop();
    const missingAuthoringRemoval = cloneManifestContent();
    missingAuthoringRemoval.inventory.removed = ["morph:identity-height"];

    expect(() => parseGoonLiveManifestContent(unsorted)).toThrow(/sorted/);
    expect(() => parseGoonLiveManifestContent(malformed)).toThrow(
      /fully-qualified/,
    );
    expect(() => parseGoonLiveManifestContent(overlap)).toThrow(
      /both kept and removed/,
    );
    expect(() => parseGoonLiveManifestContent(incomplete)).toThrow(
      /absent from liveMorphTargets|must exactly inventory/,
    );
    expect(() => parseGoonLiveManifestContent(missingAuthoringRemoval)).toThrow(
      /must include manifest:\/appearanceDials/,
    );
  });

  it("requires zero Recipe morphs and exact inventory/count parity", () => {
    const recipeMorph = cloneManifestContent() as unknown as {
      counts: { recipeMorphTargets: number };
    };
    recipeMorph.counts.recipeMorphTargets = 1;
    const wrongTotal = cloneManifestContent();
    wrongTotal.counts.morphTargets += 1;
    const wrongDynamic = cloneManifestContent();
    wrongDynamic.counts.dynamicMorphTargets = 0;

    expect(() => parseGoonLiveManifestContent(recipeMorph)).toThrow(
      /must be exactly 0/,
    );
    expect(() => parseGoonLiveManifestContent(wrongTotal)).toThrow(
      /inventories do not match counts/,
    );
    expect(() => parseGoonLiveManifestContent(wrongDynamic)).toThrow(
      /inventories do not match counts/,
    );
  });

  it("rejects authoring controls and requires avatar.json#liveBuild", async () => {
    const liveBuild = await createGoonLiveManifest(validManifestContent());
    expect(
      parseGoonLiveManifestFromAvatarManifest({
        name: "Synthetic Live Goon",
        rig: { contract: "synthetic-rig/v1" },
        liveBuild,
      }),
    ).toEqual(liveBuild);

    expect(() =>
      parseGoonLiveManifestFromAvatarManifest({
        liveBuild,
        appearanceDials: null,
      }),
    ).toThrow(/appearanceDials.*must be absent/);
    expect(() =>
      parseGoonLiveManifestFromAvatarManifest({ liveBuild, dials: null }),
    ).toThrow(/dials.*must be absent/);
    expect(() =>
      parseGoonLiveManifestFromAvatarManifest({ name: "nope" }),
    ).toThrow(/liveBuild.*required/);
  });

  it("verifies the exact embedded projection against the external receipt", async () => {
    const manifest = await createGoonLiveManifest(validManifestContent());
    const receipt = await receiptFor(manifest);
    const avatarManifest = {
      name: "Synthetic Live Goon",
      liveBuild: manifest,
    };

    await expect(
      verifyGoonLiveManifestAgainstReceipt(manifest, receipt),
    ).resolves.toEqual(manifest);
    await expect(
      verifyGoonLiveAvatarManifestAgainstReceipt(avatarManifest, receipt),
    ).resolves.toEqual(manifest);
  });

  it("rejects a mismatched external provenance link", async () => {
    const manifest = await createGoonLiveManifest(validManifestContent());
    const receipt = await receiptFor(manifest, (content) => {
      content.proofs.liveManifestProvenanceSha256 = hash("f");
    });

    await expect(
      verifyGoonLiveManifestAgainstReceipt(manifest, receipt),
    ).rejects.toThrow(/does not match.*liveManifestProvenanceSha256/);
  });

  it("rejects any receipt projection mismatch even with a matching link", async () => {
    const manifest = await createGoonLiveManifest(validManifestContent());
    const receipt = await receiptFor(manifest, (content) => {
      content.source.revision = 8;
    });

    await expect(
      verifyGoonLiveManifestAgainstReceipt(manifest, receipt),
    ).rejects.toThrow(/projection does not match/);
  });

  it("rejects self-hash tampering and cyclic embedded content", async () => {
    const manifest = await createGoonLiveManifest(validManifestContent());
    manifest.source.revision = 8;
    await expect(verifyGoonLiveManifest(manifest)).rejects.toThrow(
      /provenanceSha256 mismatch/,
    );

    const cyclic = validManifestContent() as unknown as Record<string, unknown>;
    cyclic.cycle = cyclic;
    expect(() => parseGoonLiveManifestContent(cyclic)).toThrow(/cyclic/);
  });
});
