import { describe, expect, it, vi } from "vitest";

import {
  createHairAssetFixture,
  createRigidHairGlbFixture,
} from "$lib/goons/recipe/fixtures/hairAssetFixture";
import { createHairState } from "$lib/goons/hairAssets";
import {
  RECIPE_SOURCE_CONTRACT,
  type RecipeSourceIdentity,
} from "$lib/goons/recipe/packageMetadata";
import type { RecipeSource } from "$lib/goons/recipe/recipeContracts";
import type {
  HairImportInspection,
  HairImportProposalSet,
  HairImportTransform,
} from "$lib/components/goons/hair-import/hairImportUiState";
import {
  cancelHairImport,
  createHairImport,
  createHairRefit,
  deleteHairAssetRevision,
  finalizeHairImport,
  HairImportApiError,
  prepareHairImport,
  selectHairImportFiles,
} from "./hairImports";

const HASH = "a".repeat(64);
const TRANSFORM: HairImportTransform = {
  move: { x: 0.125, y: -0.25, z: 0.5 },
  rotate: { x: 1, y: 12, z: -3 },
  uniformScale: 1.15,
  axisScale: { x: 1, y: 0.95, z: 1.05 },
};
const MOTION_SELECTIONS = [{ id: "hair-shell:region-001", moving: true }];
const INSPECTION: HairImportInspection = {
  sessionId: "hair-import-1",
  previewGeometryUrl: "/uploads/goon_hair_imports/inspection-preview.glb",
  sourceModeLabel: "Finished mesh",
  sourceSummary: "One likely hair object and one removable display stand.",
  objects: [
    {
      id: "hair-shell",
      name: "Hair Shell",
      triangleCount: 12_400,
      materialCount: 2,
      recommendedHair: true,
      reason: "Connected shell surrounding the scalp.",
    },
    {
      id: "display-stand",
      name: "Display Stand",
      triangleCount: 120,
      materialCount: 1,
      recommendedHair: false,
      reason: "Detached flat support below the hair.",
    },
  ],
  proposedTransform: TRANSFORM,
  initialTransform: TRANSFORM,
  notices: ["Normals will be normalized during preparation."],
};
const PROPOSALS: HairImportProposalSet = {
  material: {
    title: "Neutral material",
    summary: "Replace source shading with the standard neutral Hair material.",
    details: ["Preserve source alpha cutouts."],
  },
  follower: {
    title: "Appearance following",
    summary: "Follow the head and forehead without changing the accepted fit.",
    details: ["Keep ear clearance bounded."],
  },
  physics: {
    title: "Root-weighted motion",
    summary: "Anchor roots and increase movement toward the tips.",
    details: ["Three clumps proposed."],
  },
  motionReview: {
    anchoredLength: 0.5,
    weightCurve: "root-to-tip-smoothstep/v1",
    defaultIntensity: 1,
    regions: [
      {
        id: "hair-shell:region-001",
        meshNode: "Hair Shell",
        label: "Loose Hair section",
        moving: true,
        recommendedMoving: true,
        supportsMotion: true,
        lengthMeters: 0.22,
        vertexCount: 2100,
        explanation: "This section hangs below its root.",
      },
    ],
  },
  validationSummary: "The prepared candidate is ready for visual review.",
  receipt: {
    kept: ["Hair Shell"],
    removed: ["Display Stand"],
    generated: ["Neutral material", "Three motion clumps"],
  },
};

const SOURCE: RecipeSourceIdentity = {
  contract: RECIPE_SOURCE_CONTRACT,
  schemaVersion: 1,
  baseId: "batshit-base-female",
  fitFamily: "batshit-base-female-v1",
  modelSha256: HASH,
  manifestSemanticSha256: HASH,
  definitionSha256: HASH,
  neutralId: "batshit-base-female-neutral",
  neutralRecipeSha256: HASH,
  physicalBasisSha256: HASH,
  behaviorSha256: HASH,
  componentGraphSha256: HASH,
  topologySha256: HASH,
  skeletonHierarchySha256: HASH,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function hairAssetFixture() {
  return createHairAssetFixture({
    recipeSource: { identities: SOURCE } as RecipeSource,
    mainBytes: createRigidHairGlbFixture(),
    headNode: "head",
    sourceClass: "user",
  });
}

describe("hair import browser service", () => {
  it("creates an authenticated multipart inspection job and parses its strict response", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
        const form = init?.body as FormData;
        expect((form.get("file") as File).name).toBe("finished-hair.obj");
        expect(form.get("goonId")).toBe("goon-1");
        return jsonResponse({ inspection: INSPECTION });
      },
    );
    const file = new File(["o Hair\nv 0 0 0\n"], "finished-hair.obj", {
      type: "text/plain",
    });

    await expect(
      createHairImport(
        { file, goonId: "goon-1" },
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual(INSPECTION);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/goons/hair-imports",
      expect.any(Object),
    );
  });

  it("pairs one AHS calibration sidecar with one geometry file", async () => {
    const file = new File(["o Hair\nv 0 0 0\n"], "studio-hair.obj", {
      type: "text/plain",
    });
    const calibrationFile = new File(["{}"], "studio-hair.ahs", {
      type: "application/json",
    });
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const form = init?.body as FormData;
        expect((form.get("file") as File).name).toBe("studio-hair.obj");
        expect((form.get("calibrationFile") as File).name).toBe(
          "studio-hair.ahs",
        );
        return jsonResponse({ inspection: INSPECTION });
      },
    );

    const selection = selectHairImportFiles([calibrationFile, file]);
    expect(selection).toEqual({ file, calibrationFile });
    await expect(
      createHairImport(
        { ...selection, goonId: "goon-1" },
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual(INSPECTION);
  });

  it("rejects an AHS-only selection with geometry guidance", () => {
    const calibrationFile = new File(["{}"], "studio-hair.ahs", {
      type: "application/json",
    });
    expect(() => selectHairImportFiles([calibrationFile])).toThrow(
      /calibration data, not Hair geometry/,
    );
  });

  it("rejects malformed successful inspection responses instead of accepting partial data", async () => {
    const malformed = {
      ...INSPECTION,
      objects: [
        INSPECTION.objects[0],
        { ...INSPECTION.objects[1], id: "hair-shell" },
      ],
    };
    const fetcher = vi.fn(async () => jsonResponse({ inspection: malformed }));

    await expect(
      createHairImport(
        {
          file: new File(["glTF"], "finished-hair.glb", {
            type: "model/gltf-binary",
          }),
          goonId: "goon-1",
        },
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject<Partial<HairImportApiError>>({
      name: "HairImportApiError",
      status: 502,
      code: "INVALID_RESPONSE",
    });
  });

  it("opens a refit from one exact immutable Hair revision", async () => {
    const asset = await hairAssetFixture();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("/api/goons/hair-imports/refit");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          goonId: "goon-1",
          assetId: asset.assetId,
          revisionId: asset.revisionId,
          revisionSha256: asset.revisionSha256,
        });
        return jsonResponse({ inspection: INSPECTION });
      },
    );

    await expect(
      createHairRefit(
        { goonId: "goon-1", asset },
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual(INSPECTION);
  });

  it("prepares the selected objects and bounded transform through the session route", async () => {
    const asset = await hairAssetFixture();
    const candidate = {
      asset,
      hairState: createHairState(asset),
      stateVersion: 2,
      geometryUrl: asset.geometry.main.ref,
      rootNode: "HairImportRoot",
    };
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "/api/goons/hair-imports/hair-import-1/prepare",
        );
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "application/json",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          selectedObjectIds: ["hair-shell"],
          transform: TRANSFORM,
          motionRegionSelections: null,
          motionPaint: null,
          reviewedAppearanceState: null,
        });
        return jsonResponse({
          proposals: PROPOSALS,
          candidate,
        });
      },
    );

    await expect(
      prepareHairImport(
        {
          sessionId: "hair-import-1",
          selectedObjectIds: ["hair-shell"],
          transform: TRANSFORM,
          motionRegionSelections: null,
          motionPaint: null,
          reviewedAppearanceState: null,
        },
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual({
      proposals: PROPOSALS,
      candidate,
    });
  });

  it("finalizes the finished candidate and returns only a verified Hair Asset", async () => {
    const asset = await hairAssetFixture();
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "/api/goons/hair-imports/hair-import-1/finalize",
        );
        expect(init?.method).toBe("POST");
        expect(init?.credentials).toBe("same-origin");
        expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
        const form = init?.body as FormData;
        expect((form.get("preview") as File).name).toBe("hair-preview.png");
        expect((form.get("preview") as File).type).toBe("image/png");
        expect(form.get("displayName")).toBe("Finished Hair");
        expect(form.get("author")).toBe("Fixture Artist");
        expect(form.get("license")).toBe("CC-BY-4.0");
        expect(form.get("selectedObjectIds")).toBeNull();
        expect(form.get("transform")).toBeNull();
        expect(form.get("motionRegionSelections")).toBeNull();
        expect(form.get("motionPaint")).toBeNull();
        expect(form.get("acknowledgedProposals")).toBeNull();
        expect(form.get("acknowledgedViews")).toBeNull();
        expect(form.get("acknowledgedRiskStates")).toBeNull();
        return jsonResponse({ asset });
      },
    );

    await expect(
      finalizeHairImport(
        {
          sessionId: "hair-import-1",
          previewPng: new Blob([new Uint8Array([137, 80, 78, 71])], {
            type: "image/png",
          }),
          displayName: "Finished Hair",
          author: "Fixture Artist",
          license: "CC-BY-4.0",
        },
        { fetcher: fetcher as typeof fetch },
      ),
    ).resolves.toEqual(asset);
  });

  it("rejects a finalized Hair Asset whose immutable revision proof does not verify", async () => {
    const asset = await hairAssetFixture();
    const fetcher = vi.fn(async () =>
      jsonResponse({ asset: { ...asset, revisionSha256: "b".repeat(64) } }),
    );

    await expect(
      finalizeHairImport(
        {
          sessionId: "hair-import-1",
          previewPng: new Blob(["png"], { type: "image/png" }),
          displayName: "Finished Hair",
          author: "Fixture Artist",
          license: "CC-BY-4.0",
        },
        { fetcher: fetcher as typeof fetch },
      ),
    ).rejects.toMatchObject<Partial<HairImportApiError>>({
      name: "HairImportApiError",
      status: 502,
      code: "INVALID_RESPONSE",
    });
  });

  it("surfaces server error codes and details plainly", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        {
          error: "Hair selection changed after the candidate was generated.",
          code: "INVALID_STATE",
          details: { field: "selectedObjectIds" },
        },
        409,
      ),
    );

    const request = prepareHairImport(
      {
        sessionId: "hair-import-1",
        selectedObjectIds: ["hair-shell"],
        transform: TRANSFORM,
        motionRegionSelections: null,
        motionPaint: null,
        reviewedAppearanceState: null,
      },
      { fetcher: fetcher as typeof fetch },
    );
    await expect(request).rejects.toMatchObject<Partial<HairImportApiError>>({
      name: "HairImportApiError",
      status: 409,
      code: "INVALID_STATE",
      details: { field: "selectedObjectIds" },
    });
    await expect(request).rejects.toThrow(
      "Hair selection changed after the candidate was generated. (INVALID_STATE)",
    );
  });

  it("rejects invalid final metadata locally and confirms cancellation cleanup", async () => {
    const asset = await hairAssetFixture();
    const finalizeFetcher = vi.fn(async () => jsonResponse({ asset }));
    await expect(
      finalizeHairImport(
        {
          sessionId: "hair-import-1",
          previewPng: new Blob(["png"], { type: "image/png" }),
          displayName: "",
          author: "Fixture Artist",
          license: "CC-BY-4.0",
        },
        { fetcher: finalizeFetcher as typeof fetch },
      ),
    ).rejects.toMatchObject<Partial<HairImportApiError>>({
      status: 0,
      code: "INVALID_CLIENT_INPUT",
    });
    expect(finalizeFetcher).not.toHaveBeenCalled();

    const cancelFetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("/api/goons/hair-imports/hair-import-1");
        expect(init?.method).toBe("DELETE");
        expect(init?.credentials).toBe("same-origin");
        return jsonResponse({ discarded: true, deletedFiles: 4 });
      },
    );
    await expect(
      cancelHairImport("hair-import-1", {
        fetcher: cancelFetcher as typeof fetch,
      }),
    ).resolves.toEqual({ discarded: true, deletedFiles: 4 });
  });

  it("deletes one exact imported Hair revision only after server confirmation", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "/api/goons/hair-assets/user%2Fhair/revision%202",
        );
        expect(init?.method).toBe("DELETE");
        expect(init?.credentials).toBe("same-origin");
        return jsonResponse({ deleted: true });
      },
    );

    await expect(
      deleteHairAssetRevision("user/hair", "revision 2", {
        fetcher: fetcher as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });
});
