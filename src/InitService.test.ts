import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
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

type GeneratedDeliveryGroup = {
  id: string;
  repository: string;
  mode: "standalone" | "planning-spec";
  root: { id: string; title: string };
  children: {
    id: string;
    title: string;
    dependsOn: string[];
  }[];
  integrationBranch: string;
  activationIssueId?: string;
};

type GeneratedActivationRoute = {
  activatedIssue: { number: number };
  root: { number: number; title: string };
  mode: "standalone" | "planning-spec";
  children: {
    id: string;
    title: string;
    dependsOn: string[];
  }[];
};

type GeneratedDeliveryHelpers = {
  route: (input: {
    groups: readonly unknown[];
    hydrate: (group: never) => Promise<never>;
    resolve: (group: never) => never;
    deliverStandalone: (input: never) => Promise<unknown>;
    deliverSpec: (input: never) => Promise<unknown>;
  }) => Promise<{
    outcome: string;
    groups: readonly unknown[];
  }>;
  canonicalize: (
    planned: GeneratedDeliveryGroup,
    route: GeneratedActivationRoute,
    resolveId: (group: GeneratedDeliveryGroup) => string,
  ) => GeneratedDeliveryGroup;
  findActivated: (
    planned: GeneratedDeliveryGroup,
    readActivated: (
      issueNumber: number,
    ) => Promise<GeneratedActivationRoute | undefined>,
  ) => Promise<GeneratedActivationRoute | undefined>;
};

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

  it("simple-loop main.mts uses the canonical standalone lifecycle", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain("createCredentialIsolatedRunPhaseEngineAdapter(");
    expect(mainTs).toContain("await shipyard.deliverStandalone({");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("1");
    expect(mainTs).not.toContain("merge-to-head");
    expect(mainTs).not.toContain("publishTemplateDelivery");
    expect(mainTs).toContain("openPostgresCoordinator({");
    expect(mainTs).toContain("readActivatedDeliveryRoot(");
    expect(mainTs).toContain("verifyChecks: runCandidateChecks");
    expect(mainTs).toContain("prompt: options.prompt");
    expect(mainTs).toContain("envAllowlist: []");
    expect(mainTs).toContain("databaseUrl: hostEnv.SHIPYARD_DATABASE_URL");
    expect(mainTs).not.toMatch(/workerEnvAllowlist:[\s\S]{0,200}GH_TOKEN/);
    expect(mainTs).not.toMatch(
      /workerEnvAllowlist:[\s\S]{0,200}SHIPYARD_DATABASE_URL/,
    );
    expect(mainTs).toContain(
      'const modelEnvAllowlist = ["CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_API_KEY"] as const;',
    );
    // When scaffolded with default model, simple-loop uses claude-opus-4-8
    // (rewritten from template's claude-sonnet-4-6)
    expect(mainTs).toContain("\.shipyard/prompt.md");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
    expect(mainTs).toContain('provider: "claude-code"');
    expect(mainTs).toContain('model: "claude-opus-4-8"');
  });

  it("simple-loop gives a Codex worker only the OpenAI API key", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      templateName: "simple-loop",
      agent: codexAgent,
      model: codexAgent.defaultModel,
    });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain(
      'const modelEnvAllowlist = ["OPENAI_API_KEY"] as const;',
    );
    expect(mainTs).not.toContain("ANTHROPIC_API_KEY");
    expect(mainTs).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(mainTs).toContain('provider: "codex"');
    expect(mainTs).toContain(`model: "${CODEX_MODELS.routine.model}"`);
  });

  it("simple-loop prompt delegates issue selection and lifecycle authority to the host", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "simple-loop" });

    const prompt = await readFile(join(dir, ".shipyard", "prompt.md"), "utf-8");
    expect(prompt).toContain("host coordinator");
    expect(prompt).toContain("Do not query GitHub");
    expect(prompt).toContain("{{TASK_ID}}");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
    expect(prompt).not.toContain("gh issue list");
    expect(prompt).not.toContain("{{LIST_TASKS_COMMAND}}");
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

    it(".env.example includes host-only coordinator and check settings", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const envExample = await readFile(
        join(dir, ".shipyard", ".env.example"),
        "utf-8",
      );
      expect(envExample).toContain("SHIPYARD_DATABASE_URL=");
      expect(envExample).toContain("SHIPYARD_CHECKS=");
      expect(envExample).toContain("SHIPYARD_BASE_BRANCH=staging");
    });

    it("main.mts uses the canonical standalone host lifecycle", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        "createCredentialIsolatedRunPhaseEngineAdapter(",
      );
      expect(mainTs).toContain("await shipyard.deliverStandalone({");
      expect(mainTs).toContain("openPostgresCoordinator({");
      expect(mainTs).toContain("readActivatedDeliveryRoot(");
      expect(mainTs).toContain("verifyChecks: runCandidateChecks");
      expect(mainTs).toContain("cleanup: runCandidateCleanup");
      expect(mainTs).toContain("implement-prompt.md");
      expect(mainTs).toContain("review-prompt.md");
      expect(mainTs).toContain("prompt: options.prompt");
      expect(mainTs).toContain(
        'const modelEnvAllowlist = ["CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_API_KEY"] as const;',
      );
      expect(mainTs).not.toMatch(/workerEnvAllowlist:[\s\S]{0,200}GH_TOKEN/);
      expect(mainTs).not.toMatch(
        /workerEnvAllowlist:[\s\S]{0,200}SHIPYARD_DATABASE_URL/,
      );
      expect(mainTs).not.toContain("publishTemplateDelivery");
      expect(mainTs).not.toContain('"issue",\n      "close"');
      expect(mainTs).not.toContain('"pr",\n          "create"');
      expect(mainTs).not.toContain('"pr",\n          "ready"');
      expect(mainTs).not.toContain("merge-to-head");
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

    it("main.mts selects one activated standalone issue per invocation", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("branch = `shipyard/issue-${issue.number}`");
      expect(mainTs).toContain('activation.mode !== "standalone"');
      expect(mainTs).toContain("readActivatedDeliveryGroup(");
      expect(mainTs).toContain("for (const listed of listIssues)");
      expect(mainTs).not.toContain("MAX_ITERATIONS");
      expect(mainTs).not.toContain("for (let iteration");
    });

    it("sequential-reviewer gives a Codex worker only the OpenAI API key", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        agent: codexAgent,
        model: codexAgent.defaultModel,
      });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        'const modelEnvAllowlist = ["OPENAI_API_KEY"] as const;',
      );
      expect(mainTs).not.toContain("ANTHROPIC_API_KEY");
      expect(mainTs).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
    });

    it("implement-prompt.md delegates selection and lifecycle authority to the host", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("host coordinator");
      expect(prompt).toContain("Do not query GitHub");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("gh issue close");
      expect(prompt).toContain("owns its durable delivery");
      expect(prompt).toContain("publish a branch or pull request");
      expect(prompt).not.toContain("{{ISSUE_NUMBER}}");
      expect(prompt).toContain("{{ISSUE_TITLE}}");
      expect(prompt).not.toContain("{{BRANCH}}");
    });

    it("implement-prompt.md forbids selecting another issue", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("host coordinator");
      expect(prompt).toContain("Do not query GitHub, select another issue");
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

    it("review-prompt.md references .shipyard/CODING_STANDARDS.md", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain(".shipyard/CODING_STANDARDS.md");
    });

    it("review-prompt.md diffs the exact base and candidate revisions", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{BASE_SHA}} {{HEAD_SHA}}");
      expect(prompt).toContain("git log {{BASE_SHA}}..{{HEAD_SHA}} --oneline");
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf8");
      expect(main).toContain("request.candidate.base.sha");
      expect(main).toContain("request.candidate.head.sha");
    });

    it("main.mts limits implementation to one iteration", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("maxIterations: 1");
      expect(mainTs).not.toContain("maxIterations: 100");
    });

    it("main.mts reports blocked delivery without bypassing the coordinator", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "sequential-reviewer" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('result.outcome === "ready-for-human"');
      expect(mainTs).toContain("result.reason");
      expect(mainTs).toContain("deliverStandalone");
      expect(mainTs).not.toContain("publishTemplateDelivery");
    });
  });

  it.each(["simple-loop", "sequential-reviewer"])(
    "%s promotes child activations through the fenced spec lifecycle",
    async (templateName) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName });

      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toContain("readActivatedDeliveryGroup(");
      expect(main).toContain('route.mode === "planning-spec"');
      expect(main).toContain('if (route.mode === "planning-spec")');
      expect(main).toContain("await shipyard.deliverSpec({");
      expect(main).toContain("shipyard/spec-${rootIssue.number}");
      expect(main).toContain("shipyard.resolveDeliveryGroup({");
      expect(main).toContain("await shipyard.deliverStandalone({");
      expect(main).toContain("const seenDeliveryRoots = new Set<string>()");
      expect(main).toContain(
        'result.reason?.startsWith("Spec delivery is already leased:")',
      );
      expect(main).toContain('result.reason === "delivery-busy"');
      expect(main).toContain("instanceof shipyard.GitHubDeliveryRouteError");
      expect(main).toContain(
        "Implementation branch is unavailable: Branch shipyard/issue-",
      );
      const workerIdPrefix =
        templateName === "simple-loop"
          ? "simple-loop-spec-"
          : "sequential-reviewer-spec-";
      expect(main).toContain(`workerId: \`${workerIdPrefix}`);
      expect(main).toContain(
        "Planning spec #${rootIssue.number} is the delivery root.",
      );
      expect(main).not.toContain(
        "Activated issue #${route.activatedIssue.number}",
      );
      expect(main).not.toContain(
        "shipyard/spec-${route.activatedIssue.number}",
      );
      expect(main).toContain("initialRoute.activatedIssue.number");
      expect(main).toContain('kind: "planning-spec"');
    },
  );

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

  it("keeps centralized Codex worker factories and records the configured model", async () => {
    const dir = await makeDir();
    await runScaffold(dir, {
      agent: codexAgent,
      model: CODEX_MODELS.routine.model,
      templateName: "parallel-planner",
    });

    const mainTs = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
    expect(mainTs).toContain("shipyard.CODEX_MODELS.routine");
    expect(mainTs).toContain("shipyard.CODEX_MODELS.strong");
    expect(mainTs).toContain(`model: "${CODEX_MODELS.routine.model}"`);
  });

  it.each([
    { templateName: "blank", promptFilename: "prompt.md" },
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
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      if (templateName === "sequential-reviewer") {
        expect(main).toContain('"--label",\n      "shipyard"');
        expect(main).toContain('label.toLowerCase() === "shipyard"');
        expect(main).toContain('activation.mode !== "standalone"');
        expect(prompt).not.toContain("gh issue list");
        return;
      }
      expect(prompt).toContain("gh issue list --state open --label shipyard");
      expect(prompt).not.toContain("--label Shipyard");
    },
  );

  it("scaffolded standalone prompts receive their selected runtime TASK_ID", async () => {
    const cases: Array<{ template: string; file: string }> = [
      { template: "simple-loop", file: "prompt.md" },
      { template: "sequential-reviewer", file: "implement-prompt.md" },
    ];
    for (const { template, file } of cases) {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const prompt = await readFile(join(dir, ".shipyard", file), "utf-8");
      expect(prompt, `${template}/${file}`).toContain("{{TASK_ID}}");
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toContain(
        '.replaceAll("{{TASK_ID}}", String(issue.number))',
      );
    }
  });

  it.each([
    {
      template: "simple-loop",
      prompts: ["prompt.md"],
      skills: ["implement", "tdd", "code-cleanup", "code-review"],
    },
    {
      template: "sequential-reviewer",
      prompts: ["implement-prompt.md", "review-prompt.md"],
      skills: ["implement", "tdd", "code-cleanup", "code-review"],
    },
    {
      template: "parallel-planner",
      prompts: ["plan-prompt.md", "implement-prompt.md"],
      skills: [
        "implement-spec",
        "implement",
        "tdd",
        "code-cleanup",
        "code-review",
      ],
    },
    {
      template: "parallel-planner-with-review",
      prompts: [
        "plan-prompt.md",
        "implement-prompt.md",
        "repair-prompt.md",
        "review-prompt.md",
      ],
      skills: [
        "implement-spec",
        "implement",
        "tdd",
        "code-cleanup",
        "code-review",
      ],
    },
  ])(
    "$template installs all Snappedly skills in Docker and selects relevant ones",
    async ({ template, prompts, skills }) => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: template });
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf8");
      expect(main).toContain(
        "npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y",
      );
      expect(main).toContain("timeoutMs: 300_000");
      expect(main).not.toContain("loadWorkflowSkills(");
      const allPrompts = await Promise.all(
        prompts.map((promptFile) =>
          readFile(join(dir, ".shipyard", promptFile), "utf8"),
        ),
      );
      for (const skill of skills)
        expect(allPrompts.join("\n")).toContain(`/${skill}`);
      for (const promptFile of prompts) {
        const prompt = await readFile(
          join(dir, ".shipyard", promptFile),
          "utf8",
        );
        expect(prompt).toContain("~/.agents/skills");
        expect(prompt).not.toContain("{{SKILLS}}");
      }
    },
  );

  it("the blank Docker template also installs the skill catalog", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "blank" });
    const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf8");
    expect(main).toContain(
      "npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y",
    );
  });

  it("the reviewed planner cleans and reviews the integrated spec candidate", async () => {
    const dir = await makeDir();
    await runScaffold(dir, { templateName: "parallel-planner-with-review" });
    const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf8");
    expect(main).toContain("readActivatedDeliveryGroup(");
    expect(main).toContain("canonicalizeActivatedGroup(");
    expect(main).toContain("activationIssueId");
    expect(main).toContain("verifyIntegrated: async");
    expect(main).toContain(
      "scope: `integrated planning spec #${issue.number}`",
    );
    expect(main).toContain('tag: "review-report"');
    expect(main).toContain("runConsolidatedRepair");
    expect(main).toContain("targetedFindings: request.targetedFindings");
    expect(main).toContain("fixer: {");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(
      runScaffold(dir, { templateName: "nonexistent" }),
    ).rejects.toThrow("nonexistent");
  });

  describe("parallel-planner template", () => {
    const generatedRouter = async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });
      const routerPath = join(dir, ".shipyard", "deliver-groups.ts");
      const source = await readFile(routerPath, "utf-8");
      const javascript = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const imported = (await import(
        /* @vite-ignore */
        `data:text/javascript,${encodeURIComponent(javascript)}`
      )) as {
        deliverPlannedGroups: GeneratedDeliveryHelpers["route"];
        canonicalizeActivatedGroup: GeneratedDeliveryHelpers["canonicalize"];
        findActivatedDeliveryRoute: GeneratedDeliveryHelpers["findActivated"];
      };
      return {
        route: imported.deliverPlannedGroups,
        canonicalize: imported.canonicalizeActivatedGroup,
        findActivated: imported.findActivatedDeliveryRoute,
      };
    };

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

    it("promotes an activated child to the complete canonical spec group", async () => {
      const { canonicalize, findActivated } = await generatedRouter();
      const checked: number[] = [];
      const route = await findActivated(
        {
          id: "spec-100",
          repository: "snappedly/shipyard",
          mode: "planning-spec",
          root: { id: "100", title: "Planning spec" },
          children: [
            { id: "101", title: "Child one", dependsOn: [] },
            { id: "102", title: "Child two", dependsOn: ["101"] },
          ],
          integrationBranch: "shipyard/spec-100",
        },
        async (issueNumber) => {
          checked.push(issueNumber);
          return issueNumber === 101
            ? {
                activatedIssue: { number: 101 },
                root: { number: 100, title: "Planning spec" },
                mode: "planning-spec" as const,
                children: [
                  { id: "101", title: "Child one", dependsOn: [] },
                  { id: "102", title: "Child two", dependsOn: ["101"] },
                ],
              }
            : undefined;
        },
      );
      expect(checked).toEqual([100, 101]);
      expect(route?.activatedIssue.number).toBe(101);
      const group = canonicalize(
        {
          id: "standalone:101",
          repository: "snappedly/shipyard",
          mode: "standalone",
          root: { id: "101", title: "Child one" },
          children: [{ id: "101", title: "Child one", dependsOn: [] }],
          integrationBranch: "shipyard/issue-101",
        },
        route!,
        (hydrated) => `${hydrated.mode}:${hydrated.root.id}`,
      );

      expect(group).toMatchObject({
        id: "planning-spec:100",
        mode: "planning-spec",
        root: { id: "100", title: "Planning spec" },
        children: [
          { id: "101", title: "Child one", dependsOn: [] },
          { id: "102", title: "Child two", dependsOn: ["101"] },
        ],
        integrationBranch: "shipyard/spec-100",
        activationIssueId: "101",
      });
    });

    it("routes standalone groups through the generated canonical callback", async () => {
      const { route } = await generatedRouter();
      const calls: string[] = [];
      const result = await route({
        groups: [{ id: "standalone-7", mode: "standalone" }],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone: async ({ delivery }) => {
          calls.push((delivery as { id: string }).id);
          return { outcome: "ready-for-human" };
        },
        deliverSpec: async () => {
          throw new Error("spec callback must not run");
        },
      });

      expect(result.outcome).toBe("delivered");
      expect(calls).toEqual(["standalone-7"]);
    });

    it("routes a dependency graph intact to one spec delivery", async () => {
      const { route } = await generatedRouter();
      const graph = {
        id: "spec-8",
        mode: "planning-spec",
        graph: {
          children: ["11", "12", "13"],
          dependencies: [
            { itemId: "11", dependsOn: [] },
            { itemId: "12", dependsOn: [] },
            { itemId: "13", dependsOn: ["11", "12"] },
          ],
        },
      };
      let received: unknown;
      const result = await route({
        groups: [graph],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone: async () => {
          throw new Error("standalone callback must not run");
        },
        deliverSpec: async ({ delivery }) => {
          received = delivery;
          return { outcome: "ready-for-human" };
        },
      });

      expect(result.outcome).toBe("delivered");
      expect(received).toEqual(graph);
    });

    it("runs mixed unrelated groups concurrently through their canonical callbacks", async () => {
      const { route } = await generatedRouter();
      const started: string[] = [];
      let resolveGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      const run =
        (name: string) =>
        async ({ delivery }: { delivery: unknown }) => {
          const id = (delivery as { id: string }).id;
          started.push(`${name}:${id}`);
          if (started.length === 2) resolveGate();
          await gate;
          return { outcome: "ready-for-human" };
        };
      const result = await route({
        groups: [
          { id: "issue-1", mode: "standalone" },
          { id: "spec-2", mode: "planning-spec" },
        ],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone: run("standalone"),
        deliverSpec: run("spec"),
      });

      expect(result.outcome).toBe("delivered");
      expect(started).toEqual(["standalone:issue-1", "spec:spec-2"]);
    });

    it("routes sibling activations through one canonical spec delivery", async () => {
      const { route } = await generatedRouter();
      const deliverSpec = vi.fn(async () => ({ outcome: "ready-for-human" }));
      const result = await route({
        groups: [{ issueId: "101" }, { issueId: "102" }],
        hydrate: async (planned) =>
          ({
            id: "spec-100",
            mode: "planning-spec",
            activationIssueId: (planned as { issueId: string }).issueId,
          }) as never,
        resolve: (group) => group as never,
        deliverStandalone: async () => ({ outcome: "blocked" }),
        deliverSpec,
      });

      expect(deliverSpec).toHaveBeenCalledOnce();
      expect(result.groups).toHaveLength(2);
      expect(result.groups[1]).toMatchObject({ outcome: "already-routed" });
      expect(result.outcome).toBe("delivered");
    });

    it("replays a delivery through its canonical callback without duplicating its effect", async () => {
      const { route } = await generatedRouter();
      const effects = new Map<string, string>();
      let publishes = 0;
      const deliverStandalone = async ({ delivery }: { delivery: unknown }) => {
        const id = (delivery as { id: string }).id;
        const existing = effects.get(id);
        if (existing !== undefined)
          return { outcome: "ready-for-human", pr: existing };
        publishes += 1;
        effects.set(id, "pr-9");
        return { outcome: "ready-for-human", pr: "pr-9" };
      };
      const input = {
        groups: [{ id: "issue-9", mode: "standalone" }],
        hydrate: async (group: never) => group,
        resolve: (group: never) => group,
        deliverStandalone,
        deliverSpec: async () => ({ outcome: "blocked" }),
      };

      const first = await route(input);
      const replay = await route(input);

      expect(first.outcome).toBe("delivered");
      expect(replay.outcome).toBe("delivered");
      expect(effects.get("issue-9")).toBe("pr-9");
      expect(publishes).toBe(1);
    });

    it("reports blocked groups and no-work plans without claiming success", async () => {
      const { route } = await generatedRouter();
      const noWork = await route({
        groups: [],
        hydrate: async (group: never) => group,
        resolve: (group: never) => group,
        deliverStandalone: async () => ({ outcome: "ready-for-human" }),
        deliverSpec: async () => ({ outcome: "ready-for-human" }),
      });
      const blocked = await route({
        groups: [{ id: "spec-10", mode: "planning-spec" }],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone: async () => ({ outcome: "blocked" }),
        deliverSpec: async () => ({ outcome: "blocked", reason: "lease busy" }),
      });

      expect(noWork).toEqual({ outcome: "no-work", groups: [] });
      expect(blocked.outcome).toBe("blocked");
      expect(blocked.groups).toHaveLength(1);
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

    it("main.mts delegates dependency scheduling and delivery to canonical workflows", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      const router = await readFile(
        join(dir, ".shipyard", "deliver-groups.ts"),
        "utf-8",
      );
      expect(mainTs).toContain("deliverPlannedGroups({");
      expect(mainTs).toContain("deliverStandalone: deliverStandaloneGroup");
      expect(mainTs).toContain("deliverSpec: deliverSpecGroup");
      expect(mainTs).toContain("await shipyard.deliverStandalone({");
      expect(mainTs).toContain("await shipyard.deliverSpec({");
      expect(router).toContain("Promise.allSettled");
      expect(mainTs).not.toContain("publishTemplateDelivery");
      expect(mainTs).not.toContain("closeIssue(");
      expect(mainTs).not.toContain('name: "merger"');
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
    const generatedRouter = async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });
      const routerPath = join(dir, ".shipyard", "deliver-groups.ts");
      const source = await readFile(routerPath, "utf-8");
      const javascript = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const imported = (await import(
        /* @vite-ignore */
        `data:text/javascript,${encodeURIComponent(javascript)}`
      )) as {
        deliverPlannedGroups: (input: {
          groups: readonly unknown[];
          hydrate: (group: never) => Promise<never>;
          resolve: (group: never) => never;
          deliverStandalone: (input: never) => Promise<unknown>;
          deliverSpec: (input: never) => Promise<unknown>;
        }) => Promise<{
          outcome: string;
          groups: readonly unknown[];
        }>;
        canonicalizeActivatedGroup: GeneratedDeliveryHelpers["canonicalize"];
        findActivatedDeliveryRoute: GeneratedDeliveryHelpers["findActivated"];
      };
      return {
        route: imported.deliverPlannedGroups,
        canonicalize: imported.canonicalizeActivatedGroup,
        findActivated: imported.findActivatedDeliveryRoute,
        source,
      };
    };

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
        access(join(configDir, "repair-prompt.md")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(configDir, "deliver-groups.ts")),
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

    it("main.mts reviews the exact candidate in an immutable worktree", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('name: "reviewer"');
      expect(mainTs).toContain("baseBranch: input.head.sha");
      expect(mainTs).toContain("BASE_SHA: input.base.sha");
      expect(mainTs).toContain("HEAD_SHA: input.head.sha");
      expect(mainTs).toContain("REQUIRED_AXES:");
      expect(mainTs).toContain('tag: "review-report"');
      const reviewPrompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(reviewPrompt).toContain("Include every required axis");
    });

    it("main.mts sends standalone and spec work through canonical delivery", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("await shipyard.deliverStandalone({");
      expect(mainTs).toContain("await shipyard.deliverSpec({");
      expect(mainTs).toContain("deliverPlannedGroups({");
      expect(mainTs).not.toContain("publishTemplateDelivery");
      expect(mainTs).not.toContain("Promise.allSettled(");
    });

    it("generated deliveries re-read current revisions before review evidence is used", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain("BASE_SHA: input.base.sha");
      expect(mainTs).toContain("HEAD_SHA: input.head.sha");
      expect(mainTs).toContain(
        "readCurrent: () => readStandaloneCurrent({ group, brief, branch })",
      );
      expect(mainTs).toContain(
        "const current = await coordinator.getDelivery(delivery.key)",
      );
      expect(mainTs).toContain("return specCurrent({");
    });

    it("main.mts configures one consolidated repair and targeted re-review", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain(
        "repairBudget: { maxBatches: 1, maxFollowUps: 1 }",
      );
      expect(mainTs).toContain("runConsolidatedRepair");
      expect(mainTs).toContain("REVIEW_MODE: input.mode");
      expect(mainTs).toContain("commits: [integrated.headSha]");
      expect(mainTs).toContain("mode: request.mode");
      expect(mainTs).toContain("targetedFindings: request.targetedFindings");
      expect(mainTs.match(/fix: \(request\) =>/g)).toHaveLength(2);
      expect(mainTs).toContain("workerId: workerIdFor(group)");
    });

    it("main.mts delegates parallel routing and scheduling to the generated router", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const mainTs = await readFile(
        join(dir, ".shipyard", "main.mts"),
        "utf-8",
      );
      expect(mainTs).toContain('from "./deliver-groups.js"');
      expect(mainTs).toContain("readActivatedDeliveryGroup(");
      expect(mainTs).toContain("integrateTemplateDelivery");
      expect(mainTs).toContain("deliveryGroups");
      expect(mainTs).toContain("deliverStandalone: deliverStandaloneGroup");
      expect(mainTs).toContain("deliverSpec: deliverSpecGroup");
      expect(mainTs).not.toContain("runChild(");
    });

    it("generated router handles groups concurrently and contains no external effects", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const router = await readFile(
        join(dir, ".shipyard", "deliver-groups.ts"),
        "utf-8",
      );
      expect(router).toContain("Promise.allSettled");
      expect(router).not.toContain("shipyard.run(");
      expect(router).not.toContain("createGitHub");
      expect(router).not.toContain("publish");
    });

    it("generated router routes mixed standalone and spec groups concurrently", async () => {
      const { route } = await generatedRouter();
      const calls: string[] = [];
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const deliver =
        (mode: string) =>
        async ({ delivery }: { delivery: unknown }) => {
          const id = (delivery as { id: string }).id;
          calls.push(`${mode}:${id}`);
          if (calls.length === 2) finish();
          await gate;
          return { outcome: "ready-for-human" };
        };
      const result = await route({
        groups: [
          { id: "issue-17", mode: "standalone" },
          { id: "spec-18", mode: "planning-spec" },
        ],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone: deliver("standalone"),
        deliverSpec: deliver("spec"),
      });

      expect(result.outcome).toBe("delivered");
      expect(calls).toEqual(["standalone:issue-17", "spec:spec-18"]);
    });

    it("promotes activated spec children and coalesces siblings", async () => {
      const { route, canonicalize, findActivated } = await generatedRouter();
      const activated = await findActivated(
        {
          id: "spec-100",
          repository: "snappedly/shipyard",
          mode: "planning-spec",
          root: { id: "100", title: "Planning spec" },
          children: [
            { id: "101", title: "Child one", dependsOn: [] },
            { id: "102", title: "Child two", dependsOn: ["101"] },
          ],
          integrationBranch: "shipyard/spec-100",
        },
        async (issueNumber) =>
          issueNumber === 102
            ? {
                activatedIssue: { number: 102 },
                root: { number: 100, title: "Planning spec" },
                mode: "planning-spec",
                children: [
                  { id: "101", title: "Child one", dependsOn: [] },
                  { id: "102", title: "Child two", dependsOn: ["101"] },
                ],
              }
            : undefined,
      );
      const normalized = canonicalize(
        {
          id: "standalone:101",
          repository: "snappedly/shipyard",
          mode: "standalone",
          root: { id: "101", title: "Child one" },
          children: [{ id: "101", title: "Child one", dependsOn: [] }],
          integrationBranch: "shipyard/issue-101",
        },
        activated!,
        (hydrated) => `${hydrated.mode}:${hydrated.root.id}`,
      );
      const deliverSpec = vi.fn(async () => ({ outcome: "ready-for-human" }));
      const result = await route({
        groups: [{ issueId: "101" }, { issueId: "102" }],
        hydrate: async (planned) =>
          ({
            ...normalized,
            activationIssueId: (planned as { issueId: string }).issueId,
          }) as never,
        resolve: (group) => group as never,
        deliverStandalone: async () => ({ outcome: "blocked" }),
        deliverSpec,
      });

      expect(normalized).toMatchObject({
        id: "planning-spec:100",
        mode: "planning-spec",
        root: { id: "100", title: "Planning spec" },
        children: [
          { id: "101", title: "Child one", dependsOn: [] },
          { id: "102", title: "Child two", dependsOn: ["101"] },
        ],
        integrationBranch: "shipyard/spec-100",
        activationIssueId: "102",
      });
      expect(deliverSpec).toHaveBeenCalledOnce();
      expect(result.groups[1]).toMatchObject({ outcome: "already-routed" });
      expect(result.outcome).toBe("delivered");
    });

    it("generated router isolates an interrupted group and skips live work for no-work", async () => {
      const { route, source } = await generatedRouter();
      const deliverStandalone = vi.fn(async () => {
        throw new Error("worker interrupted");
      });
      const deliverSpec = vi.fn(async () => ({ outcome: "ready-for-human" }));
      const result = await route({
        groups: [
          { id: "issue-19", mode: "standalone" },
          { id: "spec-20", mode: "planning-spec" },
        ],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone,
        deliverSpec,
      });
      const noWork = await route({
        groups: [],
        hydrate: async (group) => group as never,
        resolve: (group) => group as never,
        deliverStandalone,
        deliverSpec,
      });

      expect(result.outcome).toBe("delivered");
      expect(result.groups).toHaveLength(2);
      expect(deliverStandalone).toHaveBeenCalledOnce();
      expect(deliverSpec).toHaveBeenCalledOnce();
      expect(noWork).toEqual({ outcome: "no-work", groups: [] });
      expect(deliverStandalone).toHaveBeenCalledOnce();
      expect(deliverSpec).toHaveBeenCalledOnce();
      expect(source).not.toContain("@snappedly-tools/shipyard");
      expect(source).not.toContain("shipyard.run");
      expect(source).not.toContain("createGitHub");
    });

    it("main.mts keeps the planner, worker, and reviewer bounded", async () => {
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

      // Check child worker maxIterations: 100
      const childSection = mainTs.slice(
        mainTs.indexOf("const childWorker"),
        mainTs.indexOf("const verification"),
      );
      expect(childSection).toContain("maxIterations: 100");

      // Check reviewer maxIterations: 1
      const reviewerSection = mainTs.slice(
        mainTs.indexOf("const reviewCandidate"),
        mainTs.indexOf("const runConsolidatedRepair"),
      );
      expect(reviewerSection).toContain('name: "reviewer"');
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
      expect(prompt).toContain("{{REVIEW_SCOPE}}");
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

    it("review-prompt.md diffs the exact base and candidate revisions", async () => {
      const dir = await makeDir();
      await runScaffold(dir, { templateName: "parallel-planner-with-review" });

      const prompt = await readFile(
        join(dir, ".shipyard", "review-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("git diff {{BASE_SHA}} {{HEAD_SHA}}");
      expect(prompt).toContain("git log {{BASE_SHA}}..{{HEAD_SHA}}");
      expect(prompt).not.toContain("{{SOURCE_BRANCH}}");
      expect(prompt).not.toContain("git diff main");
      expect(prompt).not.toContain("git log main");
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf8");
      expect(main).toContain("BASE_SHA: input.base.sha");
      expect(main).toContain("HEAD_SHA: input.head.sha");
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
    it("simple-loop keeps GitHub issue commands on the host", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "simple-loop",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "prompt.md"),
        "utf-8",
      );
      const main = await readFile(join(dir, ".shipyard", "main.mts"), "utf-8");
      expect(main).toMatch(/"issue",\s+"list"/);
      expect(prompt).toContain("Do not query GitHub");
      expect(prompt).not.toContain("gh issue list");
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
      // The host performs issue selection; the worker prompt has no live query.
      expect(prompt).toContain("host coordinator");
      expect(prompt).not.toContain("gh issue list");
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
      expect(prompt).toContain("issue selected by the host coordinator");
      expect(prompt).toContain("Do not query GitHub");
    });

    // --- sequential-reviewer ---

    it("sequential-reviewer keeps issue selection and closure on the host", async () => {
      const dir = await makeDir();
      await runScaffold(dir, {
        templateName: "sequential-reviewer",
        issueTracker: getIssueTracker("github-issues"),
      });

      const prompt = await readFile(
        join(dir, ".shipyard", "implement-prompt.md"),
        "utf-8",
      );
      expect(prompt).toContain("Do not query GitHub");
      expect(prompt).not.toContain("gh issue list");
      expect(prompt).not.toContain("labels");
      expect(prompt).not.toContain("comments");
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
      expect(main).toContain("TASK_ID: request.child.itemId");
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
      expect(main).toContain("TASK_ID: request.child.itemId");
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
