import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds the WebLily React Router application", async () => {
  const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  assert.match(html, /<title>WebLily/);
  assert.match(html, /LilyPond/);
  assert.match(html, /<div id="root"><\/div>/);
});
