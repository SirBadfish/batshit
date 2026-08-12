import { describe, expect, it } from "vitest";

import {
  HAIR_MOTION_PAINT_CONTRACT,
  compressHairMotionTriangleRanges,
  countHairMotionPaintTriangles,
  expandHairMotionTriangleRanges,
  parseHairMotionPaint,
} from "./hairMotionPaint";

describe("Hair motion paint contract", () => {
  it("round-trips sparse triangle selections without topology ambiguity", () => {
    const ranges = compressHairMotionTriangleRanges([9, 2, 3, 4, 9, 12], 20);
    expect(ranges).toEqual([
      [2, 4],
      [9, 9],
      [12, 12],
    ]);
    expect(expandHairMotionTriangleRanges(ranges, 20)).toEqual([
      2, 3, 4, 9, 12,
    ]);
  });

  it("preserves empty draft areas while counting only enabled painted triangles", () => {
    const paint = parseHairMotionPaint({
      contract: HAIR_MOTION_PAINT_CONTRACT,
      regions: [
        { id: "front-left", label: "Front left", enabled: true, meshes: [] },
        {
          id: "front-right",
          label: "Front right",
          enabled: true,
          meshes: [
            {
              meshNode: "Hair object 2",
              triangleCount: 40,
              triangleRanges: [[10, 14]],
            },
          ],
        },
        {
          id: "disabled-test",
          label: "Disabled test",
          enabled: false,
          meshes: [
            {
              meshNode: "Hair object 2",
              triangleCount: 40,
              triangleRanges: [[20, 29]],
            },
          ],
        },
      ],
    });

    expect(countHairMotionPaintTriangles(paint)).toBe(5);
    expect(
      paint.regions.find((region) => region.id === "front-right")?.meshes[0]
        ?.meshNode,
    ).toBe("Hair object 2");
  });

  it("rejects stale or overlapping compressed ranges", () => {
    expect(() =>
      parseHairMotionPaint({
        contract: HAIR_MOTION_PAINT_CONTRACT,
        regions: [
          {
            id: "front",
            label: "Front",
            enabled: true,
            meshes: [
              {
                meshNode: "Hair",
                triangleCount: 12,
                triangleRanges: [
                  [2, 5],
                  [5, 7],
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/sorted, non-overlapping/i);
  });
});
