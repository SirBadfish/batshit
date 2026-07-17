import { describe, expect, it } from "vitest";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  canonicalRecipeUtf8,
  isLowercaseSha256,
  requireLowercaseSha256,
  sha256Hex,
} from "./recipeCanonical";

describe("Recipe canonical serialization", () => {
  it("recursively sorts object keys while preserving array order", () => {
    expect(
      canonicalRecipeString({
        z: -0,
        a: { d: 2, c: 1 },
        list: [3, { b: true, a: null }],
      }),
    ).toBe('{"a":{"c":1,"d":2},"list":[3,{"a":null,"b":true}],"z":0}');
  });

  it("produces identical UTF-8 bytes and hashes for equivalent key orderings", async () => {
    const left = { b: [true, null, "x"], a: 1 };
    const right = { a: 1, b: [true, null, "x"] };

    expect(Array.from(canonicalRecipeUtf8(left))).toEqual(
      Array.from(canonicalRecipeUtf8(right)),
    );
    await expect(canonicalRecipeSha256(left)).resolves.toBe(
      "eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1",
    );
    await expect(canonicalRecipeSha256(right)).resolves.toBe(
      "eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1",
    );
    await expect(sha256Hex('{"a":1,"b":[true,null,"x"]}')).resolves.toBe(
      "eca8cfb31ab74533e1eb2f4c74d2d55dfe3c79ac704787e54be8647ea7777eb1",
    );
  });

  it("accepts plain null-prototype objects", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.b = 2;
    value.a = 1;
    expect(canonicalRecipeString(value)).toBe('{"a":1,"b":2}');
  });

  it.each([
    ["undefined object field", { value: undefined }],
    ["undefined array entry", [undefined]],
    ["NaN", { value: Number.NaN }],
    ["positive infinity", { value: Number.POSITIVE_INFINITY }],
    ["bigint", { value: BigInt(1) }],
    ["function", { value: () => undefined }],
    ["date", { value: new Date(0) }],
    ["map", { value: new Map([["a", 1]]) }],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalRecipeString(value)).toThrow(
      /Recipe canonicalization rejected/,
    );
  });

  it("rejects sparse arrays, named properties, and accessor elements", () => {
    const sparse = new Array(1);
    const named = [1] as number[] & { note?: string };
    named.note = "not JSON array content";
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get: () => 1,
    });
    accessor.length = 1;

    expect(() => canonicalRecipeString(sparse)).toThrow(/sparse arrays/);
    expect(() => canonicalRecipeString(named)).toThrow(/named properties/);
    expect(() => canonicalRecipeString(accessor)).toThrow(/accessor elements/);
  });

  it("rejects accessors, non-enumerable fields, symbol fields, and cycles", () => {
    const accessor = {};
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1,
    });
    const nonEnumerable = {};
    Object.defineProperty(nonEnumerable, "value", {
      enumerable: false,
      value: 1,
    });
    const symbolKey = { [Symbol("hidden")]: 1 };
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(() => canonicalRecipeString(accessor)).toThrow(
      /accessor properties/,
    );
    expect(() => canonicalRecipeString(nonEnumerable)).toThrow(
      /non-enumerable/,
    );
    expect(() => canonicalRecipeString(symbolKey)).toThrow(/symbol-keyed/);
    expect(() => canonicalRecipeString(cycle)).toThrow(/cyclic values/);
  });
});

describe("lowercase SHA-256 identities", () => {
  const digest = "0123456789abcdef".repeat(4);

  it("accepts exactly 64 lowercase hexadecimal characters", () => {
    expect(isLowercaseSha256(digest)).toBe(true);
    expect(requireLowercaseSha256(digest)).toBe(digest);
  });

  it.each([
    digest.toUpperCase(),
    digest.slice(1),
    `${digest}0`,
    "g".repeat(64),
  ])("rejects invalid digest %s", (value) => {
    expect(isLowercaseSha256(value)).toBe(false);
    expect(() => requireLowercaseSha256(value, "fixture.sha256")).toThrow(
      /fixture\.sha256 must be a lowercase SHA-256/,
    );
  });
});
