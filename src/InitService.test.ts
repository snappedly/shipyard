import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  scaffold,
  getNextStepsLines,
  getAgent,
  listTemplates,
  listIssueTrackers,
  getIssueTracker,
  getSandboxProvider,
} from "./InitService.js";
import type { AgentEntry, ScaffoldOptions } from "./InitService.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import { CODEX_MODELS } from "./modelConfig.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const claudeCodeAgent = getAgent("claude-code")!;
const codexAgent = getAgent("codex")!;

const defaultOptions: ScaffoldOptions = {
  agent: claudeCodeAgent,
  model: "claude-opus-4-8",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe("InitService scaffold", () => {
  it("uses agent dockerfileTemplate for Dockerfile (with templateArgs substitution)", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".shipyard", "Dockerfile"),
      "utf-8",
    );
    // Template has {{ISSUE_TRACKER_TOOLS}} replaced — should contain GitHub CLI (default issue tracker)
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("GitHub CLI");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  // --- Dynamic .env.example generation ---

  it.each([
    {
      agent: claudeCodeAgent,
      expectedKey: "CLAUDE_CODE_OAUTH_TOKEN=",
      unexpectedKey: "OPENAI_API_KEY=",
      expectClaudeSetupTokenHint: true,
    },
    {
      agent: codexAgent,
      expectedKey: "OPENAI_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
    },
  ])(
    "generates .env.example with $agent.name env var",
    async ({
      agent,
      expectedKey,
      unexpectedKey,
      expectClaudeSetupTokenHint,
    }) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const envExample = await readFile(
        join(dir, ".shipyard", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain(expectedKey);
      expect(envExample).not.toContain(unexpectedKey);
      expect(envExample).not.toContain("issues/191");
      if (expectClaudeSetupTokenHint) {
        expect(envExample).toContain("claude setup-token");
      } else {
        expect(envExample).not.toContain("claude setup-token");
      }
    },
  );

  it("generates .env.example with GH_TOKEN when issue tracker is github-issues", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      issueTracker: getIssueTracker("github-issues"),
    });

    const envExample = await readFile(
      join(dir, ".shipyard", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("GH_TOKEN=");
    expect(envExample).toContain("GH_REPO=\n");
    expect(envExample).toContain(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(envExample).toContain("Issues");
    expect(envExample).toContain("Metadata");
    expect(envExample).toContain(
      'GH_TOKEN="$(gh auth token)" npx shipyard run',
    );
  });

  it("creates .env from the generated .env.example", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const configDir = join(dir, ".shipyard");
    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    const env = await readFile(join(configDir, ".env"), "utf-8");

    expect(env).toBe(envExample);
  });

  it("does not scaffold config.json for blank template", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const { access } = await import("node:fs/promises");
    await expect(
      access(join(dir, ".shipyard", "config.json")),
    ).rejects.toThrow();
  });

  it("errors if .shipyard/ already exists", async () => {
    const dir = await makeDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, ".shipyard"));

    await expect(runScaffold(dir)).rejects.toThrow(
      ".shipyard/ directory already exists",
    );
  });

  it("includes .env, logs/, and worktrees/ in .gitignore but not patches/", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const gitignore = await readFile(
      join(dir, ".shipyard", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
    expect(gitignore).not.toContain("patches/");
  });

  it("Dockerfile template contains worktree mount comment", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".shipyard", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_REPO_DIR);
  });

  it.each([claudeCodeAgent, codexAgent])(
    "$name Dockerfile aligns UID/GID with -o so a host GID colliding with a reserved base-image GID (e.g. macOS staff=20) doesn't fail the build",
    async (agent) => {
      const dir = await makeDir();
      await runScaffold(dir, { agent, model: agent.defaultModel });

      const dockerfile = await readFile(
        join(dir, ".shipyard", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("groupmod -o -g $AGENT_GID node");
      expect(dockerfile).toContain(
        "usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node",
      );
    },
  );

  it("claude-code Dockerfile template does not install pnpm or enable corepack", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const dockerfile = await readFile(
      join(dir, ".shipyard", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).not.toContain("pnpm");
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const prompt = await readFile(join(dir, ".shipyard", "prompt.md"), "utf-8");
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("blank template produces skeleton prompt and main.mts", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const configDir = join(dir, ".shipyard");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
  });

  it("blank template main.mts imports from @snappedly-tools/shipyard", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('"@snappedly-tools/shipyard"');
  });

  it("blank template main.mts calls run()", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain("run(");
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "blank" });

    const prompt1 = await readFile(
      join(dir1, ".shipyard", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".shipyard", "prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  // --- main file rewriting ---

  it("scaffolds main.mts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('claudeCode("claude-sonnet-4-6")');
    // Should not contain the template's original model
    expect(mainTs).not.toContain('claudeCode("claude-opus-4-8")');
  });

  it("scaffolds main.mts with default model when using agent default", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('claudeCode("claude-opus-4-8")');
  });

  // --- Template-specific tests ---

  it.each([
    { templateName: "simple-loop", promptFilename: "prompt.md" },
    {
      templateName: "sequential-reviewer",
      promptFilename: "implement-prompt.md",
    },
    { templateName: "parallel-planner", promptFilename: "implement-prompt.md" },
    {
      templateName: "parallel-planner-with-review",
      promptFilename: "implement-prompt.md",
    },
  ])(
    "$templateName scaffolds one skill-owned GitHub issue workflow",
    async ({ templateName, promptFilename }) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName });
      const configDir = join(dir, ".shipyard");
      const main = await readFile(join(configDir, "main.mts"), "utf-8");
      const prompt = await readFile(join(configDir, promptFilename), "utf-8");

      expect(main).toContain("branchStrategy");
      expect(main).toContain("WORK_ITEM_BASE64");
      expect(main).toContain("completionSignal");
      expect(main).toContain("onSandboxReady");
      expect(main).not.toContain("createSandbox");
      expect(prompt).toContain("/implement");
      expect(prompt).toContain("/implement-spec");
      expect(prompt).toContain("WORK_ITEM_BASE64");
    },
  );

  it("keeps the blank template as a user-owned low-level workflow", async () => {
    const dir = await makeDir();
    await runScaffold(dir);
    const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(main).toContain("run({");
    expect(main).not.toContain("WORK_ITEM_BASE64");
  });

  it("keeps sequential-reviewer available with its standards starter file", async () => {
    expect(
      listTemplates().some(
        (template) => template.name === "sequential-reviewer",
      ),
    ).toBe(true);
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "sequential-reviewer" });
    const standards = await readFile(
      join(dir, ".shipyard", "CODING_STANDARDS.md"),
      "utf-8",
    );
    expect(standards).toContain("# Coding Standards");
    expect(standards).toContain("Customize");
  });

  it("simple-loop template does not scaffold compiled .js or .d.ts files", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const { readdir } = await import("node:fs/promises");
    const files = await readdir(join(dir, ".shipyard"));
    const compiledFiles = files.filter(
      (f) =>
        f.endsWith(".js") ||
        f.endsWith(".d.ts") ||
        f.endsWith(".js.map") ||
        f.endsWith(".d.ts.map"),
    );
    expect(compiledFiles).toEqual([]);
  });

  describe("getNextStepsLines", () => {
    it("shows environment setup, subscription login, and both start commands", () => {
      expect(getNextStepsLines()).toEqual([
        "Next steps:",
        "1. Fill in the values you need in `.shipyard/.env`.",
        "2. If using a model subscription, sign in. For Codex:",
        `   codex --config 'cli_auth_credentials_store="file"' login`,
        "   test -f ~/.codex/auth.json",
        "3. Start with `npx shipyard runner start` (if installed) or `npx shipyard run`",
      ]);
    });

    it("does not include internal template implementation details", () => {
      const joined = getNextStepsLines().join("\n");
      expect(joined).not.toContain("copyToWorktree");
      expect(joined).not.toContain("onSandboxReady");
      expect(joined).not.toContain("CODING_STANDARDS.md");
      expect(joined).not.toContain("codex login");
    });
  });

  it("scaffolds codex agent with codex Dockerfile", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: CODEX_MODELS.routine.model,
    });

    const dockerfile = await readFile(
      join(dir, ".shipyard", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain("FROM node:22-bookworm");
    expect(dockerfile).toContain("@openai/codex");
    expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
  });

  it("scaffolds main.mts with codex factory import when codex agent selected", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: CODEX_MODELS.routine.model,
    });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain("codex(CODEX_MODELS.routine)");
    expect(mainTs).not.toContain("claudeCode");
  });

  it("scaffolds Codex ChatGPT auth with a read-only auth cache mount", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: CODEX_MODELS.routine.model,
      codexAuth: "chatgpt",
    });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('hostPath: "~/.codex/auth.json"');
    expect(mainTs).toContain('sandboxPath: "~/.codex/auth.json"');
    expect(mainTs).toContain("readonly: true");

    const envExample = await readFile(
      join(dir, ".shipyard", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("codex login");
    expect(envExample).not.toContain("OPENAI_API_KEY=");
  });

  it("uses the selected Codex model in the skill-owned workflow", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: CODEX_MODELS.routine.model,
      templateName: "parallel-planner",
    });

    const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(main).toContain("shipyard.CODEX_MODELS.routine");
    expect(main).not.toContain("shipyard.CODEX_MODELS.strong");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  // --- Issue tracker ---

  describe("Issue tracker registry", () => {
    it("only exposes GitHub Issues", () => {
      expect(listIssueTrackers().map((tracker) => tracker.name)).toEqual([
        "github-issues",
      ]);
      expect(getIssueTracker("beads")).toBeUndefined();
      expect(getIssueTracker("custom")).toBeUndefined();
    });

    it("getIssueTracker returns github-issues entry with expected templateArgs", () => {
      const manager = getIssueTracker("github-issues");
      expect(manager).toBeDefined();
      expect(manager!.label).toBe("GitHub Issues");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "gh issue list",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain(
        "--state open --label shipyard",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).not.toContain(
        "--label Shipyard",
      );
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("labels");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("comments");
      expect(manager!.templateArgs.LIST_TASKS_COMMAND).toContain("--limit 100");
      expect(manager!.templateArgs.VIEW_TASK_COMMAND).toContain(
        "gh issue view",
      );
      expect(manager!.templateArgs.CLOSE_TASK_COMMAND).toContain(
        "gh issue close",
      );
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("GitHub CLI");
      expect(manager!.templateArgs.ISSUE_TRACKER_TOOLS).toContain("gh");
    });

    it("getIssueTracker returns undefined for unknown manager", () => {
      expect(getIssueTracker("nonexistent")).toBeUndefined();
    });
  });

  describe("Issue workflow template scaffold", () => {
    it.each([
      { templateName: "simple-loop", promptFilename: "prompt.md" },
      {
        templateName: "sequential-reviewer",
        promptFilename: "implement-prompt.md",
      },
      {
        templateName: "parallel-planner",
        promptFilename: "implement-prompt.md",
      },
      {
        templateName: "parallel-planner-with-review",
        promptFilename: "implement-prompt.md",
      },
    ])(
      "$templateName scaffolds skill-owned issue delivery",
      async ({ templateName, promptFilename }) => {
        const dir = await makeDir();
        await runScaffold(dir, { templateName });
        const configDir = join(dir, ".shipyard");
        const prompt = await readFile(join(configDir, promptFilename), "utf-8");
        const main = await readFile(join(configDir, "main.mts"), "utf-8");

        expect(prompt).toContain("/implement");
        expect(prompt).toContain("/implement-spec");
        expect(prompt).toContain("WORK_ITEM_BASE64");
        expect(prompt).toContain("CODING_STANDARDS.md");
        expect(prompt).toContain(
          "install dependencies from the current candidate",
        );
        expect(prompt).toContain(
          "If you change a dependency manifest or lockfile",
        );
        expect(prompt).not.toContain("gh issue close");
        expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
        expect(main).toContain("WORK_ITEM_BASE64");
        expect(main).toContain("completionSignal");
        expect(main).toContain("onSandboxReady");
        expect(main).not.toContain("createSandbox");
      },
    );

    it("keeps blank as a user-owned low-level workflow", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "blank" });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(prompt).toContain("<promise>COMPLETE</promise>");
      expect(main).toContain("run({");
      expect(main).not.toContain("WORK_ITEM_BASE64");
    });

    it("does not scaffold obsolete planner or reviewer prompts", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const { readdir } = await import("node:fs/promises");
      const files = await readdir(join(dir, ".shipyard"));
      expect(files).not.toContain("plan-prompt.md");
      expect(files).not.toContain("merge-prompt.md");
      expect(files).not.toContain("review-prompt.md");
    });

    it("keeps the coding-standards starter available for the reviewer templates", async () => {
      expect(
        listTemplates().some(
          (template) => template.name === "sequential-reviewer",
        ),
      ).toBe(true);
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });
      const standards = await readFile(
        join(dir, ".shipyard", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      expect(standards).toContain("Customize");
    });

    it("installs GitHub CLI into the generated issue-workflow image", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
      });

      const dockerfile = await readFile(
        join(dir, ".shipyard", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("GitHub CLI");
      expect(dockerfile).toContain("apt-get install -y gh");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });
  });

  // --- ESM extension detection ---

  describe("main file extension detection", () => {
    it("scaffolds main.mts when no package.json exists", async () => {
      const dir = await makeDir();
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".shipyard", "main.mts")),
      ).resolves.toBeUndefined();
    });

    it("scaffolds main.mts when package.json has no type field", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
      const mainContent = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainContent).toContain("@snappedly-tools/shipyard");
    });

    it("scaffolds main.mts when package.json has type: commonjs", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "commonjs" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });

    it("scaffolds main.ts when package.json has type: module", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.ts");
      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".shipyard", "main.ts")),
      ).resolves.toBeUndefined();
      // main.mts should NOT exist
      await expect(
        access(join(dir, ".shipyard", "main.mts")),
      ).rejects.toThrow();
    });

    it("main.ts scaffolded with type: module has correct imports and factory calls", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".shipyard", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain("@snappedly-tools/shipyard");
      expect(mainContent).toContain('claudeCode("claude-opus-4-8")');
    });

    it("main.ts scaffolded with type: module rewrites the Codex factory correctly", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir, {
        agent: codexAgent,
        model: CODEX_MODELS.routine.model,
      });

      const mainContent = await readFile(
        join(dir, ".shipyard", "main.ts"),
        "utf-8",
      );
      expect(mainContent).toContain("codex(CODEX_MODELS.routine)");
      expect(mainContent).not.toContain("claudeCode");
    });

    it("comments in scaffolded main.ts reference main.ts, not main.mts", async () => {
      const dir = await makeDir();
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "test", type: "module" }),
      );
      await runScaffold(dir);

      const mainContent = await readFile(
        join(dir, ".shipyard", "main.ts"),
        "utf-8",
      );
      expect(mainContent).not.toContain("main.mts");
      expect(mainContent).toContain("main.ts");
    });

    it("scaffolds main.mts when package.json is invalid JSON", async () => {
      const dir = await makeDir();
      await writeFile(join(dir, "package.json"), "not valid json{{{");
      const result = await runScaffold(dir);

      expect(result.mainFilename).toBe("main.mts");
    });
  });

  // ---------------------------------------------------------------------------
  // Sandbox provider selection
  // ---------------------------------------------------------------------------

  describe("sandbox provider", () => {
    const dockerProvider = getSandboxProvider("docker")!;

    it("selecting docker writes Dockerfile to .shipyard/", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const dockerfile = await readFile(
        join(dir, ".shipyard", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");
    });

    it("selecting docker does not write Containerfile", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".shipyard", "Containerfile")),
      ).rejects.toThrow();
    });

    it("selecting docker leaves the main file importing and calling docker", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { sandboxProvider: dockerProvider });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'import { run, claudeCode } from "@snappedly-tools/shipyard"',
      );
      expect(mainTs).toContain(
        'import { docker } from "@snappedly-tools/shipyard/sandboxes/docker"',
      );
      expect(mainTs).toContain("sandbox: docker()");
    });
  });
});
