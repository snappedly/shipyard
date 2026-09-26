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
import type { ScaffoldOptions } from "./InitService.js";
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
      expectedModelExample: "SHIPYARD_ROUTINE_MODEL=sonnet",
      expectedModelCatalog: "https://code.claude.com/docs/en/model-config",
    },
    {
      agent: codexAgent,
      expectedKey: "OPENAI_API_KEY=",
      unexpectedKey: "ANTHROPIC_API_KEY=",
      expectClaudeSetupTokenHint: false,
      expectedModelExample: "SHIPYARD_ROUTINE_MODEL=gpt-6-luna",
      expectedModelCatalog: "https://learn.chatgpt.com/docs/models",
    },
  ])(
    "generates .env.example with $agent.name env var",
    async ({
      agent,
      expectedKey,
      unexpectedKey,
      expectClaudeSetupTokenHint,
      expectedModelExample,
      expectedModelCatalog,
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
      expect(envExample).toContain("SHIPYARD_ROUTINE_MODEL=");
      expect(envExample).toContain("SHIPYARD_STRONG_MODEL=");
      expect(envExample).toContain(expectedModelExample);
      expect(envExample).toContain(expectedModelCatalog);
      expect(envExample).toContain("Aliases can change their target over time");
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
    expect(envExample).not.toContain("GH_REPO=");
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

  it("does not scaffold config.json", async () => {
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

  it("default prompt contains the issue scope and completion signal", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const prompt = await readFile(join(dir, ".shipyard", "prompt.md"), "utf-8");
    expect(prompt).toContain("# Assigned issue scope");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("defaults to simple-loop when no template is specified", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await runScaffold(dir1);
    await runScaffold(dir2, { templateName: "simple-loop" });

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

  it("does not offer or scaffold the blank template", async () => {
    expect(listTemplates().map((template) => template.name)).not.toContain(
      "blank",
    );
    await expect(
      runScaffold(await makeDir(), { templateName: "blank" }),
    ).rejects.toThrow('Unknown template: "blank"');
  });

  // --- main file rewriting ---

  it("scaffolds main.mts with the specified model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { model: "claude-sonnet-4-6" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('roleAgent("routine", "claude-sonnet-4-6")');
    expect(mainTs).toContain("const agentFactory = shipyard.claudeCode;");
    expect(mainTs).toContain("const CODEX_PROVIDER = false;");
    expect(mainTs).not.toContain("shipyard.CODEX_MODELS.routine");
  });

  it("scaffolds main.mts with default model when using agent default", async () => {
    const dir = await makeDir();
    await runScaffold(dir);

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('roleAgent("routine", "claude-opus-4-8")');
  });

  it("lets init --model supply both unset Codex roles without default effort", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: "unlisted-model",
      modelExplicit: true,
      templateName: "sequential-reviewer",
    });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain('roleAgent("routine", "unlisted-model")');
    expect(mainTs).toContain('roleAgent("strong", "unlisted-model")');
    expect(mainTs).toContain("const CODEX_PROVIDER = true;");
    expect(mainTs).toContain("const agentFactory = shipyard.codex;");
    expect(mainTs).not.toContain("shipyard.CODEX_MODELS.routine");
    expect(mainTs).not.toContain("shipyard.CODEX_MODELS.strong");
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
    it("shows environment setup, subscription login, and runner start", () => {
      expect(getNextStepsLines()).toEqual([
        "Next steps:",
        "1. Fill in the values you need in `.shipyard/.env`.",
        "2. If using a model subscription, sign in. For Codex:",
        `   codex --config 'cli_auth_credentials_store="file"' login`,
        "   test -f ~/.codex/auth.json",
        "3. Start the repository runner with `npx shipyard runner start`.",
      ]);
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
    expect(mainTs).toContain("const agentFactory = shipyard.codex;");
    expect(mainTs).toContain(
      'roleAgent("routine", shipyard.CODEX_MODELS.routine)',
    );
    expect(mainTs).toContain("const CODEX_PROVIDER = true;");
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
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])(
    "%s scaffolds issue selection, setup, and PR handoff",
    async (templateName) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName });
      const configDir = join(dir, ".shipyard");
      const main = await readFile(join(configDir, "main.mts"), "utf-8");
      const selector = await readFile(
        join(configDir, "select-issues.mjs"),
        "utf-8",
      );
      const setup = await readFile(join(configDir, "setup.sh"), "utf-8");
      const handoff = await readFile(join(configDir, "handoff.sh"), "utf-8");
      const blocked = await readFile(
        join(configDir, "block-scope.sh"),
        "utf-8",
      );
      const triage = await readFile(
        join(configDir, "triage-prompt.md"),
        "utf-8",
      );
      const triageGate = await readFile(
        join(configDir, "verify-triage.sh"),
        "utf-8",
      );
      expect(main).toContain("handoff.sh");
      expect(main).toContain("setup.sh");
      expect(main).toContain("triage-prompt.md");
      expect(main).toContain("verify-triage.sh");
      expect(selector).toMatch(/"--label",\s*"shipyard"/);
      expect(setup).toContain("snappedly/skills.git");
      expect(setup).toContain("for skill in triage implement");
      expect(triage).toContain("Follow `/triage`");
      expect(triageGate).toContain("ready-for-agent");
      expect(handoff).toContain("gh pr create");
      expect(handoff).not.toContain("gh pr merge");
      expect(blocked).toContain("shipyard:blocked");
      if (templateName.startsWith("parallel-"))
        expect(
          await readFile(join(configDir, "conflict-prompt.md"), "utf-8"),
        ).toContain("cherry-pick conflict");
    },
  );

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s scaffolds the planner branch conflict helper",
    async (templateName) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName });

      const configDir = join(dir, ".shipyard");
      const main = await readFile(join(configDir, "main.mts"), "utf-8");
      const helper = await readFile(
        join(configDir, "planner-branch.mts"),
        "utf-8",
      );
      expect(main).toContain("./planner-branch.mjs");
      expect(helper).toContain("resolvePlannerBranch");
    },
  );

  it.each([
    {
      templateName: "parallel-planner",
      agent: claudeCodeAgent,
      expectedModelExample: "SHIPYARD_ROUTINE_MODEL=sonnet",
    },
    {
      templateName: "parallel-planner",
      agent: codexAgent,
      expectedModelExample: "SHIPYARD_ROUTINE_MODEL=gpt-6-luna",
    },
    {
      templateName: "parallel-planner-with-review",
      agent: claudeCodeAgent,
      expectedModelExample: "SHIPYARD_ROUTINE_MODEL=sonnet",
    },
    {
      templateName: "parallel-planner-with-review",
      agent: codexAgent,
      expectedModelExample: "SHIPYARD_ROUTINE_MODEL=gpt-6-luna",
    },
  ])(
    "$templateName generates model role settings for $agent.name",
    async ({ templateName, agent, expectedModelExample }) => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName,
        agent,
        model: agent.defaultModel,
      });

      const envExample = await readFile(
        join(dir, ".shipyard", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain("SHIPYARD_ROUTINE_MODEL=");
      expect(envExample).toContain("SHIPYARD_STRONG_MODEL=");
      expect(envExample).toContain(expectedModelExample);
    },
  );

  describe("parallel-planner template", () => {
    it("produces main.mts, plan-prompt.md, implement-prompt.md, merge-prompt.md", async () => {
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
      ).resolves.toBeUndefined();
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
    it("produces main.mts, plan-prompt.md, implement-prompt.md, review-prompt.md, merge-prompt.md", async () => {
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
      ).resolves.toBeUndefined();
    });

    it("main.mts has correct maxIterations: planner=1, implementer=100, reviewer=1, merger=1", async () => {
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

      // Check merger maxIterations: 1
      const mergerSection = mainTs.slice(
        mainTs.indexOf('name: "merger"') - 200,
        mainTs.indexOf('name: "merger"') + 200,
      );
      expect(mergerSection).toContain("maxIterations: 1");
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
      expect(mainContent).toContain('roleAgent("routine", "claude-opus-4-8")');
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
      expect(mainContent).toContain(
        'roleAgent("routine", shipyard.CODEX_MODELS.routine)',
      );
      expect(mainContent).not.toContain("claudeCode");
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
        'import * as shipyard from "@snappedly-tools/shipyard"',
      );
      expect(mainTs).toContain(
        'import { docker } from "@snappedly-tools/shipyard/sandboxes/docker"',
      );
      expect(mainTs).toContain("const sandboxAuthOptions = {};");
      expect(mainTs).toContain("env: { GH_REPO: repository }");
      expect(mainTs).toContain("sandbox: sandboxProvider");
    });
  });
});
