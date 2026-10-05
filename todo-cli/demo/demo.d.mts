// Types for demo.mjs (written by hand, like sdk-ts's interop helpers).

export type DemoResult =
  | { readonly transcript: readonly string[]; readonly failures: readonly string[] }
  | { readonly skipped: string };

export function runDemo(options?: { readonly say?: (line: string) => void }): Promise<DemoResult>;
