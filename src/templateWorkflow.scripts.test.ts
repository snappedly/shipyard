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
  const initialized = spawnSync("git", ["init", "-q", "-b", "main"], {
    cwd: dir,
  });
  expect(initialized.status).toBe(0);
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
  it("requires activation and the sole ready triage state before implementation", async () => {
    const { dir, bin } = await fixture();
    await executable(
      join(bin, "gh"),
      `const labels = process.env.ISSUE_LABELS.split(",");
if (process.argv.includes("--json")) console.log(JSON.stringify({state:process.env.ISSUE_STATE || "OPEN",labels:labels.map((name) => ({name}))}));
else process.exit(2);`,
    );
    const verify = (labels: string, state = "OPEN") =>
      run("bash", [script("verify-triage.sh"), "42", "owner/repo"], dir, bin, {
        ISSUE_LABELS: labels,
        ISSUE_STATE: state,
      });
    expect(verify("shipyard,ready-for-agent").status).toBe(0);
    for (const labels of [
      "shipyard",
      "ready-for-agent",
      "shipyard,needs-info",
      "shipyard,ready-for-agent,needs-triage",
      "shipyard,ready-for-agent,ready-for-human",
      "shipyard,ready-for-agent,wontfix",
    ]) {
      const result = verify(labels);
      expect(result.status, labels).not.toBe(0);
      expect(result.stderr).toContain("cannot be implemented");
    }
    expect(verify("shipyard,ready-for-agent", "CLOSED").status).not.toBe(0);
  });

  it("resolves activated parent and child into one dependency ordered spec scope", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "gh.log");
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2); const path = args[1] || "";
const statusState = process.env.STATUS_STATE ? JSON.parse(fs.readFileSync(process.env.STATUS_STATE, "utf8")) : null;
const updateStatus = (target) => {
  if (!statusState) return;
  const added = args.indexOf("--add-label");
  const removed = args.indexOf("--remove-label");
  if (added >= 0 && !statusState[target].includes(args[added + 1])) statusState[target].push(args[added + 1]);
  if (removed >= 0) statusState[target] = statusState[target].filter((label) => label !== args[removed + 1]);
  fs.writeFileSync(process.env.STATUS_STATE, JSON.stringify(statusState));
};
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
  const ids = process.env.STATUS_STATE ? [2,3] : process.env.COMPLETED_STANDALONE ? [1] : process.env.PR_ONLY ? [4] : process.env.RETRY_CHILD ? [3] : process.env.PARTIAL_PR ? [2,3] : process.env.NO_LABELLED || process.env.BLOCKED_ROOT ? [2] : process.env.LATER_BATCH ? [4] : process.env.ACTIVATION === "parent" ? [2] : process.env.ACTIVATION === "siblings" ? [3,4] : process.env.UNLABELLED_SIBLING ? [1,2,3,6] : [1,2,3,4,6];
  console.log(JSON.stringify(pool.filter((item) => ids.includes(item.number)).map((item) => ({
    ...item,
    labels: item.number === 1 && process.env.COMPLETED_STANDALONE
      ? [{name:"shipyard"},{name:"shipyard:complete"}]
      : item.number === 2 && statusState
        ? [{name:"shipyard"}, ...statusState.root.map((name) => ({name}))]
      : item.number === 2 && process.env.BLOCKED_ROOT
        ? [{name:"shipyard"},{name:"shipyard:blocked"}]
        : [{name:"shipyard"}]
  }))));
}
else if (args[0] === "issue" && args[1] === "list" && args.includes("all")) console.log(JSON.stringify([
  {number:3,title:"Child",body:"**Work item type:** executable\\n\\n## Parent\\n#2",state:process.env.CLOSED_CHILD ? "CLOSED" : "OPEN",labels:process.env.NO_LABELLED ? [] : process.env.PARTIAL_PR ? [{name:"shipyard"},{name:"shipyard:complete"},{name:"shipyard:blocked"}] : process.env.LATER_BATCH || process.env.PR_ONLY ? [{name:"shipyard:complete"}] : [{name:"shipyard"}]},
  {number:4,title:"Sibling",body:"**Work item type:** executable",state:"OPEN",labels:statusState ? [{name:"shipyard:complete"}] : process.env.RETRY_CHILD ? [{name:"shipyard:blocked"}] : process.env.NO_LABELLED || process.env.UNLABELLED_SIBLING || process.env.PARTIAL_PR ? [] : [{name:"shipyard"}]}
]));
else if (args[0] === "issue" && args[1] === "view") console.log(JSON.stringify({number:2,title:"Spec",body:"**Work item type:** planning spec",state:"OPEN",labels:statusState ? statusState.root.map((name) => ({name})) : process.env.RETRY_CHILD ? [{name:"shipyard:blocked"}] : []}));
else if (args[0] === "api" && path.endsWith("/parent")) {
  if (!process.env.TEXT_ONLY && (path.includes("/3/") || (path.includes("/4/") && !process.env.PR_ONLY))) console.log(JSON.stringify({number:2}));
  else { console.error("gh: Not Found (HTTP 404)"); process.exit(1); }
}
else if (args[0] === "api" && path.includes("/sub_issues?")) console.log(JSON.stringify(process.env.TEXT_ONLY ? [] : path.includes("/2/") ? [
  {number:3,title:"Child",body:"**Work item type:** executable\\n\\n## Parent\\n#2",state:process.env.CLOSED_CHILD ? "CLOSED" : "OPEN",labels:process.env.NO_LABELLED ? [] : process.env.PARTIAL_PR ? [{name:"shipyard"},{name:"shipyard:complete"},{name:"shipyard:blocked"}] : process.env.LATER_BATCH || process.env.PR_ONLY ? [{name:"shipyard:complete"}] : [{name:"shipyard"}]},
  {number:4,title:"Sibling",body:"**Work item type:** executable",state:"OPEN",labels:statusState ? [{name:"shipyard:complete"}] : process.env.RETRY_CHILD ? [{name:"shipyard:blocked"}] : process.env.NO_LABELLED || process.env.UNLABELLED_SIBLING || process.env.PARTIAL_PR ? [] : [{name:"shipyard"}]}
] .filter((item) => !process.env.PR_ONLY || item.number !== 4) : []));
else if (args[0] === "api" && path.includes("/dependencies/blocked_by?")) console.log(JSON.stringify(path.includes("/4/") ? [{number:3,title:"Child",state:"OPEN"}] : []));
else if (args[0] === "pr" && args[1] === "list") console.log(statusState ? JSON.stringify([{number:9,headRefName:"shipyard/spec-2",isDraft:false,labels:statusState.pr.map((name) => ({name})),body:"Source issues: #2 #3 #4\\nImplemented tickets: #3 #4\\n<!-- shipyard:verified-handoff -->"}]) : process.env.PR_ONLY ? JSON.stringify([{number:9,headRefName:"shipyard/spec-2",isDraft:false,labels:[],body:"Source issues: #2 #4\\nImplemented tickets: #3\\n<!-- shipyard:verified-handoff -->"}]) : args.includes("shipyard/issue-6") || ((process.env.READY_SPEC || process.env.PARTIAL_PR || process.env.LATER_BATCH) && args.includes("shipyard/spec-2")) ? JSON.stringify([{number:9,isDraft:false,labels:process.env.BLOCKED_PR ? [{name:"shipyard:blocked"}] : [],body:process.env.UNVERIFIED_PR ? "Incomplete manual PR" : args.includes("shipyard/spec-2") ? "Source issues: #2 #3" + (process.env.STALE_PR_SCOPE ? "" : " #4") + (process.env.PARTIAL_PR || process.env.LATER_BATCH ? "\\nImplemented tickets: #3" : "") + "\\n<!-- shipyard:verified-handoff -->" : "Source issues: #6\\n<!-- shipyard:verified-handoff -->"}]) : "[]");
else if (args[0] === "pr" && args[1] === "view") console.log(JSON.stringify({labels:statusState ? statusState.pr.map((name) => ({name})) : []}));
else if (args[0] === "pr" && args[1] === "edit") { updateStatus("pr"); }
else if (args[0] === "label") {}
else if (args[0] === "issue" && args[1] === "edit") { if (process.env.FAIL_COSMETIC && args[2] === "2" && args.includes("shipyard:outstanding-tasks")) process.exit(1); if (args[2] === "2") updateStatus("root"); }
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
          completedTicketIds: [],
          outstandingTicketIds: [],
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
    const completedStandalone = run(
      "node",
      [script("select-issues.mjs")],
      dir,
      bin,
      {
        GH_LOG: log,
        COMPLETED_STANDALONE: "1",
      },
    );
    expect(completedStandalone.status, completedStandalone.stderr).toBe(0);
    expect(JSON.parse(completedStandalone.stdout)).toEqual([]);
    const partial = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      UNLABELLED_SIBLING: "1",
    });
    expect(partial.status, partial.stderr).toBe(0);
    const partialSpec = JSON.parse(partial.stdout).find(
      (scope: { id: string }) => scope.id === "2",
    );
    expect(
      partialSpec.tickets.map((ticket: { id: string }) => ticket.id),
    ).toEqual(["3"]);
    expect(partialSpec.outstandingTicketIds).toEqual(["4"]);
    const noneSelected = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      NO_LABELLED: "1",
    });
    expect(noneSelected.status, noneSelected.stderr).toBe(0);
    expect(JSON.parse(noneSelected.stdout)).toEqual([]);
    expect(await readFile(log, "utf8")).toContain(
      "issue edit 2 --repo owner/repo --add-label shipyard:outstanding-tasks",
    );
    const beforeCosmeticRetry = (await readFile(log, "utf8")).length;
    const cosmeticRetry = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      NO_LABELLED: "1",
      FAIL_COSMETIC: "1",
    });
    expect(cosmeticRetry.status, cosmeticRetry.stderr).toBe(0);
    expect(
      (await readFile(log, "utf8")).slice(beforeCosmeticRetry),
    ).not.toContain("issue edit 2 --repo owner/repo --remove-label shipyard\n");
    const blockedRoot = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      BLOCKED_ROOT: "1",
    });
    expect(blockedRoot.status, blockedRoot.stderr).toBe(0);
    expect(
      JSON.parse(blockedRoot.stdout).map((scope: { id: string }) => scope.id),
    ).toEqual(["2"]);
    const retry = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      RETRY_CHILD: "1",
    });
    expect(retry.status, retry.stderr).toBe(0);
    expect(
      JSON.parse(retry.stdout)[0].tickets.map(
        (ticket: { id: string }) => ticket.id,
      ),
    ).toEqual(["3"]);
    expect(JSON.parse(retry.stdout)[0].outstandingTicketIds).toEqual(["4"]);
    const prOnly = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      PR_ONLY: "1",
    });
    expect(prOnly.status, prOnly.stderr).toBe(0);
    expect(JSON.parse(prOnly.stdout)[0].id).toBe("2");
    expect(
      JSON.parse(prOnly.stdout)[0].tickets.map(
        (ticket: { id: string }) => ticket.id,
      ),
    ).toEqual(["4"]);
    const cosmeticFailure = run(
      "node",
      [script("select-issues.mjs")],
      dir,
      bin,
      {
        GH_LOG: log,
        FAIL_COSMETIC: "1",
      },
    );
    expect(cosmeticFailure.status, cosmeticFailure.stderr).toBe(0);
    expect(
      JSON.parse(cosmeticFailure.stdout).some(
        (scope: { id: string }) => scope.id === "2",
      ),
    ).toBe(true);
    const statusPath = join(dir, "status.json");
    await writeFile(
      statusPath,
      JSON.stringify({ root: ["shipyard:blocked"], pr: ["shipyard:blocked"] }),
    );
    const reconciledStatus = run(
      "node",
      [script("select-issues.mjs")],
      dir,
      bin,
      {
        GH_LOG: log,
        STATUS_STATE: statusPath,
      },
    );
    expect(reconciledStatus.status, reconciledStatus.stderr).toBe(0);
    expect(JSON.parse(await readFile(statusPath, "utf8"))).toEqual({
      root: ["shipyard:complete"],
      pr: ["shipyard:complete"],
    });
    const partialReady = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      PARTIAL_PR: "1",
    });
    expect(partialReady.status, partialReady.stderr).toBe(0);
    expect(JSON.parse(partialReady.stdout)).toEqual([]);
    expect(await readFile(log, "utf8")).toContain(
      "issue edit 3 --repo owner/repo --remove-label shipyard",
    );
    expect(await readFile(log, "utf8")).toContain(
      "issue edit 3 --repo owner/repo --remove-label shipyard:blocked",
    );
    const beforeBlocked = (await readFile(log, "utf8")).length;
    const blockedReady = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      PARTIAL_PR: "1",
      BLOCKED_PR: "1",
    });
    expect(blockedReady.status, blockedReady.stderr).toBe(0);
    expect(JSON.parse(blockedReady.stdout)).toEqual([]);
    expect((await readFile(log, "utf8")).slice(beforeBlocked)).toContain(
      "--add-label shipyard:outstanding-tasks",
    );
    const laterBatch = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      LATER_BATCH: "1",
    });
    expect(laterBatch.status, laterBatch.stderr).toBe(0);
    const laterScope = JSON.parse(laterBatch.stdout)[0];
    expect(
      laterScope.tickets.map((ticket: { id: string }) => ticket.id),
    ).toEqual(["4"]);
    expect(laterScope.completedTicketIds).toEqual(["3"]);
    expect(laterScope.outstandingTicketIds).toEqual([]);
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
    const closedAfterHandoff = run(
      "node",
      [script("select-issues.mjs")],
      dir,
      bin,
      {
        GH_LOG: log,
        ACTIVATION: "siblings",
        READY_SPEC: "1",
        CLOSED_CHILD: "1",
      },
    );
    expect(closedAfterHandoff.status, closedAfterHandoff.stderr).toBe(0);
    expect(JSON.parse(closedAfterHandoff.stdout)).toEqual([]);
    const changedScope = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      ACTIVATION: "siblings",
      READY_SPEC: "1",
      STALE_PR_SCOPE: "1",
    });
    expect(changedScope.status, changedScope.stderr).toBe(0);
    expect(JSON.parse(changedScope.stdout)[0].tickets).toHaveLength(2);
    expect(await readFile(log, "utf8")).toContain(
      "pr edit 9 --repo owner/repo --add-label shipyard:outstanding-tasks",
    );
    for (const template of [
      "simple-loop",
      "sequential-reviewer",
      "parallel-planner",
      "parallel-planner-with-review",
    ]) {
      const unlabeledReady = run(
        "node",
        [join(templateDir, "templates", template, "select-issues.mjs")],
        dir,
        bin,
        {
          GH_LOG: log,
          ACTIVATION: "siblings",
          READY_SPEC: "1",
          UNLABELED_PR: "1",
        },
      );
      expect(unlabeledReady.status, unlabeledReady.stderr).toBe(0);
      expect(JSON.parse(unlabeledReady.stdout)).toEqual([]);
    }
    const unverified = run("node", [script("select-issues.mjs")], dir, bin, {
      GH_LOG: log,
      ACTIVATION: "siblings",
      READY_SPEC: "1",
      UNLABELED_PR: "1",
      UNVERIFIED_PR: "1",
    });
    expect(unverified.status, unverified.stderr).toBe(0);
    expect(JSON.parse(unverified.stdout)).toHaveLength(1);
    const reconciled = await readFile(log, "utf8");
    for (const id of [2, 3, 4])
      expect(reconciled).toContain(
        `issue edit ${id} --repo owner/repo --add-label shipyard:complete`,
      );
    expect(reconciled).not.toContain("--add-label ready-for-human");
    for (const id of [3, 4])
      expect(reconciled).toContain(
        `issue edit ${id} --repo owner/repo --remove-label shipyard`,
      );
  }, 45_000);

  it("rejects conflicting native and body parent links", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "validation.log");
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.VALIDATION_LOG, args.join(" ") + "\\n");
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "list") console.log(JSON.stringify([{number:3,title:"Child",body:"## Parent\\n#9"}]));
else if (args[0] === "issue" && args[1] === "view") console.log("shipyard");
else if (args[0] === "issue" || args[0] === "label") {}
else if (args[0] === "api" && args[1].endsWith("/parent")) {
  if (process.env.FAIL_PARENT_READ) process.exit(1);
  console.log(JSON.stringify({number:2}));
}
else if (args[0] === "pr" && args[1] === "list") console.log(args.includes("--jq") ? "" : "[]");
else process.exit(2);
`,
    );
    const result = run("node", [script("select-issues.mjs")], dir, bin, {
      VALIDATION_LOG: log,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    const calls = await readFile(log, "utf8");
    expect(calls).toContain(
      "issue edit 3 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(calls).toContain("Conflicting parent links for #3");
    expect(calls).toContain(
      "issue edit 3 --repo owner/repo --remove-label shipyard",
    );

    await writeFile(log, "");
    const unknown = run("node", [script("select-issues.mjs")], dir, bin, {
      VALIDATION_LOG: log,
      FAIL_PARENT_READ: "1",
    });
    expect(unknown.status).not.toBe(0);
    expect(await readFile(log, "utf8")).not.toContain(
      "--add-label shipyard:blocked",
    );
  });

  it("rejects incomplete or non-executable spec relationships", async () => {
    const { dir, bin } = await fixture();
    const log = join(dir, "validation.log");
    await executable(
      join(bin, "gh"),
      `
const fs = require("node:fs");
const args = process.argv.slice(2); const path = args[1] || "";
fs.appendFileSync(process.env.VALIDATION_LOG, args.join(" ") + "\\n");
if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "issue" && args[1] === "list" && args.includes("open")) console.log(JSON.stringify([{number:2,title:"Spec",body:"**Work item type:** planning spec"}]));
else if (args[0] === "issue" && args[1] === "list" && args.includes("all")) console.log("[]");
else if (args[0] === "issue" && args[1] === "view") console.log("shipyard");
else if (args[0] === "pr" && args[1] === "list") console.log(args.includes("--jq") ? "" : "[]");
else if (args[0] === "issue" || args[0] === "label" || args[0] === "pr") {}
else if (args[0] === "api" && path.endsWith("/parent")) { console.error("Not Found (HTTP 404)"); process.exit(1); }
else if (args[0] === "api" && path.includes("/sub_issues?")) console.log(JSON.stringify(process.env.CASE === "missing" ? [] : [{number:3,title:"Planning child",body:"**Work item type:** planning spec",state:"open",labels:[{name:"shipyard"}]}]));
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
        VALIDATION_LOG: log,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([]);
      const calls = await readFile(log, "utf8");
      expect(calls).toContain(message);
      expect(calls).toContain(
        `issue edit ${scenario === "missing" ? 2 : 3} --repo owner/repo --add-label shipyard:blocked`,
      );
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
for (const name of ["triage","implement","implement-spec","code-cleanup","code-review","tdd"]) {
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

  it("publishes one ready PR, marks scoped issues complete, and removes activation", async () => {
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
else if (args[0] === "issue" && args[1] === "view") console.log(args.includes("labels") ? process.env.BLOCKED_OUTSTANDING && args[2] === "4" ? "shipyard:blocked" : "shipyard" : "Fix bug");
else if (args[0] === "pr" && args[1] === "list") console.log(state.number || "");
else if (args[0] === "pr" && args[1] === "create") { state.number = 7; fs.writeFileSync(process.env.PR_STATE, JSON.stringify(state)); fs.appendFileSync(process.env.HANDOFF_LOG, "BODY " + fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8") + "\\n"); }
else if (args[0] === "pr" && args[1] === "ready") { state.readyAttempted = true; if (!process.env.FAIL_PR_READY) state.isDraft = false; if (process.env.CLOSE_PR_AFTER_READY) state.status = "CLOSED"; fs.writeFileSync(process.env.PR_STATE, JSON.stringify(state)); if (process.env.FAIL_PR_READY || process.env.FAIL_PR_READY_AFTER_UPDATE) process.exit(1); }
else if (args[0] === "pr" && args[1] === "view") { if (process.env.FAIL_PR_STATUS && state.readyAttempted && args.includes("isDraft")) process.exit(1); console.log(args.includes("labels") ? process.env.FAIL_STALE_CLEANUP ? "shipyard:outstanding-tasks" : "" : args.includes("isDraft") ? String(state.isDraft) : args.includes("state") ? state.status || "OPEN" : "https://example.test/pr/7"); }
else if (args[0] === "pr" && args[1] === "edit") { if (args.includes("--body-file")) fs.appendFileSync(process.env.HANDOFF_LOG, "BODY " + fs.readFileSync(args[args.indexOf("--body-file") + 1], "utf8") + "\\n"); if (process.env.FAIL_STALE_CLEANUP && args.includes("--remove-label") && args.includes("shipyard:outstanding-tasks")) process.exit(1); }
else if (args[0] === "label") {}
else if (args[0] === "issue" && args[1] === "edit") { if (process.env.FAIL_ACTIVATION && args.includes("--remove-label")) process.exit(1); if (process.env.FAIL_COMPLETE_TICKET && args[2] === process.env.FAIL_COMPLETE_TICKET && args.includes("--add-label")) process.exit(1); }
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
    expect(commands).toContain(
      "gh pr edit 7 --repo owner/repo --add-label shipyard:complete",
    );
    expect(commands).toContain(
      "gh issue edit 1 --repo owner/repo --remove-label shipyard",
    );
    expect(commands).toContain(
      "gh issue edit 1 --repo owner/repo --add-label shipyard:complete",
    );
    expect(commands).toContain(
      "gh issue edit 1 --repo owner/repo --remove-label shipyard:pending",
    );
    expect(commands.indexOf("gh pr ready 7 --repo owner/repo")).toBeLessThan(
      commands.indexOf(
        "gh issue edit 1 --repo owner/repo --add-label shipyard:complete",
      ),
    );
    expect(commands).not.toContain("gh issue close");
    expect(commands).not.toContain("gh pr merge");
    expect(commands).toContain("<!-- shipyard:verified-handoff -->");

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
    const beforeUnready = (await readFile(log, "utf8")).length;
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
    expect((await readFile(log, "utf8")).slice(beforeUnready)).not.toContain(
      "--add-label shipyard:complete",
    );
    expect(await readFile(log, "utf8")).not.toContain("ready-for-human");

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
    const beforeFailedTicket = (await readFile(log, "utf8")).length;
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
      { ...env, FAIL_COMPLETE_TICKET: "3" },
      "Checks: pass; Review: approved",
    );
    expect(result.status).toBe(75);
    const failedTicketCommands = (await readFile(log, "utf8")).slice(
      beforeFailedTicket,
    );
    expect(failedTicketCommands).not.toContain(
      "gh issue edit 2 --repo owner/repo --add-label shipyard:complete",
    );
    expect(failedTicketCommands).not.toContain("--remove-label shipyard");

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
    for (const id of [2, 3, 4])
      expect(specCommands).toContain(
        `gh issue edit ${id} --repo owner/repo --add-label shipyard:complete`,
      );
    expect(
      specCommands.lastIndexOf(
        "gh issue edit 2 --repo owner/repo --add-label shipyard:complete",
      ),
    ).toBeGreaterThan(
      specCommands.lastIndexOf(
        "gh issue edit 4 --repo owner/repo --add-label shipyard:complete",
      ),
    );
    expect(specCommands).not.toContain("gh issue close");
    expect(specCommands).not.toContain("gh pr merge");

    await writeFile(state, JSON.stringify({ number: 0, isDraft: true }));
    const beforePartial = (await readFile(log, "utf8")).length;
    result = run(
      "bash",
      [
        script("handoff.sh"),
        "2",
        "shipyard/spec-2",
        "staging",
        "owner/repo",
        "2,3",
        "4",
      ],
      dir,
      bin,
      env,
      "Checks: pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    const partialCommands = (await readFile(log, "utf8")).slice(beforePartial);
    expect(partialCommands).toContain("BODY Source issues: #2 #3 #4");
    expect(partialCommands).toContain("Implemented tickets: #3");
    expect(partialCommands).toContain(
      "gh pr edit 7 --repo owner/repo --add-label shipyard:outstanding-tasks",
    );
    expect(partialCommands).toContain(
      "gh issue edit 2 --repo owner/repo --add-label shipyard:outstanding-tasks",
    );
    expect(partialCommands).not.toContain(
      "gh issue edit 4 --repo owner/repo --add-label shipyard:complete",
    );
    const beforeBlockedOutstanding = (await readFile(log, "utf8")).length;
    result = run(
      "bash",
      [
        script("handoff.sh"),
        "2",
        "shipyard/spec-2",
        "staging",
        "owner/repo",
        "2,3",
        "4",
      ],
      dir,
      bin,
      { ...env, BLOCKED_OUTSTANDING: "1" },
      "Checks: pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(
      (await readFile(log, "utf8")).slice(beforeBlockedOutstanding),
    ).toContain("gh pr edit 7 --repo owner/repo --add-label shipyard:blocked");

    const beforeLater = (await readFile(log, "utf8")).length;
    result = run(
      "bash",
      [
        script("handoff.sh"),
        "2",
        "shipyard/spec-2",
        "staging",
        "owner/repo",
        "2,4",
        "-",
        "3",
      ],
      dir,
      bin,
      env,
      "Checks: pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    const laterCommands = (await readFile(log, "utf8")).slice(beforeLater);
    expect(laterCommands).not.toContain("gh pr create");
    expect(laterCommands).toContain("Implemented tickets: #4 #3");
    expect(laterCommands).toContain(
      "gh pr edit 7 --repo owner/repo --add-label shipyard:complete",
    );
    expect(laterCommands).toContain(
      "gh issue edit 2 --repo owner/repo --remove-label shipyard:outstanding-tasks",
    );

    const beforeStaleFailure = (await readFile(log, "utf8")).length;
    result = run(
      "bash",
      [
        script("handoff.sh"),
        "2",
        "shipyard/spec-2",
        "staging",
        "owner/repo",
        "2,4",
        "-",
        "3",
      ],
      dir,
      bin,
      { ...env, FAIL_STALE_CLEANUP: "1" },
      "Checks: pass; Review: approved",
    );
    expect(result.status, result.stderr).toBe(0);
    const staleFailureCommands = (await readFile(log, "utf8")).slice(
      beforeStaleFailure,
    );
    expect(staleFailureCommands).not.toContain("--remove-label shipyard\n");
    expect(result.stderr).toContain("retaining ticket activation");
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
    git("-C", source, "checkout", "staging");
    await writeFile(join(source, "later.txt"), "new target commit");
    git("-C", source, "add", ".");
    git("-C", source, "commit", "-m", "advance target");
    git("-C", source, "checkout", "shipyard/issue-1");
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
if (args[0] === "issue" && args[1] === "view") console.log(process.env.REPLAY_BLOCKED ? "shipyard\\nshipyard:blocked" : "shipyard");
else if (args[0] === "issue" && args[1] === "list") console.log("[]");
else if (args[0] === "issue" && args[1] === "comment" && process.env.FAIL_COMMENT) process.exit(1);
else if (args[0] === "issue" && args[1] === "edit" && args.includes("--add-label") && args.includes("shipyard:blocked") && args[2] === process.env.FAIL_BLOCK_LABEL) process.exit(1);
else if (args[0] === "repo") console.log("owner/repo");
else if (args[0] === "pr" && args[1] === "list" && process.env.FAIL_PR_LOOKUP) process.exit(1);
else if (args[0] === "pr" && args[1] === "list" && process.env.EXISTING_PR) console.log("9");
`,
    );
    const result = run(
      "bash",
      [
        script("block-scope.sh"),
        "2",
        "3",
        "owner/repo",
        "2,3,4",
        "shipyard/spec-2",
      ],
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
    expect(commands).not.toContain("pr edit");

    const existing = run(
      "bash",
      [
        script("block-scope.sh"),
        "2",
        "3",
        "owner/repo",
        "2,3,4",
        "shipyard/spec-2",
      ],
      dir,
      bin,
      { BLOCKED_LOG: log, EXISTING_PR: "1" },
      "Tests failed",
    );
    expect(existing.status, existing.stderr).toBe(0);
    const existingCommands = await readFile(log, "utf8");
    expect(existingCommands).toContain(
      "pr edit 9 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(existingCommands).not.toContain("ready-for-human");
    expect(existingCommands).toContain(
      "issue edit 4 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(existingCommands).toContain(
      "issue edit 4 --repo owner/repo --remove-label shipyard:pending",
    );

    await writeFile(log, "");
    const lookupFailure = run(
      "bash",
      [
        script("block-scope.sh"),
        "2",
        "3",
        "owner/repo",
        "2,3,4",
        "shipyard/spec-2",
      ],
      dir,
      bin,
      { BLOCKED_LOG: log, FAIL_PR_LOOKUP: "1" },
      "PR lookup failed",
    );
    expect(lookupFailure.status, lookupFailure.stderr).toBe(0);
    const lookupCommands = await readFile(log, "utf8");
    expect(lookupCommands).toContain(
      "issue edit 3 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(lookupCommands).not.toContain(
      "issue edit 3 --repo owner/repo --remove-label shipyard\n",
    );
    const pendingPath = join(dir, ".git", "shipyard-pending", "2-3.pending");
    expect(await readFile(pendingPath, "utf8")).toContain("PR lookup failed");

    await writeFile(log, "");
    const commentFailure = run(
      "bash",
      [
        script("block-scope.sh"),
        "2",
        "3",
        "owner/repo",
        "2,3,4",
        "shipyard/spec-2",
      ],
      dir,
      bin,
      { BLOCKED_LOG: log, FAIL_COMMENT: "1" },
      "Comment was unavailable",
    );
    expect(commentFailure.status).not.toBe(0);
    const commentCommands = await readFile(log, "utf8");
    expect(commentCommands).toContain(
      "issue edit 3 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(commentCommands).not.toContain(
      "issue edit 3 --repo owner/repo --remove-label shipyard\n",
    );
    expect(await readFile(pendingPath, "utf8")).toContain(
      "Comment was unavailable",
    );

    await writeFile(log, "");
    const superseded = run("node", [script("select-issues.mjs")], dir, bin, {
      BLOCKED_LOG: log,
      EXISTING_PR: "1",
    });
    expect(superseded.status, superseded.stderr).toBe(0);
    expect(await readFile(pendingPath, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(log, "utf8")).not.toContain(
      "--add-label shipyard:blocked",
    );

    run(
      "bash",
      [
        script("block-scope.sh"),
        "2",
        "3",
        "owner/repo",
        "2,3,4",
        "shipyard/spec-2",
      ],
      dir,
      bin,
      { BLOCKED_LOG: log, FAIL_COMMENT: "1" },
      "Comment was unavailable",
    );

    await writeFile(log, "");
    const reconciled = run("node", [script("select-issues.mjs")], dir, bin, {
      BLOCKED_LOG: log,
      EXISTING_PR: "1",
      REPLAY_BLOCKED: "1",
    });
    expect(reconciled.status, reconciled.stderr).toBe(0);
    expect(JSON.parse(reconciled.stdout)).toEqual([]);
    expect(await readFile(pendingPath, "utf8").catch(() => null)).toBeNull();
    const reconcileCommands = await readFile(log, "utf8");
    expect(reconcileCommands).toContain(
      "pr edit 9 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(reconcileCommands).toContain(
      "issue edit 3 --repo owner/repo --remove-label shipyard\n",
    );

    const firstBlockFailure = run(
      "bash",
      [
        script("block-scope.sh"),
        "2",
        "3",
        "owner/repo",
        "2,3,4",
        "shipyard/spec-2",
      ],
      dir,
      bin,
      { BLOCKED_LOG: log, FAIL_BLOCK_LABEL: "3" },
      "First block write failed",
    );
    expect(firstBlockFailure.status).not.toBe(0);
    expect(await readFile(pendingPath, "utf8")).toContain(
      "shipyard/spec-2\t\nFirst block write failed",
    );
    await writeFile(log, "");
    const replayFirstBlock = run(
      "node",
      [script("select-issues.mjs")],
      dir,
      bin,
      { BLOCKED_LOG: log },
    );
    expect(replayFirstBlock.status, replayFirstBlock.stderr).toBe(0);
    expect(await readFile(log, "utf8")).toContain(
      "issue edit 3 --repo owner/repo --add-label shipyard:blocked",
    );
    expect(await readFile(pendingPath, "utf8").catch(() => null)).toBeNull();

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
  }, 15_000);
});
