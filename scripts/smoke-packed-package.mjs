#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";

const tarballArgument = process.argv[2];
if (!tarballArgument) {
  throw new Error("Usage: smoke-packed-package.mjs <package.tgz>");
}

const tarball = resolve(tarballArgument);
const temporaryDirectory = await mkdtemp(
  resolve(tmpdir(), "shipyard-package-smoke-"),
);

try {
  await writeFile(
    resolve(temporaryDirectory, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  execFileSync("npm", ["install", "--ignore-scripts", tarball], {
    cwd: temporaryDirectory,
    stdio: "inherit",
  });
  execFileSync("npm", ["install", "--ignore-scripts", "typescript@5.9.3"], {
    cwd: temporaryDirectory,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        'await import("@snappedly-tools/shipyard")',
        'await import("@snappedly-tools/shipyard/sandboxes/docker")',
        'await import("@snappedly-tools/shipyard/sandboxes/vercel")',
        'await import("@snappedly-tools/shipyard/sandboxes/no-sandbox")',
      ].join(";"),
    ],
    { cwd: temporaryDirectory, stdio: "inherit" },
  );
  await writeFile(
    resolve(temporaryDirectory, "consumer.ts"),
    [
      'import * as shipyard from "@snappedly-tools/shipyard";',
      'import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";',
      'import { vercel } from "@snappedly-tools/shipyard/sandboxes/vercel";',
      'import { noSandbox } from "@snappedly-tools/shipyard/sandboxes/no-sandbox";',
      "void [shipyard, docker, vercel, noSandbox];",
    ].join("\n"),
  );
  await writeFile(
    resolve(temporaryDirectory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    }),
  );
  execFileSync("npm", ["exec", "--", "tsc", "--noEmit"], {
    cwd: temporaryDirectory,
    stdio: "inherit",
  });
  execFileSync(
    process.execPath,
    [
      resolve(
        temporaryDirectory,
        "node_modules/@snappedly-tools/shipyard/dist/main.js",
      ),
      "--help",
    ],
    { cwd: temporaryDirectory, stdio: "inherit" },
  );

  const installedPackage = JSON.parse(
    await readFile(
      resolve(
        temporaryDirectory,
        "node_modules/@snappedly-tools/shipyard/package.json",
      ),
      "utf8",
    ),
  );
  console.log(
    `✓ Installed and exercised ${installedPackage.name} from ${basename(tarball)}`,
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
