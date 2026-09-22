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

  it("simple-loop template produces main.mts and prompt.md", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const configDir = join(dir, ".shipyard");
    const { access } = await import("node:fs/promises");

    await expect(access(join(configDir, "main.mts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.mts imports from @snappedly-tools/shipyard", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('"@snappedly-tools/shipyard"');
  });

  it("simple-loop main.mts contains shipyard.run() with expected options", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("1");
    expect(mainTs).not.toContain("merge-to-head");
    expect(mainTs).toContain("runAuthorizedImplementation");
    // When scaffolded with default model, simple-loop uses claude-opus-4-8
    // (rewritten from template's claude-sonnet-4-6)
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(join(dir, ".shipyard", "prompt.md"), "utf-8");
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  describe("sequential-reviewer template", () => {
    it("produces main.mts, implement-prompt.md, and review-prompt.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const configDir = join(dir, ".shipyard");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
    });

    it("main.mts imports from @snappedly-tools/shipyard", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@snappedly-tools/shipyard"');
    });

    it("main.mts uses createSandbox so implementer and reviewer share a sandbox", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("sandbox.run");
      expect(mainTs).toContain("sandbox.close");
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
    });

    it("main.mts does not use merge-to-head (incompatible with reviewer handoff)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("merge-to-head");
    });

    it("main.mts only reviews when implementer produces commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement.commits.length");
    });

    it("implement-prompt.md contains coordinator guardrails and no closure command", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).toContain("coordinator-owned standalone delivery");
      expect(prompt).toContain("Do not publish a branch or pull request");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
      expect(prompt).not.toContain("{{ISSUE_TITLE}}");
      expect(prompt).not.toContain("{{BRANCH}}");
    });

    it("implement-prompt.md hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(
        "already been filtered to issues ready for work",
      );
      expect(prompt).toContain("sole source of truth");
      expect(prompt).toContain("Do not run your own unfiltered query");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("sequential-reviewer appears in listTemplates()", async () => {
      const templates = listTemplates();
      expect(templates.some((t) => t.name === "sequential-reviewer")).toBe(
        true,
      );
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const standards = await readFile(
        join(dir, ".shipyard", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      // Should have guiding comment, not opinionated defaults
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.shipyard/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.shipyard/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs against {{TARGET_BRANCH}} (the fork point), not the branch itself", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      // SOURCE_BRANCH equals BRANCH at run time, so diffing against it is
      // always empty — the prompt must use TARGET_BRANCH instead.
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });

    it("main.mts runs the implementer for a single iteration (one issue per outer pass)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"'),
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 1");
      expect(implementerSection).not.toContain("maxIterations: 100");
    });

    it("main.mts stops the loop when the implementer produces no commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      const noCommitIndex = mainTs.indexOf("!implement.commits.length");
      const section = mainTs.slice(noCommitIndex, noCommitIndex + 400);
      expect(section).toContain("break");
      expect(section).not.toContain("continue");
    });
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

  it("keeps centralized Codex model references in multi-phase templates", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: CODEX_MODELS.routine.model,
      templateName: "parallel-planner",
    });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain("shipyard.CODEX_MODELS.routine");
    expect(mainTs).toContain("shipyard.CODEX_MODELS.strong");
    expect(mainTs).not.toMatch(/gpt-5\.6/);
  });

  it.each([
    { templateName: "blank", promptFilename: "prompt.md" },
    { templateName: "simple-loop", promptFilename: "prompt.md" },
    {
      templateName: "sequential-reviewer",
      promptFilename: "implement-prompt.md",
    },
    { templateName: "parallel-planner", promptFilename: "plan-prompt.md" },
    {
      templateName: "parallel-planner-with-review",
      promptFilename: "plan-prompt.md",
    },
  ])(
    "$templateName selects only open issues with the lowercase shipyard label",
    async ({ templateName, promptFilename }) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName });

      const prompt = await readFile(
        join(dir, ".shipyard", promptFilename),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list --state open --label shipyard");
      expect(prompt).not.toContain("--label Shipyard");
    },
  );

  it("scaffolded prompts that lack a runtime TASK_ID do not contain {{TASK_ID}}", async () => {
    // Regression test for #477: the {{TASK_ID}} placeholder inside
    // VIEW_TASK_COMMAND / CLOSE_TASK_COMMAND used to leak into prompts
    // whose runtime promptArgs do not include TASK_ID (simple-loop and
    // sequential-reviewer's implement),
    // causing PromptArgumentSubstitution to throw on every iteration.
    const cases: Array<{ template: string; file: string }> = [
      { template: "simple-loop", file: "prompt.md" },
      { template: "sequential-reviewer", file: "implement-prompt.md" },
    ];
    for (const { template, file } of cases) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const prompt = await readFile(join(dir, ".shipyard", file), "utf-8");
      expect(prompt, `${template}/${file}`).not.toContain("{{TASK_ID}}");
    }
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  describe("parallel-planner template", () => {
    it("produces worker and planner files without a direct merge prompt", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".shipyard");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).rejects.toThrow();
    });

    it("main.mts uses npm install hook and imports shipyard", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("npm install");
      expect(mainTs).toContain("shipyard");
    });

    it("main.mts imports from @snappedly-tools/shipyard", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@snappedly-tools/shipyard"');
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      // All factory calls should use the specified model (default: claude-opus-4-8)
      expect(mainTs).toContain("claude-opus-4-8");
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("main.mts emits delivery groups and has no merge phase", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("deliveryGroups");
      expect(mainTs).toContain("resolveDeliveryGroup");
      expect(mainTs).toContain("planSpecDelivery");
      expect(mainTs).not.toContain("merge-prompt.md");
    });

    it("main.mts does not contain a merge agent", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).not.toContain("completedBranches.length === 1");
      expect(mainTs).not.toContain('name: "merger"');
    });

    it("main.mts runs dependency-safe groups and stops on no progress", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("Promise.allSettled");
      expect(mainTs).toContain("dependsOn.every");
      expect(mainTs).toContain("No delivery group made progress");

      const noProgressIndex = mainTs.indexOf("if (completed.length === 0)");
      const noProgressSection = mainTs.slice(
        noProgressIndex,
        noProgressIndex + 350,
      );
      expect(noProgressSection).toContain("break");
      expect(noProgressSection).not.toContain("continue");
    });

    it("common files are still generated with parallel-planner template", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const configDir = join(dir, ".shipyard");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → CLAUDE_CODE_OAUTH_TOKEN, default issue tracker → GH_TOKEN
      expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
      expect(envExample).toContain("GH_TOKEN=");
    });
  });

  describe("parallel-planner-with-review template", () => {
    it("produces worker, planner, and review files without a direct merge prompt", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".shipyard");
      const { access } = await import("node:fs/promises");

      await expect(
        access(join(configDir, "main.mts")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "plan-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "implement-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "review-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "merge-prompt.md")),
      ).rejects.toThrow();
    });

    it("main.mts imports from @snappedly-tools/shipyard", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('"@snappedly-tools/shipyard"');
    });

    it("main.mts uses a separate review sandbox per candidate branch", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("createSandbox");
      expect(mainTs).toContain("reviewSandbox.run");
      expect(mainTs).toContain("reviewSandbox.close");
    });

    it("main.mts runs implementer then read-only reviewer for each child", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
      expect(mainTs).toContain("implementation.commits.length > 0");
    });

    it("main.mts captures reviewer results without merging reviewer commits", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      // Reviewer result must be captured, not discarded
      expect(mainTs).toContain("const review = await runReview");
      // Review commits are intentionally not adopted by the delivery.
      expect(mainTs).toContain("implementation.commits");
      expect(mainTs).not.toContain("review.commits");
    });

    it("main.mts resumes completed branches and stops on no progress", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("implementation.commits.length > 0 ||");
      expect(mainTs).toContain("implementation.completionSignal !== undefined");
      expect(mainTs).toContain("deliveryGroups");
      expect(mainTs).toContain("No delivery group made progress");

      const noProgressIndex = mainTs.indexOf("if (completed.length === 0)");
      const noProgressSection = mainTs.slice(
        noProgressIndex,
        noProgressIndex + 350,
      );
      expect(noProgressSection).toContain("break");
      expect(noProgressSection).not.toContain("continue");
    });

    it("main.mts uses Promise.allSettled for parallel execution", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("Promise.allSettled");
    });

    it("main.mts has correct maxIterations: planner=1, implementer=100, reviewer=1", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      // Check planner maxIterations: 1 (near "planner" name)
      const plannerSection = mainTs.slice(
        mainTs.indexOf('name: "planner"') - 200,
        mainTs.indexOf('name: "planner"') + 200,
      );
      expect(plannerSection).toContain("maxIterations: 1");

      // Check implementer maxIterations: 100
      const implementerSection = mainTs.slice(
        mainTs.indexOf('name: "implementer"') - 200,
        mainTs.indexOf('name: "implementer"') + 200,
      );
      expect(implementerSection).toContain("maxIterations: 100");

      // Check reviewer maxIterations: 1
      const reviewerSection = mainTs.slice(
        mainTs.indexOf('name: "reviewer"') - 200,
        mainTs.indexOf('name: "reviewer"') + 200,
      );
      expect(reviewerSection).toContain("maxIterations: 1");

      expect(mainTs).not.toContain('name: "merger"');
    });

    it("implement-prompt.md contains {{TASK_ID}}, {{ISSUE_TITLE}}, {{BRANCH}} prompt arguments", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("review-prompt.md contains {{BRANCH}} prompt argument", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{BRANCH}}");
    });

    it("review-prompt.md requires read-only findings and candidate identity", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("read-only findings");
      expect(prompt).toContain("{{DELIVERY_ID}}");
      expect(prompt).toContain("{{TASK_ID}}");
    });

    it("parallel-planner-with-review appears in listTemplates()", () => {
      const templates = listTemplates();
      expect(
        templates.some((t) => t.name === "parallel-planner-with-review"),
      ).toBe(true);
    });

    it("common files are still generated", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const configDir = join(dir, ".shipyard");
      const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
      expect(dockerfile).toContain("FROM node:22-bookworm");
      expect(dockerfile).not.toContain("{{ISSUE_TRACKER_TOOLS}}");

      const envExample = await readFile(
        join(configDir, ".env.example"),
        "utf-8",
      );
      // Dynamic env: claude-code agent → CLAUDE_CODE_OAUTH_TOKEN, default issue tracker → GH_TOKEN
      expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
      expect(envExample).toContain("GH_TOKEN=");
    });

    it("main.mts references the specified model for all factory calls", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("claude-opus-4-8");
    });

    it("scaffolds CODING_STANDARDS.md with minimal starter content", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const standards = await readFile(
        join(dir, ".shipyard", "CODING_STANDARDS.md"),
        "utf-8",
      );
      expect(standards).toContain("# Coding Standards");
      expect(standards).toContain("Customize");
    });

    it("review-prompt.md references @.shipyard/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("@.shipyard/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs against {{TARGET_BRANCH}} (the fork point), not the branch itself", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{TARGET_BRANCH}}...{{BRANCH}}");
      expect(prompt).toContain("git log {{TARGET_BRANCH}}..{{BRANCH}}");
      // SOURCE_BRANCH equals BRANCH at run time, so diffing against it is
      // always empty — the prompt must use TARGET_BRANCH instead.
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
    });
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

  describe("Issue tracker scaffold", () => {
    it("simple-loop with github-issues produces prompt with gh issue commands (richer version)", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("scaffold without issueTracker defaults to github-issues", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      // Should default to github-issues and replace placeholders
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("simple-loop prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    it("simple-loop prompt hints the issue list is pre-filtered and discourages unfiltered re-query", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "simple-loop" });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(
        "already been filtered to issues ready for work",
      );
      expect(prompt).toContain("sole source of truth");
      expect(prompt).toContain("Do not run your own unfiltered query");
    });

    // --- sequential-reviewer ---

    it("sequential-reviewer with github-issues produces implement-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).toContain("labels");
      expect(prompt).toContain("comments");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("sequential-reviewer implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- blank ---

    it("blank with github-issues produces prompt with gh issue list example", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "blank",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue list");
      expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    // --- parallel-planner ---

    it("parallel-planner with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".shipyard", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner main.mts uses delivery groups and child IDs", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toContain("deliveryGroups");
      expect(main).toContain("TASK_ID: child.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner main.mts uses Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).toContain("plan.output.deliveryGroups");
      expect(main).toContain('from "zod"');
      expect(main).toContain("z.object");
      expect(main).not.toContain("extractPlanIssues");
    });

    it("parallel-planner implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner has no generated merge prompt", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
        issueTracker: getIssueTracker("github-issues"),
      });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".shipyard", "merge-prompt.md")),
      ).rejects.toThrow();
    });

    it("parallel-planner implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner",
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- parallel-planner-with-review ---

    it("parallel-planner-with-review with github-issues produces plan-prompt with gh issue commands", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const planPrompt = await readFile(
        join(dir, ".shipyard", "plan-prompt.md"),
        "utf-8",
      );
      expect(planPrompt).toContain("gh issue list");
      expect(planPrompt).toContain("labels");
      expect(planPrompt).toContain("comments");
      expect(planPrompt).not.toContain("{{LIST_TASKS_COMMAND}}");
    });

    it("parallel-planner-with-review main.mts uses delivery groups and child IDs", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toContain("deliveryGroups");
      expect(main).toContain("TASK_ID: child.id");
      expect(main).not.toContain("number: number");
      expect(main).not.toContain("ISSUE_NUMBER");
      expect(main).not.toContain("`  #${");
    });

    it("parallel-planner-with-review main.mts uses Output.object for the plan", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toContain("Output.object");
      expect(main).toContain('tag: "plan"');
      expect(main).toContain("plan.output.deliveryGroups");
      expect(main).toContain('from "zod"');
      expect(main).toContain("z.object");
      expect(main).not.toContain("extractPlanIssues");
    });

    it("parallel-planner-with-review implement-prompt does not contain close-issue instruction", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("close the issue when done");
      expect(prompt).not.toContain("{{CLOSE_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review implement-prompt uses TASK_ID placeholder", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("{{TASK_ID}}");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
    });

    it("parallel-planner-with-review with github-issues produces implement-prompt with gh issue view", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("gh issue view");
      expect(prompt).not.toContain("{{VIEW_TASK_COMMAND}}");
    });

    it("parallel-planner-with-review has no generated merge prompt", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
        issueTracker: getIssueTracker("github-issues"),
      });

      const { access } = await import("node:fs/promises");
      await expect(
        access(join(dir, ".shipyard", "merge-prompt.md")),
      ).rejects.toThrow();
    });

    it("parallel-planner-with-review implement-prompt uses backlog-agnostic language", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "parallel-planner-with-review",
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).not.toContain("GitHub issue");
    });

    // --- Dockerfile issue tracker tools ---

    it("scaffold with github-issues produces Dockerfile with GitHub CLI install", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        issueTracker: getIssueTracker("github-issues"),
      });

      const dockerfile = await readFile(
        join(dir, ".shipyard", "Dockerfile"),
        "utf-8",
      );
      expect(dockerfile).toContain("GitHub CLI");
      expect(dockerfile).toContain("gh");
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
