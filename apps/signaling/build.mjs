import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  // The bundled CJS dependency (ws) calls require("events"). In an ESM
  // bundle there is no ambient require, so provide a real one.
  banner: {
    js: "import{createRequire as __createRequire}from 'node:module';const require=__createRequire(import.meta.url);",
  },
  sourcemap: false,
  logLevel: "info",
});
