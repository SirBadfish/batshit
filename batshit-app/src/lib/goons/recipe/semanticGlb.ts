import { canonicalRecipeString } from "./recipeCanonical";

export const RECIPE_SEMANTIC_GLB_CONTRACT = "recipe-semantic-glb/v1" as const;
export const RECIPE_SEMANTIC_GLB_UNIT_QUATERNION_TOLERANCE = 1e-6 as const;

export type SemanticJsonRecord = Record<string, unknown>;

export type SemanticGltfRecord = SemanticJsonRecord & {
  accessors?: unknown[];
  bufferViews?: unknown[];
  buffers?: unknown[];
  meshes?: unknown[];
  nodes?: unknown[];
  skins?: unknown[];
};

export type SemanticGlbDocument = {
  readonly contract: typeof RECIPE_SEMANTIC_GLB_CONTRACT;
  readonly diagnosticPrefix: string;
  readonly gltf: SemanticGltfRecord;
  readonly binary: Uint8Array;
  readonly nodes: SemanticJsonRecord[];
  readonly meshes: SemanticJsonRecord[];
  readonly skins: SemanticJsonRecord[];
  readonly parents: Map<number, number>;
  readonly rawNodeByName: Map<string, number>;
  readonly runtimeNodeByName: Map<string, number>;
};

export type SemanticGlbAccessorInfo = {
  readonly count: number;
  readonly components: number;
  readonly componentType: number;
  readonly type: string;
  readonly normalized: boolean;
};

export type SemanticGlbAccessor = SemanticGlbAccessorInfo & {
  readonly values: Float64Array;
};

export type SemanticGlbAccessorRowVisitor = (
  row: number,
  values: Float64Array,
) => void;

export type SemanticGlbAccessorScalarVisitor = (
  row: number,
  component: number,
  value: number,
) => void;

export type SemanticGlbNodeTransform =
  | {
      readonly representation: "matrix";
      readonly matrix: number[];
      readonly rawMatrix: number[];
      readonly translation: null;
      readonly rotation: null;
      readonly scale: null;
    }
  | {
      readonly representation: "trs";
      readonly matrix: number[];
      readonly rawMatrix: null;
      readonly translation: [number, number, number];
      readonly rotation: [number, number, number, number];
      readonly scale: [number, number, number];
    };

export type ParseSemanticGlbOptions = {
  diagnosticPrefix?: string;
};

const DEFAULT_DIAGNOSTIC_PREFIX = RECIPE_SEMANTIC_GLB_CONTRACT;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_JSON_CHUNK = 0x4e4f534a;
const GLB_BINARY_CHUNK = 0x004e4942;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();
const MAX_DECODED_ACCESSOR_BYTES = 256 * 1024 * 1024;

const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

function diagnosticPrefix(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f\[\]]/.test(value)
  ) {
    throw new Error(
      `[${DEFAULT_DIAGNOSTIC_PREFIX}] diagnosticPrefix must be a non-empty trimmed label`,
    );
  }
  return value;
}

function fail(prefix: string, message: string): never {
  throw new Error(`[${prefix}] ${message}`);
}

function record(
  value: unknown,
  context: string,
  prefix: string,
): SemanticJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(prefix, `${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(prefix, `${context} must be a plain object`);
  }
  return value as SemanticJsonRecord;
}

function array(value: unknown, context: string, prefix: string): unknown[] {
  if (!Array.isArray(value)) fail(prefix, `${context} must be an array`);
  return value;
}

function optionalArray(
  value: unknown,
  context: string,
  prefix: string,
): unknown[] {
  return value === undefined ? [] : array(value, context, prefix);
}

function integer(
  value: unknown,
  context: string,
  prefix: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(prefix, `${context} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function safeProduct(
  left: number,
  right: number,
  context: string,
  prefix: string,
): number {
  const value = left * right;
  if (!Number.isSafeInteger(value)) {
    fail(prefix, `${context} exceeds the safe integer range`);
  }
  return value;
}

function finite(value: unknown, context: string, prefix: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(prefix, `${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function nonEmptyString(
  value: unknown,
  context: string,
  prefix: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(prefix, `${context} must be a non-empty trimmed string`);
  }
  return value;
}

function safeIndex<T>(
  values: T[],
  value: unknown,
  context: string,
  prefix: string,
): T {
  const index = integer(value, context, prefix);
  if (index >= values.length) fail(prefix, `${context} is out of range`);
  return values[index];
}

function readUint32(
  view: DataView,
  offset: number,
  context: string,
  prefix: string,
): number {
  if (offset < 0 || offset + 4 > view.byteLength) {
    fail(prefix, `${context} is out of bounds`);
  }
  return view.getUint32(offset, true);
}

function alignGlbChunk(value: number, prefix: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(prefix, "GLB chunk byte length is invalid");
  }
  return Math.ceil(value / 4) * 4;
}

export function writeDeterministicSemanticGlb(
  gltf: SemanticGltfRecord,
  binary: Uint8Array,
  options: ParseSemanticGlbOptions = {},
): Uint8Array {
  const prefix = diagnosticPrefix(
    options.diagnosticPrefix ?? DEFAULT_DIAGNOSTIC_PREFIX,
  );
  canonicalRecipeString(gltf);
  if (
    !ArrayBuffer.isView(binary) ||
    !('BYTES_PER_ELEMENT' in binary) ||
    binary.BYTES_PER_ELEMENT !== 1
  ) {
    fail(prefix, "GLB binary must be a Uint8Array");
  }
  const json = ENCODER.encode(canonicalRecipeString(gltf));
  const jsonLength = alignGlbChunk(json.byteLength, prefix);
  const binaryLength = alignGlbChunk(binary.byteLength, prefix);
  const total = 12 + 8 + jsonLength + 8 + binaryLength;
  if (!Number.isSafeInteger(total) || total > 0xffffffff) {
    fail(prefix, "GLB exceeds the glTF 2.0 32-bit length limit");
  }
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, GLB_JSON_CHUNK, true);
  output.fill(0x20, 20, 20 + jsonLength);
  output.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, GLB_BINARY_CHUNK, true);
  output.set(binary, binaryHeader + 8);
  return output;
}

export function semanticGlbRuntimeNodeName(name: string): string {
  return name.replace(/\s/g, "_").replace(/[\[\].:/]/g, "");
}

export function parseSemanticGlb(
  glbBytes: Uint8Array,
  options: ParseSemanticGlbOptions = {},
): SemanticGlbDocument {
  const prefix = diagnosticPrefix(
    options.diagnosticPrefix ?? DEFAULT_DIAGNOSTIC_PREFIX,
  );
  if (!(glbBytes instanceof Uint8Array)) {
    fail(prefix, "avatar.glb must be a Uint8Array");
  }
  if (glbBytes.byteLength < 28) fail(prefix, "avatar.glb is truncated");
  const view = new DataView(
    glbBytes.buffer,
    glbBytes.byteOffset,
    glbBytes.byteLength,
  );
  if (readUint32(view, 0, "GLB magic", prefix) !== GLB_MAGIC) {
    fail(prefix, "avatar.glb magic is invalid");
  }
  if (readUint32(view, 4, "GLB version", prefix) !== GLB_VERSION) {
    fail(prefix, "avatar.glb must be glTF 2");
  }
  if (readUint32(view, 8, "GLB length", prefix) !== glbBytes.byteLength) {
    fail(prefix, "avatar.glb declared length does not match its bytes");
  }

  const chunks: Array<{ type: number; bytes: Uint8Array }> = [];
  let offset = 12;
  while (offset < glbBytes.byteLength) {
    if (offset + 8 > glbBytes.byteLength) {
      fail(prefix, "GLB chunk header is truncated");
    }
    const byteLength = readUint32(view, offset, "GLB chunk length", prefix);
    const type = readUint32(view, offset + 4, "GLB chunk type", prefix);
    offset += 8;
    if (byteLength % 4 !== 0 || offset + byteLength > glbBytes.byteLength) {
      fail(prefix, "GLB chunk length is invalid");
    }
    chunks.push({
      type,
      bytes: glbBytes.subarray(offset, offset + byteLength),
    });
    offset += byteLength;
  }
  if (
    chunks.length !== 2 ||
    chunks[0].type !== GLB_JSON_CHUNK ||
    chunks[1].type !== GLB_BINARY_CHUNK
  ) {
    fail(
      prefix,
      "avatar.glb must contain exactly one JSON chunk and one BIN chunk",
    );
  }

  let gltfValue: unknown;
  try {
    const text = UTF8.decode(chunks[0].bytes).replace(/[\u0000\u0020]+$/g, "");
    gltfValue = JSON.parse(text);
  } catch (error) {
    fail(prefix, `avatar.glb JSON is invalid: ${String(error)}`);
  }
  canonicalRecipeString(gltfValue);
  const gltf = record(
    gltfValue,
    "avatar.glb JSON",
    prefix,
  ) as SemanticGltfRecord;
  if (gltf.asset === undefined) {
    fail(prefix, "avatar.glb JSON is missing asset metadata");
  }
  const buffers = array(gltf.buffers, "gltf.buffers", prefix);
  if (buffers.length !== 1) {
    fail(prefix, "GLB must contain exactly one embedded buffer");
  }
  const declaredBinaryLength = integer(
    record(buffers[0], "gltf.buffers[0]", prefix).byteLength,
    "gltf.buffers[0].byteLength",
    prefix,
  );
  if (
    declaredBinaryLength > chunks[1].bytes.byteLength ||
    chunks[1].bytes.byteLength - declaredBinaryLength > 3
  ) {
    fail(prefix, "GLB BIN chunk length does not match gltf.buffers[0]");
  }

  const nodes = optionalArray(gltf.nodes, "gltf.nodes", prefix).map(
    (entry, index) => record(entry, `gltf.nodes[${index}]`, prefix),
  );
  const meshes = optionalArray(gltf.meshes, "gltf.meshes", prefix).map(
    (entry, index) => record(entry, `gltf.meshes[${index}]`, prefix),
  );
  const skins = optionalArray(gltf.skins, "gltf.skins", prefix).map(
    (entry, index) => record(entry, `gltf.skins[${index}]`, prefix),
  );
  const parents = new Map<number, number>();
  const rawNodeByName = new Map<string, number>();
  const runtimeNodeByName = new Map<string, number>();
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    if (node.name !== undefined) {
      const name = nonEmptyString(
        node.name,
        `gltf.nodes[${nodeIndex}].name`,
        prefix,
      );
      if (rawNodeByName.has(name)) {
        fail(prefix, `duplicate GLB node name ${name}`);
      }
      rawNodeByName.set(name, nodeIndex);
      const runtimeName = semanticGlbRuntimeNodeName(name);
      if (!runtimeName) {
        fail(prefix, `GLB node ${name} has no stable runtime name`);
      }
      if (runtimeNodeByName.has(runtimeName)) {
        fail(prefix, `duplicate Three.js runtime node name ${runtimeName}`);
      }
      runtimeNodeByName.set(runtimeName, nodeIndex);
    }
    for (const childValue of optionalArray(
      node.children,
      `gltf.nodes[${nodeIndex}].children`,
      prefix,
    )) {
      const child = integer(
        childValue,
        `gltf.nodes[${nodeIndex}].children[]`,
        prefix,
      );
      if (child >= nodes.length) {
        fail(prefix, "GLB child node index is out of range");
      }
      if (child === nodeIndex || parents.has(child)) {
        fail(prefix, `GLB node ${child} has an invalid or ambiguous parent`);
      }
      parents.set(child, nodeIndex);
    }
  }

  const parentState = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start += 1) {
    if (parentState[start] === 2) continue;
    const chain: number[] = [];
    let current: number | undefined = start;
    while (current !== undefined && parentState[current] === 0) {
      parentState[current] = 1;
      chain.push(current);
      current = parents.get(current);
    }
    if (current !== undefined && parentState[current] === 1) {
      fail(
        prefix,
        `GLB node hierarchy contains a parent cycle at node ${current}`,
      );
    }
    for (const nodeIndex of chain) parentState[nodeIndex] = 2;
  }

  return {
    contract: RECIPE_SEMANTIC_GLB_CONTRACT,
    diagnosticPrefix: prefix,
    gltf,
    binary: chunks[1].bytes.subarray(0, declaredBinaryLength),
    nodes,
    meshes,
    skins,
    parents,
    rawNodeByName,
    runtimeNodeByName,
  };
}

function readComponent(
  view: DataView,
  offset: number,
  componentType: number,
  normalized: boolean,
  context: string,
  prefix: string,
): number {
  const bytes = COMPONENT_BYTES[componentType];
  if (!bytes || offset < 0 || offset + bytes > view.byteLength) {
    fail(prefix, `${context} reads outside the GLB BIN chunk`);
  }
  let value: number;
  switch (componentType) {
    case 5120:
      value = view.getInt8(offset);
      if (normalized) value = Math.max(value / 127, -1);
      break;
    case 5121:
      value = view.getUint8(offset);
      if (normalized) value /= 255;
      break;
    case 5122:
      value = view.getInt16(offset, true);
      if (normalized) value = Math.max(value / 32767, -1);
      break;
    case 5123:
      value = view.getUint16(offset, true);
      if (normalized) value /= 65535;
      break;
    case 5125:
      value = view.getUint32(offset, true);
      if (normalized) value /= 4294967295;
      break;
    case 5126:
      if (normalized) {
        fail(prefix, `${context} FLOAT accessors cannot be normalized`);
      }
      value = view.getFloat32(offset, true);
      break;
    default:
      fail(
        prefix,
        `${context} uses unsupported componentType ${componentType}`,
      );
  }
  return finite(value, context, prefix);
}

type SemanticGlbDataViewPlan = {
  readonly viewStart: number;
  readonly byteOffset: number;
  readonly stride: number;
  readonly componentBytes: number;
  readonly components: number;
  readonly componentType: number;
  readonly normalized: boolean;
  readonly rows: number;
  readonly context: string;
};

type SemanticGlbAccessorPlan = SemanticGlbAccessorInfo & {
  readonly context: string;
  readonly base: SemanticGlbDataViewPlan | null;
  readonly sparse: {
    readonly count: number;
    readonly indices: SemanticGlbDataViewPlan;
    readonly values: SemanticGlbDataViewPlan;
  } | null;
};

function planSemanticGlbDataView(
  parsed: SemanticGlbDocument,
  bufferViewValue: unknown,
  byteOffsetValue: unknown,
  rows: number,
  componentType: number,
  normalized: boolean,
  components: number,
  context: string,
): SemanticGlbDataViewPlan {
  const prefix = parsed.diagnosticPrefix;
  const bufferViews = optionalArray(
    parsed.gltf.bufferViews,
    "gltf.bufferViews",
    prefix,
  );
  const bufferViewIndex = integer(
    bufferViewValue,
    `${context}.bufferView`,
    prefix,
  );
  const bufferView = record(
    safeIndex(bufferViews, bufferViewIndex, `${context}.bufferView`, prefix),
    `gltf.bufferViews[${bufferViewIndex}]`,
    prefix,
  );
  if (bufferView.buffer !== 0 && bufferView.buffer !== undefined) {
    fail(prefix, `${context} references a non-GLB buffer`);
  }
  const viewStart = integer(
    bufferView.byteOffset ?? 0,
    `gltf.bufferViews[${bufferViewIndex}].byteOffset`,
    prefix,
  );
  const viewLength = integer(
    bufferView.byteLength,
    `gltf.bufferViews[${bufferViewIndex}].byteLength`,
    prefix,
  );
  if (
    viewStart > parsed.binary.byteLength ||
    viewLength > parsed.binary.byteLength - viewStart
  ) {
    fail(
      prefix,
      `gltf.bufferViews[${bufferViewIndex}] exceeds the GLB BIN chunk`,
    );
  }
  const byteOffset = integer(
    byteOffsetValue ?? 0,
    `${context}.byteOffset`,
    prefix,
  );
  const componentBytes = COMPONENT_BYTES[componentType];
  if (!componentBytes) {
    fail(prefix, `${context} uses an unsupported component type`);
  }
  const elementBytes = safeProduct(
    componentBytes,
    components,
    `${context} element byte length`,
    prefix,
  );
  const stride = integer(
    bufferView.byteStride ?? elementBytes,
    `gltf.bufferViews[${bufferViewIndex}].byteStride`,
    prefix,
    1,
  );
  if (stride < elementBytes || stride % componentBytes !== 0) {
    fail(prefix, `${context} has invalid byteStride`);
  }
  const lastRowOffset = safeProduct(
    rows - 1,
    stride,
    `${context} row span`,
    prefix,
  );
  const accessedBytes = safeProduct(
    1,
    lastRowOffset + elementBytes,
    `${context} accessed byte length`,
    prefix,
  );
  if (byteOffset > viewLength || accessedBytes > viewLength - byteOffset) {
    fail(prefix, `${context} exceeds its bufferView`);
  }
  if ((viewStart + byteOffset) % componentBytes !== 0) {
    fail(prefix, `${context} is not aligned to its component size`);
  }
  return {
    viewStart,
    byteOffset,
    stride,
    componentBytes,
    components,
    componentType,
    normalized,
    rows,
    context,
  };
}

function readSemanticGlbDataViewRow(
  parsed: SemanticGlbDocument,
  plan: SemanticGlbDataViewPlan,
  row: number,
  destination: Float64Array,
  binaryView: DataView,
): void {
  const prefix = parsed.diagnosticPrefix;
  if (!Number.isSafeInteger(row) || row < 0 || row >= plan.rows) {
    fail(prefix, `${plan.context} resolves an out-of-range source row`);
  }
  if (destination.length !== plan.components) {
    fail(prefix, `${plan.context} row destination has the wrong size`);
  }
  const source = plan.viewStart + plan.byteOffset + row * plan.stride;
  for (let component = 0; component < plan.components; component += 1) {
    destination[component] = readComponent(
      binaryView,
      source + component * plan.componentBytes,
      plan.componentType,
      plan.normalized,
      `${plan.context}[${row}][${component}]`,
      prefix,
    );
  }
}

function planSemanticGlbAccessor(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
): SemanticGlbAccessorPlan {
  const prefix = parsed.diagnosticPrefix;
  const accessors = optionalArray(
    parsed.gltf.accessors,
    "gltf.accessors",
    prefix,
  );
  const raw = record(
    safeIndex(accessors, accessorIndex, "accessor index", prefix),
    `gltf.accessors[${String(accessorIndex)}]`,
    prefix,
  );
  const context = `gltf.accessors[${String(accessorIndex)}]`;
  const count = integer(raw.count, `${context}.count`, prefix, 1);
  const componentType = integer(
    raw.componentType,
    `${context}.componentType`,
    prefix,
  );
  const componentBytes = COMPONENT_BYTES[componentType];
  if (!componentBytes) {
    fail(prefix, `${context} uses unsupported componentType`);
  }
  const type = nonEmptyString(raw.type, `${context}.type`, prefix);
  const components = TYPE_COMPONENTS[type];
  if (!components) fail(prefix, `${context} uses unsupported type ${type}`);
  const normalized = raw.normalized === true;
  if (raw.normalized !== undefined && typeof raw.normalized !== "boolean") {
    fail(prefix, `${context}.normalized must be boolean`);
  }
  const valueCount = safeProduct(
    count,
    components,
    `${context} value count`,
    prefix,
  );
  const maximumValuesFromPackage = Math.floor(
    parsed.binary.byteLength / componentBytes,
  );
  if (valueCount > maximumValuesFromPackage) {
    fail(
      prefix,
      `${context} declares more values than the GLB can safely represent`,
    );
  }
  if (
    safeProduct(valueCount, 8, `${context} decoded byte length`, prefix) >
    MAX_DECODED_ACCESSOR_BYTES
  ) {
    fail(
      prefix,
      `${context} exceeds the ${MAX_DECODED_ACCESSOR_BYTES}-byte decoded accessor limit`,
    );
  }

  const base =
    raw.bufferView === undefined
      ? null
      : planSemanticGlbDataView(
          parsed,
          raw.bufferView,
          raw.byteOffset,
          count,
          componentType,
          normalized,
          components,
          context,
        );
  if (raw.bufferView === undefined && raw.byteOffset !== undefined) {
    fail(prefix, `${context}.byteOffset cannot exist without bufferView`);
  }

  let sparse: SemanticGlbAccessorPlan["sparse"] = null;
  if (raw.sparse !== undefined) {
    const sparseRecord = record(raw.sparse, `${context}.sparse`, prefix);
    const sparseCount = integer(
      sparseRecord.count,
      `${context}.sparse.count`,
      prefix,
      1,
    );
    if (sparseCount > count) {
      fail(prefix, `${context}.sparse.count exceeds accessor count`);
    }
    const indices = record(
      sparseRecord.indices,
      `${context}.sparse.indices`,
      prefix,
    );
    const indexComponentType = integer(
      indices.componentType,
      `${context}.sparse.indices.componentType`,
      prefix,
    );
    if (![5121, 5123, 5125].includes(indexComponentType)) {
      fail(prefix, `${context}.sparse indices use an invalid component type`);
    }
    const indexPlan = planSemanticGlbDataView(
      parsed,
      indices.bufferView,
      indices.byteOffset,
      sparseCount,
      indexComponentType,
      false,
      1,
      `${context}.sparse.indices`,
    );
    const sparseValues = record(
      sparseRecord.values,
      `${context}.sparse.values`,
      prefix,
    );
    const valuePlan = planSemanticGlbDataView(
      parsed,
      sparseValues.bufferView,
      sparseValues.byteOffset,
      sparseCount,
      componentType,
      normalized,
      components,
      `${context}.sparse.values`,
    );
    const scratch = new Float64Array(1);
    const binaryView = new DataView(
      parsed.binary.buffer,
      parsed.binary.byteOffset,
      parsed.binary.byteLength,
    );
    let previous = -1;
    for (let row = 0; row < sparseCount; row += 1) {
      readSemanticGlbDataViewRow(parsed, indexPlan, row, scratch, binaryView);
      const index = scratch[0];
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= count ||
        index <= previous
      ) {
        fail(
          prefix,
          `${context}.sparse indices must be unique, increasing, and in range`,
        );
      }
      previous = index;
    }
    sparse = {
      count: sparseCount,
      indices: indexPlan,
      values: valuePlan,
    };
  }

  return {
    context,
    count,
    components,
    componentType,
    type,
    normalized,
    base,
    sparse,
  };
}

function accessorInfo(plan: SemanticGlbAccessorPlan): SemanticGlbAccessorInfo {
  return {
    count: plan.count,
    components: plan.components,
    componentType: plan.componentType,
    type: plan.type,
    normalized: plan.normalized,
  };
}

function visitSemanticGlbAccessorPlanRows(
  parsed: SemanticGlbDocument,
  plan: SemanticGlbAccessorPlan,
  visitor: SemanticGlbAccessorRowVisitor,
): void {
  const binaryView = new DataView(
    parsed.binary.buffer,
    parsed.binary.byteOffset,
    parsed.binary.byteLength,
  );
  const rowValues = new Float64Array(plan.components);
  const sparseIndexValue = new Float64Array(1);
  let sparseRow = 0;
  let sparseIndex: number | null = null;
  if (plan.sparse !== null) {
    readSemanticGlbDataViewRow(
      parsed,
      plan.sparse.indices,
      sparseRow,
      sparseIndexValue,
      binaryView,
    );
    sparseIndex = sparseIndexValue[0];
  }

  for (let row = 0; row < plan.count; row += 1) {
    rowValues.fill(0);
    if (plan.base !== null) {
      readSemanticGlbDataViewRow(parsed, plan.base, row, rowValues, binaryView);
    }
    if (plan.sparse !== null && sparseIndex === row) {
      readSemanticGlbDataViewRow(
        parsed,
        plan.sparse.values,
        sparseRow,
        rowValues,
        binaryView,
      );
      sparseRow += 1;
      if (sparseRow < plan.sparse.count) {
        readSemanticGlbDataViewRow(
          parsed,
          plan.sparse.indices,
          sparseRow,
          sparseIndexValue,
          binaryView,
        );
        sparseIndex = sparseIndexValue[0];
      } else {
        sparseIndex = null;
      }
    }
    visitor(row, rowValues);
  }
}

export function inspectSemanticGlbAccessor(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
): SemanticGlbAccessorInfo {
  return accessorInfo(planSemanticGlbAccessor(parsed, accessorIndex));
}

/**
 * Visits rows in ascending order with one reused scratch array.
 *
 * The visitor must copy a row if it needs to retain it after the callback.
 * Repeating this function creates a fresh plan and restarts at row zero.
 */
export function visitSemanticGlbAccessorRows(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
  visitor: SemanticGlbAccessorRowVisitor,
): SemanticGlbAccessorInfo {
  if (typeof visitor !== "function") {
    fail(parsed.diagnosticPrefix, "accessor row visitor must be a function");
  }
  const plan = planSemanticGlbAccessor(parsed, accessorIndex);
  visitSemanticGlbAccessorPlanRows(parsed, plan, visitor);
  return accessorInfo(plan);
}

export function visitSemanticGlbAccessorScalars(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
  visitor: SemanticGlbAccessorScalarVisitor,
): SemanticGlbAccessorInfo {
  if (typeof visitor !== "function") {
    fail(parsed.diagnosticPrefix, "accessor scalar visitor must be a function");
  }
  const plan = planSemanticGlbAccessor(parsed, accessorIndex);
  visitSemanticGlbAccessorPlanRows(parsed, plan, (row, values) => {
    for (let component = 0; component < values.length; component += 1) {
      visitor(row, component, values[component]);
    }
  });
  return accessorInfo(plan);
}

export function decodeSemanticGlbAccessor(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
): SemanticGlbAccessor {
  const plan = planSemanticGlbAccessor(parsed, accessorIndex);
  const values = new Float64Array(plan.count * plan.components);
  visitSemanticGlbAccessorPlanRows(parsed, plan, (row, rowValues) => {
    values.set(rowValues, row * plan.components);
  });
  for (let index = 0; index < values.length; index += 1) {
    values[index] = finite(
      values[index],
      `${plan.context} value ${index}`,
      parsed.diagnosticPrefix,
    );
  }
  return { ...accessorInfo(plan), values };
}

export function getSemanticGlbNode(
  parsed: SemanticGlbDocument,
  nodeIndex: unknown,
  context = "node index",
): SemanticJsonRecord {
  return safeIndex(parsed.nodes, nodeIndex, context, parsed.diagnosticPrefix);
}

export function getSemanticGlbMesh(
  parsed: SemanticGlbDocument,
  meshIndex: unknown,
  context = "mesh index",
): SemanticJsonRecord {
  return safeIndex(parsed.meshes, meshIndex, context, parsed.diagnosticPrefix);
}

export function getSemanticGlbSkin(
  parsed: SemanticGlbDocument,
  skinIndex: unknown,
  context = "skin index",
): SemanticJsonRecord {
  return safeIndex(parsed.skins, skinIndex, context, parsed.diagnosticPrefix);
}

export function resolveSemanticGlbNode(
  parsed: SemanticGlbDocument,
  value: unknown,
  context: string,
): number {
  const prefix = parsed.diagnosticPrefix;
  const name = nonEmptyString(value, context, prefix);
  const exact = parsed.rawNodeByName.get(name);
  const runtime = parsed.runtimeNodeByName.get(name);
  if (exact !== undefined && runtime !== undefined && exact !== runtime) {
    fail(prefix, `${context} ${name} is ambiguous`);
  }
  const resolved = exact ?? runtime;
  if (resolved === undefined) {
    fail(prefix, `${context} ${name} is missing from avatar.glb`);
  }
  return resolved;
}

export function stableSemanticGlbNodeName(
  parsed: SemanticGlbDocument,
  nodeIndex: number,
  context: string,
): string {
  const node = getSemanticGlbNode(parsed, nodeIndex, context);
  return semanticGlbRuntimeNodeName(
    nonEmptyString(node.name, `${context}.name`, parsed.diagnosticPrefix),
  );
}

export function resolveSemanticGlbNodeTransform(
  node: SemanticJsonRecord,
  context: string,
  options: ParseSemanticGlbOptions = {},
): SemanticGlbNodeTransform {
  const prefix = diagnosticPrefix(
    options.diagnosticPrefix ?? DEFAULT_DIAGNOSTIC_PREFIX,
  );
  if (node.matrix !== undefined) {
    if (
      node.translation !== undefined ||
      node.rotation !== undefined ||
      node.scale !== undefined
    ) {
      fail(prefix, `${context} mixes matrix and TRS`);
    }
    const values = array(node.matrix, `${context}.matrix`, prefix).map(
      (value, index) => finite(value, `${context}.matrix[${index}]`, prefix),
    );
    if (values.length !== 16) {
      fail(prefix, `${context}.matrix must contain 16 values`);
    }
    return {
      representation: "matrix",
      matrix: values,
      rawMatrix: [...values],
      translation: null,
      rotation: null,
      scale: null,
    };
  }

  const translation = array(
    node.translation ?? [0, 0, 0],
    `${context}.translation`,
    prefix,
  ).map((value, index) =>
    finite(value, `${context}.translation[${index}]`, prefix),
  );
  const rotation = array(
    node.rotation ?? [0, 0, 0, 1],
    `${context}.rotation`,
    prefix,
  ).map((value, index) =>
    finite(value, `${context}.rotation[${index}]`, prefix),
  );
  const scale = array(node.scale ?? [1, 1, 1], `${context}.scale`, prefix).map(
    (value, index) => finite(value, `${context}.scale[${index}]`, prefix),
  );
  if (translation.length !== 3 || rotation.length !== 4 || scale.length !== 3) {
    fail(prefix, `${context} has malformed TRS`);
  }
  const q = rotation as [number, number, number, number];
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (Math.abs(length - 1) > RECIPE_SEMANTIC_GLB_UNIT_QUATERNION_TOLERANCE) {
    fail(
      prefix,
      `${context}.rotation must have unit length within ${RECIPE_SEMANTIC_GLB_UNIT_QUATERNION_TOLERANCE} (got ${length})`,
    );
  }
  const t = translation as [number, number, number];
  const s = scale as [number, number, number];
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const matrix = [
    (1 - (yy + zz)) * s[0],
    (xy + wz) * s[0],
    (xz - wy) * s[0],
    0,
    (xy - wz) * s[1],
    (1 - (xx + zz)) * s[1],
    (yz + wx) * s[1],
    0,
    (xz + wy) * s[2],
    (yz - wx) * s[2],
    (1 - (xx + yy)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ].map((value) => (Object.is(value, -0) ? 0 : value));
  return {
    representation: "trs",
    matrix,
    rawMatrix: null,
    translation: t,
    rotation: q,
    scale: s,
  };
}
