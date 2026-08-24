import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(projectRoot, "dist");
const workerDist = join(dist, "weblilypond");

for (const stalePath of ["assets", "index.html", "favicon.svg", "file.svg", "globe.svg", "window.svg", ".assetsignore", "wrangler.json"]) {
  await rm(join(dist, stalePath), { recursive: true, force: true });
}

await cp(join(workerDist, "index.js"), join(dist, "index.js"));

const workerConfig = JSON.parse(await readFile(join(workerDist, "wrangler.json"), "utf8"));
workerConfig.assets.directory = "./client";
await writeFile(join(dist, "wrangler.json"), `${JSON.stringify(workerConfig)}\n`);
