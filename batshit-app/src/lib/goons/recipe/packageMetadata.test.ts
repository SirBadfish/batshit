import { describe, expect, it } from "vitest";
import {
  RECIPE_SOURCE_CONTRACT,
  createRecipeSourceIdentity,
  parseRecipeSourceIdentity,
  recipeManifestSemanticSha256,
  verifyRecipeSourceIdentity,
  verifyRecipeSourceManifest,
} from "./packageMetadata";

const sha = (character: string) => character.repeat(64);

function manifest() {
  return {
    contractVersion: 2,
    name: "Editable label",
    description: "Editable copy",
    appearanceDials: {
      contract: "appearance-dials/v2",
      definitionSha256: sha("1"),
      neutral: {
        id: "sa090-evaluation-neutral-r2",
        recipeSha256: sha("4"),
      },
      dials: [
        {
          id: "head_size",
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          label: "Head Size",
          description: "Presentation copy",
          keywords: ["head"],
          region: "head",
          tier: "core",
          order: 1,
          step: 0.01,
          symmetry: {
            mode: "linked-with-offsets",
            left: {
              id: "head_size_left",
              label: "Left Head Size",
              step: 0.01,
              range: [-1, 1],
              members: [],
            },
            right: {
              id: "head_size_right",
              label: "Right Head Size",
              step: 0.01,
              range: [-1, 1],
              members: [],
            },
          },
        },
      ],
      targets: {
        "identity.head-size": {
          bindings: [{ node: "body", morph: "head-size" }],
          provenance: { reviewStatus: "approved" },
        },
      },
      followers: {
        eyes: {
          drivers: [],
          provenance: { source: "proof" },
        },
      },
      fitEvidence: { reportSha256: sha("a") },
      productResolution: { resolutionSha256: sha("b") },
      evaluation: { candidate: true },
    },
    rig: {
      baseId: "batshit-base-f-v1",
      fitFamily: "batshit-base-f-v1",
      performance: { contract: "batshit-performance-rig/v1" },
      provenance: { exported: "2026-07-16", sourceBlend: "private.blend" },
    },
    facialArtwork: {
      schemaVersion: "facial-artwork/v3",
      roles: ["brow-left"],
      definitionSha256: sha("c"),
      status: "in-development",
      productExportApproved: false,
      ownership: { author: "Batshit" },
      hashContract: { algorithm: "sha256", absolutePathsAllowed: false },
      provenanceContract: { rightsConfirmedMustBe: true },
      topologyFreeze: {
        acceptedInputSha256: sha("5"),
        acceptedProofReportSha256: sha("6"),
        generatorDependencies: [{ id: "generator", sha256: sha("7") }],
        bindingLaw: "stable-runtime-binding",
      },
    },
    eyeAppearance: {
      schemaVersion: "eye-appearance/v1",
      controls: ["iris-color"],
      definitionSha256: sha("d"),
      status: "in-development",
      productExportApproved: false,
      ownership: { author: "Batshit" },
      rangeEvidence: { sha256: sha("e") },
    },
    evaluation: { productExportApproved: false },
  };
}

function input() {
  return {
    baseId: "batshit-base-f-v1",
    fitFamily: "batshit-base-f-v1",
    modelSha256: sha("2"),
    definitionSha256: sha("1"),
    neutralId: "sa090-evaluation-neutral-r2",
    neutralRecipeSha256: sha("4"),
    physicalBasisSha256: sha("5"),
    behaviorSha256: sha("6"),
    componentGraphSha256: sha("7"),
    topologySha256: sha("8"),
    skeletonHierarchySha256: sha("9"),
  };
}

describe("recipe-source/v1 package metadata", () => {
  it("creates and verifies one intrinsic non-circular source identity", async () => {
    const sourceManifest = manifest() as ReturnType<typeof manifest> & {
      recipeSource?: unknown;
    };
    const identity = await createRecipeSourceIdentity(input(), sourceManifest);
    sourceManifest.recipeSource = identity;

    expect(identity.contract).toBe(RECIPE_SOURCE_CONTRACT);
    await expect(
      verifyRecipeSourceManifest(sourceManifest, input().modelSha256),
    ).resolves.toEqual(identity);
  });

  it("keeps presentation, evaluation, provenance, and Recipe wrappers out of semantic identity", async () => {
    const first = manifest() as Record<string, unknown>;
    const second = structuredClone(first) as Record<string, any>;
    second.name = "Renamed";
    second.description = "Different copy";
    second.evaluation = { productExportApproved: true };
    second.rig.provenance = { exported: "tomorrow" };
    second.appearanceDials.dials[0].label = "Cranium Scale";
    second.appearanceDials.dials[0].order = 999;
    second.appearanceDials.dials[0].symmetry.left.label = "Left Cranium";
    second.appearanceDials.dials[0].symmetry.left.step = 0.5;
    second.appearanceDials.dials[0].symmetry.right.label = "Right Cranium";
    second.appearanceDials.dials[0].symmetry.right.step = 0.5;
    second.appearanceDials.targets["identity.head-size"].provenance = {
      reviewStatus: "changed",
    };
    second.appearanceDials.followers.eyes.provenance = { source: "changed" };
    second.appearanceDials.fitEvidence = { reportSha256: sha("f") };
    second.appearanceDials.productResolution = { resolutionSha256: sha("f") };
    second.appearanceDials.evaluation = { candidate: false };
    second.facialArtwork.status = "approved";
    second.facialArtwork.productExportApproved = true;
    second.facialArtwork.topologyFreeze.acceptedInputSha256 = sha("8");
    second.facialArtwork.topologyFreeze.acceptedProofReportSha256 = sha("9");
    second.facialArtwork.topologyFreeze.generatorDependencies[0].sha256 =
      sha("a");
    second.eyeAppearance.status = "approved";
    second.eyeAppearance.rangeEvidence = { sha256: sha("f") };
    second.recipeSource = { transient: true };
    second.recipeUpdates = { transient: true };

    await expect(recipeManifestSemanticSha256(first)).resolves.toBe(
      await recipeManifestSemanticSha256(second),
    );
  });

  it("changes semantic identity when a runtime contract changes", async () => {
    const first = manifest();
    const second = structuredClone(first);
    second.rig.performance.contract = "batshit-performance-rig/v2";

    await expect(recipeManifestSemanticSha256(first)).resolves.not.toBe(
      await recipeManifestSemanticSha256(second),
    );
  });

  it("retains executable facial-artwork contracts and topology laws", async () => {
    const first = manifest();
    const ownership = structuredClone(first);
    ownership.facialArtwork.ownership.author = "Another Owner";
    const hashing = structuredClone(first);
    hashing.facialArtwork.hashContract.algorithm = "sha512";
    const provenance = structuredClone(first);
    provenance.facialArtwork.provenanceContract.rightsConfirmedMustBe = false;
    const topologyLaw = structuredClone(first);
    topologyLaw.facialArtwork.topologyFreeze.bindingLaw = "different-binding";

    const sourceHash = await recipeManifestSemanticSha256(first);
    await expect(recipeManifestSemanticSha256(ownership)).resolves.not.toBe(
      sourceHash,
    );
    await expect(recipeManifestSemanticSha256(hashing)).resolves.not.toBe(
      sourceHash,
    );
    await expect(recipeManifestSemanticSha256(provenance)).resolves.not.toBe(
      sourceHash,
    );
    await expect(recipeManifestSemanticSha256(topologyLaw)).resolves.not.toBe(
      sourceHash,
    );
  });

  it("rejects exact transport hashes inside the embedded source block", async () => {
    const identity = (await createRecipeSourceIdentity(
      input(),
      manifest(),
    )) as any;
    identity.packageSha256 = sha("a");
    expect(() => parseRecipeSourceIdentity(identity)).toThrow(
      /must contain exactly/,
    );
  });

  it("rejects stale model and semantic hashes", async () => {
    const sourceManifest = manifest();
    const identity = await createRecipeSourceIdentity(input(), sourceManifest);

    await expect(
      verifyRecipeSourceIdentity(identity, sourceManifest, sha("a")),
    ).rejects.toThrow(/does not match the exact avatar\.glb bytes/);

    sourceManifest.rig.performance.contract = "batshit-performance-rig/v2";
    await expect(
      verifyRecipeSourceIdentity(identity, sourceManifest, input().modelSha256),
    ).rejects.toThrow(/manifest semantic hash mismatch/);
  });

  it("rejects authoring/Live ambiguity", async () => {
    const missingAuthoring = manifest() as Record<string, unknown>;
    delete missingAuthoring.appearanceDials;
    await expect(
      verifyRecipeSourceManifest(missingAuthoring, input().modelSha256),
    ).rejects.toThrow(/must contain appearanceDials/);

    const live = manifest() as Record<string, unknown>;
    live.liveBuild = { contract: "goon-live-manifest/v1" };
    await expect(
      verifyRecipeSourceManifest(live, input().modelSha256),
    ).rejects.toThrow(/cannot contain liveBuild metadata/);
  });

  it("rejects a source identity that disagrees with explicit manifest identity", async () => {
    const sourceManifest = manifest() as ReturnType<typeof manifest> & {
      recipeSource?: unknown;
    };
    sourceManifest.recipeSource = {
      ...(await createRecipeSourceIdentity(input(), sourceManifest)),
      fitFamily: "another-family",
    };
    await expect(
      verifyRecipeSourceManifest(sourceManifest, input().modelSha256),
    ).rejects.toThrow(/disagrees with authoring manifest identity/);
  });
});
