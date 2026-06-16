// Build script: bundles the TypeScript sources into dist/ and copies static assets.
// Usage:
//   node build.mjs           -> one-off production build
//   node build.mjs --watch   -> rebuild on change (great while developing)
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

// Each entry point becomes its own bundle. MV3 requires plain files referenced
// from manifest.json (background.js, content.js) with no external imports at runtime,
// so we bundle everything each entry needs into a single self-contained file.
const buildOptions = {
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
  },
  bundle: true,
  format: "iife",          // IIFE = safe for both service worker and content-script contexts
  target: "chrome110",     // covers modern Chrome + Edge (Chromium)
  outdir,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
  logLevel: "info",
};

async function copyStatic() {
  // Copy manifest + icons verbatim into dist/.
  await cp("public", outdir, { recursive: true });
}

async function run() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  if (watch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    await copyStatic();
    console.log("[build] watching for changes…");
  } else {
    await esbuild.build(buildOptions);
    await copyStatic();
    console.log("[build] done -> dist/");
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
