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

describe("issue workflow scripts", () => {
  it("resolves activated parent and child into one dependency ordered spec scope", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "gh.log");
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2); const path = args[1] || "";
fs.appendFileSync(process.env.GH_LOG, args.join(" ") + "\\n");
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "list" && args.includes("open")) {
  const pool = [
    {number:1,title:"Standalone",body:""},
    {number:2,title:"Spec",body:"**Work item type:** planning spec"},
    {number:3,title:"Child",body:"**Work item type:** executable\\n\\n## Parent\\n#2"},
    {number:4,title:"Sibling",body:""},
    {number:6,title:"Already ready",body:""}
  ];
  const ids = process.env.ACTIVATION === "parent" ? [2] : process.env.ACTIVATION === "siblings" ? [3,4] : [1,2,3,6];
  console.log(JSON.stringify(pool.filter((item) => ids.includes(item.number))));
}
else if (args[0] === "issue" && args[1] === "list" && args.includes("all")) console.log(JSON.stringify([
  {number:3,title:"Child",body:"**Work item type:** executable\\n\\n## Parent\\n#2",state:"OPEN"},
  {number:4,title:"Sibling",body:"**Work item type:** executable",state:"OPEN"}
]));
else if (args[0] === "issue" && args[1] === "view") console.log(JSON.stringify({number:2,title:"Spec",body:"**Work item type:** planning spec",state:"OPEN"}));
else if (args[0] === "api" && path.endsWith("/parent")) {
  if (!process.env.TEXT_ONLY && (path.includes("/3/") || path.includes("/4/"))) console.log(JSON.stringify({number:2}));
  else { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
}
else if (args[0] === "api" && path.includes("/sub_issues?")) console.log(JSON.stringify(process.env.TEXT_ONLY ? [] : path.includes("/2/") ? [
  {number:3,title:"Child",body:"**Work item type:** executable\\n\\n## Parent\\n#2",state:"OPEN"},
  {number:4,title:"Sibling",body:"**Work item type:** executable",state:"OPEN"}
] : []));
else if (args[0] === "api" && path.includes("/dependencies/blocked_by?")) console.log(JSON.stringify(path.includes("/4/") ? [{number:3,title:"Child",state:"OPEN"}] : []));
else if (args[0] === "pr" && args[1] === "list") console.log(args.includes("shipyard/issue-6") || (process.env.READY_SPEC && args.includes("shipyard/spec-2")) ? JSON.stringify([{number:9,isDraft:false,labels:[{name:"ready-for-human"}]}]) : "[]");
else if (args[0] === "issue" && args[1] === "edit") {}
else process.exit(2);
`,
    );
    for (const template of [
      "simple-loop",
      "sequential-reviewer",
      "parallel-planner",
      "parallel-planner-with-review",
    ]) {
      const result = run(
        "node",
        [join(templateDir, "templates", template, "select-issues.mjs")],
        dir,
        bin,
        { GH_LOG: log },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        {
          id: "1",
          title: "Standalone",
          branch: "shipyard/issue-1",
          kind: "standalone",
        },
        {
          id: "2",
          title: "Spec",
          body: "**Work item type:** planning spec",
          branch: "shipyard/spec-2",
          kind: "spec",
          tickets: [
            {
              id: "3",
              title: "Child",
              body: "**Work item type:** executable\n\n## Parent\n#2",
              state: "OPEN",
              blockedBy: [],
            },
            {
              id: "4",
              title: "Sibling",
              body: "**Work item type:** executable",
              state: "OPEN",
              blockedBy: [{ id: "3", title: "Child", state: "OPEN" }],
            },
          ],
        },
      ]);
    }
    expect(await readFile(log, "utf8")).toContain(
      "issue edit 6 --repo owner/repo --remove-label shipyard",
    );
    for (const activation of ["parent", "siblings"]) {
      const result = run("node", [script("select-issues.mjs")], dir, bin, {
        GH_LOG: log,
        ACTIVATION: activation,
      });
      expect(result.status, result.stderr).toBe(0);
      const scopes = JSON.parse(result.stdout);
      expect(scopes).toHaveLength(1);
      expect(scopes[0].id).toBe("2");
      expect(
        scopes[0].tickets.map((ticket: { id: string }) => ticket.id),
      ).toEqual(["3", "4"]);
    }
    const textOnly = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      ACTIVATION: "parent",
      TEXT_ONLY: "1",
    });
    expect(textOnly.status, textOnly.stderr).toBe(0);
    expect(
      JSON.parse(textOnly.stdout)[0].tickets.map(
        (ticket: { id: string }) => ticket.id,
      ),
    ).toEqual(["3"]);
    const alreadyReady = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      ACTIVATION: "siblings",
      READY_SPEC: "1",
    });
    expect(alreadyReady.status, alreadyReady.stderr).toBe(0);
    expect(JSON.parse(alreadyReady.stdout)).toEqual([]);
    const reconciled = await readFile(log, "utf8");
    for (const id of [3, 4])
      expect(reconciled).toContain(
        `issue edit ${id} --repo owner/repo --remove-label shipyard`,
      );
  }, 20_000);

  it("rejects conflicting native and body parent links", async () => {
    const { dir, bin } = await fixture();
    await executable(
      join(bin, "gh"),
      `
const args = process.argv.slice(2);
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "list") console.log(JSON.stringify([{number:3,title:"Child",body:"## Parent\\n#9"}]));
else if (args[0] === "api" && args[1].endsWith("/parent")) console.log(JSON.stringify({number:2}));
else process.exit(2);
`,
    );
    const result = run("node", [script("select-issues.mjs")], dir, bin);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Conflicting parent links for #3");
  });

  it("rejects incomplete or non-executable spec relationships", async () => {
    const { dir, bin } = await fixture();
    await executable(
      join(bin, "gh"),
      `
const args = process.argv.slice(2); const path = args[1] || "";
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "list" && args.includes("open")) console.log(JSON.stringify([{number:2,title:"Spec",body:"**Work item type:** planning spec"}]));
else if (args[0] === "issue" && args[1] === "list" && args.includes("all")) console.log("[]");
else if (args[0] === "api" && path.endsWith("/parent")) { console.error("Not Found (HTTP 404)"); process.exit(1); }
else if (args[0] === "api" && path.includes("/sub_issues?")) console.log(JSON.stringify(process.env.CASE === "missing" ? [] : [{number:3,title:"Planning child",body:"**Work item type:** planning spec",state:"open"}]));
else if (args[0] === "api" && path.includes("/dependencies/blocked_by?")) console.log("[]");
else process.exit(2);
`,
    );
    for (const [scenario, message] of [
      ["missing", "no linked executable tickets"],
      ["nonexec", "not an executable ticket"],
    ] as const) {
      const result = run("node", [script("select-issues.mjs")], dir, bin, {
        CASE: scenario,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
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
else if (args[0] === "issue" && args[1] === "view") console.log(args.includes("labels") ? "shipyard" : "Fix bug");
else if (args[0] === "pr" && args[1] === "list") console.log(state.number || "");
else if (args[0] === "pr" && args[1] === "create") { state.number = 7; fs.writeFileSync(process.env.PR_STATE, JSON.stringify(state)); fs.appendFileSync(process.env.HANDOFF_LOG, "BODY " + fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8") + "\\n"); }
else if (args[0] === "pr" && args[1] === "ready") { state.readyAttempted = true; if (!process.env.FAIL_PR_READY) state.isDraft = false; if (process.env.CLOSE_PR_AFTER_READY) state.status = "CLOSED"; fs.writeFileSync(process.env.PR_STATE, JSON.stringify(state)); if (process.env.FAIL_PR_READY || process.env.FAIL_PR_READY_AFTER_UPDATE) process.exit(1); }
else if (args[0] === "pr" && args[1] === "view") { if (process.env.FAIL_PR_STATUS && state.readyAttempted && args.includes("isDraft")) process.exit(1); console.log(args.includes("isDraft") ? String(state.isDraft) : args.includes("state") ? state.status || "OPEN" : "https://example.test/pr/7"); }
else if (args[0] === "pr" && args[1] === "edit") {}
else if (args[0] === "label") {}
else if (args[0] === "issue" && args[1] === "edit") { if (process.env.FAIL_ACTIVATION) process.exit(1); }
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
    for (const [packet, message] of [
      ["Review: approved", "Missing check evidence"],
      ["Checks: npm test pass", "Missing review evidence"],
    ] as const) {
      result = run(
        "bash",
        [
          script("handoff.sh"),
          "1",
          "shipyard/issue-1",
          "staging",
          "owner/repo",
        ],
        dir,
        bin,
        env,
        packet,
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
    }
    expect(await readFile(log, "utf8").catch(() => "")).toBe("");

    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      env,
      "Checks: npm test pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("https://example.test/pr/7");
    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      env,
      "Checks: npm test pass; Review: approved",
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

    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      { ...env, FAIL_ACTIVATION: "1" },
      "Checks: npm test pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("https://example.test/pr/7");
    expect(result.stderr).toContain("next invocation will retry cleanup");

    await writeFile(state, JSON.stringify({ number: 7, isDraft: true }));
    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      { ...env, FAIL_PR_READY: "1" },
      "Checks: npm test pass; Review: approved",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not become ready");
    expect(await readFile(state, "utf8")).toContain('"isDraft":true');
    expect(await readFile(log, "utf8")).toContain(
      "gh pr edit 7 --repo owner/repo --remove-label ready-for-human",
    );

    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      { ...env, FAIL_PR_READY_AFTER_UPDATE: "1" },
      "Checks: npm test pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("https://example.test/pr/7");
    expect(await readFile(state, "utf8")).toContain('"isDraft":false');

    await writeFile(state, JSON.stringify({ number: 7, isDraft: true }));
    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      { ...env, FAIL_PR_READY_AFTER_UPDATE: "1", FAIL_PR_STATUS: "1" },
      "Checks: npm test pass; Review: approved",
    );
    expect(result.status).toBe(75);
    expect(result.stderr).toContain("Could not confirm PR readiness");

    await writeFile(state, JSON.stringify({ number: 7, isDraft: true }));
    result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      dir,
      bin,
      { ...env, CLOSE_PR_AFTER_READY: "1" },
      "Checks: npm test pass; Review: approved",
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("did not become ready");

    await writeFile(state, JSON.stringify({ number: 0, isDraft: true }));
    result = run(
      "bash",
      [
        script("handoff.sh"),
        "2",
        "shipyard/spec-2",
        "staging",
        "owner/repo",
        "2,3,4",
      ],
      dir,
      bin,
      env,
      "Checks: pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    const specCommands = await readFile(log, "utf8");
    expect(specCommands).toContain("BODY Source issues: #2 #3 #4");
    for (const id of [2, 3, 4])
      expect(specCommands).toContain(
        `gh issue edit ${id} --repo owner/repo --remove-label shipyard`,
      );
    expect(specCommands).not.toContain("gh issue close");
    expect(specCommands).not.toContain("gh pr merge");
  }, 15_000);

  it("hands off a bundle clone whose target exists only as a remote ref", async () => {
    const { dir, bin } = await fixture();
    const source = join(dir, "source");
    const clone = join(dir, "clone");
    const bundle = join(dir, "source.bundle");
    const realGit = run("which", ["git"], dir, bin).stdout.trim();
    const git = (...args: string[]) => {
      const result = spawnSync(realGit, args, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    git("init", "-b", "staging", source);
    git("-C", source, "config", "user.name", "Test");
    git("-C", source, "config", "user.email", "test@example.com");
    await writeFile(join(source, "base.txt"), "base");
    git("-C", source, "add", ".");
    git("-C", source, "commit", "-m", "base");
    git("-C", source, "checkout", "-b", "shipyard/issue-1");
    await writeFile(join(source, "change.txt"), "change");
    git("-C", source, "add", ".");
    git("-C", source, "commit", "-m", "change");
    git("-C", source, "bundle", "create", bundle, "--all");
    git("clone", bundle, clone);
    git("-C", clone, "checkout", "shipyard/issue-1");
    const localBase = spawnSync(realGit, ["-C", clone, "rev-parse", "staging"]);
    expect(localBase.status).not.toBe(0);
    await executable(
      join(bin, "git"),
      `
const {spawnSync} = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("push") || (args[0] === "remote" && args[1] === "set-url")) process.exit(0);
const result = spawnSync(process.env.REAL_GIT, args, {stdio:"inherit"});
process.exit(result.status ?? 1);
`,
    );
    await executable(
      join(bin, "gh"),
      `
const args = process.argv.slice(2);
if (args[0] === "issue" && args[1] === "view") {
  if (!args.includes("--repo")) process.exit(2);
  console.log(args.includes("labels") ? "shipyard" : "Fix bug");
} else if (args[0] === "pr" && args[1] === "list") console.log("7");
else if (args[0] === "pr" && args[1] === "view") console.log(args.includes("isDraft") ? "false" : args.includes("state") ? "OPEN" : "https://example.test/pr/7");
else if (args[0] === "pr" || args[0] === "label" || args[0] === "issue") {}
else process.exit(2);
`,
    );
    const result = run(
      "bash",
      [script("handoff.sh"), "1", "shipyard/issue-1", "staging", "owner/repo"],
      clone,
      bin,
      { REAL_GIT: realGit },
      "Checks: passed; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("https://example.test/pr/7");
  });

  it("marks a failed child and its spec blocked, comments, and removes scope activation", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "blocked.log");
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.BLOCKED_LOG, args.join(" ") + "\\n");
if (args[0] === "issue" && args[1] === "view") console.log("shipyard");
`,
    );
    const result = run(
      "bash",
      [script("block-scope.sh"), "2", "3", "owner/repo", "2,3,4"],
      dir,
      bin,
      { BLOCKED_LOG: log },
      "Cherry-pick of #3 conflicted and could not be resolved",
    );
    expect(result.status, result.stderr).toBe(0);
    const commands = await readFile(log, "utf8");
    expect(commands).toContain("label create shipyard:blocked");
    expect(commands).toContain("issue comment 3 --repo owner/repo --body");
    expect(commands).toContain("issue comment 2 --repo owner/repo --body");
    expect(commands).toContain(
      "Cherry-pick of #3 conflicted and could not be resolved",
    );
    for (const id of [2, 3, 4])
      expect(commands).toContain(
        `issue edit ${id} --repo owner/repo --remove-label shipyard`,
      );
    expect(commands).toContain(
      "issue edit 3 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(commands).toContain(
      "issue edit 2 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(commands).not.toContain("issue close");

    await writeFile(log, "");
    const standalone = run(
      "bash",
      [script("block-scope.sh"), "1", "1", "owner/repo", "1"],
      dir,
      bin,
      { BLOCKED_LOG: log },
      "Tests failed",
    );
    expect(standalone.status, standalone.stderr).toBe(0);
    const standaloneCommands = await readFile(log, "utf8");
    expect(standaloneCommands.match(/issue comment 1 /g)).toHaveLength(1);
    expect(standaloneCommands).toContain("Tests failed");
  });
});
