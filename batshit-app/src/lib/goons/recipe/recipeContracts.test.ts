import { describe, expect, it } from "vitest";
import { RECIPE_MIGRATION_REPORT_CONTRACT } from "./contractIds";
import { GOON_LIVE_BUILD_CONTRACT } from "./liveBuildContracts";
import { RECIPE_SOURCE_CONTRACT } from "./packageMetadata";
import {
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_STATE_CONTRACT,
  parseGoonRecipe,
  parseRecipeAuthoringRevision,
  parseRecipeRevisionBundle,
  recipeAuthoringRevisionSha256,
  recipeRevisionBundleSha256,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  verifyGoonRecipe,
} from "./recipeContracts";

const sha = (character: string) => character.repeat(64);

function hashCharacter(recipeRevision: number, offset: number): string {
  return "0123456789abcdef"[(recipeRevision * 5 + offset) % 16];
}

function documentRef(contract: string, suffix: string, hashCharacter: string) {
  return {
    contract,
    ref: `recipe-documents/${suffix}.json`,
    sha256: sha(hashCharacter),
  };
}

function revision(recipeRevision: number) {
  const suffix = String(recipeRevision);
  const packageHash = sha(hashCharacter(recipeRevision, 0));
  const definitionHash = sha(hashCharacter(recipeRevision, 1));
  const neutralHash = sha(hashCharacter(recipeRevision, 2));
  return {
    contract: GOON_RECIPE_REVISION_CONTRACT,
    recipeRevision,
    revisionId: `recipe-revision-${suffix}`,
    revisionSha256: sha(hashCharacter(recipeRevision, 3)),
    source: {
      package: {
        ref: `goons/source-${suffix}.bgoon`,
        sha256: packageHash,
      },
      model: {
        ref: `goons/source-${suffix}.glb`,
        sha256: sha(hashCharacter(recipeRevision, 4)),
      },
      manifest: {
        ref: `goons/source-${suffix}/avatar.json`,
        sha256: sha(hashCharacter(recipeRevision, 5)),
      },
      identities: {
        contract: RECIPE_SOURCE_CONTRACT,
        schemaVersion: 1,
        baseId: "batshit-base-female",
        fitFamily: "batshit-base-female-v1",
        modelSha256: sha(hashCharacter(recipeRevision, 4)),
        manifestSemanticSha256: sha(hashCharacter(recipeRevision, 11)),
        definitionSha256: definitionHash,
        neutralId: `neutral-${suffix}`,
        neutralRecipeSha256: neutralHash,
        physicalBasisSha256: sha("f"),
        behaviorSha256: sha(hashCharacter(recipeRevision, 6)),
        componentGraphSha256: sha(hashCharacter(recipeRevision, 12)),
        topologySha256: sha("d"),
        skeletonHierarchySha256: sha("e"),
      },
    },
    state: {
      contract: GOON_RECIPE_STATE_CONTRACT,
      stateSha256: sha(hashCharacter(recipeRevision, 7)),
      appearanceDials: {
        contract: "appearance-dial-values/v2",
        definitionSha256: definitionHash,
        neutralId: `neutral-${suffix}`,
        neutralRecipeSha256: neutralHash,
        values: {
          body_height: 0.25,
          body_height_left: -0.125,
        },
        unlockedDialIds: ["body_height"],
      },
      siblings: [
        {
          id: "facial-artwork",
          contract: "facial-artwork-state/v3",
          definitionSha256: sha("4"),
          stateSha256: sha(hashCharacter(recipeRevision, 8)),
          state: {
            schemaVersion: "facial-artwork-state/v3",
            definitionSha256: sha("4"),
            roles: {},
          },
        },
      ],
    },
    liveBuildReceipt: documentRef(
      GOON_LIVE_BUILD_CONTRACT,
      `live-build-${suffix}`,
      hashCharacter(recipeRevision, 9),
    ),
    updateReport:
      recipeRevision === 1
        ? null
        : documentRef(
            RECIPE_MIGRATION_REPORT_CONTRACT,
            `update-${suffix}`,
            hashCharacter(recipeRevision, 10),
          ),
  };
}

function authoringRevision(recipeRevision: number) {
  const successful = revision(recipeRevision);
  const { liveBuildReceipt: _liveBuildReceipt, ...authoring } = successful;
  return {
    ...authoring,
    contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  };
}

function validRecipe() {
  const activeRevision = revision(2);
  return {
    contract: GOON_RECIPE_CONTRACT,
    recipeRevision: 2,
    revisionId: "recipe-revision-2",
    concurrencyToken: sha("9"),
    liveStatus: "up_to_date",
    authoringRevision: authoringRevision(2),
    activeRevision,
    previousRevision: revision(1),
    activeLiveBuildReceipt: structuredClone(activeRevision.liveBuildReceipt),
    pendingJob: null,
    latestUpdateReport: documentRef(
      RECIPE_MIGRATION_REPORT_CONTRACT,
      "latest-update",
      "a",
    ),
    lastFailure: null,
  };
}

function pendingRecipe(liveStatus = "needs_bake") {
  const owner = validRecipe();
  return {
    ...owner,
    recipeRevision: 3,
    revisionId: "recipe-revision-3",
    liveStatus,
    authoringRevision: authoringRevision(3),
  };
}

function activeJob(status: string) {
  return {
    jobId: "recipe-job-3",
    status,
    recipeRevision: 3,
    revisionId: "recipe-revision-3",
    reportRefs: [documentRef("recipe-job-report/v1", "job-3-progress", "b")],
  };
}

function failure() {
  return {
    jobId: "recipe-job-3",
    stage: "verifying",
    reason: "Strict package verification failed.",
    reportRef: documentRef("recipe-job-report/v1", "job-3-failure", "c"),
  };
}

async function hashSuccessfulRevision(candidate: ReturnType<typeof revision>) {
  for (const sibling of candidate.state.siblings) {
    sibling.stateSha256 = await recipeSiblingStateSha256(sibling.state);
  }
  candidate.state.stateSha256 = await recipeStateSnapshotSha256(
    candidate.state,
  );
  candidate.revisionSha256 = await recipeRevisionBundleSha256(candidate);
}

async function verifiableRecipe() {
  const owner = validRecipe();
  await hashSuccessfulRevision(owner.previousRevision);
  await hashSuccessfulRevision(owner.activeRevision);
  owner.activeLiveBuildReceipt = structuredClone(
    owner.activeRevision.liveBuildReceipt,
  );
  owner.authoringRevision = {
    ...structuredClone(owner.activeRevision),
    contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  } as ReturnType<typeof authoringRevision>;
  delete (owner.authoringRevision as any).liveBuildReceipt;
  owner.authoringRevision.revisionSha256 = await recipeAuthoringRevisionSha256(
    owner.authoringRevision,
  );
  return owner;
}

describe("goon-recipe/v1 contracts", () => {
  it("parses the durable authoring owner and active/previous successful revisions", () => {
    const parsed = parseGoonRecipe(validRecipe());

    expect(parsed.contract).toBe(GOON_RECIPE_CONTRACT);
    expect(parsed.authoringRevision.recipeRevision).toBe(2);
    expect(parsed.activeRevision?.recipeRevision).toBe(2);
    expect(parsed.previousRevision?.recipeRevision).toBe(1);
    expect(parsed.authoringRevision.source.identities.modelSha256).toBe(
      parsed.authoringRevision.source.model.sha256,
    );
    expect(
      parsed.authoringRevision.state.appearanceDials.values.body_height,
    ).toBe(0.25);
    expect(parsed.authoringRevision.state.siblings[0]).toMatchObject({
      id: "facial-artwork",
      contract: "facial-artwork-state/v3",
    });
  });

  it("parses successful and authoring revisions independently", () => {
    expect(parseRecipeRevisionBundle(revision(1)).revisionId).toBe(
      "recipe-revision-1",
    );
    expect(parseRecipeAuthoringRevision(authoringRevision(1)).revisionId).toBe(
      "recipe-revision-1",
    );
  });

  it("rejects unknown fields at every owned wrapper", () => {
    const owner = validRecipe() as any;
    owner.untracked = true;
    expect(() => parseGoonRecipe(owner)).toThrow(
      /recipe contains unsupported fields: untracked/,
    );

    const asset = validRecipe() as any;
    asset.authoringRevision.source.package.filename = "source.bgoon";
    expect(() => parseGoonRecipe(asset)).toThrow(
      /authoringRevision\.source\.package contains unsupported fields: filename/,
    );

    const sibling = validRecipe() as any;
    sibling.authoringRevision.state.siblings[0].legacyPayload = {};
    expect(() => parseGoonRecipe(sibling)).toThrow(
      /unsupported fields: legacyPayload/,
    );
  });

  it("requires canonical source hashes and exact model identity", () => {
    const uppercase = validRecipe() as any;
    uppercase.authoringRevision.source.model.sha256 = sha("A");
    expect(() => parseGoonRecipe(uppercase)).toThrow(
      /must be a lowercase SHA-256/,
    );

    const mismatchedModel = validRecipe() as any;
    mismatchedModel.authoringRevision.source.identities.modelSha256 = sha("0");
    expect(() => parseGoonRecipe(mismatchedModel)).toThrow(
      /modelSha256 must match model\.sha256/,
    );

    const reusedRef = validRecipe() as any;
    reusedRef.authoringRevision.source.model.ref =
      reusedRef.authoringRevision.source.package.ref;
    expect(() => parseGoonRecipe(reusedRef)).toThrow(/refs must be distinct/);
  });

  it("binds Appearance values to the exact source definition and neutral identities", () => {
    const definitionMismatch = validRecipe() as any;
    definitionMismatch.authoringRevision.state.appearanceDials.definitionSha256 =
      sha("0");
    expect(() => parseGoonRecipe(definitionMismatch)).toThrow(
      /Appearance definition identity does not match Recipe Source/,
    );

    const neutralMismatch = validRecipe() as any;
    neutralMismatch.authoringRevision.state.appearanceDials.neutralRecipeSha256 =
      sha("0");
    expect(() => parseGoonRecipe(neutralMismatch)).toThrow(
      /Appearance neutral Recipe identity does not match Recipe Source/,
    );

    const wrongContract = validRecipe() as any;
    wrongContract.authoringRevision.state.appearanceDials.contract =
      "appearance-dial-values/v1";
    expect(() => parseGoonRecipe(wrongContract)).toThrow(
      /contract must equal appearance-dial-values\/v2/,
    );
  });

  it("rejects unsafe Appearance values and unlock records instead of pruning or clamping", () => {
    const nonFinite = validRecipe() as any;
    nonFinite.authoringRevision.state.appearanceDials.values.body_height =
      Number.NaN;
    expect(() => parseGoonRecipe(nonFinite)).toThrow(
      /body_height: numbers must be finite/,
    );

    const unknownUnlock = validRecipe() as any;
    unknownUnlock.authoringRevision.state.appearanceDials.unlockedDialIds = [
      "missing_dial",
    ];
    expect(() => parseGoonRecipe(unknownUnlock)).toThrow(
      /contains unknown dial missing_dial/,
    );

    const duplicateUnlock = validRecipe() as any;
    duplicateUnlock.authoringRevision.state.appearanceDials.unlockedDialIds = [
      "body_height",
      "body_height",
    ];
    expect(() => parseGoonRecipe(duplicateUnlock)).toThrow(
      /must not contain duplicates/,
    );
  });

  it("keeps sibling state extensible only through exact versioned and hashed wrappers", () => {
    const mismatchedContract = validRecipe() as any;
    mismatchedContract.authoringRevision.state.siblings[0].state.schemaVersion =
      "facial-artwork-state/v2";
    expect(() => parseGoonRecipe(mismatchedContract)).toThrow(
      /state must declare the same versioned contract/,
    );

    const unversioned = validRecipe() as any;
    unversioned.authoringRevision.state.siblings[0].contract =
      "facial-artwork-state";
    expect(() => parseGoonRecipe(unversioned)).toThrow(
      /must be a versioned contract id/,
    );

    const duplicate = validRecipe() as any;
    duplicate.authoringRevision.state.siblings.push(
      structuredClone(duplicate.authoringRevision.state.siblings[0]),
    );
    expect(() => parseGoonRecipe(duplicate)).toThrow(
      /must not contain duplicate ids/,
    );
  });

  it("retains successful revisions relative to the active revision, not pending authoring work", () => {
    const parsed = parseGoonRecipe(pendingRecipe());
    expect(parsed.authoringRevision.recipeRevision).toBe(3);
    expect(parsed.activeRevision?.recipeRevision).toBe(2);
    expect(parsed.previousRevision?.recipeRevision).toBe(1);

    const staleOwner = validRecipe() as any;
    staleOwner.revisionId = "recipe-revision-stale";
    expect(() => parseGoonRecipe(staleOwner)).toThrow(
      /authoring revision identity must match the owner/,
    );

    const gap = pendingRecipe() as any;
    gap.previousRevision.recipeRevision = 3;
    expect(() => parseGoonRecipe(gap)).toThrow(
      /previous revision must be exactly active revision minus one/,
    );

    const reusedIdentity = pendingRecipe() as any;
    reusedIdentity.revisionId = "recipe-revision-2";
    reusedIdentity.authoringRevision.revisionId = "recipe-revision-2";
    expect(() => parseGoonRecipe(reusedIdentity)).toThrow(
      /must have a new immutable revision id/,
    );
  });

  it("represents a first bake without inventing an active Live revision", () => {
    const firstBake = {
      ...validRecipe(),
      recipeRevision: 1,
      revisionId: "recipe-revision-1",
      liveStatus: "needs_bake",
      authoringRevision: authoringRevision(1),
      activeRevision: null,
      previousRevision: null,
      activeLiveBuildReceipt: null,
      latestUpdateReport: null,
    };
    const parsed = parseGoonRecipe(firstBake);
    expect(parsed.activeRevision).toBeNull();
    expect(parsed.activeLiveBuildReceipt).toBeNull();

    const invented = structuredClone(firstBake) as any;
    invented.activeLiveBuildReceipt = documentRef(
      GOON_LIVE_BUILD_CONTRACT,
      "invented",
      "d",
    );
    expect(() => parseGoonRecipe(invented)).toThrow(
      /cannot have a Live-build receipt/,
    );
  });

  it("requires up-to-date authoring state to match the active successful revision", () => {
    const changedState = validRecipe() as any;
    changedState.authoringRevision.state.stateSha256 = sha("0");
    expect(() => parseGoonRecipe(changedState)).toThrow(
      /up_to_date requires the authoring revision to match/,
    );

    const changedSource = validRecipe() as any;
    changedSource.authoringRevision.source.model.ref = "goons/changed.glb";
    expect(() => parseGoonRecipe(changedSource)).toThrow(
      /up_to_date requires the authoring revision to match/,
    );

    const falseDirty = validRecipe() as any;
    falseDirty.liveStatus = "needs_bake";
    expect(() => parseGoonRecipe(falseDirty)).toThrow(/cannot require a bake/);
  });

  it("requires the active Live receipt to match the active successful revision", () => {
    const wrongContract = validRecipe() as any;
    wrongContract.activeLiveBuildReceipt.contract = "goon-live-build/v2";
    expect(() => parseGoonRecipe(wrongContract)).toThrow(
      /contract must equal goon-live-build\/v1/,
    );

    const wrongReceipt = validRecipe() as any;
    wrongReceipt.activeLiveBuildReceipt.sha256 = sha("d");
    expect(() => parseGoonRecipe(wrongReceipt)).toThrow(
      /active Live-build receipt must match the active revision/,
    );
  });

  it("accepts only status-consistent active, failed, and interrupted jobs", () => {
    const building = pendingRecipe("building") as any;
    building.pendingJob = activeJob("baking");
    expect(parseGoonRecipe(building).pendingJob?.status).toBe("baking");

    const failed = pendingRecipe("failed") as any;
    failed.pendingJob = activeJob("failed");
    failed.lastFailure = failure();
    expect(parseGoonRecipe(failed).lastFailure?.stage).toBe("verifying");

    const interrupted = pendingRecipe("interrupted") as any;
    interrupted.pendingJob = activeJob("interrupted");
    interrupted.lastFailure = failure();
    expect(parseGoonRecipe(interrupted).pendingJob?.status).toBe("interrupted");

    const missingJob = pendingRecipe("building") as any;
    expect(() => parseGoonRecipe(missingJob)).toThrow(
      /building requires one active pending job/,
    );
  });

  it("fails closed on stale or asset-bearing pending jobs", () => {
    const stale = pendingRecipe("building") as any;
    stale.pendingJob = activeJob("verifying");
    stale.pendingJob.recipeRevision = 2;
    expect(() => parseGoonRecipe(stale)).toThrow(
      /must target the exact current Recipe revision/,
    );

    const assetBearing = pendingRecipe("building") as any;
    assetBearing.pendingJob = activeJob("packaging");
    assetBearing.pendingJob.package = {
      ref: "goons/candidate.bgoon",
      sha256: sha("e"),
    };
    expect(() => parseGoonRecipe(assetBearing)).toThrow(
      /unsupported fields: package/,
    );

    const terminal = pendingRecipe("building") as any;
    terminal.pendingJob = activeJob("committed");
    expect(() => parseGoonRecipe(terminal)).toThrow(
      /cannot retain a committed or discarded job/,
    );
  });

  it("recomputes sibling, state, authoring, and successful revision hashes", async () => {
    const owner = await verifiableRecipe();
    await expect(verifyGoonRecipe(owner)).resolves.toMatchObject({
      contract: GOON_RECIPE_CONTRACT,
      recipeRevision: 2,
    });

    owner.authoringRevision.state.appearanceDials.values.body_height = 0.5;
    await expect(verifyGoonRecipe(owner)).rejects.toThrow(
      /recipe state hash mismatch/,
    );
  });

  it("rejects accessor-backed and other non-canonical JSON inputs", () => {
    const owner = validRecipe() as any;
    Object.defineProperty(owner.authoringRevision.source, "model", {
      enumerable: true,
      get: () => revision(2).source.model,
    });
    expect(() => parseGoonRecipe(owner)).toThrow(
      /accessor properties are not supported/,
    );
  });
});
