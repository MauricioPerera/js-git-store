export type Branch = "content" | "index";

export const DEFAULT_HEAVY_REGEX = /\.(bin|docs\.json)$/;

export interface BranchRouter {
  branchOf(filename: string): Branch;
  regex(): RegExp;
}

/**
 * Build a router. Strips the `g` flag from the passed regex to prevent the
 * stateful-lastIndex footgun of `.test()` on `/g` regexes.
 */
export function makeBranchRouter(heavy?: RegExp): BranchRouter {
  const src = heavy ?? DEFAULT_HEAVY_REGEX;
  const flags = src.flags.replace("g", "");
  const re = new RegExp(src.source, flags);
  return {
    branchOf: (filename: string): Branch => (re.test(filename) ? "content" : "index"),
    regex: () => re,
  };
}
