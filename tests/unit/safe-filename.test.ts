import { describe, expect, it } from "vitest";
import { assertSafeFilename } from "../../src/core/safe-filename.js";

describe("assertSafeFilename", () => {
  const ok = ["users.docs.json", "a.bin", "sub/file.json", "deeply/nested/path.bin", "with-dash.json", "with_under.json"];
  for (const f of ok) {
    it(`accepts ${JSON.stringify(f)}`, () => {
      expect(() => assertSafeFilename(f)).not.toThrow();
    });
  }

  const bad: Array<[string, string]> = [
    ["", "non-empty"],
    ["..", "segment"],
    [".", "segment"],
    ["../escape.json", "segment"],
    ["sub/../escape.json", "segment"],
    ["./local.json", "segment"],
    ["/abs/path.json", "relative"],
    ["\\win\\abs.json", "relative"],
    ["C:/windows.json", "drive-letter"],
    ["d:\\win.json", "drive-letter"],
    ["nul\0byte.json", "null byte"],
  ];
  for (const [f, hint] of bad) {
    it(`rejects ${JSON.stringify(f)} (${hint})`, () => {
      let err: unknown;
      try { assertSafeFilename(f); } catch (e) { err = e; }
      expect((err as { code?: string })?.code).toBe("INVALID_CONFIG");
    });
  }

  it("rejects non-string input", () => {
    let err: unknown;
    try { assertSafeFilename(42 as unknown as string); } catch (e) { err = e; }
    expect((err as { code?: string })?.code).toBe("INVALID_CONFIG");
  });
});
