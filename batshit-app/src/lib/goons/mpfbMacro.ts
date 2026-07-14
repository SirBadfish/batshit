/**
 * Shared MakeHuman/MPFB macro interpolation.
 *
 * Both body-dials/v1 and appearance-dials/v2 use this exact implementation so
 * the exporter-generated MPFB parity fixture remains the single mathematical
 * source of truth during the v2 cutover.
 */

export type MpfbMacroPart = {
  lowest: number;
  highest: number;
  low: string;
  high: string;
};

export type MpfbMacroDimension = {
  parts: MpfbMacroPart[];
  extrapolateHigh?: boolean;
};

export type MpfbMacroCorner<Axis extends string> = {
  id: string;
  comps: Partial<Record<Axis, string>>;
  fixedFactor: number;
};

export function interpolateMpfbMacroComponents(
  parts: MpfbMacroPart[],
  value: number,
  extrapolateHigh = false,
): Map<string, number> {
  const components = new Map<string, number>();
  for (const part of parts) {
    if (value <= part.lowest || value >= part.highest) continue;
    const pct = (value - part.lowest) / (part.highest - part.lowest);
    const lowWeight = Math.round((1 - pct) * 10000) / 10000;
    const highWeight = Math.round(pct * 10000) / 10000;
    if (part.low) {
      components.set(part.low, (components.get(part.low) ?? 0) + lowWeight);
    }
    if (part.high) {
      components.set(part.high, (components.get(part.high) ?? 0) + highWeight);
    }
  }
  if (extrapolateHigh && components.size === 0 && parts.length > 0) {
    const last = parts[parts.length - 1];
    if (value >= last.highest) {
      const pct = (value - last.lowest) / (last.highest - last.lowest);
      const lowWeight = Math.round((1 - pct) * 10000) / 10000;
      const highWeight = Math.round(pct * 10000) / 10000;
      if (last.low) {
        components.set(last.low, (components.get(last.low) ?? 0) + lowWeight);
      }
      if (last.high) {
        components.set(
          last.high,
          (components.get(last.high) ?? 0) + highWeight,
        );
      }
    }
  }
  return components;
}

export function resolveMpfbMacroCornerWeights<Axis extends string>(
  axes: readonly Axis[],
  dimensions: Record<Axis, MpfbMacroDimension>,
  corners: Array<MpfbMacroCorner<Axis>>,
  axisValues: Record<Axis, number>,
  cutoff: number,
): Map<string, number> {
  const components = {} as Record<Axis, Map<string, number>>;
  for (const axis of axes) {
    const dimension = dimensions[axis];
    components[axis] = interpolateMpfbMacroComponents(
      dimension.parts,
      axisValues[axis],
      dimension.extrapolateHigh,
    );
  }

  const weights = new Map<string, number>();
  for (const corner of corners) {
    let weight = corner.fixedFactor;
    for (const axis of axes) {
      const component = corner.comps[axis];
      if (component === undefined) continue;
      weight *= components[axis].get(component) ?? 0;
      if (weight === 0) break;
    }
    weights.set(corner.id, Math.abs(weight) > cutoff ? weight : 0);
  }
  return weights;
}
