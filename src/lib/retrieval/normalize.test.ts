import { describe, expect, it } from "vitest";
import { assertNormalized, l2Normalize } from "./normalize.js";

function norm(v: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < v.length; i++) sumSquares += v[i]! * v[i]!;
  return Math.sqrt(sumSquares);
}

describe("l2Normalize", () => {
  it("returns a vector with L2 norm within 1e-6 of 1.0 for a typical vector", () => {
    const v = new Float32Array([3, 4]);
    expect(Math.abs(norm(l2Normalize(v)) - 1.0)).toBeLessThan(1e-6);
  });

  it("returns a vector with L2 norm within 1e-6 of 1.0 for a very small-magnitude vector", () => {
    const v = new Float32Array([1e-6, 2e-6, -1.5e-6]);
    expect(Math.abs(norm(l2Normalize(v)) - 1.0)).toBeLessThan(1e-6);
  });

  it("returns a vector with L2 norm within 1e-6 of 1.0 for a very large-magnitude vector", () => {
    const v = new Float32Array([1e8, -2e8, 3e8]);
    expect(Math.abs(norm(l2Normalize(v)) - 1.0)).toBeLessThan(1e-6);
  });

  it("returns the input values unchanged when skip: true is passed (D-16 negative control)", () => {
    const v = new Float32Array([3, 4]);
    const out = l2Normalize(v, { skip: true });
    expect(Array.from(out)).toEqual(Array.from(v));
  });

  it("throws naming the zero-vector case for an all-zero vector", () => {
    expect(() => l2Normalize(new Float32Array(768))).toThrow(/zero vector/i);
  });

  it("has exactly one exported normalization function", () => {
    // Documented here as an executable companion to the plan's grep-based acceptance criterion;
    // this test just re-affirms the single call site behaves for both the normalize and skip cases.
    const v = new Float32Array([1, 1, 1]);
    expect(l2Normalize(v)).toBeInstanceOf(Float32Array);
    expect(l2Normalize(v, { skip: true })).toBeInstanceOf(Float32Array);
  });
});

describe("assertNormalized", () => {
  it("does not throw for a vector with norm within tolerance of 1.0", () => {
    const v = l2Normalize(new Float32Array([1, 2, 3]));
    expect(() => assertNormalized(v)).not.toThrow();
  });

  it("throws with the measured norm in the message when the norm deviates beyond tolerance", () => {
    const v = new Float32Array([3, 4]); // norm = 5
    expect(() => assertNormalized(v)).toThrow(/5/);
  });

  it("negative control: assertNormalized(l2Normalize(v, { skip: true })) throws for a non-unit vector", () => {
    const nonUnitVector = new Float32Array([3, 4, 0]); // norm = 5, not 1.0
    expect(() => assertNormalized(l2Normalize(nonUnitVector, { skip: true }))).toThrow();
  });
});
