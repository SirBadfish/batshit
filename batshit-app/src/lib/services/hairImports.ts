import {
  createHairState,
  parseHairState,
  verifyHairAsset,
  type HairAssetV1,
  type HairStateV2,
} from "$lib/goons/hairAssets";
import { HAIR_IMPORT_CANONICAL_ROOT_NODE } from "$lib/goons/hairImportAuthoring";
import { parseHairMotionPaint } from "$lib/goons/hairMotionPaint";
import type { AppearanceDialValueState } from "$lib/goons/appearanceDials.contracts";
import {
  HAIR_IMPORT_TRANSFORM_LIMITS,
  type HairImportFinalizeRequest,
  type HairImportInspection,
  type HairImportPreviewRequest,
  type HairImportProposal,
  type HairImportProposalSet,
  type HairImportTransform,
} from "$lib/components/goons/hair-import/hairImportUiState";

type UnknownRecord = Record<string, unknown>;

export type HairImportClientOptions = {
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

export type HairImportFileBundle = {
  file: File;
  calibrationFile: File | null;
};

export type HairImportPrepareResult = {
  proposals: HairImportProposalSet;
  candidate: HairImportPreparedCandidate;
};

export type HairImportPrepareRequest = HairImportPreviewRequest & {
  reviewedAppearanceState: AppearanceDialValueState | null;
};

export type HairImportPreparedCandidate = {
  asset: HairAssetV1;
  hairState: HairStateV2;
  stateVersion: number;
  geometryUrl: string;
  rootNode: typeof HAIR_IMPORT_CANONICAL_ROOT_NODE;
};

export type FinalizeHairImportInput = HairImportFinalizeRequest & {
  previewPng: Blob;
  displayName: string;
  author: string;
  license: string;
};

export type HairImportCancelResult = {
  discarded: true;
  deletedFiles: number;
};

export class HairImportApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;
  readonly responseBody: unknown;

  constructor(
    message: string,
    input: {
      status: number;
      code?: string | null;
      details?: unknown;
      responseBody?: unknown;
    },
  ) {
    super(input.code ? `${message} (${input.code})` : message);
    this.name = "HairImportApiError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
    this.responseBody = input.responseBody;
  }
}

function invalidInput(message: string): never {
  throw new HairImportApiError(message, {
    status: 0,
    code: "INVALID_CLIENT_INPUT",
  });
}

function invalidResponse(message: string, responseBody: unknown): never {
  throw new HairImportApiError(message, {
    status: 502,
    code: "INVALID_RESPONSE",
    responseBody,
  });
}

function record(value: unknown, context: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidResponse(`${context} must be an object.`, value);
  }
  return value as UnknownRecord;
}

function text(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalidResponse(`${context} must be a non-empty trimmed string.`, value);
  }
  return value;
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalidResponse(`${context} must be a non-negative safe integer.`, value);
  }
  return value as number;
}

function positiveInteger(value: unknown, context: string): number {
  const result = nonNegativeInteger(value, context);
  if (result < 1) invalidResponse(`${context} must be positive.`, value);
  return result;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidResponse(`${context} must be finite.`, value);
  }
  return Object.is(value, -0) ? 0 : value;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean")
    invalidResponse(`${context} must be boolean.`, value);
  return value;
}

function stringArray(
  value: unknown,
  context: string,
  maximum = 4096,
): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    invalidResponse(
      `${context} must be an array with no more than ${maximum} entries.`,
      value,
    );
  }
  const result = value.map((entry, index) =>
    text(entry, `${context}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    invalidResponse(`${context} must not contain duplicate entries.`, value);
  }
  return result;
}

function parseVector(value: unknown, context: string) {
  const raw = record(value, context);
  return {
    x: finite(raw.x, `${context}.x`),
    y: finite(raw.y, `${context}.y`),
    z: finite(raw.z, `${context}.z`),
  };
}

function parseTransform(value: unknown, context: string): HairImportTransform {
  const raw = record(value, context);
  return {
    move: parseVector(raw.move, `${context}.move`),
    rotate: parseVector(raw.rotate, `${context}.rotate`),
    uniformScale: finite(raw.uniformScale, `${context}.uniformScale`),
    axisScale: parseVector(raw.axisScale, `${context}.axisScale`),
  };
}

function parseInspection(value: unknown): HairImportInspection {
  const envelope = record(value, "Hair import inspection response");
  const raw =
    "inspection" in envelope
      ? record(envelope.inspection, "Hair import inspection")
      : envelope;
  if (
    !Array.isArray(raw.objects) ||
    raw.objects.length === 0 ||
    raw.objects.length > 1024
  ) {
    invalidResponse(
      "Hair import inspection objects must contain 1 to 1024 entries.",
      raw.objects,
    );
  }
  const ids = new Set<string>();
  const objects = raw.objects.map((entry, index) => {
    const object = record(entry, `Hair import inspection objects[${index}]`);
    const id = text(object.id, `Hair import inspection objects[${index}].id`);
    if (ids.has(id))
      invalidResponse(
        "Hair import inspection object ids must be unique.",
        raw.objects,
      );
    ids.add(id);
    return {
      id,
      name: text(object.name, `Hair import inspection objects[${index}].name`),
      triangleCount: nonNegativeInteger(
        object.triangleCount,
        `Hair import inspection objects[${index}].triangleCount`,
      ),
      materialCount: nonNegativeInteger(
        object.materialCount,
        `Hair import inspection objects[${index}].materialCount`,
      ),
      recommendedHair: booleanValue(
        object.recommendedHair,
        `Hair import inspection objects[${index}].recommendedHair`,
      ),
      reason: text(
        object.reason,
        `Hair import inspection objects[${index}].reason`,
      ),
    };
  });
  return {
    sessionId: text(raw.sessionId, "Hair import inspection sessionId"),
    previewGeometryUrl: text(
      raw.previewGeometryUrl,
      "Hair import inspection previewGeometryUrl",
    ),
    sourceModeLabel: text(
      raw.sourceModeLabel,
      "Hair import inspection sourceModeLabel",
    ),
    sourceSummary: text(
      raw.sourceSummary,
      "Hair import inspection sourceSummary",
    ),
    objects,
    proposedTransform: parseTransform(
      raw.proposedTransform,
      "Hair import inspection proposedTransform",
    ),
    initialTransform: parseTransform(
      raw.initialTransform,
      "Hair import inspection initialTransform",
    ),
    notices: stringArray(raw.notices, "Hair import inspection notices", 256),
  };
}

function parseProposal(value: unknown, context: string): HairImportProposal {
  const raw = record(value, context);
  return {
    title: text(raw.title, `${context}.title`),
    summary: text(raw.summary, `${context}.summary`),
    details: stringArray(raw.details, `${context}.details`, 256),
  };
}

function parseProposals(value: unknown): HairImportProposalSet {
  const raw = record(value, "Hair import proposals");
  const receipt = record(raw.receipt, "Hair import proposals receipt");
  const motionReview = record(raw.motionReview, "Hair import motion review");
  if (!Array.isArray(motionReview.regions) || motionReview.regions.length > 254) {
    invalidResponse("Hair import motion review must contain at most 254 regions.", value);
  }
  const regionIds = new Set<string>();
  const regions = motionReview.regions.map((entry, index) => {
    const region = record(entry, `Hair import motion regions[${index}]`);
    const id = text(region.id, `Hair import motion regions[${index}].id`);
    if (regionIds.has(id)) {
      invalidResponse("Hair import motion region ids must be unique.", value);
    }
    regionIds.add(id);
    return {
      id,
      meshNode: text(region.meshNode, `Hair import motion regions[${index}].meshNode`),
      label: text(region.label, `Hair import motion regions[${index}].label`),
      moving: booleanValue(region.moving, `Hair import motion regions[${index}].moving`),
      recommendedMoving: booleanValue(
        region.recommendedMoving,
        `Hair import motion regions[${index}].recommendedMoving`,
      ),
      supportsMotion: booleanValue(
        region.supportsMotion,
        `Hair import motion regions[${index}].supportsMotion`,
      ),
      lengthMeters: finite(
        region.lengthMeters,
        `Hair import motion regions[${index}].lengthMeters`,
      ),
      vertexCount: positiveInteger(
        region.vertexCount,
        `Hair import motion regions[${index}].vertexCount`,
      ),
      explanation: text(
        region.explanation,
        `Hair import motion regions[${index}].explanation`,
      ),
    };
  });
  return {
    material: parseProposal(raw.material, "Hair import material proposal"),
    follower: parseProposal(raw.follower, "Hair import follower proposal"),
    physics: parseProposal(raw.physics, "Hair import physics proposal"),
    motionReview: {
      anchoredLength: finite(motionReview.anchoredLength, "Hair import motion anchoredLength"),
      weightCurve: (() => {
        const value = text(motionReview.weightCurve, "Hair import motion weightCurve");
        if (value !== "root-to-tip-smoothstep/v1") {
          invalidResponse("Hair import motion weight curve is unsupported.", motionReview);
        }
        return "root-to-tip-smoothstep/v1" as const;
      })(),
      defaultIntensity: finite(
        motionReview.defaultIntensity,
        "Hair import motion defaultIntensity",
      ),
      regions,
    },
    validationSummary: text(
      raw.validationSummary,
      "Hair import proposals validationSummary",
    ),
    receipt: {
      kept: stringArray(receipt.kept, "Hair import proposals receipt kept"),
      removed: stringArray(
        receipt.removed,
        "Hair import proposals receipt removed",
      ),
      generated: stringArray(
        receipt.generated,
        "Hair import proposals receipt generated",
      ),
    },
  };
}

function requireClientMotionSelections(value: unknown) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 254) {
    invalidInput("Hair import motion region selections must contain at most 254 entries.");
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalidInput(`Hair import motion region selections[${index}] must be an object.`);
    }
    const raw = entry as UnknownRecord;
    const id = requireClientText(raw.id, `Hair import motion region selections[${index}].id`);
    if (ids.has(id)) invalidInput("Hair import motion region selection ids must be unique.");
    ids.add(id);
    if (typeof raw.moving !== "boolean") {
      invalidInput(`Hair import motion region selections[${index}].moving must be boolean.`);
    }
    return { id, moving: raw.moving };
  });
}

function requireClientMotionPaint(value: unknown) {
  if (value === null) return null;
  try {
    return parseHairMotionPaint(value);
  } catch (error) {
    invalidInput(
      error instanceof Error ? error.message : "Hair motion paint is invalid.",
    );
  }
}

function requireClientText(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalidInput(`${context} must be a non-empty trimmed string.`);
  }
  return value;
}

function requireClientStringArray(
  value: unknown,
  context: string,
  options: { minimum?: number; maximum?: number } = {},
): string[] {
  const minimum = options.minimum ?? 0;
  const maximum = options.maximum ?? 1024;
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    invalidInput(`${context} must contain ${minimum} to ${maximum} entries.`);
  }
  const result = value.map((entry, index) => {
    if (typeof entry !== "string")
      invalidInput(`${context}[${index}] must be a string.`);
    return requireClientText(entry, `${context}[${index}]`);
  });
  if (new Set(result).size !== result.length) {
    invalidInput(`${context} must not contain duplicate entries.`);
  }
  return result;
}

function requireClientFinite(
  value: unknown,
  context: string,
  bounds: { min: number; max: number },
) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < bounds.min ||
    value > bounds.max
  ) {
    invalidInput(`${context} must be between ${bounds.min} and ${bounds.max}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requireClientVector(
  value: unknown,
  context: string,
  bounds: { min: number; max: number },
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidInput(`${context} must be an object.`);
  }
  const raw = value as UnknownRecord;
  return {
    x: requireClientFinite(raw.x, `${context}.x`, bounds),
    y: requireClientFinite(raw.y, `${context}.y`, bounds),
    z: requireClientFinite(raw.z, `${context}.z`, bounds),
  };
}

function requireClientTransform(value: unknown): HairImportTransform {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidInput("Hair import transform must be an object.");
  }
  const raw = value as UnknownRecord;
  return {
    move: requireClientVector(
      raw.move,
      "Hair import transform move",
      HAIR_IMPORT_TRANSFORM_LIMITS.move,
    ),
    rotate: requireClientVector(
      raw.rotate,
      "Hair import transform rotate",
      HAIR_IMPORT_TRANSFORM_LIMITS.rotate,
    ),
    uniformScale: requireClientFinite(
      raw.uniformScale,
      "Hair import transform uniformScale",
      HAIR_IMPORT_TRANSFORM_LIMITS.uniformScale,
    ),
    axisScale: requireClientVector(
      raw.axisScale,
      "Hair import transform axisScale",
      HAIR_IMPORT_TRANSFORM_LIMITS.axisScale,
    ),
  };
}

function sessionPath(sessionId: string, suffix = "") {
  const id = requireClientText(sessionId, "Hair import sessionId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    invalidInput("Hair import sessionId must be a stable id.");
  }
  return `/api/goons/hair-imports/${encodeURIComponent(id)}${suffix}`;
}

async function requestJson(
  path: string,
  init: RequestInit,
  fallback: string,
  options: HairImportClientOptions,
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch;
  const response = await fetcher(path, {
    ...init,
    credentials: "same-origin",
    signal: options.signal,
    headers: {
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const bodyText = await response.text().catch(() => "");
  let payload: unknown = null;
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      if (response.ok)
        invalidResponse(`${fallback} returned invalid JSON.`, bodyText);
      payload = bodyText;
    }
  }
  if (!response.ok) {
    const body =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as UnknownRecord)
        : null;
    const code =
      typeof body?.code === "string" && body.code.trim()
        ? body.code.trim()
        : null;
    const message =
      typeof body?.error === "string" && body.error.trim()
        ? body.error.trim()
        : typeof payload === "string" && payload.trim()
          ? payload
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
          : `${fallback} (${response.status}).`;
    throw new HairImportApiError(message, {
      status: response.status,
      code,
      details: body?.details,
      responseBody: payload,
    });
  }
  if (payload === null)
    invalidResponse(`${fallback} returned an empty response.`, payload);
  return payload;
}

export async function createHairImport(
  input: { file: File; calibrationFile?: File | null; goonId: string },
  options: HairImportClientOptions = {},
): Promise<HairImportInspection> {
  if (
    typeof File === "undefined" ||
    !(input.file instanceof File) ||
    input.file.size === 0
  ) {
    invalidInput("Hair import file must be a non-empty browser File.");
  }
  const form = new FormData();
  form.append("file", input.file, input.file.name);
  if (input.calibrationFile) {
    if (
      !(input.calibrationFile instanceof File) ||
      input.calibrationFile.size === 0 ||
      !/\.ahs$/i.test(input.calibrationFile.name)
    ) {
      invalidInput(
        "Anime Hair Studio calibration must be one non-empty .ahs browser File.",
      );
    }
    form.append(
      "calibrationFile",
      input.calibrationFile,
      input.calibrationFile.name,
    );
  }
  form.append("goonId", requireClientText(input.goonId, "Hair import goonId"));
  const payload = await requestJson(
    "/api/goons/hair-imports",
    { method: "POST", body: form },
    "Hair import inspection failed",
    options,
  );
  return parseInspection(payload);
}

export function selectHairImportFiles(
  files: readonly File[],
): HairImportFileBundle {
  if (files.length === 0) {
    invalidInput("Choose one OBJ or GLB Hair file.");
  }
  const geometry = files.filter((file) => /\.(?:obj|glb)$/i.test(file.name));
  const calibrations = files.filter((file) => /\.ahs$/i.test(file.name));
  const unsupported = files.filter(
    (file) => !/\.(?:obj|glb|ahs)$/i.test(file.name),
  );
  if (unsupported.length > 0) {
    invalidInput(
      `Unsupported Hair import file: ${unsupported[0].name}. Choose OBJ or GLB geometry, plus an optional .ahs calibration file.`,
    );
  }
  if (geometry.length === 0 && calibrations.length > 0) {
    invalidInput(
      "An .ahs project is calibration data, not Hair geometry. Choose the exported OBJ and optional .ahs file together.",
    );
  }
  if (geometry.length !== 1) {
    invalidInput("Choose exactly one OBJ or GLB Hair geometry file.");
  }
  if (calibrations.length > 1) {
    invalidInput("Choose at most one Anime Hair Studio .ahs calibration file.");
  }
  if (files.some((file) => file.size === 0)) {
    invalidInput("Hair import files must not be empty.");
  }
  return { file: geometry[0], calibrationFile: calibrations[0] ?? null };
}

export async function createHairRefit(
  input: { goonId: string; asset: HairAssetV1 },
  options: HairImportClientOptions = {},
): Promise<HairImportInspection> {
  const payload = await requestJson(
    "/api/goons/hair-imports/refit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        goonId: requireClientText(input.goonId, "Hair refit goonId"),
        assetId: requireClientText(input.asset.assetId, "Hair refit assetId"),
        revisionId: requireClientText(
          input.asset.revisionId,
          "Hair refit revisionId",
        ),
        revisionSha256: requireClientText(
          input.asset.revisionSha256,
          "Hair refit revisionSha256",
        ),
      }),
    },
    "Hair refit inspection failed",
    options,
  );
  return parseInspection(payload);
}

export async function prepareHairImport(
  input: HairImportPrepareRequest,
  options: HairImportClientOptions = {},
): Promise<HairImportPrepareResult> {
  const selectedObjectIds = requireClientStringArray(
    input.selectedObjectIds,
    "Hair import selectedObjectIds",
    { minimum: 1 },
  );
  const transform = requireClientTransform(input.transform);
  const motionRegionSelections = requireClientMotionSelections(input.motionRegionSelections);
  const motionPaint = requireClientMotionPaint(input.motionPaint);
  const payload = await requestJson(
    sessionPath(input.sessionId, "/prepare"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedObjectIds,
        transform,
        motionRegionSelections,
        motionPaint,
        reviewedAppearanceState: input.reviewedAppearanceState,
      }),
    },
    "Hair import preparation failed",
    options,
  );
  const body = record(payload, "Hair import preparation response");
  const rawCandidate = record(
    body.candidate,
    "Hair import preparation candidate",
  );
  let asset: HairAssetV1;
  let hairState: HairStateV2;
  try {
    asset = await verifyHairAsset(rawCandidate.asset);
    hairState = parseHairState(rawCandidate.hairState);
  } catch (error) {
    invalidResponse(
      error instanceof Error
        ? `Hair import preparation returned an invalid candidate: ${error.message}`
        : "Hair import preparation returned an invalid candidate.",
      payload,
    );
  }
  const expectedState = createHairState(asset!);
  if (
    hairState!.selected?.assetId !== expectedState.selected?.assetId ||
    hairState!.selected?.assetRevisionId !==
      expectedState.selected?.assetRevisionId ||
    hairState!.selected?.assetRevisionSha256 !==
      expectedState.selected?.assetRevisionSha256
  ) {
    invalidResponse(
      "Hair import preparation candidate Hair state does not select its immutable asset.",
      payload,
    );
  }
  const geometryUrl = text(
    rawCandidate.geometryUrl,
    "Hair import preparation candidate geometryUrl",
  );
  if (geometryUrl !== asset!.geometry.main.ref) {
    invalidResponse(
      "Hair import preparation candidate geometry URL does not match its asset receipt.",
      payload,
    );
  }
  if (rawCandidate.rootNode !== HAIR_IMPORT_CANONICAL_ROOT_NODE) {
    invalidResponse(
      "Hair import preparation candidate root node is unsupported.",
      payload,
    );
  }
  return {
    proposals: parseProposals(body.proposals),
    candidate: {
      asset: asset!,
      hairState: hairState!,
      stateVersion: positiveInteger(
        rawCandidate.stateVersion,
        "Hair import preparation candidate stateVersion",
      ),
      geometryUrl,
      rootNode: HAIR_IMPORT_CANONICAL_ROOT_NODE,
    },
  };
}

export async function finalizeHairImport(
  input: FinalizeHairImportInput,
  options: HairImportClientOptions = {},
): Promise<HairAssetV1> {
  if (
    typeof Blob === "undefined" ||
    !(input.previewPng instanceof Blob) ||
    input.previewPng.size === 0
  ) {
    invalidInput("Hair import preview must be a non-empty PNG Blob.");
  }
  if (input.previewPng.type !== "image/png") {
    invalidInput("Hair import preview must use image/png.");
  }
  const form = new FormData();
  form.append("preview", input.previewPng, "hair-preview.png");
  form.append(
    "displayName",
    requireClientText(input.displayName, "Hair import displayName"),
  );
  form.append("author", requireClientText(input.author, "Hair import author"));
  form.append(
    "license",
    requireClientText(input.license, "Hair import license"),
  );
  const payload = await requestJson(
    sessionPath(input.sessionId, "/finalize"),
    { method: "POST", body: form },
    "Hair import finalization failed",
    options,
  );
  const envelope = record(payload, "Hair import finalization response");
  try {
    return await verifyHairAsset(envelope.asset);
  } catch (error) {
    invalidResponse(
      error instanceof Error
        ? `Hair import finalization returned an invalid Hair Asset: ${error.message}`
        : "Hair import finalization returned an invalid Hair Asset.",
      payload,
    );
  }
}

export async function cancelHairImport(
  sessionId: string,
  options: HairImportClientOptions = {},
): Promise<HairImportCancelResult> {
  const payload = await requestJson(
    sessionPath(sessionId),
    { method: "DELETE" },
    "Hair import cancellation failed",
    options,
  );
  const body = record(payload, "Hair import cancellation response");
  if (body.discarded !== true) {
    invalidResponse(
      "Hair import cancellation did not confirm draft cleanup.",
      payload,
    );
  }
  return {
    discarded: true,
    deletedFiles: nonNegativeInteger(
      body.deletedFiles,
      "Hair import cancellation deletedFiles",
    ),
  };
}

export async function deleteHairAssetRevision(
  assetId: string,
  revisionId: string,
  options: HairImportClientOptions = {},
): Promise<void> {
  const stableAssetId = requireClientText(assetId, "Hair Asset id");
  const stableRevisionId = requireClientText(revisionId, "Hair Asset revision id");
  const payload = await requestJson(
    `/api/goons/hair-assets/${encodeURIComponent(stableAssetId)}/${encodeURIComponent(stableRevisionId)}`,
    { method: "DELETE" },
    "Hair Asset deletion failed",
    options,
  );
  const body = record(payload, "Hair Asset deletion response");
  if (body.deleted !== true) {
    invalidResponse("Hair Asset deletion was not confirmed.", payload);
  }
}
