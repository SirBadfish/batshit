import type {
  AppearanceDialMacroAxis,
  AppearanceDialTrackPoint,
  AppearanceQuat,
  AppearanceTargetLicense,
  AppearanceTargetUsage,
  AppearanceVec3,
} from "./appearanceDials.contracts";

export const MACRO_AXES: AppearanceDialMacroAxis[] = [
  "muscle",
  "weight",
  "cupsize",
  "firmness",
];
export const ALLOWED_LICENSES = new Set<AppearanceTargetLicense>([
  "CC0-1.0",
  "LicenseRef-Batshit-First-Party",
]);
export const ALLOWED_USAGES = new Set<AppearanceTargetUsage>([
  "identity",
  "pose-corrective",
]);
export const ZERO_TOLERANCE = 1e-8;
export const MACRO_BASELINE_TOLERANCE = 1e-6;

const SHA256_RE = /^[a-f0-9]{64}$/i;
const STABLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const RESERVED_IDS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_PROVENANCE_PATH_FIELDS = [
  "path",
  "relativePath",
  "sourcePath",
  "sourceLocator",
] as const;

export function createRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isStableId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    STABLE_ID_RE.test(value) &&
    !RESERVED_IDS.has(value)
  );
}

export function isSha256(value: unknown): value is string {
  return isNonEmptyString(value) && SHA256_RE.test(value);
}

export function isVec3(value: unknown): value is AppearanceVec3 {
  return (
    Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber)
  );
}

export function isPositiveVec3(value: unknown): value is AppearanceVec3 {
  return isVec3(value) && value.every((entry) => entry > 0);
}

export function isQuat(value: unknown): value is AppearanceQuat {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    !value.every(isFiniteNumber)
  ) {
    return false;
  }
  return (
    Math.abs(Math.hypot(value[0], value[1], value[2], value[3]) - 1) < 0.01
  );
}

export function isZeroVec3(value: AppearanceVec3): boolean {
  return value.every((entry) => Math.abs(entry) <= ZERO_TOLERANCE);
}

export function isIdentityQuat(value: AppearanceQuat): boolean {
  return (
    Math.abs(value[0]) <= ZERO_TOLERANCE &&
    Math.abs(value[1]) <= ZERO_TOLERANCE &&
    Math.abs(value[2]) <= ZERO_TOLERANCE &&
    Math.abs(Math.abs(value[3]) - 1) <= ZERO_TOLERANCE
  );
}

export function isIdentityScale(value: AppearanceVec3): boolean {
  return value.every((entry) => Math.abs(entry - 1) <= ZERO_TOLERANCE);
}

export function isRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    value[0] < value[1] &&
    value[0] <= 0 &&
    value[1] >= 0 &&
    Number.isFinite(value[1] - value[0])
  );
}

export function isTrack(value: unknown): value is AppearanceDialTrackPoint[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  let previous = Number.NEGATIVE_INFINITY;
  let previousOutput = 0;
  for (const point of value) {
    if (
      !Array.isArray(point) ||
      point.length !== 2 ||
      !isFiniteNumber(point[0]) ||
      !isFiniteNumber(point[1]) ||
      point[0] <= previous ||
      (previous !== Number.NEGATIVE_INFINITY &&
        (!Number.isFinite(point[0] - previous) ||
          !Number.isFinite(point[1] - previousOutput)))
    ) {
      return false;
    }
    previous = point[0];
    previousOutput = point[1];
  }
  return true;
}

export function normalizeFaceMorphCollisionName(name: string): string {
  const index = name.indexOf("Fcl_");
  return index >= 0 ? name.slice(index) : name;
}

export function assertNoForbiddenPaths(
  value: Record<string, unknown>,
  context: string,
) {
  const forbidden = FORBIDDEN_PROVENANCE_PATH_FIELDS.find(
    (field) => value[field] !== undefined,
  );
  if (forbidden) {
    throw new Error(context + " contains forbidden path field " + forbidden);
  }
}

export function evaluateAppearanceDialTrack(
  track: AppearanceDialTrackPoint[],
  value: number,
): number {
  const requireFinite = (output: number) => {
    if (!Number.isFinite(output)) {
      throw new Error("appearance dial track produced a non-finite output");
    }
    return output;
  };
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last) return 0;
  if (value <= first[0]) return requireFinite(first[1]);
  if (value >= last[0]) return requireFinite(last[1]);
  for (let index = 0; index < track.length - 1; index += 1) {
    const [x0, y0] = track[index];
    const [x1, y1] = track[index + 1];
    if (value < x0 || value > x1) continue;
    const t = (value - x0) / (x1 - x0);
    const output = y0 + t * (y1 - y0);
    return requireFinite(output);
  }
  return 0;
}
