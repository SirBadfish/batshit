export const HAIR_MOTION_PAINT_CONTRACT = "hair-motion-paint/v1" as const;

export type HairMotionTriangleRange = readonly [start: number, end: number];

export type HairMotionPaintMeshV1 = {
  meshNode: string;
  triangleCount: number;
  triangleRanges: HairMotionTriangleRange[];
};

export type HairMotionPaintRegionV1 = {
  id: string;
  label: string;
  enabled: boolean;
  meshes: HairMotionPaintMeshV1[];
};

export type HairMotionPaintV1 = {
  contract: typeof HAIR_MOTION_PAINT_CONTRACT;
  regions: HairMotionPaintRegionV1[];
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_REGIONS = 64;
const MAX_MESHES_PER_REGION = 64;
const MAX_TOTAL_RANGES = 8192;

function fail(message: string): never {
  throw new Error(`[${HAIR_MOTION_PAINT_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    fail(`${context} must contain exactly: ${canonical.join(", ")}`);
  }
}

function stableId(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > 96 ||
    !ID_PATTERN.test(value)
  ) {
    fail(`${context} must be a stable 1-96 character id`);
  }
  return value;
}

function meshNodeName(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      `${context} must be a trimmed mesh node name no longer than 256 characters`,
    );
  }
  return value;
}

function label(value: unknown, context: string) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < 1 ||
    value.length > 80 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be a trimmed label no longer than 80 characters`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(`${context} must be a positive integer`);
  }
  return value as number;
}

export function compressHairMotionTriangleRanges(
  triangleIndices: readonly number[],
  triangleCount: number,
): HairMotionTriangleRange[] {
  positiveInteger(triangleCount, "triangleCount");
  const sorted = [...new Set(triangleIndices)].sort(
    (left, right) => left - right,
  );
  for (const triangleIndex of sorted) {
    if (
      !Number.isSafeInteger(triangleIndex) ||
      triangleIndex < 0 ||
      triangleIndex >= triangleCount
    ) {
      fail(
        `triangle index ${String(triangleIndex)} is outside 0-${triangleCount - 1}`,
      );
    }
  }
  const ranges: HairMotionTriangleRange[] = [];
  for (const triangleIndex of sorted) {
    const previous = ranges.at(-1);
    if (previous && triangleIndex === previous[1] + 1) {
      ranges[ranges.length - 1] = [previous[0], triangleIndex];
    } else {
      ranges.push([triangleIndex, triangleIndex]);
    }
  }
  return ranges;
}

export function expandHairMotionTriangleRanges(
  ranges: readonly HairMotionTriangleRange[],
  triangleCount: number,
) {
  positiveInteger(triangleCount, "triangleCount");
  const triangles: number[] = [];
  let previousEnd = -1;
  for (const [start, end] of ranges) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= triangleCount ||
      start <= previousEnd
    ) {
      fail(
        "triangle ranges must be sorted, non-overlapping, and inside the declared topology",
      );
    }
    for (let triangle = start; triangle <= end; triangle += 1)
      triangles.push(triangle);
    previousEnd = end;
  }
  return triangles;
}

export function parseHairMotionPaint(
  value: unknown,
  context = "Hair motion paint",
): HairMotionPaintV1 {
  const raw = record(value, context);
  exactKeys(raw, ["contract", "regions"], context);
  if (raw.contract !== HAIR_MOTION_PAINT_CONTRACT) {
    fail(`${context}.contract must equal ${HAIR_MOTION_PAINT_CONTRACT}`);
  }
  if (
    !Array.isArray(raw.regions) ||
    raw.regions.length < 1 ||
    raw.regions.length > MAX_REGIONS
  ) {
    fail(`${context}.regions must contain 1-${MAX_REGIONS} painted areas`);
  }
  const regionIds = new Set<string>();
  let totalRanges = 0;
  const regions = raw.regions.map(
    (entry, regionIndex): HairMotionPaintRegionV1 => {
      const region = record(entry, `${context}.regions[${regionIndex}]`);
      exactKeys(
        region,
        ["enabled", "id", "label", "meshes"],
        `${context}.regions[${regionIndex}]`,
      );
      const id = stableId(region.id, `${context}.regions[${regionIndex}].id`);
      if (regionIds.has(id)) fail(`${context} repeats painted area ${id}`);
      regionIds.add(id);
      if (typeof region.enabled !== "boolean") {
        fail(`${context}.regions[${regionIndex}].enabled must be boolean`);
      }
      if (
        !Array.isArray(region.meshes) ||
        region.meshes.length > MAX_MESHES_PER_REGION
      ) {
        fail(
          `${context}.regions[${regionIndex}].meshes may contain up to ${MAX_MESHES_PER_REGION} meshes`,
        );
      }
      const meshNodes = new Set<string>();
      const meshes = region.meshes.map(
        (entry, meshIndex): HairMotionPaintMeshV1 => {
          const mesh = record(
            entry,
            `${context}.regions[${regionIndex}].meshes[${meshIndex}]`,
          );
          exactKeys(
            mesh,
            ["meshNode", "triangleCount", "triangleRanges"],
            `${context}.regions[${regionIndex}].meshes[${meshIndex}]`,
          );
          const meshNode = meshNodeName(
            mesh.meshNode,
            `${context}.regions[${regionIndex}].meshes[${meshIndex}].meshNode`,
          );
          if (meshNodes.has(meshNode))
            fail(`${context}.regions[${regionIndex}] repeats mesh ${meshNode}`);
          meshNodes.add(meshNode);
          const triangleCount = positiveInteger(
            mesh.triangleCount,
            `${context}.regions[${regionIndex}].meshes[${meshIndex}].triangleCount`,
          );
          if (
            !Array.isArray(mesh.triangleRanges) ||
            mesh.triangleRanges.length < 1
          ) {
            fail(
              `${context}.regions[${regionIndex}].meshes[${meshIndex}] must paint at least one triangle`,
            );
          }
          const triangleRanges = mesh.triangleRanges.map(
            (range, rangeIndex) => {
              if (!Array.isArray(range) || range.length !== 2) {
                fail(
                  `${context}.regions[${regionIndex}].meshes[${meshIndex}].triangleRanges[${rangeIndex}] must be [start, end]`,
                );
              }
              return [range[0], range[1]] as HairMotionTriangleRange;
            },
          );
          expandHairMotionTriangleRanges(triangleRanges, triangleCount);
          totalRanges += triangleRanges.length;
          if (totalRanges > MAX_TOTAL_RANGES) {
            fail(
              `${context} exceeds ${MAX_TOTAL_RANGES.toLocaleString()} compressed triangle ranges`,
            );
          }
          return { meshNode, triangleCount, triangleRanges };
        },
      );
      return {
        id,
        label: label(region.label, `${context}.regions[${regionIndex}].label`),
        enabled: region.enabled,
        meshes: meshes.sort((left, right) =>
          left.meshNode.localeCompare(right.meshNode),
        ),
      };
    },
  );
  return {
    contract: HAIR_MOTION_PAINT_CONTRACT,
    regions: regions.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function countHairMotionPaintTriangles(
  value: HairMotionPaintV1 | null | undefined,
) {
  if (!value) return 0;
  return value.regions.reduce(
    (total, region) =>
      total +
      (region.enabled
        ? region.meshes.reduce(
            (meshTotal, mesh) =>
              meshTotal +
              mesh.triangleRanges.reduce(
                (rangeTotal, [start, end]) => rangeTotal + end - start + 1,
                0,
              ),
            0,
          )
        : 0),
    0,
  );
}
