/**
 * Body Dials — first-party Goon body dial resolver (SA-090 dial round).
 *
 * Consumes the `avatar.json#dials` block (`body-dials/v1`) shipped by the
 * dial-round exporter and turns per-goon dial values into:
 *   - morph target influences (piecewise-linear member tracks + the MPFB
 *     macro product formula, both authored/measured at export time)
 *   - per-bone rest-translation offsets (runtime joint follow)
 *   - a uniform root scale (Overall Height) and a sole offset (re-grounding)
 *   - a rigid head-asset follow scale (eyes/teeth/tongue/brows/lashes)
 *
 * Everything here is data-driven from the manifest — no bone lists, key
 * names, gains, or curves may be hardcoded. The macro engine reimplements
 * MakeHuman/MPFB's macrodetail interpolation exactly; its parity against
 * MPFB ground truth is locked by the exporter-generated fixture replayed in
 * bodyDials.test.ts.
 */

import {
  interpolateMpfbMacroComponents,
  resolveMpfbMacroCornerWeights,
} from "./mpfbMacro";

export type BodyDialTrackPoint = [number, number];

export type BodyDialMember = {
  key: string;
  track: BodyDialTrackPoint[];
};

export type BodyDialKind = "tracks" | "macro-axis" | "root-scale";

export type BodyDialMacroAxis = "muscle" | "weight" | "cupsize" | "firmness";

export type BodyDialDef = {
  id: string;
  label: string;
  group: string;
  kind: BodyDialKind;
  range: [number, number];
  default: number;
  advanced?: boolean;
  members?: BodyDialMember[];
  axis?: BodyDialMacroAxis;
  /**
   * Optional dial-value -> macro-axis-value mapping for macro-axis dials
   * (Cup Size top extension: 0..1 is identity, the extension segment above 1
   * extrapolates the axis past its designed max). Absent = identity.
   */
  axisTrack?: BodyDialTrackPoint[];
  scalePerUnit?: number;
  engineNote?: string;
};

export type BodyDialGroup = { id: string; label: string };

export type BodyDialKeyMeta = {
  baselineValue: number;
  influenceMin: number;
  influenceMax: number;
  soleDeltaY?: number;
};

export type MacroPart = {
  lowest: number;
  highest: number;
  low: string;
  high: string;
};

export type MacroCorner = {
  key: string;
  family: string;
  comps: Partial<Record<BodyDialMacroAxis, string>>;
  fixedFactor: number;
  baselineWeight: number;
};

export type BodyDialsMacroEngine = {
  formula: string;
  cutoff: number;
  baselineState: Record<string, unknown>;
  /**
   * `extrapolateHigh` (exporter-emitted, currently cupsize only) lets axis
   * values continue past the last part's padded top along the same linear
   * blend — the high comp exceeds 1 while the low comp goes negative, which
   * is exactly the "keep growing along the MakeHuman line" behavior.
   */
  dims: Record<
    BodyDialMacroAxis,
    { parts: MacroPart[]; extrapolateHigh?: boolean }
  >;
  corners: MacroCorner[];
};

export type BodyDialsHeadAssetFollow = {
  dial: string;
  nodes: string[];
  scalePerUnit: number;
  pivotWorld: [number, number, number];
};

export type BodyDialsManifest = {
  contract: string;
  bodyMesh: string;
  groups: BodyDialGroup[];
  dials: BodyDialDef[];
  keys: Record<string, BodyDialKeyMeta>;
  macroEngine: BodyDialsMacroEngine;
  jointDeltas: Record<string, Record<string, [number, number, number]>>;
  headAssetFollow?: BodyDialsHeadAssetFollow;
};

export type ResolvedBodyDialState = {
  /** morph target name -> influence (already clamped to the key's bounds) */
  influences: Map<string, number>;
  /** exported bone name -> rest-translation offset in glTF world meters */
  jointOffsets: Map<string, [number, number, number]>;
  /** uniform avatar-root scale factor (Overall Height) */
  rootScale: number;
  /** vertical floor shift in glTF world meters (before root scaling) */
  soleOffsetY: number;
  /** rigid head-asset scale factor (Head Size follow) */
  headAssetScale: number;
};

export const BODY_DIALS_CONTRACT = "body-dials/v1";

const MACRO_AXES: BodyDialMacroAxis[] = [
  "muscle",
  "weight",
  "cupsize",
  "firmness",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTrack(value: unknown): value is BodyDialTrackPoint[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every(
      (pt) =>
        Array.isArray(pt) &&
        pt.length === 2 &&
        isFiniteNumber(pt[0]) &&
        isFiniteNumber(pt[1]),
    )
  );
}

/**
 * Parse + validate a manifest's `dials` block. Returns null when the avatar
 * simply has no dials block; throws on a present-but-malformed block so a
 * broken export fails loudly instead of silently shipping a dial-less goon.
 */
export function parseBodyDialsManifest(
  manifest: unknown,
): BodyDialsManifest | null {
  if (!isRecord(manifest)) return null;
  const raw = manifest.dials;
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new Error("avatar.json#dials is not an object");
  }
  if (raw.contract !== BODY_DIALS_CONTRACT) {
    throw new Error(
      `avatar.json#dials contract ${String(raw.contract)} is not ${BODY_DIALS_CONTRACT}`,
    );
  }
  if (typeof raw.bodyMesh !== "string" || !raw.bodyMesh) {
    throw new Error("avatar.json#dials is missing bodyMesh");
  }
  if (!Array.isArray(raw.dials) || raw.dials.length === 0) {
    throw new Error("avatar.json#dials has no dial definitions");
  }
  if (!isRecord(raw.keys)) {
    throw new Error("avatar.json#dials is missing the keys block");
  }
  if (
    !isRecord(raw.macroEngine) ||
    !Array.isArray((raw.macroEngine as { corners?: unknown }).corners)
  ) {
    throw new Error("avatar.json#dials is missing the macroEngine block");
  }

  const dials: BodyDialDef[] = [];
  for (const entry of raw.dials as unknown[]) {
    if (!isRecord(entry))
      throw new Error("avatar.json#dials contains a non-object dial");
    const id = typeof entry.id === "string" ? entry.id : "";
    const kind = entry.kind;
    const range = entry.range;
    if (
      !id ||
      (kind !== "tracks" && kind !== "macro-axis" && kind !== "root-scale") ||
      !Array.isArray(range) ||
      range.length !== 2 ||
      !isFiniteNumber(range[0]) ||
      !isFiniteNumber(range[1]) ||
      range[0] >= range[1] ||
      !isFiniteNumber(entry.default)
    ) {
      throw new Error(
        `avatar.json#dials dial ${id || "<unnamed>"} is malformed`,
      );
    }
    if (kind === "tracks") {
      const members = entry.members;
      if (!Array.isArray(members) || members.length === 0) {
        throw new Error(`dial ${id} has no members`);
      }
      for (const member of members) {
        if (
          !isRecord(member) ||
          typeof member.key !== "string" ||
          !isTrack(member.track)
        ) {
          throw new Error(`dial ${id} has a malformed member track`);
        }
        if (!isRecord((raw.keys as Record<string, unknown>)[member.key])) {
          throw new Error(
            `dial ${id} references key ${member.key} missing from the keys block`,
          );
        }
      }
    }
    if (
      kind === "macro-axis" &&
      !MACRO_AXES.includes(entry.axis as BodyDialMacroAxis)
    ) {
      throw new Error(
        `dial ${id} has an unknown macro axis ${String(entry.axis)}`,
      );
    }
    if (entry.axisTrack !== undefined) {
      if (kind !== "macro-axis" || !isTrack(entry.axisTrack)) {
        throw new Error(`dial ${id} has a malformed axisTrack`);
      }
    }
    if (kind === "root-scale" && !isFiniteNumber(entry.scalePerUnit)) {
      throw new Error(`dial ${id} is missing scalePerUnit`);
    }
    dials.push(entry as unknown as BodyDialDef);
  }

  const macroEngine = raw.macroEngine as unknown as BodyDialsMacroEngine;
  for (const axis of MACRO_AXES) {
    if (!Array.isArray(macroEngine.dims?.[axis]?.parts)) {
      throw new Error(
        `avatar.json#dials macroEngine is missing the ${axis} parts table`,
      );
    }
  }

  return {
    contract: BODY_DIALS_CONTRACT,
    bodyMesh: raw.bodyMesh,
    groups: Array.isArray(raw.groups) ? (raw.groups as BodyDialGroup[]) : [],
    dials,
    keys: raw.keys as Record<string, BodyDialKeyMeta>,
    macroEngine,
    jointDeltas: isRecord(raw.jointDeltas)
      ? (raw.jointDeltas as BodyDialsManifest["jointDeltas"])
      : {},
    headAssetFollow: isRecord(raw.headAssetFollow)
      ? (raw.headAssetFollow as unknown as BodyDialsHeadAssetFollow)
      : undefined,
  };
}

export function clampBodyDialValue(dial: BodyDialDef, value: unknown): number {
  const numeric = isFiniteNumber(value) ? value : dial.default;
  return Math.min(dial.range[1], Math.max(dial.range[0], numeric));
}

/** Stored per-goon values normalized against the manifest (clamped, defaulted). */
export function normalizeBodyDialValues(
  manifest: BodyDialsManifest,
  stored: Record<string, number> | null | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const dial of manifest.dials) {
    out[dial.id] = clampBodyDialValue(dial, stored?.[dial.id]);
  }
  return out;
}

export function evalBodyDialTrack(
  track: BodyDialTrackPoint[],
  value: number,
): number {
  const first = track[0];
  const last = track[track.length - 1];
  if (!first || !last) return 0;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < track.length - 1; i += 1) {
    const [x0, y0] = track[i];
    const [x1, y1] = track[i + 1];
    if (value >= x0 && value <= x1) {
      if (x1 === x0) return y1;
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return 0;
}

/**
 * Mirror of MPFB TargetService._interpolate_macro_components.
 *
 * `extrapolateHigh` extends the LAST part's linear blend past its padded top
 * bound (exporter-flagged dims only — Cup Size top extension): the high comp
 * weight keeps growing past 1 and the low comp goes negative, continuing the
 * exact MakeHuman growth line. In-range behavior is byte-identical to MPFB.
 */
export function interpolateMacroComponents(
  parts: MacroPart[],
  value: number,
  extrapolateHigh = false,
): Map<string, number> {
  return interpolateMpfbMacroComponents(parts, value, extrapolateHigh);
}

/**
 * MPFB macro product formula: corner weight = fixed pinned factor x product
 * of the free-dimension component weights, zeroed below the cutoff.
 */
export function resolveMacroCornerWeights(
  engine: BodyDialsMacroEngine,
  axisValues: Record<BodyDialMacroAxis, number>,
): Map<string, number> {
  return resolveMpfbMacroCornerWeights(
    MACRO_AXES,
    engine.dims,
    engine.corners.map((corner) => ({
      id: corner.key,
      comps: corner.comps,
      fixedFactor: corner.fixedFactor,
    })),
    axisValues,
    engine.cutoff,
  );
}

function clampInfluence(
  meta: BodyDialKeyMeta | undefined,
  influence: number,
): number {
  if (!meta) return influence;
  return Math.min(meta.influenceMax, Math.max(meta.influenceMin, influence));
}

/**
 * Resolve the full dial state: dial values -> morph influences + joint
 * offsets + root scale + grounding shift + head-asset follow scale.
 */
export function resolveBodyDialState(
  manifest: BodyDialsManifest,
  storedValues: Record<string, number> | null | undefined,
): ResolvedBodyDialState {
  const values = normalizeBodyDialValues(manifest, storedValues);
  const influences = new Map<string, number>();
  const macroValues: Record<BodyDialMacroAxis, number> = {
    muscle: 0.5,
    weight: 0,
    cupsize: 0.5,
    firmness: 0.5,
  };
  let rootScale = 1;
  let headAssetScale = 1;

  for (const dial of manifest.dials) {
    const value = values[dial.id];
    if (dial.kind === "root-scale") {
      rootScale = 1 + (dial.scalePerUnit ?? 0) * value;
      continue;
    }
    if (dial.kind === "macro-axis") {
      if (dial.axis) {
        macroValues[dial.axis] = dial.axisTrack
          ? evalBodyDialTrack(dial.axisTrack, value)
          : value;
      }
      continue;
    }
    for (const member of dial.members ?? []) {
      const contribution = evalBodyDialTrack(member.track, value);
      if (contribution === 0 && !influences.has(member.key)) continue;
      influences.set(
        member.key,
        (influences.get(member.key) ?? 0) + contribution,
      );
    }
  }

  const cornerWeights = resolveMacroCornerWeights(
    manifest.macroEngine,
    macroValues,
  );
  for (const corner of manifest.macroEngine.corners) {
    const weight = cornerWeights.get(corner.key) ?? 0;
    const influence = weight - corner.baselineWeight;
    if (influence === 0 && !influences.has(corner.key)) continue;
    influences.set(corner.key, (influences.get(corner.key) ?? 0) + influence);
  }

  for (const [key, influence] of influences) {
    influences.set(key, clampInfluence(manifest.keys[key], influence));
  }

  const jointOffsets = new Map<string, [number, number, number]>();
  let soleOffsetY = 0;
  for (const [key, influence] of influences) {
    if (influence === 0) continue;
    const meta = manifest.keys[key];
    if (meta?.soleDeltaY) {
      soleOffsetY += influence * meta.soleDeltaY;
    }
    const perBone = manifest.jointDeltas[key];
    if (!perBone) continue;
    for (const [bone, delta] of Object.entries(perBone)) {
      const current = jointOffsets.get(bone) ?? [0, 0, 0];
      current[0] += influence * delta[0];
      current[1] += influence * delta[1];
      current[2] += influence * delta[2];
      jointOffsets.set(bone, current);
    }
  }

  const follow = manifest.headAssetFollow;
  if (follow) {
    const followValue = values[follow.dial];
    if (isFiniteNumber(followValue)) {
      headAssetScale = 1 + follow.scalePerUnit * followValue;
    }
  }

  return { influences, jointOffsets, rootScale, soleOffsetY, headAssetScale };
}

/** True when two stored dial-value records resolve identically. */
export function bodyDialValuesEqual(
  a: Record<string, number> | null | undefined,
  b: Record<string, number> | null | undefined,
): boolean {
  const ka = a ? Object.keys(a) : [];
  const kb = b ? Object.keys(b) : [];
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (a?.[key] !== b?.[key]) return false;
  }
  return true;
}
