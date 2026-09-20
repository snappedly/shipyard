#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packOutput = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    encoding: "utf8",
  }),
);
const packResult = Array.isArray(packOutput)
  ? packOutput[0]
  : packOutput[packageJson.name];

if (!packResult) {
  throw new Error(`npm pack did not report ${packageJson.name}`);
}

const packedFiles = new Set(packResult.files.map(({ path }) => path));
const requiredFiles = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/main.js",
];

for (const file of requiredFiles) {
  if (!packedFiles.has(file)) {
    throw new Error(`Published package is missing ${file}`);
  }
}

const declaredPackages = new Set([
  packageJson.name,
  ...Object.keys(packageJson.dependencies ?? {}),
  ...Object.keys(packageJson.peerDependencies ?? {}),
]);
const declarationFiles = packResult.files
  .map(({ path }) => path)
  .filter((path) => path.endsWith(".d.ts"));
const importPattern = /(?:from\s+|import\s*)["']([^./][^"']*)["']/g;

for (const file of declarationFiles) {
  const contents = await readFile(file, "utf8");
  for (const match of contents.matchAll(importPattern)) {
    const specifier = match[1];
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (
      !packageName.startsWith("node:") &&
      !declaredPackages.has(packageName)
    ) {
      throw new Error(`${file} imports undeclared package ${packageName}`);
    }
  }
}

console.log(`✓ Package manifest contains ${packedFiles.size} files`);
console.log("✓ Public declarations only import declared packages");
