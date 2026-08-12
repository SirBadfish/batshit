import {
  decodeSemanticGlbAccessor,
  inspectSemanticGlbAccessor,
  parseSemanticGlb,
  resolveSemanticGlbNodeTransform,
  writeDeterministicSemanticGlb,
  type SemanticGlbDocument,
  type SemanticJsonRecord,
} from "./recipe/semanticGlb";

export const HAIR_IMPORT_INSPECTION_CONTRACT =
  "hair-import-inspection/v1" as const;
export const HAIR_IMPORT_CANONICALIZATION_CONTRACT =
  "hair-import-canonicalization/v1" as const;
export const HAIR_IMPORT_TRANSFORM_CONTRACT =
  "hair-import-transform/v1" as const;
export const HAIR_IMPORT_RECEIPT_CONTRACT = "hair-import-receipt/v1" as const;

export const HAIR_IMPORT_BUDGETS = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxConversionMilliseconds: 5_000,
  maxJsonBytes: 8 * 1024 * 1024,
  maxJsonDepth: 64,
  maxJsonValues: 500_000,
  maxJsonArrayEntries: 100_000,
  maxObjLines: 1_000_000,
  maxObjLineBytes: 64 * 1024,
  maxObjects: 1_024,
  maxObjectNameBytes: 512,
  maxMaterials: 256,
  maxVertices: 500_000,
  maxNormals: 500_000,
  maxTexcoords: 500_000,
  maxFaces: 500_000,
  maxFaceVertices: 64,
  maxTriangles: 500_000,
  maxCanonicalVertices: 1_500_000,
  maxDegenerateTriangles: 10_000,
  maxDegenerateFraction: 0.25,
  maxGlbNodes: 4_096,
  maxGlbMeshes: 4_096,
  maxGlbPrimitives: 8_192,
  maxGlbAccessors: 32_768,
  maxGlbBufferViews: 32_768,
  maxTranslation: 10,
  minUniformScale: 0.01,
  maxUniformScale: 100,
  minAxisScale: 0.5,
  maxAxisScale: 2,
} as const);

export type HairImportBudgets = {
  -readonly [Key in keyof typeof HAIR_IMPORT_BUDGETS]: number;
};

export type HairImportFormat = "obj" | "glb";
export type HairImportSourceMode =
  "ahs-like-obj" | "generic-obj" | "generic-glb";
export type HairImportObjectKind =
  "mesh" | "line-helper" | "point-helper" | "empty";
export type HairImportDecision = "keep" | "remove";
export type HairImportReceiptAction = "kept" | "removed" | "generated";
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Bounds3 = { min: Vec3; max: Vec3 };

export type HairImportReceiptEntryV1 = {
  action: HairImportReceiptAction;
  subject: string;
  reason: string;
  count: number | null;
};

export type HairImportObjectInventoryV1 = {
  objectId: string;
  name: string;
  kind: HairImportObjectKind;
  sourceIndex: number;
  vertexCount: number;
  triangleCount: number;
  lineCount: number;
  pointCount: number;
  materialNames: string[];
  bounds: Bounds3 | null;
  defaultDecision: HairImportDecision;
  defaultReason: string;
};

export type HairImportInspectionV1 = {
  contract: typeof HAIR_IMPORT_INSPECTION_CONTRACT;
  format: HairImportFormat;
  sourceMode: HairImportSourceMode;
  sourceBytes: number;
  inventory: HairImportObjectInventoryV1[];
  geometry: {
    objectCount: number;
    meshCount: number;
    vertexCount: number;
    triangleCount: number;
    materialCount: number;
    discardedDegenerateTriangles: number;
    bounds: Bounds3 | null;
  };
  receipts: HairImportReceiptEntryV1[];
};

export type HairImportTransformV1 = {
  contract: typeof HAIR_IMPORT_TRANSFORM_CONTRACT;
  translation: Vec3;
  rotation: Vec3;
  uniformScale: number;
  axisScale: Vec3;
};

export type HairImportTransformInput = {
  translation?: readonly number[] | null;
  rotation?: readonly number[] | null;
  uniformScale?: number | null;
  axisScale?: readonly number[] | null;
};

export type HairImportSourceCalibrationV1 = {
  contract: "hair-import-source-calibration/v1";
  mode: "registered-template/v1" | "stock-scalp-deformation/v1";
  sourceScalpPoints: Vec3[] | null;
  targetScalpPoints: Vec3[] | null;
};

export type InspectHairImportSourceInput = {
  bytes: Uint8Array;
  filename?: string;
  budgets?: Partial<HairImportBudgets>;
  now?: () => number;
};

export type CanonicalizeHairImportSelectionInput =
  InspectHairImportSourceInput & {
    keepObjectIds?: readonly string[];
    removeObjectIds?: readonly string[];
    transform?: HairImportTransformInput | null;
    calibration?: HairImportSourceCalibrationV1 | null;
  };

export type HairImportGeometrySummaryV1 = {
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
  materialCount: 1;
  textureCount: 0;
  bounds: Bounds3;
};

export type HairImportCanonicalizationV1 = {
  contract: typeof HAIR_IMPORT_CANONICALIZATION_CONTRACT;
  format: HairImportFormat;
  sourceMode: HairImportSourceMode;
  inspection: HairImportInspectionV1;
  keptObjectIds: string[];
  removedObjectIds: string[];
  transform: HairImportTransformV1;
  geometry: HairImportGeometrySummaryV1;
  receipts: HairImportReceiptEntryV1[];
  glbBytes: Uint8Array;
};

type Triangle = readonly [Vec3, Vec3, Vec3];

type ParsedObject = {
  objectId: string;
  name: string;
  sourceIndex: number;
  triangles: Triangle[];
  referencedVertices: Set<number>;
  linePaths: Vec3[][];
  lineCount: number;
  pointCount: number;
  materials: Set<string>;
  discardedDegenerateTriangles: number;
};

type ParsedHairImportSource = {
  format: HairImportFormat;
  sourceMode: HairImportSourceMode;
  sourceBytes: number;
  objects: ParsedObject[];
  materialCount: number;
  discardedDegenerateTriangles: number;
  receipts: HairImportReceiptEntryV1[];
};

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK = 0x4e4f534a;
const EPSILON_SQUARED = 1e-20;
const IDENTITY_TRANSFORM: HairImportTransformV1 = {
  contract: HAIR_IMPORT_TRANSFORM_CONTRACT,
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
  uniformScale: 1,
  axisScale: [1, 1, 1],
};

class HairImportError extends Error {
  constructor(message: string) {
    super(`[hair-import-intake/v1] ${message}`);
    this.name = "HairImportError";
  }
}

function fail(message: string): never {
  throw new HairImportError(message);
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function safeInteger(value: unknown, context: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${context} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function optionalArray(value: unknown, context: string): unknown[] {
  return value === undefined ? [] : array(value, context);
}

function normalizedBudgets(
  overrides?: Partial<HairImportBudgets>,
): HairImportBudgets {
  const result = { ...HAIR_IMPORT_BUDGETS } as HairImportBudgets;
  if (!overrides) return result;
  for (const key of Object.keys(overrides) as Array<keyof HairImportBudgets>) {
    if (!(key in HAIR_IMPORT_BUDGETS)) fail(`unknown import budget ${key}`);
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value <= 0)
      fail(`import budget ${key} must be positive`);
    if (value > HAIR_IMPORT_BUDGETS[key]) {
      fail(
        `import budget ${key} may tighten but not exceed the production limit`,
      );
    }
    result[key] = value;
  }
  return result;
}

function createDeadline(
  now: (() => number) | undefined,
  budgets: HairImportBudgets,
) {
  const clock = now ?? (() => performance.now());
  const start = clock();
  if (!Number.isFinite(start))
    fail("the import clock returned a non-finite value");
  return (context: string) => {
    const current = clock();
    if (!Number.isFinite(current))
      fail("the import clock returned a non-finite value");
    if (current - start > budgets.maxConversionMilliseconds) {
      fail(
        `${context} exceeded the ${budgets.maxConversionMilliseconds}ms conversion budget`,
      );
    }
  };
}

function validateBytes(bytes: Uint8Array, budgets: HairImportBudgets) {
  if (
    !ArrayBuffer.isView(bytes) ||
    !("BYTES_PER_ELEMENT" in bytes) ||
    bytes.BYTES_PER_ELEMENT !== 1
  ) {
    fail("source bytes must be a Uint8Array");
  }
  if (bytes.byteLength === 0) fail("source file is empty");
  if (bytes.byteLength > budgets.maxSourceBytes) {
    fail(
      `source file exceeds the ${budgets.maxSourceBytes}-byte import budget`,
    );
  }
}

function validateFilename(
  filename: string | undefined,
): HairImportFormat | null {
  if (filename === undefined) return null;
  if (
    typeof filename !== "string" ||
    !filename.trim() ||
    filename.includes("\0")
  ) {
    fail("filename must be a non-empty safe string when provided");
  }
  const base = filename.replace(/\\/g, "/").split("/").at(-1) ?? "";
  if (!base || base === "." || base === "..") fail("filename is invalid");
  const lower = base.toLowerCase();
  if (lower.endsWith(".obj")) return "obj";
  if (lower.endsWith(".glb")) return "glb";
  fail("Hair import accepts only .obj or .glb source files");
}

function sourceFormat(bytes: Uint8Array): HairImportFormat {
  if (bytes.byteLength >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, true) === GLB_MAGIC) return "glb";
  }
  return "obj";
}

function receipt(
  action: HairImportReceiptAction,
  subject: string,
  reason: string,
  count: number | null = null,
): HairImportReceiptEntryV1 {
  return { action, subject, reason, count };
}

function cloneVec3(value: Vec3): Vec3 {
  return [value[0], value[1], value[2]];
}

function expandBounds(bounds: Bounds3 | null, point: Vec3): Bounds3 {
  if (!bounds) return { min: cloneVec3(point), max: cloneVec3(point) };
  for (let axis = 0; axis < 3; axis += 1) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
  return bounds;
}

function objectBounds(object: ParsedObject): Bounds3 | null {
  let bounds: Bounds3 | null = null;
  for (const triangle of object.triangles) {
    for (const point of triangle) bounds = expandBounds(bounds, point);
  }
  return bounds;
}

function mergedBounds(objects: readonly ParsedObject[]): Bounds3 | null {
  let bounds: Bounds3 | null = null;
  for (const object of objects) {
    for (const triangle of object.triangles) {
      for (const point of triangle) bounds = expandBounds(bounds, point);
    }
  }
  return bounds;
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function lengthSquared(value: Vec3) {
  return value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
}

function triangleNormal(triangle: Triangle): Vec3 | null {
  const raw = cross(
    subtract(triangle[1], triangle[0]),
    subtract(triangle[2], triangle[0]),
  );
  const squared = lengthSquared(raw);
  if (squared <= EPSILON_SQUARED) return null;
  const scale = 1 / Math.sqrt(squared);
  return [raw[0] * scale, raw[1] * scale, raw[2] * scale];
}

function inventoryKind(object: ParsedObject): HairImportObjectKind {
  if (object.triangles.length > 0) return "mesh";
  if (object.lineCount > 0) return "line-helper";
  if (object.pointCount > 0) return "point-helper";
  return "empty";
}

function inventoryEntry(object: ParsedObject): HairImportObjectInventoryV1 {
  const kind = inventoryKind(object);
  const keep = kind === "mesh";
  return {
    objectId: object.objectId,
    name: object.name,
    kind,
    sourceIndex: object.sourceIndex,
    vertexCount: object.referencedVertices.size,
    triangleCount: object.triangles.length,
    lineCount: object.lineCount,
    pointCount: object.pointCount,
    materialNames: [...object.materials].sort((left, right) =>
      left.localeCompare(right),
    ),
    bounds: objectBounds(object),
    defaultDecision: keep ? "keep" : "remove",
    defaultReason: keep
      ? "Renderable triangle geometry is kept by default for review."
      : `${kind} records are authoring-only and cannot enter canonical Hair geometry.`,
  };
}

function inspectionFromParsed(
  parsed: ParsedHairImportSource,
): HairImportInspectionV1 {
  const inventory = parsed.objects.map(inventoryEntry);
  const meshObjects = parsed.objects.filter(
    (object) => object.triangles.length > 0,
  );
  const vertexCount = meshObjects.reduce(
    (total, object) => total + object.referencedVertices.size,
    0,
  );
  const triangleCount = meshObjects.reduce(
    (total, object) => total + object.triangles.length,
    0,
  );
  return {
    contract: HAIR_IMPORT_INSPECTION_CONTRACT,
    format: parsed.format,
    sourceMode: parsed.sourceMode,
    sourceBytes: parsed.sourceBytes,
    inventory,
    geometry: {
      objectCount: inventory.length,
      meshCount: meshObjects.length,
      vertexCount,
      triangleCount,
      materialCount: parsed.materialCount,
      discardedDegenerateTriangles: parsed.discardedDegenerateTriangles,
      bounds: mergedBounds(meshObjects),
    },
    receipts: [...parsed.receipts],
  };
}

function objectName(
  value: string,
  fallback: string,
  budgets: HairImportBudgets,
) {
  const normalized =
    value.trim().replace(/[\u0000-\u001f\u007f]/g, "") || fallback;
  if (
    new TextEncoder().encode(normalized).byteLength > budgets.maxObjectNameBytes
  ) {
    fail(`object name exceeds the ${budgets.maxObjectNameBytes}-byte limit`);
  }
  return normalized;
}

function objIndex(value: string, count: number, context: string) {
  if (!/^-?[0-9]+$/.test(value))
    fail(`${context} contains a malformed OBJ index`);
  const raw = Number(value);
  if (!Number.isSafeInteger(raw) || raw === 0)
    fail(`${context} contains an invalid OBJ index`);
  const resolved = raw > 0 ? raw - 1 : count + raw;
  if (resolved < 0 || resolved >= count)
    fail(`${context} references an out-of-range OBJ index`);
  return resolved;
}

type ObjCorner = {
  vertex: number;
  texcoord: number | null;
  normal: number | null;
};

function objCorner(
  value: string,
  counts: { vertices: number; texcoords: number; normals: number },
  context: string,
): ObjCorner {
  const parts = value.split("/");
  if (parts.length > 3 || parts.length === 0 || !parts[0]) {
    fail(`${context} contains a malformed face corner`);
  }
  const vertex = objIndex(parts[0], counts.vertices, `${context} vertex`);
  const texcoord =
    parts.length >= 2 && parts[1]
      ? objIndex(parts[1], counts.texcoords, `${context} texcoord`)
      : null;
  const normal =
    parts.length === 3 && parts[2]
      ? objIndex(parts[2], counts.normals, `${context} normal`)
      : null;
  return { vertex, texcoord, normal };
}

function parseObjNumber(value: string, context: string) {
  if (!value || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    fail(`${context} must be a finite decimal number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${context} must be finite`);
  return Object.is(parsed, -0) ? 0 : parsed;
}

function splitObjLines(bytes: Uint8Array, budgets: HairImportBudgets) {
  let lineBytes = 0;
  let lineCount = 1;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index];
    if (byte === 0) fail("OBJ source contains a NUL byte");
    if (byte === 10) {
      if (lineBytes > budgets.maxObjLineBytes) {
        fail(`OBJ line exceeds the ${budgets.maxObjLineBytes}-byte limit`);
      }
      lineBytes = 0;
      lineCount += 1;
      if (lineCount > budgets.maxObjLines) {
        fail(`OBJ source exceeds the ${budgets.maxObjLines}-line limit`);
      }
    } else {
      lineBytes += 1;
    }
  }
  if (lineBytes > budgets.maxObjLineBytes) {
    fail(`OBJ line exceeds the ${budgets.maxObjLineBytes}-byte limit`);
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    fail(`OBJ source is not valid UTF-8: ${String(error)}`);
  }
  return text.split(/\r?\n/);
}

function createParsedObject(index: number, name: string): ParsedObject {
  return {
    objectId: `object-${String(index + 1).padStart(4, "0")}`,
    name,
    sourceIndex: index,
    triangles: [],
    referencedVertices: new Set(),
    linePaths: [],
    lineCount: 0,
    pointCount: 0,
    materials: new Set(),
    discardedDegenerateTriangles: 0,
  };
}

function parseObjSource(
  bytes: Uint8Array,
  budgets: HairImportBudgets,
  checkpoint: (context: string) => void,
): ParsedHairImportSource {
  const lines = splitObjLines(bytes, budgets);
  const vertices: Vec3[] = [];
  const texcoords: Vec2[] = [];
  const normals: Vec3[] = [];
  const objects: ParsedObject[] = [];
  const materialNames = new Set<string>();
  const comments: string[] = [];
  let faceCount = 0;
  let sourceTriangles = 0;
  let discardedDegenerateTriangles = 0;
  let activeMaterial: string | null = null;
  let current: ParsedObject | null = null;

  const ensureObject = () => {
    if (current) return current;
    if (objects.length >= budgets.maxObjects) {
      fail(`OBJ source exceeds the ${budgets.maxObjects}-object limit`);
    }
    current = createParsedObject(
      objects.length,
      `Object ${objects.length + 1}`,
    );
    objects.push(current);
    return current;
  };

  const beginObject = (rawName: string, directive: string) => {
    const name = objectName(
      rawName,
      `${directive} ${objects.length + 1}`,
      budgets,
    );
    if (
      current &&
      current.triangles.length === 0 &&
      current.lineCount === 0 &&
      current.pointCount === 0 &&
      current.referencedVertices.size === 0
    ) {
      current.name = name;
      return;
    }
    if (objects.length >= budgets.maxObjects) {
      fail(`OBJ source exceeds the ${budgets.maxObjects}-object limit`);
    }
    current = createParsedObject(objects.length, name);
    objects.push(current);
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if ((lineIndex & 1023) === 0) checkpoint("OBJ parsing");
    const trimmed = lines[lineIndex].trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#")) {
      if (comments.length < 32) comments.push(trimmed.slice(1).trim());
      continue;
    }
    const firstWhitespace = trimmed.search(/\s/);
    const directive =
      firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
    const remainder =
      firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace).trim();
    const values = remainder ? remainder.split(/\s+/) : [];
    const context = `OBJ line ${lineIndex + 1}`;

    switch (directive) {
      case "v": {
        if (values.length !== 3 && values.length !== 4) {
          fail(
            `${context} vertex must contain three coordinates and optional w=1`,
          );
        }
        if (vertices.length >= budgets.maxVertices) {
          fail(`OBJ source exceeds the ${budgets.maxVertices}-vertex limit`);
        }
        const point: Vec3 = [
          parseObjNumber(values[0], `${context} x`),
          parseObjNumber(values[1], `${context} y`),
          parseObjNumber(values[2], `${context} z`),
        ];
        if (
          values.length === 4 &&
          parseObjNumber(values[3], `${context} w`) !== 1
        ) {
          fail(`${context} uses an unsupported non-unit homogeneous vertex`);
        }
        vertices.push(point);
        break;
      }
      case "vt": {
        if (values.length !== 2 && values.length !== 3) {
          fail(
            `${context} texcoord must contain two coordinates and optional w`,
          );
        }
        if (texcoords.length >= budgets.maxTexcoords) {
          fail(`OBJ source exceeds the ${budgets.maxTexcoords}-texcoord limit`);
        }
        texcoords.push([
          parseObjNumber(values[0], `${context} u`),
          parseObjNumber(values[1], `${context} v`),
        ]);
        if (values.length === 3) parseObjNumber(values[2], `${context} w`);
        break;
      }
      case "vn": {
        if (values.length !== 3)
          fail(`${context} normal must contain three coordinates`);
        if (normals.length >= budgets.maxNormals) {
          fail(`OBJ source exceeds the ${budgets.maxNormals}-normal limit`);
        }
        const normal: Vec3 = [
          parseObjNumber(values[0], `${context} nx`),
          parseObjNumber(values[1], `${context} ny`),
          parseObjNumber(values[2], `${context} nz`),
        ];
        if (lengthSquared(normal) <= EPSILON_SQUARED)
          fail(`${context} normal has zero length`);
        normals.push(normal);
        break;
      }
      case "f": {
        if (values.length < 3 || values.length > budgets.maxFaceVertices) {
          fail(
            `${context} face must contain 3-${budgets.maxFaceVertices} corners`,
          );
        }
        faceCount += 1;
        if (faceCount > budgets.maxFaces) {
          fail(`OBJ source exceeds the ${budgets.maxFaces}-face limit`);
        }
        const object = ensureObject();
        const corners = values.map((value, cornerIndex) =>
          objCorner(
            value,
            {
              vertices: vertices.length,
              texcoords: texcoords.length,
              normals: normals.length,
            },
            `${context} corner ${cornerIndex + 1}`,
          ),
        );
        for (const corner of corners)
          object.referencedVertices.add(corner.vertex);
        if (activeMaterial) object.materials.add(activeMaterial);
        for (let index = 1; index + 1 < corners.length; index += 1) {
          sourceTriangles += 1;
          if (sourceTriangles > budgets.maxTriangles) {
            fail(
              `OBJ source exceeds the ${budgets.maxTriangles}-triangle limit`,
            );
          }
          const triangle: Triangle = [
            vertices[corners[0].vertex],
            vertices[corners[index].vertex],
            vertices[corners[index + 1].vertex],
          ];
          if (!triangleNormal(triangle)) {
            object.discardedDegenerateTriangles += 1;
            discardedDegenerateTriangles += 1;
            continue;
          }
          object.triangles.push(triangle);
        }
        break;
      }
      case "l": {
        if (values.length < 2)
          fail(`${context} line must reference at least two vertices`);
        const object = ensureObject();
        const path: Vec3[] = [];
        for (const value of values) {
          const vertexToken = value.split("/")[0];
          const index = objIndex(
            vertexToken,
            vertices.length,
            `${context} line vertex`,
          );
          object.referencedVertices.add(index);
          path.push(vertices[index]);
        }
        object.linePaths.push(path);
        object.lineCount += 1;
        break;
      }
      case "p": {
        if (values.length === 0)
          fail(`${context} point must reference at least one vertex`);
        const object = ensureObject();
        for (const value of values) {
          const index = objIndex(
            value,
            vertices.length,
            `${context} point vertex`,
          );
          object.referencedVertices.add(index);
        }
        object.pointCount += values.length;
        break;
      }
      case "o":
      case "g":
        if (!remainder) fail(`${context} ${directive} name is empty`);
        beginObject(remainder, directive === "o" ? "Object" : "Group");
        break;
      case "usemtl": {
        if (!remainder) fail(`${context} material name is empty`);
        activeMaterial = objectName(remainder, "Material", budgets);
        materialNames.add(activeMaterial);
        if (materialNames.size > budgets.maxMaterials) {
          fail(`OBJ source exceeds the ${budgets.maxMaterials}-material limit`);
        }
        break;
      }
      case "s":
        if (!/^(?:off|on|0|[1-9][0-9]*)$/i.test(remainder)) {
          fail(`${context} contains an invalid smoothing-group value`);
        }
        break;
      case "mtllib":
        fail(
          `${context} references an external material library; external refs are forbidden`,
        );
      default:
        fail(`${context} uses unsupported OBJ directive ${directive}`);
    }
  }

  checkpoint("OBJ inspection");
  if (vertices.length === 0) fail("OBJ source contains no vertices");
  if (objects.length === 0) fail("OBJ source contains no inspectable objects");
  const degenerateFraction =
    sourceTriangles === 0 ? 0 : discardedDegenerateTriangles / sourceTriangles;
  if (
    discardedDegenerateTriangles > budgets.maxDegenerateTriangles ||
    degenerateFraction > budgets.maxDegenerateFraction
  ) {
    fail(
      "OBJ source contains too much degenerate triangle geometry to clean safely",
    );
  }

  const faceNames = new Set(
    objects
      .filter((object) => object.triangles.length > 0)
      .map((object) => object.name.toLowerCase()),
  );
  const pairedCurveHelpers = objects.filter((object) => {
    if (object.lineCount === 0 || object.triangles.length > 0) return false;
    const lower = object.name.toLowerCase();
    if (!lower.endsWith("_curve")) return false;
    return faceNames.has(lower.slice(0, -"_curve".length));
  }).length;
  const hasAhsMarker = comments.some((comment) =>
    comment
      .toLowerCase()
      .includes("anime hair studio mesh and center-curve export"),
  );
  const sourceMode: HairImportSourceMode =
    hasAhsMarker && pairedCurveHelpers > 0 ? "ahs-like-obj" : "generic-obj";
  const receipts: HairImportReceiptEntryV1[] = [
    receipt(
      "generated",
      "source-mode",
      sourceMode === "ahs-like-obj"
        ? `Content contains the AHS export marker and ${pairedCurveHelpers} polygon/curve object pair(s); no calibration was inferred.`
        : "No trusted calibration was inferred from OBJ content.",
      pairedCurveHelpers,
    ),
  ];
  for (const object of objects) {
    const entry = inventoryEntry(object);
    receipts.push(
      receipt(
        entry.defaultDecision === "keep" ? "kept" : "removed",
        entry.objectId,
        entry.defaultReason,
        entry.triangleCount || entry.lineCount || entry.pointCount || null,
      ),
    );
  }
  if (discardedDegenerateTriangles > 0) {
    receipts.push(
      receipt(
        "removed",
        "degenerate-triangles",
        "Zero-area triangles were culled within the bounded cleanup allowance.",
        discardedDegenerateTriangles,
      ),
    );
  }
  if (materialNames.size > 0) {
    receipts.push(
      receipt(
        "removed",
        "source-materials",
        "Source material assignments were inventoried and will be replaced by Batshit neutral material ownership.",
        materialNames.size,
      ),
    );
  }
  return {
    format: "obj",
    sourceMode,
    sourceBytes: bytes.byteLength,
    objects,
    materialCount: materialNames.size,
    discardedDegenerateTriangles,
    receipts,
  };
}

function readUint32(bytes: Uint8Array, offset: number, context: string) {
  if (offset < 0 || offset + 4 > bytes.byteLength)
    fail(`${context} is out of bounds`);
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset, true);
}

function scanJsonDepth(text: string, budgets: HairImportBudgets) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > budgets.maxJsonDepth) {
        fail(`GLB JSON exceeds the ${budgets.maxJsonDepth}-level depth limit`);
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) fail("GLB JSON delimiters are unbalanced");
    }
  }
  if (inString || depth !== 0) fail("GLB JSON structure is incomplete");
}

function preflightGlbContainer(bytes: Uint8Array, budgets: HairImportBudgets) {
  if (bytes.byteLength < 28) fail("GLB source is truncated");
  if (readUint32(bytes, 0, "GLB magic") !== GLB_MAGIC)
    fail("GLB magic is invalid");
  if (readUint32(bytes, 4, "GLB version") !== GLB_VERSION)
    fail("GLB source must use glTF 2");
  if (readUint32(bytes, 8, "GLB length") !== bytes.byteLength) {
    fail("GLB declared length does not match its bytes");
  }
  const jsonLength = readUint32(bytes, 12, "GLB JSON chunk length");
  if (readUint32(bytes, 16, "GLB JSON chunk type") !== GLB_JSON_CHUNK) {
    fail("GLB first chunk must be JSON");
  }
  if (jsonLength > budgets.maxJsonBytes) {
    fail(`GLB JSON exceeds the ${budgets.maxJsonBytes}-byte limit`);
  }
  if (20 + jsonLength > bytes.byteLength) fail("GLB JSON chunk is truncated");
  let jsonText: string;
  try {
    jsonText = UTF8.decode(bytes.subarray(20, 20 + jsonLength)).replace(
      /[\u0000\u0020]+$/g,
      "",
    );
  } catch (error) {
    fail(`GLB JSON is not valid UTF-8: ${String(error)}`);
  }
  scanJsonDepth(jsonText, budgets);
}

function validateJsonBudget(value: unknown, budgets: HairImportBudgets) {
  const stack: unknown[] = [value];
  let values = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    values += 1;
    if (values > budgets.maxJsonValues) {
      fail(`GLB JSON exceeds the ${budgets.maxJsonValues}-value limit`);
    }
    if (Array.isArray(current)) {
      if (current.length > budgets.maxJsonArrayEntries) {
        fail(
          `GLB JSON array exceeds the ${budgets.maxJsonArrayEntries}-entry limit`,
        );
      }
      for (const entry of current) stack.push(entry);
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    for (const [key, entry] of Object.entries(
      current as Record<string, unknown>,
    )) {
      if (key === "uri")
        fail("GLB contains an external or embedded URI reference");
      if (key === "extensions" || key === "extras") {
        fail(
          `GLB ${key} content is outside the geometry-only Hair import boundary`,
        );
      }
      stack.push(entry);
    }
  }
}

function enforceArrayLimit(value: unknown, name: string, limit: number) {
  const entries = optionalArray(value, name);
  if (entries.length > limit) fail(`${name} exceeds the ${limit}-entry limit`);
  return entries;
}

function matrixMultiply(left: readonly number[], right: readonly number[]) {
  const result = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let inner = 0; inner < 4; inner += 1) {
        value += left[inner * 4 + row] * right[column * 4 + inner];
      }
      result[column * 4 + row] = Object.is(value, -0) ? 0 : value;
    }
  }
  return result;
}

function transformPoint(matrix: readonly number[], point: Vec3): Vec3 {
  const x = point[0];
  const y = point[1];
  const z = point[2];
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (!Number.isFinite(w) || Math.abs(w) <= 1e-12)
    fail("GLB node transform has invalid w");
  const transformed: Vec3 = [
    (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w,
    (matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14]) / w,
  ];
  transformed.forEach((entry, axis) =>
    finite(entry, `transformed position axis ${axis}`),
  );
  return transformed;
}

function matrixDeterminant3(matrix: readonly number[]) {
  const a = matrix[0];
  const b = matrix[4];
  const c = matrix[8];
  const d = matrix[1];
  const e = matrix[5];
  const f = matrix[9];
  const g = matrix[2];
  const h = matrix[6];
  const i = matrix[10];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function sourceWorldMatrices(
  parsed: SemanticGlbDocument,
  reachable: Set<number>,
) {
  const memo = new Map<number, number[]>();
  const resolve = (nodeIndex: number): number[] => {
    const existing = memo.get(nodeIndex);
    if (existing) return existing;
    const node = parsed.nodes[nodeIndex];
    const local = resolveSemanticGlbNodeTransform(
      node,
      `gltf.nodes[${nodeIndex}]`,
      {
        diagnosticPrefix: "hair-import-glb/v1",
      },
    ).matrix;
    const parentIndex = parsed.parents.get(nodeIndex);
    const world =
      parentIndex === undefined
        ? local
        : matrixMultiply(resolve(parentIndex), local);
    if (
      !Number.isFinite(matrixDeterminant3(world)) ||
      Math.abs(matrixDeterminant3(world)) < 1e-12
    ) {
      fail(`gltf.nodes[${nodeIndex}] has a degenerate world transform`);
    }
    memo.set(nodeIndex, world);
    return world;
  };
  for (const nodeIndex of reachable) resolve(nodeIndex);
  return memo;
}

function validateOptionalNormalAccessor(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
  positionCount: number,
  context: string,
) {
  if (accessorIndex === undefined) return;
  const accessor = decodeSemanticGlbAccessor(parsed, accessorIndex);
  if (
    accessor.type !== "VEC3" ||
    accessor.components !== 3 ||
    accessor.componentType !== 5126 ||
    accessor.normalized ||
    accessor.count !== positionCount
  ) {
    fail(
      `${context} NORMAL accessor must be FLOAT VEC3 with the POSITION count`,
    );
  }
  for (let row = 0; row < accessor.count; row += 1) {
    const normal: Vec3 = [
      accessor.values[row * 3],
      accessor.values[row * 3 + 1],
      accessor.values[row * 3 + 2],
    ];
    if (lengthSquared(normal) <= EPSILON_SQUARED)
      fail(`${context} contains a zero-length normal`);
  }
}

function validateOptionalUvAccessor(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
  positionCount: number,
  context: string,
) {
  if (accessorIndex === undefined) return;
  const accessor = decodeSemanticGlbAccessor(parsed, accessorIndex);
  if (
    accessor.type !== "VEC2" ||
    accessor.components !== 2 ||
    accessor.componentType !== 5126 ||
    accessor.normalized ||
    accessor.count !== positionCount
  ) {
    fail(
      `${context} TEXCOORD_0 accessor must be FLOAT VEC2 with the POSITION count`,
    );
  }
}

function parseGlbSource(
  bytes: Uint8Array,
  budgets: HairImportBudgets,
  checkpoint: (context: string) => void,
): ParsedHairImportSource {
  preflightGlbContainer(bytes, budgets);
  checkpoint("GLB container preflight");
  const parsed = parseSemanticGlb(bytes, {
    diagnosticPrefix: "hair-import-glb/v1",
  });
  validateJsonBudget(parsed.gltf, budgets);

  for (const field of ["animations", "skins", "cameras"] as const) {
    if (optionalArray(parsed.gltf[field], `gltf.${field}`).length > 0) {
      fail(
        `GLB ${field} content is unsupported; only ordinary polygon geometry may be imported`,
      );
    }
  }
  const images = enforceArrayLimit(
    parsed.gltf.images,
    "gltf.images",
    budgets.maxMaterials,
  );
  const textures = enforceArrayLimit(
    parsed.gltf.textures,
    "gltf.textures",
    budgets.maxMaterials,
  );
  const samplers = enforceArrayLimit(
    parsed.gltf.samplers,
    "gltf.samplers",
    budgets.maxMaterials,
  );
  const rawBufferViews = optionalArray(
    parsed.gltf.bufferViews,
    "gltf.bufferViews",
  );
  images.forEach((value, index) => {
    const image = record(value, `gltf.images[${index}]`);
    if (image.uri !== undefined) {
      fail(
        `gltf.images[${index}] uses an external/data URI; Hair import accepts embedded GLB images only`,
      );
    }
    const bufferView = safeInteger(
      image.bufferView,
      `gltf.images[${index}].bufferView`,
    );
    if (bufferView >= rawBufferViews.length) {
      fail(`gltf.images[${index}].bufferView is out of range`);
    }
    if (
      image.mimeType !== "image/png" &&
      image.mimeType !== "image/jpeg" &&
      image.mimeType !== "image/webp"
    ) {
      fail(`gltf.images[${index}] uses an unsupported embedded image type`);
    }
  });
  textures.forEach((value, index) => {
    const texture = record(value, `gltf.textures[${index}]`);
    const source = safeInteger(
      texture.source,
      `gltf.textures[${index}].source`,
    );
    if (source >= images.length)
      fail(`gltf.textures[${index}].source is out of range`);
    if (texture.sampler !== undefined) {
      const sampler = safeInteger(
        texture.sampler,
        `gltf.textures[${index}].sampler`,
      );
      if (sampler >= samplers.length) {
        fail(`gltf.textures[${index}].sampler is out of range`);
      }
    }
  });
  for (const field of [
    "extensions",
    "extensionsUsed",
    "extensionsRequired",
  ] as const) {
    if (parsed.gltf[field] !== undefined) {
      fail(
        `GLB ${field} content is unsupported in the geometry-only Hair import boundary`,
      );
    }
  }
  if (parsed.skins.length > 0)
    fail("GLB skeletons are unsupported for Hair import");
  const nodes = enforceArrayLimit(
    parsed.gltf.nodes,
    "gltf.nodes",
    budgets.maxGlbNodes,
  );
  const meshes = enforceArrayLimit(
    parsed.gltf.meshes,
    "gltf.meshes",
    budgets.maxGlbMeshes,
  );
  const accessors = enforceArrayLimit(
    parsed.gltf.accessors,
    "gltf.accessors",
    budgets.maxGlbAccessors,
  );
  enforceArrayLimit(
    parsed.gltf.bufferViews,
    "gltf.bufferViews",
    budgets.maxGlbBufferViews,
  );
  const materials = enforceArrayLimit(
    parsed.gltf.materials,
    "gltf.materials",
    budgets.maxMaterials,
  );
  const scenes = optionalArray(parsed.gltf.scenes, "gltf.scenes");
  if (
    scenes.length !== 1 ||
    (parsed.gltf.scene !== undefined && parsed.gltf.scene !== 0)
  ) {
    fail("GLB Hair import requires exactly one active scene");
  }
  const scene = record(scenes[0], "gltf.scenes[0]");
  const roots = array(scene.nodes, "gltf.scenes[0].nodes").map((value, index) =>
    safeInteger(value, `gltf.scenes[0].nodes[${index}]`),
  );
  if (roots.length === 0) fail("GLB active scene has no root nodes");
  const reachable = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const nodeIndex = pending.pop()!;
    if (nodeIndex >= nodes.length)
      fail("GLB scene references an out-of-range node");
    if (reachable.has(nodeIndex)) continue;
    reachable.add(nodeIndex);
    const node = record(nodes[nodeIndex], `gltf.nodes[${nodeIndex}]`);
    for (const child of optionalArray(
      node.children,
      `gltf.nodes[${nodeIndex}].children`,
    )) {
      pending.push(safeInteger(child, `gltf.nodes[${nodeIndex}].children[]`));
    }
  }
  if (reachable.size !== nodes.length) {
    fail("GLB contains nodes outside its active scene");
  }
  const worlds = sourceWorldMatrices(parsed, reachable);
  const referencedMeshes = new Set<number>();
  const objects: ParsedObject[] = [];
  let primitiveCount = 0;
  let sourceVertexCount = 0;
  let sourceTriangles = 0;
  let discardedDegenerateTriangles = 0;

  for (const nodeIndex of [...reachable].sort((left, right) => left - right)) {
    checkpoint("GLB geometry inspection");
    const node = record(nodes[nodeIndex], `gltf.nodes[${nodeIndex}]`);
    if (
      node.camera !== undefined ||
      node.skin !== undefined ||
      node.weights !== undefined
    ) {
      fail(`gltf.nodes[${nodeIndex}] contains unsupported scene behavior`);
    }
    if (node.mesh === undefined) continue;
    const meshIndex = safeInteger(node.mesh, `gltf.nodes[${nodeIndex}].mesh`);
    if (meshIndex >= meshes.length)
      fail(`gltf.nodes[${nodeIndex}].mesh is out of range`);
    referencedMeshes.add(meshIndex);
    const mesh = record(meshes[meshIndex], `gltf.meshes[${meshIndex}]`);
    if (mesh.weights !== undefined)
      fail(`gltf.meshes[${meshIndex}] morph weights are unsupported`);
    const primitives = array(
      mesh.primitives,
      `gltf.meshes[${meshIndex}].primitives`,
    );
    if (primitives.length === 0)
      fail(`gltf.meshes[${meshIndex}] contains no primitives`);
    for (
      let primitiveIndex = 0;
      primitiveIndex < primitives.length;
      primitiveIndex += 1
    ) {
      primitiveCount += 1;
      if (primitiveCount > budgets.maxGlbPrimitives) {
        fail(`GLB exceeds the ${budgets.maxGlbPrimitives}-primitive limit`);
      }
      const context = `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`;
      const primitive = record(primitives[primitiveIndex], context);
      if (primitive.mode !== undefined && primitive.mode !== 4) {
        fail(`${context} must use TRIANGLES mode`);
      }
      if (primitive.targets !== undefined)
        fail(`${context} morph targets are unsupported`);
      const attributes = record(primitive.attributes, `${context}.attributes`);
      const unsupportedAttributes = Object.keys(attributes).filter(
        (key) => !["POSITION", "NORMAL", "TEXCOORD_0"].includes(key),
      );
      if (unsupportedAttributes.length > 0) {
        fail(
          `${context} contains unsupported attributes: ${unsupportedAttributes.join(", ")}`,
        );
      }
      if (attributes.POSITION === undefined)
        fail(`${context} is missing POSITION`);
      const positionInfo = inspectSemanticGlbAccessor(
        parsed,
        attributes.POSITION,
      );
      if (
        positionInfo.type !== "VEC3" ||
        positionInfo.components !== 3 ||
        positionInfo.componentType !== 5126 ||
        positionInfo.normalized
      ) {
        fail(`${context} POSITION accessor must be non-normalized FLOAT VEC3`);
      }
      sourceVertexCount += positionInfo.count;
      if (sourceVertexCount > budgets.maxVertices) {
        fail(`GLB exceeds the ${budgets.maxVertices}-vertex limit`);
      }
      validateOptionalNormalAccessor(
        parsed,
        attributes.NORMAL,
        positionInfo.count,
        context,
      );
      validateOptionalUvAccessor(
        parsed,
        attributes.TEXCOORD_0,
        positionInfo.count,
        context,
      );
      const positions = decodeSemanticGlbAccessor(parsed, attributes.POSITION);
      const indices: number[] = [];
      if (primitive.indices === undefined) {
        if (positions.count % 3 !== 0)
          fail(`${context} non-indexed position count is not triangular`);
        for (let index = 0; index < positions.count; index += 1)
          indices.push(index);
      } else {
        const indexAccessor = decodeSemanticGlbAccessor(
          parsed,
          primitive.indices,
        );
        if (
          indexAccessor.type !== "SCALAR" ||
          indexAccessor.components !== 1 ||
          ![5121, 5123, 5125].includes(indexAccessor.componentType) ||
          indexAccessor.normalized ||
          indexAccessor.count % 3 !== 0
        ) {
          fail(
            `${context} indices must be non-normalized unsigned SCALAR triangles`,
          );
        }
        for (let index = 0; index < indexAccessor.count; index += 1) {
          const value = indexAccessor.values[index];
          if (
            !Number.isSafeInteger(value) ||
            value < 0 ||
            value >= positions.count
          ) {
            fail(`${context} contains an out-of-range index`);
          }
          indices.push(value);
        }
      }
      sourceTriangles += indices.length / 3;
      if (sourceTriangles > budgets.maxTriangles) {
        fail(`GLB exceeds the ${budgets.maxTriangles}-triangle limit`);
      }
      const world = worlds.get(nodeIndex)!;
      const referencedVertices = new Set<number>();
      const triangles: Triangle[] = [];
      let objectDegenerate = 0;
      for (let index = 0; index < indices.length; index += 3) {
        if ((index & 4095) === 0) checkpoint("GLB triangle conversion");
        const triangle = [
          indices[index],
          indices[index + 1],
          indices[index + 2],
        ].map((vertexIndex) => {
          referencedVertices.add(vertexIndex);
          return transformPoint(world, [
            positions.values[vertexIndex * 3],
            positions.values[vertexIndex * 3 + 1],
            positions.values[vertexIndex * 3 + 2],
          ]);
        }) as [Vec3, Vec3, Vec3];
        if (!triangleNormal(triangle)) {
          objectDegenerate += 1;
          discardedDegenerateTriangles += 1;
          continue;
        }
        triangles.push(triangle);
      }
      const materialSet = new Set<string>();
      if (primitive.material !== undefined) {
        const materialIndex = safeInteger(
          primitive.material,
          `${context}.material`,
        );
        if (materialIndex >= materials.length)
          fail(`${context}.material is out of range`);
        const material = record(
          materials[materialIndex],
          `gltf.materials[${materialIndex}]`,
        );
        materialSet.add(
          typeof material.name === "string" && material.name.trim()
            ? material.name.trim()
            : `Material ${materialIndex + 1}`,
        );
      }
      const nodeName =
        typeof node.name === "string" && node.name.trim()
          ? node.name.trim()
          : typeof mesh.name === "string" && mesh.name.trim()
            ? mesh.name.trim()
            : `Node ${nodeIndex + 1}`;
      objects.push({
        objectId: `object-${String(objects.length + 1).padStart(4, "0")}`,
        name:
          primitives.length === 1
            ? nodeName
            : `${nodeName} / Primitive ${primitiveIndex + 1}`,
        sourceIndex: objects.length,
        triangles,
        referencedVertices,
        linePaths: [],
        lineCount: 0,
        pointCount: 0,
        materials: materialSet,
        discardedDegenerateTriangles: objectDegenerate,
      });
      if (objects.length > budgets.maxObjects) {
        fail(`GLB exceeds the ${budgets.maxObjects}-object inventory limit`);
      }
    }
  }
  if (referencedMeshes.size !== meshes.length) {
    fail("GLB contains mesh resources outside its active scene");
  }
  if (objects.length === 0)
    fail("GLB active scene contains no polygon mesh objects");
  const degenerateFraction =
    sourceTriangles === 0 ? 0 : discardedDegenerateTriangles / sourceTriangles;
  if (
    discardedDegenerateTriangles > budgets.maxDegenerateTriangles ||
    degenerateFraction > budgets.maxDegenerateFraction
  ) {
    fail("GLB contains too much degenerate triangle geometry to clean safely");
  }
  const receipts: HairImportReceiptEntryV1[] = [
    receipt(
      "generated",
      "source-mode",
      "Embedded polygon GLB content uses generic fitting; no source calibration was inferred.",
      null,
    ),
  ];
  for (const object of objects) {
    const entry = inventoryEntry(object);
    receipts.push(
      receipt("kept", entry.objectId, entry.defaultReason, entry.triangleCount),
    );
  }
  if (discardedDegenerateTriangles > 0) {
    receipts.push(
      receipt(
        "removed",
        "degenerate-triangles",
        "Zero-area triangles were culled within the bounded cleanup allowance.",
        discardedDegenerateTriangles,
      ),
    );
  }
  if (materials.length > 0) {
    receipts.push(
      receipt(
        "removed",
        "source-materials",
        "Source materials were inventoried and will be replaced by Batshit neutral material ownership.",
        materials.length,
      ),
    );
  }
  if (images.length > 0 || textures.length > 0) {
    receipts.push(
      receipt(
        "removed",
        "source-textures",
        "Embedded source textures were inventoried and removed with source material ownership.",
        images.length,
      ),
    );
  }
  checkpoint("GLB inspection");
  return {
    format: "glb",
    sourceMode: "generic-glb",
    sourceBytes: bytes.byteLength,
    objects,
    materialCount: materials.length,
    discardedDegenerateTriangles,
    receipts,
  };
}

function parseSource(input: InspectHairImportSourceInput) {
  const budgets = normalizedBudgets(input.budgets);
  validateBytes(input.bytes, budgets);
  const extensionFormat = validateFilename(input.filename);
  const format = sourceFormat(input.bytes);
  if (extensionFormat && extensionFormat !== format) {
    fail(
      `filename extension ${extensionFormat} does not match ${format} source content`,
    );
  }
  const checkpoint = createDeadline(input.now, budgets);
  const parsed =
    format === "glb"
      ? parseGlbSource(input.bytes, budgets, checkpoint)
      : parseObjSource(input.bytes, budgets, checkpoint);
  checkpoint("source inspection");
  return { budgets, checkpoint, parsed };
}

export function inspectHairImportSource(
  input: InspectHairImportSourceInput,
): HairImportInspectionV1 {
  if (!input || typeof input !== "object")
    fail("inspection input must be an object");
  return inspectionFromParsed(parseSource(input).parsed);
}

function finiteVector(
  value: readonly number[] | null | undefined,
  fallback: Vec3,
  context: string,
) {
  if (value === undefined || value === null) return cloneVec3(fallback);
  if (!Array.isArray(value) || value.length !== 3)
    fail(`${context} must contain exactly 3 numbers`);
  return value.map((entry, axis) =>
    finite(entry, `${context}[${axis}]`),
  ) as Vec3;
}

function normalizeAngle(value: number) {
  const fullTurn = Math.PI * 2;
  const normalized =
    ((((value + Math.PI) % fullTurn) + fullTurn) % fullTurn) - Math.PI;
  return Object.is(normalized, -0) ? 0 : normalized;
}

export function normalizeHairImportTransform(
  value?: HairImportTransformInput | null,
  budgetOverrides?: Partial<HairImportBudgets>,
): HairImportTransformV1 {
  const budgets = normalizedBudgets(budgetOverrides);
  if (value !== undefined && value !== null && typeof value !== "object") {
    fail("Hair import transform must be an object");
  }
  const translation = finiteVector(
    value?.translation,
    IDENTITY_TRANSFORM.translation,
    "translation",
  );
  if (translation.some((entry) => Math.abs(entry) > budgets.maxTranslation)) {
    fail(`translation must stay within ±${budgets.maxTranslation}`);
  }
  const rotation = finiteVector(
    value?.rotation,
    IDENTITY_TRANSFORM.rotation,
    "rotation",
  ).map(normalizeAngle) as Vec3;
  const uniformScale = finite(value?.uniformScale ?? 1, "uniformScale");
  if (
    uniformScale < budgets.minUniformScale ||
    uniformScale > budgets.maxUniformScale
  ) {
    fail(
      `uniformScale must be ${budgets.minUniformScale}-${budgets.maxUniformScale}`,
    );
  }
  const axisScale = finiteVector(
    value?.axisScale,
    IDENTITY_TRANSFORM.axisScale,
    "axisScale",
  );
  if (
    axisScale.some(
      (entry) => entry < budgets.minAxisScale || entry > budgets.maxAxisScale,
    )
  ) {
    fail(
      `axisScale entries must be ${budgets.minAxisScale}-${budgets.maxAxisScale}`,
    );
  }
  return {
    contract: HAIR_IMPORT_TRANSFORM_CONTRACT,
    translation,
    rotation,
    uniformScale,
    axisScale,
  };
}

function applyImportTransform(
  point: Vec3,
  transform: HairImportTransformV1,
): Vec3 {
  let x = point[0] * transform.uniformScale * transform.axisScale[0];
  let y = point[1] * transform.uniformScale * transform.axisScale[1];
  let z = point[2] * transform.uniformScale * transform.axisScale[2];
  const [rx, ry, rz] = transform.rotation;
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const nextY = y * cosX - z * sinX;
  const nextZ = y * sinX + z * cosX;
  y = nextY;
  z = nextZ;
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const nextX = x * cosY + z * sinY;
  z = -x * sinY + z * cosY;
  x = nextX;
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  const rotatedX = x * cosZ - y * sinZ;
  const rotatedY = x * sinZ + y * cosZ;
  const result: Vec3 = [
    rotatedX + transform.translation[0],
    rotatedY + transform.translation[1],
    z + transform.translation[2],
  ];
  result.forEach((entry, axis) =>
    finite(entry, `transformed import position axis ${axis}`),
  );
  return result;
}

function floatPoint(point: Vec3): Vec3 {
  const result = point.map((entry) => Math.fround(entry)) as Vec3;
  if (result.some((entry) => !Number.isFinite(entry))) {
    fail("transformed geometry exceeds finite Float32 range");
  }
  return result;
}

function calibrationPoint(value: unknown, context: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(`${context} must contain exactly three coordinates`);
  }
  return value.map((entry, axis) =>
    finite(entry, `${context} axis ${axis}`),
  ) as Vec3;
}

function calibrationPoints(value: unknown, context: string): Vec3[] {
  if (!Array.isArray(value) || value.length !== 112) {
    fail(`${context} must contain exactly 112 points`);
  }
  return value.map((entry, index) =>
    calibrationPoint(entry, `${context}[${index}]`),
  );
}

function normalizeSourceCalibration(
  value: HairImportSourceCalibrationV1 | null | undefined,
): HairImportSourceCalibrationV1 | null {
  if (value === null || value === undefined) return null;
  if (
    !value ||
    typeof value !== "object" ||
    value.contract !== "hair-import-source-calibration/v1"
  ) {
    fail("source calibration uses an unsupported contract");
  }
  if (value.mode === "registered-template/v1") {
    if (value.sourceScalpPoints !== null || value.targetScalpPoints !== null) {
      fail("registered-template calibration cannot contain scalp deformation");
    }
    return {
      contract: "hair-import-source-calibration/v1",
      mode: "registered-template/v1",
      sourceScalpPoints: null,
      targetScalpPoints: null,
    };
  }
  if (value.mode !== "stock-scalp-deformation/v1") {
    fail("source calibration uses an unsupported mode");
  }
  return {
    contract: "hair-import-source-calibration/v1",
    mode: "stock-scalp-deformation/v1",
    sourceScalpPoints: calibrationPoints(
      value.sourceScalpPoints,
      "source scalp calibration",
    ),
    targetScalpPoints: calibrationPoints(
      value.targetScalpPoints,
      "target scalp calibration",
    ),
  };
}

function uniqueIds(values: readonly string[] | undefined, context: string) {
  if (values === undefined) return null;
  if (!Array.isArray(values)) fail(`${context} must be an array`);
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !/^object-[0-9]{4}$/.test(value)) {
      fail(`${context} contains an invalid object id`);
    }
    if (result.has(value))
      fail(`${context} contains duplicate object id ${value}`);
    result.add(value);
  }
  return result;
}

function selectObjects(
  objects: readonly ParsedObject[],
  keepValues: readonly string[] | undefined,
  removeValues: readonly string[] | undefined,
) {
  const known = new Map(objects.map((object) => [object.objectId, object]));
  const requestedKeep = uniqueIds(keepValues, "keepObjectIds");
  const requestedRemove =
    uniqueIds(removeValues, "removeObjectIds") ?? new Set<string>();
  for (const id of [...(requestedKeep ?? []), ...requestedRemove]) {
    if (!known.has(id)) fail(`selection references unknown object id ${id}`);
  }
  for (const id of requestedKeep ?? []) {
    if (requestedRemove.has(id)) fail(`selection both keeps and removes ${id}`);
    if (known.get(id)!.triangles.length === 0) {
      fail(`selection cannot keep non-polygon object ${id}`);
    }
  }
  const kept = objects.filter((object) => {
    if (requestedRemove.has(object.objectId)) return false;
    if (requestedKeep) return requestedKeep.has(object.objectId);
    return object.triangles.length > 0;
  });
  if (kept.length === 0)
    fail("Hair import selection must keep at least one polygon object");
  const removed = objects.filter((object) => !kept.includes(object));
  return { kept, removed };
}

type CanonicalObjectGeometry = {
  object: ParsedObject;
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  bounds: Bounds3;
  triangleCount: number;
};

function projectionAxes(bounds: Bounds3): [number, number] {
  const extents = bounds.max.map((entry, axis) => entry - bounds.min[axis]);
  const axes = [0, 1, 2].sort(
    (left, right) => extents[right] - extents[left] || left - right,
  );
  return [axes[0], axes[1]];
}

function projectedUv(
  point: Vec3,
  bounds: Bounds3,
  axes: [number, number],
): Vec2 {
  const result: Vec2 = [0.5, 0.5];
  for (let index = 0; index < 2; index += 1) {
    const axis = axes[index];
    const extent = bounds.max[axis] - bounds.min[axis];
    result[index] =
      extent <= 1e-12 ? 0.5 : (point[axis] - bounds.min[axis]) / extent;
  }
  return result;
}

function closestCurveProgress(point: Vec3, path: readonly Vec3[]) {
  if (path.length < 2) fail("paired AHS curve contains fewer than two points");
  const lengths: number[] = [];
  let totalLength = 0;
  for (let index = 0; index + 1 < path.length; index += 1) {
    const length = Math.sqrt(lengthSquared(subtract(path[index + 1], path[index])));
    if (!Number.isFinite(length) || length <= 1e-10) {
      fail("paired AHS curve contains a zero-length segment");
    }
    lengths.push(length);
    totalLength += length;
  }
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestProgress = 0;
  let prefix = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const start = path[index];
    const segment = subtract(path[index + 1], start);
    const relative = subtract(point, start);
    const denominator = lengthSquared(segment);
    const projection = Math.min(
      1,
      Math.max(
        0,
        (relative[0] * segment[0] +
          relative[1] * segment[1] +
          relative[2] * segment[2]) /
          denominator,
      ),
    );
    const closest: Vec3 = [
      start[0] + segment[0] * projection,
      start[1] + segment[1] * projection,
      start[2] + segment[2] * projection,
    ];
    const distance = lengthSquared(subtract(point, closest));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestProgress = (prefix + lengths[index] * projection) / totalLength;
    }
    prefix += lengths[index];
  }
  return bestProgress;
}

function weightedScalpDelta(
  point: Vec3,
  sourcePoints: readonly Vec3[],
  targetPoints: readonly Vec3[],
): Vec3 {
  const nearest = sourcePoints
    .map((source, index) => ({
      index,
      distance: lengthSquared(subtract(point, source)),
    }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index)
    .slice(0, 4);
  if (nearest[0].distance <= 1e-12) {
    return subtract(targetPoints[nearest[0].index], sourcePoints[nearest[0].index]);
  }
  let weightTotal = 0;
  const delta: Vec3 = [0, 0, 0];
  for (const entry of nearest) {
    const weight = 1 / Math.max(entry.distance, 1e-10);
    const local = subtract(targetPoints[entry.index], sourcePoints[entry.index]);
    delta[0] += local[0] * weight;
    delta[1] += local[1] * weight;
    delta[2] += local[2] * weight;
    weightTotal += weight;
  }
  return delta.map((entry) => entry / weightTotal) as Vec3;
}

function buildSourceDeformer(
  sourceObjects: readonly ParsedObject[],
  calibration: HairImportSourceCalibrationV1 | null,
) {
  if (!calibration || calibration.mode === "registered-template/v1") {
    return (_object: ParsedObject, point: Vec3): Vec3 => point;
  }
  const sourcePoints = calibration.sourceScalpPoints!;
  const targetPoints = calibration.targetScalpPoints!;
  const curves = new Map<string, Vec3[]>();
  for (const object of sourceObjects) {
    if (object.triangles.length > 0 || object.linePaths.length === 0) continue;
    const key = object.name.toLowerCase();
    if (curves.has(key) || object.linePaths.length !== 1) {
      fail(`AHS curve helper ${object.name} must contain one unique path`);
    }
    curves.set(key, object.linePaths[0]);
  }
  const perObject = new Map<string, { path: Vec3[]; rootDelta: Vec3 }>();
  return (object: ParsedObject, point: Vec3): Vec3 => {
    let entry = perObject.get(object.objectId);
    if (!entry) {
      const path = curves.get(`${object.name.toLowerCase()}_curve`);
      if (!path) {
        fail(`AHS stock conversion requires a paired curve for ${object.name}`);
      }
      entry = {
        path,
        rootDelta: weightedScalpDelta(path[0], sourcePoints, targetPoints),
      };
      perObject.set(object.objectId, entry);
    }
    const progress = closestCurveProgress(point, entry.path);
    const smooth = progress * progress * (3 - 2 * progress);
    const influence = 1 - smooth;
    return [
      point[0] + entry.rootDelta[0] * influence,
      point[1] + entry.rootDelta[1] * influence,
      point[2] + entry.rootDelta[2] * influence,
    ];
  };
}

function buildCanonicalGeometry(
  objects: readonly ParsedObject[],
  sourceObjects: readonly ParsedObject[],
  transform: HairImportTransformV1,
  calibration: HairImportSourceCalibrationV1 | null,
  budgets: HairImportBudgets,
  checkpoint: (context: string) => void,
) {
  const sourceDeformer = buildSourceDeformer(sourceObjects, calibration);
  const transformedByObject = objects.map((object) => ({
    object,
    triangles: object.triangles.map(
      (triangle) =>
        triangle.map((point) =>
          floatPoint(
            applyImportTransform(sourceDeformer(object, point), transform),
          ),
        ) as [Vec3, Vec3, Vec3],
    ),
  }));
  let overallBounds: Bounds3 | null = null;
  let vertexCount = 0;
  let triangleCount = 0;
  for (const { triangles } of transformedByObject) {
    triangleCount += triangles.length;
    vertexCount += triangles.length * 3;
    if (
      triangleCount > budgets.maxTriangles ||
      vertexCount > budgets.maxCanonicalVertices
    ) {
      fail("selected Hair geometry exceeds the canonical output budget");
    }
    for (const triangle of triangles) {
      for (const point of triangle)
        overallBounds = expandBounds(overallBounds, point);
    }
  }
  if (!overallBounds) fail("selected Hair geometry has no valid bounds");
  const axes = projectionAxes(overallBounds);
  const geometry: CanonicalObjectGeometry[] = [];
  for (const { object, triangles } of transformedByObject) {
    const positions = new Float32Array(triangles.length * 9);
    const normals = new Float32Array(triangles.length * 9);
    const uvs = new Float32Array(triangles.length * 6);
    let bounds: Bounds3 | null = null;
    for (
      let triangleIndex = 0;
      triangleIndex < triangles.length;
      triangleIndex += 1
    ) {
      if ((triangleIndex & 1023) === 0)
        checkpoint("canonical geometry generation");
      const triangle = triangles[triangleIndex];
      const normal = triangleNormal(triangle);
      if (!normal)
        fail(
          `selected object ${object.objectId} became degenerate after fitting`,
        );
      for (let corner = 0; corner < 3; corner += 1) {
        const point = triangle[corner];
        positions.set(point, triangleIndex * 9 + corner * 3);
        normals.set(normal, triangleIndex * 9 + corner * 3);
        uvs.set(
          projectedUv(point, overallBounds, axes),
          triangleIndex * 6 + corner * 2,
        );
        bounds = expandBounds(bounds, point);
      }
    }
    if (!bounds)
      fail(
        `selected object ${object.objectId} contains no canonical triangles`,
      );
    geometry.push({
      object,
      positions,
      normals,
      uvs,
      bounds,
      triangleCount: triangles.length,
    });
  }
  return { geometry, bounds: overallBounds, vertexCount, triangleCount };
}

function appendAligned(chunks: Uint8Array[], bytes: Uint8Array) {
  const current = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const padding = (4 - (current % 4)) % 4;
  if (padding > 0) chunks.push(new Uint8Array(padding));
  const offset = current + padding;
  chunks.push(bytes);
  return offset;
}

function typedBytes(value: Float32Array) {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function canonicalGlb(geometry: readonly CanonicalObjectGeometry[]) {
  const chunks: Uint8Array[] = [];
  const bufferViews: Array<Record<string, unknown>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const meshes: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [
    {
      name: "HairImportRoot",
      children: geometry.map((_entry, index) => index + 1),
    },
  ];

  for (let index = 0; index < geometry.length; index += 1) {
    const entry = geometry[index];
    const attributes: Record<string, number> = {};
    for (const [semantic, arrayValue, type] of [
      ["POSITION", entry.positions, "VEC3"],
      ["NORMAL", entry.normals, "VEC3"],
      ["TEXCOORD_0", entry.uvs, "VEC2"],
    ] as const) {
      const offset = appendAligned(chunks, typedBytes(arrayValue));
      const bufferViewIndex = bufferViews.length;
      bufferViews.push({
        buffer: 0,
        byteOffset: offset,
        byteLength: arrayValue.byteLength,
        target: 34962,
      });
      const accessorIndex = accessors.length;
      const accessor: Record<string, unknown> = {
        bufferView: bufferViewIndex,
        componentType: 5126,
        count:
          semantic === "TEXCOORD_0"
            ? arrayValue.length / 2
            : arrayValue.length / 3,
        type,
      };
      if (semantic === "POSITION") {
        accessor.min = entry.bounds.min;
        accessor.max = entry.bounds.max;
      }
      accessors.push(accessor);
      attributes[semantic] = accessorIndex;
    }
    meshes.push({
      name: `HairMesh_${entry.object.objectId}`,
      primitives: [{ attributes, material: 0, mode: 4 }],
    });
    nodes.push({ name: `Hair_${entry.object.objectId}`, mesh: index });
  }

  const binaryLength = chunks.reduce(
    (total, chunk) => total + chunk.byteLength,
    0,
  );
  const binary = new Uint8Array(binaryLength);
  let offset = 0;
  for (const chunk of chunks) {
    binary.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return writeDeterministicSemanticGlb(
    {
      asset: { version: "2.0", generator: "Batshit Hair Import Intake v1" },
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews,
      accessors,
      materials: [
        {
          name: "BatshitHairNeutralPlaceholder",
          pbrMetallicRoughness: {
            baseColorFactor: [0.5, 0.5, 0.5, 1],
            metallicFactor: 0,
            roughnessFactor: 0.65,
          },
          alphaMode: "OPAQUE",
          doubleSided: false,
        },
      ],
      meshes,
      nodes,
      scenes: [{ name: "BatshitHairImportScene", nodes: [0] }],
      scene: 0,
    },
    binary,
    { diagnosticPrefix: "hair-import-canonical-glb/v1" },
  );
}

export function canonicalizeHairImportSelection(
  input: CanonicalizeHairImportSelectionInput,
): HairImportCanonicalizationV1 {
  if (!input || typeof input !== "object")
    fail("canonicalization input must be an object");
  const { budgets, checkpoint, parsed } = parseSource(input);
  const inspection = inspectionFromParsed(parsed);
  const selection = selectObjects(
    parsed.objects,
    input.keepObjectIds,
    input.removeObjectIds,
  );
  const transform = normalizeHairImportTransform(
    input.transform,
    input.budgets,
  );
  const calibration = normalizeSourceCalibration(input.calibration);
  if (calibration && parsed.sourceMode !== "ahs-like-obj") {
    fail("Anime Hair Studio calibration requires a matching AHS OBJ export");
  }
  const built = buildCanonicalGeometry(
    selection.kept,
    parsed.objects,
    transform,
    calibration,
    budgets,
    checkpoint,
  );
  const glbBytes = canonicalGlb(built.geometry);
  checkpoint("canonical GLB writing");
  const verified = parseSemanticGlb(glbBytes, {
    diagnosticPrefix: "hair-import-canonical-glb/v1",
  });
  if (
    verified.meshes.length !== selection.kept.length ||
    verified.skins.length !== 0
  ) {
    fail(
      "canonical GLB verification did not preserve the selected geometry inventory",
    );
  }
  const objectIds = new Set(parsed.objects.map((object) => object.objectId));
  const receipts = parsed.receipts.filter(
    (entry) => !objectIds.has(entry.subject),
  );
  for (const object of selection.kept) {
    receipts.push(
      receipt(
        "kept",
        object.objectId,
        "The reviewed polygon object was written into canonical Hair geometry.",
        object.triangles.length,
      ),
    );
  }
  for (const object of selection.removed) {
    receipts.push(
      receipt(
        "removed",
        object.objectId,
        object.triangles.length > 0
          ? "The polygon object was explicitly excluded from the reviewed selection."
          : "Authoring-only non-polygon records cannot enter canonical Hair geometry.",
        object.triangles.length ||
          object.lineCount ||
          object.pointCount ||
          null,
      ),
    );
  }
  receipts.push(
    receipt(
      "generated",
      "canonical-normals",
      "Finite face normals were regenerated after source and reviewed fit transforms.",
      built.vertexCount,
    ),
    receipt(
      "generated",
      "canonical-uv0",
      "Deterministic bounds-projected UV0 coordinates were generated for neutral Hair material ownership.",
      built.vertexCount,
    ),
    receipt(
      "generated",
      "neutral-material-placeholder",
      "One opaque neutral PBR placeholder replaced all source material ownership.",
      1,
    ),
    receipt(
      "generated",
      "reviewed-fit-transform",
      "The bounded translation, XYZ rotation, uniform scale, and per-axis correction were baked into canonical positions.",
      null,
    ),
  );
  if (calibration?.mode === "registered-template/v1") {
    receipts.push(
      receipt(
        "generated",
        "ahs-registered-template",
        "The registered Batshit Anime Hair Studio calibration supplied the deterministic starting fit without changing source Hair shape.",
        null,
      ),
    );
  } else if (calibration?.mode === "stock-scalp-deformation/v1") {
    receipts.push(
      receipt(
        "generated",
        "ahs-stock-scalp-deformation",
        "The registered stock scalp was mapped toward the Batshit scalp at each paired curve root, with correction fading smoothly to zero at each distal tip.",
        calibration.sourceScalpPoints?.length ?? null,
      ),
    );
  }
  checkpoint("canonical Hair verification");
  return {
    contract: HAIR_IMPORT_CANONICALIZATION_CONTRACT,
    format: parsed.format,
    sourceMode: parsed.sourceMode,
    inspection,
    keptObjectIds: selection.kept.map((object) => object.objectId),
    removedObjectIds: selection.removed.map((object) => object.objectId),
    transform,
    geometry: {
      meshCount: selection.kept.length,
      vertexCount: built.vertexCount,
      triangleCount: built.triangleCount,
      materialCount: 1,
      textureCount: 0,
      bounds: built.bounds,
    },
    receipts,
    glbBytes,
  };
}
