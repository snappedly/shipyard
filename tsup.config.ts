import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    main: "src/main.ts",
    "sandboxes/docker": "src/sandboxes/docker.ts",
    "sandboxes/vercel": "src/sandboxes/vercel.ts",
    "sandboxes/no-sandbox": "src/sandboxes/no-sandbox.ts",
  },
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  platform: "node",
  splitting: true,
  sourcemap: true,
  clean: true,
  dts: true,
  treeshake: true,
  external: ["@vercel/sandbox"],
  define: {
    __SHIPYARD_VERSION__: JSON.stringify(pkg.version),
  },
});
