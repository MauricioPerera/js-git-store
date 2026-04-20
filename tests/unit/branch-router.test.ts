import { describe, expect, it } from "vitest";
import { DEFAULT_HEAVY_REGEX, makeBranchRouter } from "../../src/core/branch-router.js";

describe("branch router", () => {
  it("default regex routes heavy files to content", () => {
    const r = makeBranchRouter();
    expect(r.branchOf("users.docs.json")).toBe("content");
    expect(r.branchOf("articles.bin")).toBe("content");
    expect(r.branchOf("embeddings.q8.bin")).toBe("content");
    expect(r.branchOf("embeddings.b1.bin")).toBe("content");
  });

  it("default regex routes light files to index", () => {
    const r = makeBranchRouter();
    expect(r.branchOf("users.meta.json")).toBe("index");
    expect(r.branchOf("users.email.idx.json")).toBe("index");
    expect(r.branchOf("users.age.sidx.json")).toBe("index");
    expect(r.branchOf("embeddings.json")).toBe("index");
    expect(r.branchOf("embeddings.q8.json")).toBe("index");
  });

  it("custom regex overrides default", () => {
    const r = makeBranchRouter(/^big-/);
    expect(r.branchOf("big-users.json")).toBe("content");
    expect(r.branchOf("small-users.json")).toBe("index");
  });

  it("exposes the normalized regex (clone, /g stripped)", () => {
    expect(makeBranchRouter().regex().source).toBe(DEFAULT_HEAVY_REGEX.source);
    expect(makeBranchRouter(/\.bin$/g).regex().flags).not.toContain("g");
  });
});
