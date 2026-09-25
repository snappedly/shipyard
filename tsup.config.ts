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
    workflow: "src/workflow/index.ts",
    "integrations/github": "src/integrations/github/index.ts",
    "integrations/releases": "src/integrations/releases/index.ts",
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
  define: {
    __SHIPYARD_VERSION__: JSON.stringify(pkg.version),
  },
});
