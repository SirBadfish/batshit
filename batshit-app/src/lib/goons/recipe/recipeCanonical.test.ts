import { createHash } from "node:crypto";
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

  it("preserves finite-number spellings at rounding and exponent boundaries", () => {
    const values = [
      -0, 0, Number.MIN_VALUE, -Number.MIN_VALUE,
      2.2250738585072014e-308, Number.MAX_VALUE,
      0.000001, 0.0000001, 100000000000000000000, 1e21,
      -1.2345678901234567e-20,
    ];
    expect(canonicalRecipeString(values)).toBe(
      "[0,0,5e-324,-5e-324,2.2250738585072014e-308,1.7976931348623157e+308,0.000001,1e-7,100000000000000000000,1e+21,-1.2345678901234567e-20]",
    );
  });

  it.each([0, 1, 1023, 1024, 1025, 2048, 2049])(
    "keeps independent JSON bytes and hash for numeric array length %i",
    async (length) => {
      const values = Array.from({ length }, (_, index) =>
        index % 17 === 0 ? -0 : index % 17 === 1 ? Number.MIN_VALUE * (index + 1) :
          index % 17 === 2 ? 1e21 + index : (index - 1024) / 8192,
      );
      const expected = JSON.stringify(values);
      const expectedBytes = new TextEncoder().encode(expected);
      const expectedHash = createHash("sha256").update(expectedBytes).digest("hex");

      expect(canonicalRecipeString(values)).toBe(expected);
      expect(canonicalRecipeUtf8(values)).toEqual(expectedBytes);
      await expect(canonicalRecipeSha256(values)).resolves.toBe(expectedHash);
    },
  );

  it.each([1, 1023, 1024, 1025, 2048])(
    "keeps strict mixed-array output after a numeric prefix of %i",
    (length) => {
      const prefix = Array.from({ length }, (_, index) => index % 7 === 0 ? -0 : index - 512);
      const mixed = [...prefix, { z: 2, a: 1 }, true, null, "tail", [3, 2]];
      const prefixText = JSON.stringify(prefix).slice(1, -1);
      expect(canonicalRecipeString(mixed)).toBe(
        `[${prefixText},{"a":1,"z":2},true,null,"tail",[3,2]]`,
      );
    },
  );

  it("keeps element failures ahead of later named and symbol errors after a long numeric prefix", () => {
    const prefix = Array.from({ length: 1024 }, (_, index) => index);
    const nonFinite = [...prefix, Number.NaN] as unknown[] & { note?: string };
    nonFinite.note = "later named property";
    expect(() => canonicalRecipeString(nonFinite)).toThrow(
      /\$\[1024\]: numbers must be finite/,
    );

    const sparse = [...prefix, 1];
    delete sparse[1024];
    Object.defineProperty(sparse, Symbol("later"), { value: true });
    expect(() => canonicalRecipeString(sparse)).toThrow(
      /\$\[1024\]: sparse arrays are not supported/,
    );

    const accessor: unknown[] = [...prefix, 1];
    let getterCalls = 0;
    Object.defineProperty(accessor, "1024", {
      enumerable: true,
      configurable: true,
      get() { getterCalls += 1; throw Error("array getter ran"); },
    });
    expect(() => canonicalRecipeString(accessor)).toThrow(
      /\$\[1024\]: accessor elements are not supported/,
    );
    expect(getterCalls).toBe(0);

    const named = [...prefix] as number[] & { note?: string };
    named.note = "named before symbol";
    Object.defineProperty(named, Symbol("later"), { value: true });
    expect(() => canonicalRecipeString(named)).toThrow(/arrays may not contain named properties/);
    const symbolOnly = [...prefix];
    Object.defineProperty(symbolOnly, Symbol("later"), { value: true });
    expect(() => canonicalRecipeString(symbolOnly)).toThrow(/symbol-keyed properties/);
  });

  it("rejects non-enumerable entries, invalid values, and cycles after a long numeric prefix", () => {
    const prefix = Array.from({ length: 1024 }, (_, index) => index);
    const hidden = [...prefix, 1];
    Object.defineProperty(hidden, "1024", { value: 1, enumerable: false });
    expect(() => canonicalRecipeString(hidden)).toThrow(/non-enumerable elements/);
    for (const invalid of [Number.POSITIVE_INFINITY, undefined, BigInt(1), () => 1]) {
      expect(() => canonicalRecipeString([...prefix, invalid])).toThrow(
        /Recipe canonicalization rejected \$\[1024\]/,
      );
    }
    const cycle: unknown[] = [...prefix];
    cycle.push(cycle);
    expect(() => canonicalRecipeString(cycle)).toThrow(/cyclic values/);
  });

  it("ignores inherited toJSON while encoding a large numeric array", () => {
    const prototypes = [Array.prototype, Object.prototype];
    const originals = prototypes.map((prototype) =>
      Object.getOwnPropertyDescriptor(prototype, "toJSON"),
    );
    let calls = 0;
    try {
      for (const prototype of prototypes) {
        Object.defineProperty(prototype, "toJSON", {
          configurable: true,
          value() { calls += 1; throw Error("inherited toJSON ran"); },
        });
      }
      const values = Array.from({ length: 1025 }, (_, index) => index);
      expect(canonicalRecipeString(values)).toBe(
        `[${Array.from({ length: 1025 }, (_, index) => index).join(",")}]`,
      );
      expect(calls).toBe(0);
    } finally {
      for (let index = 0; index < prototypes.length; index += 1) {
        const original = originals[index];
        if (original) Object.defineProperty(prototypes[index]!, "toJSON", original);
        else Reflect.deleteProperty(prototypes[index]!, "toJSON");
      }
    }
  });

  it.each(["numeric", "mixed"] as const)(
    "preserves the original %s array Proxy descriptor and length trap order",
    (kind) => {
      const calls: string[] = [];
      const source = kind === "numeric" ? [1, 2, 3] : [1, { z: 2, a: 1 }, 3];
      const value = new Proxy(source, {
        ownKeys(target) {
          calls.push("ownKeys");
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor(target, key) {
          calls.push(`descriptor:${String(key)}`);
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
          calls.push(`get:${String(key)}`);
          if (key === "length") return Reflect.get(target, key, receiver);
          throw Error(`source index was read directly: ${String(key)}`);
        },
      });
      expect(canonicalRecipeString(value)).toBe(
        kind === "numeric" ? "[1,2,3]" : '[1,{"a":1,"z":2},3]',
      );
      expect(calls).toEqual([
        "ownKeys", "descriptor:0", "descriptor:1", "descriptor:2", "descriptor:length",
        ...Array(7).fill("get:length"), "ownKeys",
      ]);
    },
  );

  it("preserves repeated length reads even when a Proxy changes one loop result", () => {
    const calls: string[] = [];
    let lengthReads = 0;
    const value = new Proxy([1, 2, 3], {
      ownKeys(target) {
        calls.push("ownKeys");
        return Reflect.ownKeys(target);
      },
      getOwnPropertyDescriptor(target, key) {
        calls.push(`descriptor:${String(key)}`);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) {
        calls.push(`get:${String(key)}`);
        if (key !== "length") throw Error(`source index was read directly: ${String(key)}`);
        lengthReads += 1;
        return lengthReads === 3 ? 2 : Reflect.get(target, key, receiver);
      },
    });
    expect(canonicalRecipeString(value)).toBe("[1,2]");
    expect(calls).toEqual([
      "ownKeys", "descriptor:0", "descriptor:1", "descriptor:2", "descriptor:length",
      ...Array(6).fill("get:length"), "ownKeys",
    ]);
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
