/*
  Minimal ambient shape for `bun:test` so `tsc --emitDeclarationOnly` (run by
  esbuild.config.mjs over the whole of src/) can typecheck the *.test.ts files
  without pulling @types/bun into the dependency tree.
*/
declare module "bun:test" {
  export function describe(label: string, fn: () => void): void;
  export function test(label: string, fn: () => void | Promise<void>): void;
  export function it(label: string, fn: () => void | Promise<void>): void;
  export function expect(value: any): {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toThrow(expected?: any): void;
  };
}
