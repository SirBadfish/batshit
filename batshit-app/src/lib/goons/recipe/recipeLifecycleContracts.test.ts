import { describe, expect, it } from "vitest";
import { RECIPE_MIGRATION_REPORT_CONTRACT } from "./contractIds";
import { GOON_LIVE_BUILD_CONTRACT } from "./liveBuildContracts";
import { RECIPE_SOURCE_CONTRACT } from "./packageMetadata";
import {
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  GOON_RECIPE_REVISION_CONTRACT,
  GOON_RECIPE_STATE_CONTRACT,
  recipeAuthoringRevisionSha256,
  recipeRevisionBundleSha256,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
} from "./recipeContracts";
import {
  GOON_RECIPE_DOCUMENT_CONTRACT,
  GOON_RECIPE_JOB_CONTRACT,
  GOON_RECIPE_OWNER_V2_CONTRACT,
  GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  createGoonRecipeDocument,
  createRecipeRevisionEnvelope,
  parseGoonRecipeJob,
  parseGoonRecipeV2,
  recipeDocumentRedisKey,
  recipeJobRedisKey,
  recipeRevisionRedisKey,
  verifyGoonRecipeDocument,
  verifyRecipeRevisionEnvelope,
} from "./recipeLifecycleContracts";
import { RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT } from "./archiveContainmentContracts";

const sha = (character: string) => character.repeat(64);
const now = "2026-07-17T17:00:00.000Z";

function documentRef(contract: string, ref: string, character: string) {
  return { contract, ref, sha256: sha(character) };
}

function storedAsset(type: string, name: string, character: string, bytes: number) {
  return {
    ref: `/uploads/${type}/${name}`,
    sha256: sha(character),
    bytes,
  };
}

function successfulRevision(recipeRevision: number) {
  const suffix = String(recipeRevision);
  const packageHash = sha(recipeRevision === 1 ? "1" : "2");
  const modelHash = sha(recipeRevision === 1 ? "3" : "4");
  const manifestHash = sha(recipeRevision === 1 ? "5" : "6");
  const definitionHash = sha(recipeRevision === 1 ? "7" : "8");
  const neutralHash = sha(recipeRevision === 1 ? "9" : "a");
  return {
    contract: GOON_RECIPE_REVISION_CONTRACT,
    recipeRevision,
    revisionId: `recipe-revision-${suffix}`,
    revisionSha256: sha("0"),
    source: {
      package: { ref: `goons/source-${suffix}.bgoon`, sha256: packageHash },
      model: { ref: `goons/source-${suffix}.glb`, sha256: modelHash },
      manifest: { ref: `goons/source-${suffix}.json`, sha256: manifestHash },
      identities: {
        contract: RECIPE_SOURCE_CONTRACT,
        schemaVersion: 1,
        baseId: "batshit-base-female",
        fitFamily: "batshit-base-female-v1",
        modelSha256: modelHash,
        manifestSemanticSha256: sha("b"),
        definitionSha256: definitionHash,
        neutralId: `neutral-${suffix}`,
        neutralRecipeSha256: neutralHash,
        physicalBasisSha256: sha("c"),
        behaviorSha256: sha("d"),
        componentGraphSha256: sha("e"),
        topologySha256: sha("f"),
        skeletonHierarchySha256: sha("1"),
      },
    },
    state: {
      contract: GOON_RECIPE_STATE_CONTRACT,
      stateSha256: sha("0"),
      appearanceDials: {
        contract: "appearance-dial-values/v2",
        definitionSha256: definitionHash,
        neutralId: `neutral-${suffix}`,
        neutralRecipeSha256: neutralHash,
        values: { body_height: 0.25 },
        unlockedDialIds: [],
      },
      siblings: [
        {
          id: "facial-artwork",
          contract: "facial-artwork-state/v3",
          definitionSha256: sha("2"),
          stateSha256: sha("0"),
          state: {
            schemaVersion: "facial-artwork-state/v3",
            definitionSha256: sha("2"),
            roles: {},
          },
        },
      ],
    },
    liveBuildReceipt: documentRef(
      GOON_LIVE_BUILD_CONTRACT,
      `goon_recipe_document:user-1:goon-1:${sha("3")}`,
      "3",
    ),
    updateReport:
      recipeRevision === 1
        ? null
        : documentRef(
            RECIPE_MIGRATION_REPORT_CONTRACT,
            `goon_recipe_document:user-1:goon-1:${sha("4")}`,
            "4",
          ),
  };
}

async function verifiedRevision(recipeRevision: number) {
  const revision = successfulRevision(recipeRevision);
  for (const sibling of revision.state.siblings) {
    sibling.stateSha256 = await recipeSiblingStateSha256(sibling.state);
  }
  revision.state.stateSha256 = await recipeStateSnapshotSha256(revision.state);
  revision.revisionSha256 = await recipeRevisionBundleSha256(revision);
  return revision;
}

async function envelope(recipeRevision: number) {
  return createRecipeRevisionEnvelope({
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    revision: await verifiedRevision(recipeRevision),
    sourceContainmentReceipt: documentRef(
      RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
      `goon_recipe_document:user-1:goon-1:${sha("5")}`,
      "5",
    ),
    live: {
      package: storedAsset("goon_custom_packages", `live-${recipeRevision}.bgoon`, "6", 300),
      model: storedAsset("goon_custom_models", `live-${recipeRevision}.glb`, "7", 200),
      manifest: storedAsset("goon_custom_manifests", `live-${recipeRevision}.json`, "8", 100),
    },
  });
}

async function authoringRevision(recipeRevision: number) {
  const revision = await verifiedRevision(recipeRevision);
  const { liveBuildReceipt: _liveBuildReceipt, ...authoring } = revision;
  const result = {
    ...authoring,
    contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
    revisionSha256: sha("0"),
  };
  result.revisionSha256 = await recipeAuthoringRevisionSha256(result);
  return result;
}

async function owner() {
  return {
    contract: GOON_RECIPE_OWNER_V2_CONTRACT,
    writeVersion: 9,
    nextRecipeRevision: 3,
    liveStatus: "up_to_date",
    authoringRevision: await authoringRevision(2),
    activeRevision: documentRef(
      GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      "goon_recipe_revision:user-1:goon-1:recipe-revision-2",
      "9",
    ),
    previousRevision: documentRef(
      GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      "goon_recipe_revision:user-1:goon-1:recipe-revision-1",
      "a",
    ),
    pendingJob: null,
    latestUpdateReport: documentRef(
      RECIPE_MIGRATION_REPORT_CONTRACT,
      `goon_recipe_document:user-1:goon-1:${sha("b")}`,
      "b",
    ),
    lastFailure: null,
    maintenanceFailure: null,
  } as const;
}

function planningJob(source: Awaited<ReturnType<typeof verifiedRevision>>["source"]) {
  return {
    contract: GOON_RECIPE_JOB_CONTRACT,
    userId: "user-1",
    goonId: "goon-1",
    jobId: "job-1",
    idempotencyKey: "package-update-1",
    operation: "package-update",
    status: "planning",
    stateVersion: 1,
    attempt: 1,
    targetWriteVersion: 9,
    targetRecipeRevision: 3,
    targetRevisionId: "recipe-revision-3",
    sourceRevision: documentRef(
      GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      "goon_recipe_revision:user-1:goon-1:recipe-revision-2",
      "9",
    ),
    stagedSource: {
      source,
      containmentReceipt: documentRef(
        RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
        `goon_recipe_document:user-1:goon-1:${sha("5")}`,
        "5",
      ),
    },
    plan: null,
    candidateRevision: null,
    lease: { ownerId: "runtime-1", expiresAt: "2026-07-17T17:05:00.000Z" },
    failure: null,
    cleanupAssets: [
      storedAsset("goon_custom_packages", "source-3.bgoon", "a", 300),
    ],
    createdAt: now,
    updatedAt: now,
  } as const;
}

describe("Recipe R3 lifecycle contracts", () => {
  it("self-hashes immutable revision envelopes that bind exact Live refs", async () => {
    const value = await envelope(2);
    await expect(verifyRecipeRevisionEnvelope(value)).resolves.toEqual(value);

    value.live.model.bytes += 1;
    await expect(verifyRecipeRevisionEnvelope(value)).rejects.toThrow(/mismatch/);
  });

  it("stores content-addressed documents and rejects content tampering", async () => {
    const document = await createGoonRecipeDocument({
      userId: "user-1",
      goonId: "goon-1",
      content: {
        contract: "recipe-job-report/v1",
        status: "ready",
      },
    });
    expect(document.contract).toBe(GOON_RECIPE_DOCUMENT_CONTRACT);
    await expect(verifyGoonRecipeDocument(document)).resolves.toEqual(document);

    document.content.status = "tampered";
    await expect(verifyGoonRecipeDocument(document)).rejects.toThrow(/mismatch/);
  });

  it("keeps rollback activation separate from monotonic write/allocation versions", async () => {
    const current = await owner();
    const rolledBack = {
      ...current,
      writeVersion: 10,
      authoringRevision: await authoringRevision(1),
      activeRevision: current.previousRevision,
      previousRevision: current.activeRevision,
    };
    const parsed = parseGoonRecipeV2(rolledBack);
    expect(parsed.writeVersion).toBe(10);
    expect(parsed.nextRecipeRevision).toBe(3);
    expect(parsed.activeRevision?.ref).toContain("recipe-revision-1");
    expect(parsed.previousRevision?.ref).toContain("recipe-revision-2");
    expect(rolledBack).not.toHaveProperty("concurrencyToken");
  });

  it("represents a verified ready candidate as building without an active lease", async () => {
    const current = await owner();
    const revision = await verifiedRevision(3);
    const job = {
      ...planningJob(revision.source),
      status: "ready" as const,
      lease: null,
      plan: documentRef(
        "recipe-migration-plan/v1",
        `goon_recipe_document:user-1:goon-1:${sha("c")}`,
        "c",
      ),
      candidateRevision: documentRef(
        GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
        "goon_recipe_revision:user-1:goon-1:recipe-revision-3",
        "d",
      ),
    };
    const parsedJob = parseGoonRecipeJob(job);
    const parsedOwner = parseGoonRecipeV2({
      ...current,
      liveStatus: "building",
      pendingJob: {
        jobId: job.jobId,
        jobRef: recipeJobRedisKey(job.userId, job.goonId, job.jobId),
        status: job.status,
        operation: job.operation,
        targetWriteVersion: current.writeVersion,
        targetRecipeRevision: job.targetRecipeRevision,
        targetRevisionId: job.targetRevisionId,
      },
    });
    expect(parsedJob.status).toBe("ready");
    expect(parsedOwner.pendingJob?.status).toBe("ready");
  });

  it("requires leases, failures, and candidate refs at their exact job stages", async () => {
    const revision = await verifiedRevision(3);
    const valid = planningJob(revision.source);
    expect(parseGoonRecipeJob(valid).lease?.ownerId).toBe("runtime-1");

    expect(() => parseGoonRecipeJob({ ...valid, lease: null })).toThrow(
      /must exist exactly while a runner owns an active stage/,
    );
    expect(() =>
      parseGoonRecipeJob({
        ...valid,
        status: "failed",
        lease: null,
        failure: null,
      }),
    ).toThrow(/must exist exactly for failed or interrupted work/);
    expect(() =>
      parseGoonRecipeJob({
        ...valid,
        status: "ready",
        lease: null,
      }),
    ).toThrow(/candidateRevision is required/);
  });

  it("requires terminal jobs to release cleanup refs", async () => {
    const revision = await verifiedRevision(3);
    const valid = planningJob(revision.source);
    expect(() =>
      parseGoonRecipeJob({
        ...valid,
        status: "discarded",
        lease: null,
      }),
    ).toThrow(/must be empty after a terminal transition/);
  });

  it("builds user-remappable deterministic Redis keys", () => {
    expect(recipeJobRedisKey("user-1", "goon-1", "job-1")).toBe(
      "goon_recipe_job:user-1:goon-1:job-1",
    );
    expect(recipeDocumentRedisKey("user-1", "goon-1", sha("a"))).toBe(
      `goon_recipe_document:user-1:goon-1:${sha("a")}`,
    );
    expect(recipeRevisionRedisKey("user-1", "goon-1", "revision-1")).toBe(
      "goon_recipe_revision:user-1:goon-1:revision-1",
    );
  });
});
