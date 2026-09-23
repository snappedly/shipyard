import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const templateDir = dirname(fileURLToPath(import.meta.url));
const script = (name: string) =>
  join(templateDir, "templates", "simple-loop", name);
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "shipyard-skills-"));
  const bin = join(dir, "bin");
  await mkdir(bin);
  return { dir, bin };
};
const executable = async (path: string, content: string) => {
  await writeFile(path, `#!/usr/bin/env node\n${content}`);
  await chmod(path, 0o755);
};
const run = (
  command: string,
  args: string[],
  dir: string,
  bin: string,
  extra: Record<string, string> = {},
  input?: string,
) =>
  spawnSync(command, args, {
    cwd: dir,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: join(dir, "home"),
      ...extra,
    },
  });

describe("standalone workflow scripts", () => {
  it("selects standalone issues, skips specs and linked children, and reconciles a ready PR", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "gh.log");
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, args.join(" ") + "\\n");
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "list") console.log(JSON.stringify([
  {number:1,title:"Standalone",body:""},
  {number:2,title:"Spec",body:"**Work item type:** planning spec"},
  {number:3,title:"Text child",body:"## Parent\\n#2"},
  {number:4,title:"Native child",body:""},
  {number:5,title:"Native spec",body:""},
  {number:6,title:"Already ready",body:""}
]));
else if (args[0] === "api" && args[1].endsWith("/parent")) {
  if (args[1].includes("/4/")) console.log("{}");
  else { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
}
else if (args[0] === "api" && args[1].endsWith("/sub_issues")) console.log(args[1].includes("/5/") ? "1" : "0");
else if (args[0] === "pr" && args[1] === "list") console.log(args.includes("shipyard/issue-6") ? JSON.stringify([{number:9,isDraft:false,labels:[{name:"ready-for-human"}]}]) : "[]");
else if (args[0] === "issue" && args[1] === "edit") console.log("");
else process.exit(2);
`,
    );
    const result = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { id: "1", title: "Standalone", branch: "shipyard/issue-1" },
    ]);
    expect(await readFile(log, "utf8")).toContain(
      "issue edit 6 --repo owner/repo --remove-label shipyard",
    );
  });

  it("installs the candidate's package manager and complete skill directories before work", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "install.log");
    await mkdir(join(dir, "home"));
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        dependencies: { first: "1" },
      }),
    );
    await executable(
      join(bin, "corepack"),
      `
const fs = require("node:fs");
fs.appendFileSync(process.env.INSTALL_LOG, process.argv.slice(2).join(" ") + " " + fs.readFileSync("package.json", "utf8") + "\\n");
`,
    );
    await executable(
      join(bin, "git"),
      `
const fs = require("node:fs"); const path = require("node:path");
fs.appendFileSync(process.env.INSTALL_LOG, "git " + process.argv.slice(2).join(" ") + "\\n");
if (process.argv[2] === "remote") process.exit(0);
if (process.env.FAIL_CLONE) process.exit(1);
const root = process.argv.at(-1);
for (const name of ["implement","implement-spec","code-cleanup","code-review","tdd"]) {
  const dir = path.join(root,"skills","tools",name);
  fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,"SKILL.md"), name); fs.writeFileSync(path.join(dir,"guidance.md"), "linked guidance");
}
`,
    );
    let result = run("bash", [script("setup.sh")], dir, bin, {
      INSTALL_LOG: log,
      GH_REPO: "owner/repo",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(
      await readFile(
        join(dir, "home", ".agents", "skills", "implement", "guidance.md"),
        "utf8",
      ),
    ).toBe("linked guidance");
    expect(await readFile(log, "utf8")).toContain(
      "git remote set-url origin https://github.com/owner/repo.git",
    );
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        dependencies: { first: "1", added: "2" },
      }),
    );
    result = run("bash", [script("setup.sh")], dir, bin, {
      INSTALL_LOG: log,
      GH_REPO: "owner/repo",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(log, "utf8")).toContain('"added":"2"');
    result = run("bash", [script("setup.sh")], dir, bin, {
      INSTALL_LOG: log,
      GH_REPO: "owner/repo",
      FAIL_CLONE: "1",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not install Snappedly skills");
  });

  it("publishes or updates one ready PR, then removes activation without closing the issue", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "handoff.log");
    const state = join(dir, "pr.json");
    await writeFile(state, JSON.stringify({ number: 0, isDraft: true }));
    await executable(
      join(bin, "git"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HANDOFF_LOG, "git " + args.join(" ") + "\\n");
if (args[0] === "log") console.log("abc123");
`,
    );
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
let state = JSON.parse(fs.readFileSync(process.env.PR_STATE, "utf8"));
fs.appendFileSync(process.env.HANDOFF_LOG, "gh " + args.join(" ") + "\\n");
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "view") console.log("Fix bug");
else if (args[0] === "pr" && args[1] === "list") console.log(state.number || "");
else if (args[0] === "pr" && args[1] === "create") { state.number = 7; fs.writeFileSync(process.env.PR_STATE, JSON.stringify(state)); }
else if (args[0] === "pr" && args[1] === "ready") { state.isDraft = false; fs.writeFileSync(process.env.PR_STATE, JSON.stringify(state)); }
else if (args[0] === "pr" && args[1] === "view") console.log(args.includes("isDraft") ? String(state.isDraft) : "https://example.test/pr/7");
else if (args[0] === "pr" && args[1] === "edit") {}
else if (args[0] === "label") {}
else if (args[0] === "issue" && args[1] === "edit") {}
else process.exit(2);
`,
    );
    const env = { HANDOFF_LOG: log, PR_STATE: state };
    let result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      env,
      "",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing verification evidence");
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");

    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      env,
      "npm test: pass; review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("https://example.test/pr/7");
    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      env,
      "npm test: pass; review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    const commands = await readFile(log, "utf8");
    expect(commands.match(/gh pr create/g)).toHaveLength(1);
    expect(commands.match(/gh pr edit 7/g)).toHaveLength(4);
    expect(commands).toContain(
      "gh issue edit 1 --repo owner/repo --remove-label shipyard",
    );
    expect(commands).not.toContain("gh issue close");
    expect(commands).not.toContain("gh pr merge");
  });
});
