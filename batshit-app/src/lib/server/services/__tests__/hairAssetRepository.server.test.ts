import { describe, expect, it, vi } from "vitest";

import {
  HAIR_ASSET_AUDIT_CONTRACT,
  HAIR_ASSET_CONTRACT,
  HAIR_FIT_RECEIPT_CONTRACT,
  HAIR_FOLLOWER_DECLARATION_CONTRACT,
  HAIR_MATERIAL_DECLARATION_CONTRACT,
  HAIR_PHYSICS_DECLARATION_CONTRACT,
  HAIR_REFIT_SOURCE_CONTRACT,
  createHairState,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  verifyHairAsset,
  type HairAssetV1,
  type HairRefitSourceV1,
} from "$lib/goons/hairAssets";
import { redis } from "$lib/server/redis";
import { useRedisTestServer } from "$lib/test-utils/redis-memory";
import {
  createHairImportJob,
  getHairImportJob,
  hairImportJobIndexKey,
  hairImportJobRedisKey,
  replaceHairImportJob,
} from "../hairImportJobRepository.server";

import {
  HairAssetRepositoryError,
  commitImportedHairAssetRevision,
  deleteUserHairAssetRevision,
  getHairRefitSource,
  listHairAssets,
  listHairRefitSources,
  putUserHairAssetRevision,
  resolveHairAssetRevision,
  userHairAssetIndexKey,
  userHairRefitSourceKey,
  userHairAssetRevisionKey,
} from "../hairAssetRepository.server";

const USER_ID = "hair-user";
const ZERO = "0".repeat(64);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === "true";

function ref(name: string, sha256: string) {
  return {
    ref: `/uploads/goon_hair_assets/${name}`,
    sha256,
    bytes: 1024,
    mimeType: name.endsWith(".glb") ? "model/gltf-binary" : "application/json",
  };
}

async function userAsset(): Promise<HairAssetV1> {
  const value = {
    schemaVersion: HAIR_ASSET_CONTRACT,
    assetId: "imported-style",
    revisionId: "imported-style-r1",
    revision: 1,
    revisionSha256: ZERO,
    sourceClass: "user" as const,
    display: {
      name: "Imported Style",
      previewImage: ref("preview.json", HASH_A),
      tags: ["imported"],
    },
    compatibility: {
      baseId: "batshit-base-female",
      fitFamily: "batshit-base-female-v1",
    },
    geometry: { main: ref("hair.glb", HASH_B), sparseAccent: null },
    attachment: {
      headNode: "head",
      authoredRootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      fitReceipt: {
        contract: HAIR_FIT_RECEIPT_CONTRACT,
        receiptId: "imported-style-fit-r1",
        assetId: "imported-style",
        assetRevisionId: "imported-style-r1",
        assetRevisionSha256: ZERO,
        baseId: "batshit-base-female",
        fitFamily: "batshit-base-female-v1",
        headAttachmentNode: "head",
        appearanceDefinitionSha256: HASH_C,
        physicalBasisSha256: HASH_A,
        topologySha256: HASH_B,
        skeletonHierarchySha256: HASH_C,
        fitSha256: ZERO,
      },
    },
    material: {
      contract: HAIR_MATERIAL_DECLARATION_CONTRACT,
      status: "pending" as const,
      definitionSha256: null,
      layout: null,
      neutralValueTexture: null,
      highlightMask: null,
      normalTexture: null,
      roughnessTexture: null,
      defaults: {
        baseColor: "#2a1738",
        highlightColor: "#6f4a8e",
        metalness: 0,
        roughness: 0.55,
        alphaMode: "OPAQUE" as const,
      },
    },
    follower: {
      contract: HAIR_FOLLOWER_DECLARATION_CONTRACT,
      mode: "static" as const,
      definitionSha256: null,
      asset: null,
      staticReason: "pending-h4-preview-only" as const,
    },
    physics: {
      contract: HAIR_PHYSICS_DECLARATION_CONTRACT,
      mode: "static" as const,
      definitionSha256: null,
      asset: null,
      staticReason: "pending-h5-preview-only" as const,
    },
    audit: {
      contract: HAIR_ASSET_AUDIT_CONTRACT,
      meshCount: 49,
      vertexCount: 15876,
      triangleCount: 26460,
      materialCount: 1,
      textureCount: 0,
      sparseAccent: false,
      receiptSha256: HASH_A,
    },
    provenance: {
      author: "Local user",
      license: "user-provided",
      sourceTool: "canonical-import-fixture",
      sourceSha256: HASH_B,
      catalogEligible: false,
      productExportApproved: false,
    },
    receiptRefs: [ref("creation-receipt.json", HASH_C)],
  };
  value.revisionSha256 = await hairAssetRevisionSha256(value);
  value.attachment.fitReceipt.assetRevisionSha256 = value.revisionSha256;
  value.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(
    value.attachment.fitReceipt,
  );
  return verifyHairAsset(value);
}

async function changedUserAsset(asset: HairAssetV1): Promise<HairAssetV1> {
  const changed = structuredClone(asset);
  changed.display.name = "Different immutable content";
  changed.revisionSha256 = ZERO;
  changed.attachment.fitReceipt.assetRevisionSha256 = ZERO;
  changed.attachment.fitReceipt.fitSha256 = ZERO;
  changed.revisionSha256 = await hairAssetRevisionSha256(changed);
  changed.attachment.fitReceipt.assetRevisionSha256 = changed.revisionSha256;
  changed.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(
    changed.attachment.fitReceipt,
  );
  return verifyHairAsset(changed);
}

function refitSource(asset: HairAssetV1): HairRefitSourceV1 {
  return {
    contract: HAIR_REFIT_SOURCE_CONTRACT,
    assetId: asset.assetId,
    revisionId: asset.revisionId,
    source: ref("refit-source.glb", HASH_A),
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
}

async function seedOwnedFileRecords(
  asset: HairAssetV1,
  source: HairRefitSourceV1 | null = null,
) {
  for (const file of [
    asset.display.previewImage,
    asset.geometry.main,
    ...asset.receiptRefs,
    ...(source ? [source.source] : []),
  ]) {
    const filename = file.ref.split("/").at(-1)!;
    await redis.json.set(`upload:goon_hair_assets:${filename}`, "$", {
      storage: "filesystem",
      uploadType: "goon_hair_assets",
      relativePath: `goon_hair_assets/${filename}`,
      filePath: `/owned/goon_hair_assets/${filename}`,
      filename,
      originalName: filename,
      mimetype: file.mimeType,
      size: file.bytes,
      sha256: file.sha256,
    });
  }
}

describe("Hair Asset immutable Redis repository", () => {
  useRedisTestServer();

  it("stores, lists, and resolves the exact user revision only after owned-file proof", async () => {
    const asset = await userAsset();
    await seedOwnedFileRecords(asset);

    await expect(putUserHairAssetRevision(USER_ID, asset)).resolves.toEqual(
      asset,
    );
    await expect(
      putUserHairAssetRevision(USER_ID, structuredClone(asset)),
    ).resolves.toEqual(asset);
    await redis.sRem(
      userHairAssetIndexKey(USER_ID),
      "imported-style@imported-style-r1",
    );
    await expect(
      putUserHairAssetRevision(USER_ID, structuredClone(asset)),
    ).resolves.toEqual(asset);
    await expect(listHairAssets(USER_ID, { builtinAssets: [] })).resolves.toEqual([asset]);
    await expect(listHairRefitSources(USER_ID)).resolves.toEqual([]);
    await expect(
      getHairRefitSource(USER_ID, asset.assetId, asset.revisionId),
    ).resolves.toBeNull();
    await expect(
      resolveHairAssetRevision(USER_ID, createHairState(asset).selected!, {
        builtinAssets: [],
      }),
    ).resolves.toEqual(asset);
    expect(await redis.sMembers(userHairAssetIndexKey(USER_ID))).toEqual([
      "imported-style@imported-style-r1",
    ]);

    await redis.del("upload:goon_hair_assets:hair.glb");
    await expect(
      resolveHairAssetRevision(USER_ID, createHairState(asset).selected!, {
        builtinAssets: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_OWNED_FILE" });
  });

  it("rejects missing owned files and immutable replacement attempts", async () => {
    const asset = await userAsset();
    await expect(
      putUserHairAssetRevision(USER_ID, asset),
    ).rejects.toMatchObject({
      code: "INVALID_OWNED_FILE",
    });

    await seedOwnedFileRecords(asset);
    await putUserHairAssetRevision(USER_ID, asset);
    const changed = await changedUserAsset(asset);
    await expect(
      putUserHairAssetRevision(USER_ID, changed),
    ).rejects.toMatchObject({
      code: "IMMUTABLE_REVISION_CONFLICT",
    });
  });

  it.runIf(REAL_REDIS_LANE)(
    "keeps the immutable attachment hash stable across a real RedisJSON round trip",
    async () => {
      const asset = await userAsset();
      asset.attachment.authoredRootMatrix = [
        1.0000001192092896,
        7.198165674182855e-11,
        9.222511998086658e-8,
        -0,
        -1.2383957222474875e-11,
        1.0000000273221477,
        -0.000020774660564493175,
        0,
        -9.222218899873071e-8,
        0.00002108229873099043,
        1.0000022292645545,
        0,
        4.233189798141136e-9,
        -1.4731680690987062,
        -0.04590650020980835,
        1,
      ];
      asset.revisionSha256 = ZERO;
      asset.attachment.fitReceipt.assetRevisionSha256 = ZERO;
      asset.attachment.fitReceipt.fitSha256 = ZERO;
      asset.revisionSha256 = await hairAssetRevisionSha256(asset);
      asset.attachment.fitReceipt.assetRevisionSha256 = asset.revisionSha256;
      asset.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(
        asset.attachment.fitReceipt,
      );
      const verified = await verifyHairAsset(asset);
      const key = userHairAssetRevisionKey(
        USER_ID,
        verified.assetId,
        verified.revisionId,
      );

      await redis.json.set(key, "$", verified);
      const stored = await redis.json.get(key);

      await expect(verifyHairAsset(stored)).resolves.toEqual(verified);
    },
  );

  it.runIf(REAL_REDIS_LANE)(
    "rolls back a new revision when the catalog index write fails",
    async () => {
      const asset = await userAsset();
      await seedOwnedFileRecords(asset);
      const indexKey = userHairAssetIndexKey(USER_ID);
      const revisionKey = userHairAssetRevisionKey(
        USER_ID,
        asset.assetId,
        asset.revisionId,
      );
      await redis.set(indexKey, "wrong-type-index");

      await expect(
        putUserHairAssetRevision(USER_ID, asset),
      ).rejects.toMatchObject({
        code: "ATOMIC_REGISTRATION_FAILED",
        status: 500,
      });
      await expect(redis.json.get(revisionKey)).resolves.toBeNull();
      await expect(redis.get(indexKey)).resolves.toBe("wrong-type-index");
    },
  );

  it.runIf(REAL_REDIS_LANE)(
    "keeps an existing exact revision when an idempotent index repair fails",
    async () => {
      const asset = await userAsset();
      await seedOwnedFileRecords(asset);
      const indexKey = userHairAssetIndexKey(USER_ID);
      const revisionKey = userHairAssetRevisionKey(
        USER_ID,
        asset.assetId,
        asset.revisionId,
      );
      await putUserHairAssetRevision(USER_ID, asset);
      await redis.del(indexKey);
      await redis.set(indexKey, "wrong-type-index");

      await expect(
        putUserHairAssetRevision(USER_ID, structuredClone(asset)),
      ).rejects.toMatchObject({
        code: "ATOMIC_REGISTRATION_FAILED",
        status: 500,
      });
      await expect(redis.json.get(revisionKey)).resolves.toEqual(asset);
      await expect(redis.get(indexKey)).resolves.toBe("wrong-type-index");
    },
  );

  it.runIf(REAL_REDIS_LANE)(
    "registers concurrent identical retries idempotently and preserves immutable conflicts",
    async () => {
      const asset = await userAsset();
      await seedOwnedFileRecords(asset);

      await expect(
        Promise.all([
          putUserHairAssetRevision(USER_ID, structuredClone(asset)),
          putUserHairAssetRevision(USER_ID, structuredClone(asset)),
        ]),
      ).resolves.toEqual([asset, asset]);
      await expect(
        redis.sMembers(userHairAssetIndexKey(USER_ID)),
      ).resolves.toEqual(["imported-style@imported-style-r1"]);
      await expect(
        putUserHairAssetRevision(USER_ID, await changedUserAsset(asset)),
      ).rejects.toMatchObject({
        code: "IMMUTABLE_REVISION_CONFLICT",
        status: 409,
      });
      await expect(
        redis.json.get(
          userHairAssetRevisionKey(USER_ID, asset.assetId, asset.revisionId),
        ),
      ).resolves.toEqual(asset);
    },
  );

  it.runIf(REAL_REDIS_LANE)(
    "atomically transfers a reviewed import from cleanup ownership into the immutable catalog",
    async () => {
      const asset = await userAsset();
      const sourceRecord = refitSource(asset);
      await seedOwnedFileRecords(asset, sourceRecord);
      const source = {
        uploadType: "goon_hair_imports" as const,
        filename: "staged-source.obj",
        originalName: "finished-hair.obj",
        ref: "/uploads/goon_hair_imports/staged-source.obj",
        sha256: HASH_A,
        bytes: 128,
        mimeType: "text/plain",
      };
      const created = await createHairImportJob({
        userId: USER_ID,
        goonId: "goon-import-owner",
        source,
        inspection: { sourceMode: "generic-obj" },
        jobId: "atomic-import-job",
      });
      const reviewable = await replaceHairImportJob(created, {
        ...created,
        status: "reviewable",
        candidate: { assetId: asset.assetId, revisionId: asset.revisionId },
      });

      await expect(
        commitImportedHairAssetRevision({
          userId: USER_ID,
          jobId: reviewable.jobId,
          expectedJobStateVersion: reviewable.stateVersion + 1,
          asset,
          refitSource: sourceRecord,
        }),
      ).rejects.toMatchObject({
        code: "ATOMIC_REGISTRATION_FAILED",
        status: 409,
      });
      await expect(
        getHairImportJob(USER_ID, reviewable.jobId),
      ).resolves.toEqual(reviewable);
      await expect(
        redis.json.get(
          userHairAssetRevisionKey(USER_ID, asset.assetId, asset.revisionId),
        ),
      ).resolves.toBeNull();

      await expect(
        commitImportedHairAssetRevision({
          userId: USER_ID,
          jobId: reviewable.jobId,
          expectedJobStateVersion: reviewable.stateVersion,
          asset,
          refitSource: sourceRecord,
        }),
      ).resolves.toEqual(asset);
      await expect(
        getHairRefitSource(USER_ID, asset.assetId, asset.revisionId),
      ).resolves.toEqual(sourceRecord);
      await expect(listHairRefitSources(USER_ID)).resolves.toEqual([
        sourceRecord,
      ]);
      await expect(
        redis.json.get(
          userHairAssetRevisionKey(USER_ID, asset.assetId, asset.revisionId),
        ),
      ).resolves.toEqual(asset);
      await expect(
        redis.json.get(hairImportJobRedisKey(USER_ID, reviewable.jobId)),
      ).resolves.toBeNull();
      await expect(
        redis.sMembers(hairImportJobIndexKey(USER_ID)),
      ).resolves.toEqual([]);
    },
  );

  it("blocks referenced deletion, then removes metadata and unshared owned files", async () => {
    const asset = await userAsset();
    const sourceRecord = refitSource(asset);
    await seedOwnedFileRecords(asset, sourceRecord);
    await putUserHairAssetRevision(USER_ID, asset);
    await redis.json.set(
      userHairRefitSourceKey(USER_ID, asset.assetId, asset.revisionId),
      "$",
      sourceRecord,
    );
    await redis.sAdd(`user:${USER_ID}:goons`, "goon-with-hair");
    await redis.json.set("goon:goon-with-hair", "$", {
      id: "goon-with-hair",
      user_id: USER_ID,
      hairState: createHairState(asset),
    });

    await expect(
      deleteUserHairAssetRevision(USER_ID, asset.assetId, asset.revisionId, {
        deleteOwnedFile: vi.fn(),
      }),
    ).rejects.toMatchObject<Partial<HairAssetRepositoryError>>({
      code: "ASSET_IN_USE",
      status: 409,
    });

    await redis.del("goon:goon-with-hair");
    await redis.sRem(`user:${USER_ID}:goons`, "goon-with-hair");
    const deleteOwnedFile = vi.fn().mockResolvedValue(undefined);
    await expect(
      deleteUserHairAssetRevision(USER_ID, asset.assetId, asset.revisionId, {
        deleteOwnedFile,
      }),
    ).resolves.toEqual(asset);
    expect(deleteOwnedFile).toHaveBeenCalledTimes(4);
    expect(
      await redis.json.get(
        userHairAssetRevisionKey(USER_ID, asset.assetId, asset.revisionId),
      ),
    ).toBeNull();
    expect(
      await redis.json.get(
        userHairRefitSourceKey(USER_ID, asset.assetId, asset.revisionId),
      ),
    ).toBeNull();
  });
});
