import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

vi.mock("../goonRecipeRepository.server", () => ({
  getOwnedRecipeGoon: vi.fn().mockResolvedValue({}),
}));

import { useRedisTestServer } from "$lib/test-utils/redis-memory";
import { redis } from "$lib/server/redis";
import {
  HAIR_REFIT_SOURCE_CONTRACT,
  collectHairAssetFileRefs,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  hairMaterialDefinitionSha256,
} from "$lib/goons/hairAssets";
import {
  createHairAssetFixture,
  createRigidHairGlbFixture,
} from "$lib/goons/recipe/fixtures/hairAssetFixture";
import { RECIPE_SOURCE_CONTRACT } from "$lib/goons/recipe/packageMetadata";
import type { RecipeSource } from "$lib/goons/recipe/recipeContracts";
import { sha256Hex } from "$lib/goons/recipe/recipeCanonical";

import {
  createHairImportJob,
  getHairImportJobForCleanup,
  hairImportJobIndexKey,
  hairImportJobRedisKey,
} from "../hairImportJobRepository.server";
import {
  beginHairImport,
  beginHairRefit,
  pruneDiscardableHairImportJobs,
  resolveHairImportCandidateFileTransition,
} from "../hairImportLifecycle.server";

const ZERO = "0".repeat(64);
const recipeSource = {
  identities: {
    contract: RECIPE_SOURCE_CONTRACT,
    schemaVersion: 1,
    baseId: "batshit-base-female",
    fitFamily: "batshit-base-female-v1",
    modelSha256: "1".repeat(64),
    manifestSemanticSha256: "2".repeat(64),
    definitionSha256: "3".repeat(64),
    neutralId: "neutral",
    neutralRecipeSha256: "4".repeat(64),
    physicalBasisSha256: "5".repeat(64),
    behaviorSha256: "6".repeat(64),
    componentGraphSha256: "7".repeat(64),
    topologySha256: "8".repeat(64),
    skeletonHierarchySha256: "9".repeat(64),
  },
} as RecipeSource;

const source = {
  uploadType: "goon_hair_imports" as const,
  filename: "expired-source.obj",
  originalName: "finished-hair.obj",
  ref: "/uploads/goon_hair_imports/expired-source.obj",
  sha256: "a".repeat(64),
  bytes: 128,
  mimeType: "text/plain",
};

const inspectionPreview = {
  uploadType: "goon_hair_imports" as const,
  filename: "inspection-preview.glb",
  ref: "/uploads/goon_hair_imports/inspection-preview.glb",
  sha256: "b".repeat(64),
  bytes: 512,
  mimeType: "model/gltf-binary",
};

describe("Hair import lifecycle cleanup", () => {
  useRedisTestServer();

  beforeEach(() => {
    vi.stubEnv("BATSHIT_TOKEN", "hair-import-cleanup-test-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps a content-addressed candidate file reused by the next preview", () => {
    const sharedMask = {
      ...inspectionPreview,
      filename: "shared-highlight.png",
      ref: "/uploads/goon_hair_assets/shared-highlight.png",
      sha256: "e".repeat(64),
      mimeType: "image/png",
    };
    const replacedGeometry = {
      ...inspectionPreview,
      filename: "old-hair.glb",
      ref: "/uploads/goon_hair_assets/old-hair.glb",
    };
    const nextGeometry = {
      ...inspectionPreview,
      filename: "new-hair.glb",
      ref: "/uploads/goon_hair_assets/new-hair.glb",
    };

    const transition = resolveHairImportCandidateFileTransition({
      source,
      previousFiles: [replacedGeometry, sharedMask],
      createdFiles: [nextGeometry, sharedMask],
    });

    expect(transition.obsoletePreviousFiles).toEqual([replacedGeometry]);
    expect(transition.cleanupFiles.map((file) => file.ref)).toEqual([
      source.ref,
      replacedGeometry.ref,
      nextGeometry.ref,
      sharedMask.ref,
    ]);
  });

  it("stages one canonical all-object GLB for immediate visual inspection", async () => {
    const uploadedNames: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        uploadedNames.push(file.name);
        if (file.name === "inspection-preview.glb") {
          expect(
            new TextDecoder().decode(
              new Uint8Array(await file.arrayBuffer()).subarray(0, 4),
            ),
          ).toBe("glTF");
        }
        return new Response(
          JSON.stringify({
            file: {
              filename: `${uploadedNames.length}-${file.name}`,
              sha256: (uploadedNames.length === 1 ? "c" : "d").repeat(64),
              size: file.size,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const obj = [
      "o tripo_part_0",
      "v 0 0 0",
      "v 1 0 0",
      "v 0 1 0",
      "f 1 2 3",
      "o tripo_part_1",
      "v 0 0 1",
      "v 1 0 1",
      "v 0 1 1",
      "f 4 5 6",
    ].join("\n");

    const result = await beginHairImport({
      userId: "preview-user",
      goonId: "preview-goon",
      fileName: "tripo.glb.obj",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode(obj),
    });

    expect(uploadedNames).toEqual(["tripo.glb.obj", "inspection-preview.glb"]);
    expect(result.inspection).toMatchObject({
      previewGeometryUrl: "/uploads/goon_hair_imports/2-inspection-preview.glb",
      objects: [
        { id: "object-0001", name: "tripo_part_0", recommendedHair: true },
        { id: "object-0002", name: "tripo_part_1", recommendedHair: true },
      ],
    });
    expect(result.job.cleanupFiles).toHaveLength(2);
  });

  it("uses a recognized AHS sidecar for the deterministic starting fit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        const bytes = new Uint8Array(await file.arrayBuffer());
        return new Response(
          JSON.stringify({
            file: {
              filename: `staged-${file.name}`,
              sha256: await sha256Hex(bytes),
              size: bytes.byteLength,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const geometry = new TextEncoder().encode(`# Anime Hair Studio mesh and center-curve export
o Bang
v -1 0 0
v 1 0 0
v 0 2 0
f 1 2 3
o Bang_curve
v 0 0 0
v 0 2 0
l 4 5
o Side
v -0.5 0 0
v 0.5 0 0
v 0 1 0
f 6 7 8
o Side_curve
v 0 0 0
v 0 1 0
l 9 10
`);
    const calibrationBytes = new Uint8Array(
      await readFile(
        path.resolve(
          process.cwd(),
          "../docs/user-docs/user-templates/batshit-anime-hair-studio/Batshit-Base-Female-Hair-Template-v1.ahs",
        ),
      ),
    );

    const result = await beginHairImport({
      userId: "ahs-user",
      goonId: "ahs-goon",
      fileName: "studio-hair.obj",
      mimeType: "text/plain",
      bytes: geometry,
      calibrationFileName: "Batshit-Base-Female-Hair-Template-v1.ahs",
      calibrationBytes,
    });

    expect(result.inspection).toMatchObject({
      sourceModeLabel: "Anime Hair Studio / Batshit template",
      proposedTransform: {
        move: {
          x: -0.000001000000000001,
          y: 1.5027458333333332,
          z: 0.04487804761904763,
        },
        uniformScale: 0.06499761904761901,
      },
    });
    expect(result.job.calibration).toMatchObject({
      recognition: "batshit-template",
      sourceCalibration: { mode: "registered-template/v1" },
    });
    expect(result.inspection.notices).toEqual([
      "Recognized the Batshit Base Female Anime Hair Studio template. Batshit applied its registered deterministic starting fit.",
      "line-helper records are authoring-only and cannot enter canonical Hair geometry.",
    ]);
  });

  it("reopens a sanitized source at the saved fit and reserves the next immutable revision", async () => {
    const hairBytes = createRigidHairGlbFixture();
    const asset = await createHairAssetFixture({
      recipeSource,
      mainBytes: hairBytes,
      headNode: "head",
      sourceClass: "user",
    });
    for (const ref of collectHairAssetFileRefs(asset)) {
      ref.ref = `/uploads/goon_hair_assets/${ref.ref.split("/").at(-1)}`;
    }
    const refitSource = {
      contract: HAIR_REFIT_SOURCE_CONTRACT,
      assetId: asset.assetId,
      revisionId: asset.revisionId,
      source: structuredClone(asset.geometry.main),
      startingTransform: {
        move: { x: 0, y: 1.48, z: 0.04 },
        rotate: { x: 0, y: 0, z: 0 },
        uniformScale: 0.5,
        axisScale: { x: 1, y: 1, z: 1 },
      },
      savedTransform: {
        move: { x: 0, y: 1.65, z: 0.04 },
        rotate: { x: 0, y: -90, z: 0 },
        uniformScale: 0.27,
        axisScale: { x: 1.15, y: 1.15, z: 1.01 },
      },
    };
    asset.revisionSha256 = ZERO;
    asset.material.definitionSha256 = await hairMaterialDefinitionSha256(
      asset.material,
    );
    asset.attachment.fitReceipt.assetRevisionSha256 = ZERO;
    asset.attachment.fitReceipt.fitSha256 = ZERO;
    asset.revisionSha256 = await hairAssetRevisionSha256(asset);
    asset.attachment.fitReceipt.assetRevisionSha256 = asset.revisionSha256;
    asset.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(
      asset.attachment.fitReceipt,
    );
    await redis.sAdd(
      "user:refit-user:hair_assets",
      `${asset.assetId}@${asset.revisionId}`,
    );
    await redis.json.set(
      `hair_asset:refit-user:${asset.assetId}:${asset.revisionId}`,
      "$",
      asset,
    );
    await redis.json.set(
      `hair_refit_source:refit-user:${asset.assetId}:${asset.revisionId}`,
      "$",
      refitSource,
    );
    for (const ref of collectHairAssetFileRefs(asset)) {
      const filename = ref.ref.split("/").at(-1)!;
      await redis.json.set(`upload:goon_hair_assets:${filename}`, "$", {
        storage: "filesystem",
        uploadType: "goon_hair_assets",
        relativePath: `goon_hair_assets/${filename}`,
        sha256: ref.sha256,
        size: ref.bytes,
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (
          !init?.method &&
          String(input).endsWith("/uploads/goon_hair_assets/hair.glb")
        ) {
          return new Response(hairBytes, { status: 200 });
        }
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        const bytes = new Uint8Array(await file.arrayBuffer());
        return new Response(
          JSON.stringify({
            file: {
              filename: `staged-${file.name}`,
              sha256: await sha256Hex(bytes),
              size: bytes.byteLength,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const result = await beginHairRefit({
      userId: "refit-user",
      goonId: "refit-goon",
      assetId: asset.assetId,
      revisionId: asset.revisionId,
      revisionSha256: asset.revisionSha256,
    });

    expect(result.inspection.initialTransform).toEqual(
      refitSource.savedTransform,
    );
    expect(result.job.target).toMatchObject({
      kind: "refit",
      assetId: asset.assetId,
      revisionId: `${asset.assetId}-r2`,
      revision: 2,
      sourceRevisionId: asset.revisionId,
    });
    expect(result.job.cleanupFiles).toHaveLength(2);
  });

  it("deletes every owned file before removing an expired job record", async () => {
    await createHairImportJob({
      userId: "cleanup-user",
      goonId: "cleanup-goon",
      source,
      cleanupFiles: [inspectionPreview],
      inspection: {},
      now: new Date("2026-08-08T12:00:00.000Z"),
      jobId: "expired-job",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      pruneDiscardableHairImportJobs(
        "cleanup-user",
        new Date("2026-08-10T12:00:00.000Z"),
      ),
    ).resolves.toEqual({ deletedJobs: 1, deletedFiles: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      uploadType: "goon_hair_imports",
      filename: "inspection-preview.glb",
    });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({
      uploadType: "goon_hair_imports",
      filename: "expired-source.obj",
    });
    await expect(
      getHairImportJobForCleanup("cleanup-user", "expired-job"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the exact expired job when owned-file cleanup fails so deletion can be retried", async () => {
    const job = await createHairImportJob({
      userId: "cleanup-retry-user",
      goonId: "cleanup-goon",
      source,
      inspection: {},
      now: new Date("2026-08-08T12:00:00.000Z"),
      jobId: "expired-retry-job",
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response("storage offline", { status: 503 })),
    );

    await expect(
      pruneDiscardableHairImportJobs(
        "cleanup-retry-user",
        new Date("2026-08-10T12:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "CLEANUP_FAILED", status: 502 });
    await expect(
      getHairImportJobForCleanup("cleanup-retry-user", "expired-retry-job"),
    ).resolves.toEqual(job);
  });

  it("discards an obsolete job contract and every owned draft file before a new import", async () => {
    const jobId = "obsolete-job";
    await redis.execute(async (client: any) => {
      await client.json.set(
        hairImportJobRedisKey("obsolete-user", jobId),
        "$",
        {
          contract: "hair-import-job/v1",
          jobId,
          userId: "obsolete-user",
          status: "reviewable",
          cleanupFiles: [source, inspectionPreview],
        },
      );
      await client.sAdd(hairImportJobIndexKey("obsolete-user"), jobId);
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetcher);

    await expect(
      pruneDiscardableHairImportJobs(
        "obsolete-user",
        new Date("2026-08-10T12:00:00.000Z"),
      ),
    ).resolves.toEqual({ deletedJobs: 1, deletedFiles: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      getHairImportJobForCleanup("obsolete-user", jobId),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
