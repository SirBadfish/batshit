import { describe, expect, it } from "vitest";
import { sha256Hex } from "./recipeCanonical";
import { verifyRecipeSourceRawAssets } from "./recipeSourceAssets";
import { createRecipePhysicalMigrationFixture } from "./fixtures/recipePhysicalMigrationPair";

const mutable = <T>(value: T): T => structuredClone(value);

function changedByte(value: Uint8Array): Uint8Array {
  const changed = Uint8Array.from(value);
  changed[0] = changed[0]! ^ 0xff;
  return changed;
}

describe("Recipe Source raw asset proof", () => {
  it("binds all three exact assets and the target package's exact direct edge", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const verified = await verifyRecipeSourceRawAssets(
      fixture.target.recipeSource,
      {
        packageBytes: fixture.target.packageBytes,
        modelBytes: fixture.target.glbBytes,
        manifestBytes: fixture.target.manifestBytes,
      },
      fixture.edge.to,
      fixture.edge,
    );

    expect(verified.source).toEqual(fixture.target.recipeSource);
    expect(verified.packageSha256).toBe(
      fixture.target.recipeSource.package.sha256,
    );
    expect(verified.modelSha256).toBe(fixture.edge.to.modelSha256);
    expect(verified.manifestSha256).toBe(
      fixture.target.recipeSource.manifest.sha256,
    );
  });

  it.each(["packageBytes", "modelBytes", "manifestBytes"] as const)(
    "rejects one-byte %s tamper",
    async (field) => {
      const fixture = await createRecipePhysicalMigrationFixture();
      const assets = {
        packageBytes: fixture.target.packageBytes,
        modelBytes: fixture.target.glbBytes,
        manifestBytes: fixture.target.manifestBytes,
      };
      assets[field] = changedByte(assets[field]);
      await expect(
        verifyRecipeSourceRawAssets(
          fixture.target.recipeSource,
          assets,
          fixture.edge.to,
          fixture.edge,
        ),
      ).rejects.toThrow(/exact Recipe Source hashes/);
    },
  );

  it("rejects a source record swapped onto another package's bytes", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    await expect(
      verifyRecipeSourceRawAssets(
        fixture.source.recipeSource,
        {
          packageBytes: fixture.target.packageBytes,
          modelBytes: fixture.target.glbBytes,
          manifestBytes: fixture.target.manifestBytes,
        },
        fixture.edge.to,
        fixture.edge,
      ),
    ).rejects.toThrow(/exact Recipe Source hashes/);
  });

  it("rejects target bytes whose verified metadata omits the required edge", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = JSON.parse(
      new TextDecoder().decode(fixture.target.manifestBytes),
    ) as Record<string, unknown>;
    manifest.recipeUpdates = {
      contract: "recipe-updates/v1",
      schemaVersion: 1,
      edges: [],
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const source = mutable(fixture.target.recipeSource);
    source.manifest.sha256 = await sha256Hex(manifestBytes);

    await expect(
      verifyRecipeSourceRawAssets(
        source,
        {
          packageBytes: fixture.target.packageBytes,
          modelBytes: fixture.target.glbBytes,
          manifestBytes,
        },
        fixture.edge.to,
        fixture.edge,
      ),
    ).rejects.toThrow(/exact required update edge/);
  });

  it("rejects independently supplied non-JSON manifest bytes", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifestBytes = new TextEncoder().encode("not JSON");
    const source = mutable(fixture.target.recipeSource);
    source.manifest.sha256 = await sha256Hex(manifestBytes);
    await expect(
      verifyRecipeSourceRawAssets(
        source,
        {
          packageBytes: fixture.target.packageBytes,
          modelBytes: fixture.target.glbBytes,
          manifestBytes,
        },
        fixture.edge.to,
        fixture.edge,
      ),
    ).rejects.toThrow(/strict UTF-8 JSON/);
  });
});
