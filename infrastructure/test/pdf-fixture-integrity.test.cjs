const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const root = resolve(__dirname, "../..");
test("PDF bytes are protected from Git text conversion", () => {
  assert.match(
    readFileSync(resolve(root, ".gitattributes"), "utf8"),
    /^\*\.pdf binary$/m,
  );
});
for (const name of [
  "single",
  "multi",
  "empty",
  "graphics",
  "image-only",
  "script",
  "encrypted",
  "encrypted-empty-password",
]) {
  test(`${name} fixture preserves the actual xref byte offset`, () => {
    const bytes = readFileSync(
      resolve(root, "apps/api/test/fixtures/pdf", name + ".pdf"),
    );
    const match = /startxref\s+(\d+)\s+%%EOF/.exec(bytes.toString("latin1"));
    assert.ok(match, "fixture has a startxref pointer");
    const offset = Number(match[1]);
    assert.equal(bytes.subarray(offset, offset + 4).toString("ascii"), "xref");
  });
}
