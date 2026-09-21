import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";
import type { CodexAuthMode } from "./CodexAuth.js";
import { assertConfigDirAvailable } from "./runtimeConfig.js";
import {
  CONFIG_DIR,
  PRODUCT_NAME,
  CLI_NAME,
  LOCKS_DIR,
} from "./runtimeNames.js";
import { CODEX_MODELS } from "./modelConfig.js";

const GITIGNORE = `.env
logs/
worktrees/
${LOCKS_DIR}/
`;

export const DEFAULT_AGENT_NAME = "codex";
const TEMPLATE_AGENT_FACTORY = "codex";

const CODEX_CHATGPT_ENV_EXAMPLE = `# Codex ChatGPT subscription authentication
# On the host, run \`codex login\` and make sure \`~/.codex/auth.json\` exists.
# Shipyard mounts that file read-only into the sandbox.
# Do not add OPENAI_API_KEY here: that selects API-key billing instead.`;

const CODEX_CHATGPT_AUTH_OPTIONS = `{
  mounts: [
    {
      hostPath: "~/.codex/auth.json",
      sandboxPath: "~/.codex/auth.json",
      readonly: true,
    },
  ],
}`;

export interface TemplateMetadata {
  name: string;
  description: string;
  /**
   * Host-side npm packages the template's `main` file imports directly (e.g.
   * the planner templates import `zod` for their `<plan>` output schema). Init
   * offers to install these with the detected package manager so that
   * `npx tsx ${CONFIG_DIR}/main.ts` doesn't crash with ERR_MODULE_NOT_FOUND.
   */
  dependencies?: readonly string[];
}

const TEMPLATES: TemplateMetadata[] = [
  {
    name: "blank",
    description: "Bare scaffold — write your own prompt and orchestration",
  },
  {
    name: "simple-loop",
    description: "Picks issues one by one and closes them",
  },
  {
    name: "sequential-reviewer",
    description:
      "Implements issues one by one, with a code review step after each",
  },
  {
    name: "parallel-planner",
    description:
      "Plans parallelizable issues, executes on separate branches, merges",
    dependencies: ["zod"],
  },
  {
    name: "parallel-planner-with-review",
    description:
      "Plans parallelizable issues, executes with per-branch review, merges",
    dependencies: ["zod"],
  },
];

export const listTemplates = (): TemplateMetadata[] => TEMPLATES;

/**
 * Host-side npm packages the given template imports directly. Empty when the
 * template name is unknown or the template declares no extra dependencies.
 */
export const getTemplateDependencies = (
  templateName: string,
): readonly string[] =>
  TEMPLATES.find((t) => t.name === templateName)?.dependencies ?? [];

// ---------------------------------------------------------------------------
// Package manager detection (internal — not part of public API)
// ---------------------------------------------------------------------------

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

/** A package manager Shipyard can detect on the host and build install commands for. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Lockfiles checked in priority order. bun.lock / bun.lockb are both valid bun
// lockfiles (text vs binary), so both map to bun.
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/**
 * Detect the host project's package manager. An explicit corepack-style
 * `packageManager` field in package.json wins; otherwise the first matching
 * lockfile decides. Defaults to npm when nothing matches.
 */
export const detectPackageManager = (
  repoDir: string,
): Effect.Effect<PackageManager, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const pkgPath = join(repoDir, "package.json");
    const pkgExists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (pkgExists) {
      const content = yield* fs
        .readFileString(pkgPath)
        .pipe(Effect.orElseSucceed(() => ""));
      try {
        const pkg = JSON.parse(content) as Record<string, unknown>;
        const field = pkg["packageManager"];
        if (typeof field === "string") {
          const name = field.split("@")[0];
          const match = PACKAGE_MANAGERS.find((pm) => pm === name);
          if (match) return match;
        }
      } catch {
        // Malformed package.json — fall through to lockfile detection.
      }
    }

    for (const [file, pm] of LOCKFILES) {
      const exists = yield* fs
        .exists(join(repoDir, file))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) return pm;
    }

    return "npm";
  });

/** Build the command that adds a runtime dependency for the given package manager. */
export const addDependencyCommand = (
  packageManager: PackageManager,
  pkg: string,
): string => {
  switch (packageManager) {
    case "pnpm":
      return `pnpm add ${pkg}`;
    case "yarn":
      return `yarn add ${pkg}`;
    case "bun":
      return `bun add ${pkg}`;
    case "npm":
      return `npm install ${pkg}`;
  }
};

/**
 * Whether the host package.json already declares `pkg` in any of its dependency
 * maps. Used so init doesn't offer to install something already present.
 */
export const hostHasDependency = (
  repoDir: string,
  pkg: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return false;
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      const depMaps = [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ];
      return depMaps.some((key) => {
        const deps = parsed[key];
        return (
          typeof deps === "object" && deps !== null && pkg in (deps as object)
        );
      });
    } catch {
      return false;
    }
  });

// ---------------------------------------------------------------------------
// Agent registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface AgentEntry {
  readonly name: string;
  readonly label: string;
  readonly defaultModel: string;
  readonly factoryImport: string;
  readonly dockerfileTemplate: string;
  /** Lines to include in the generated `.env.example` for this agent's API key. */
  readonly envExample: string;
}

const CLAUDE_CODE_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: shipyard docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER \${AGENT_UID}:\${AGENT_GID}

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Add Claude to PATH
ENV PATH="/home/agent/.local/bin:$PATH"

WORKDIR /home/agent

# In worktree sandbox mode, Shipyard bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const CODEX_DOCKERFILE = `FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y \\
  git \\
  curl \\
  jq \\
  && rm -rf /var/lib/apt/lists/*

{{ISSUE_TRACKER_TOOLS}}

# Build-args for UID/GID alignment: shipyard docker build-image
# defaults these to the host user's UID/GID so image-built files
# and bind-mounted files share an owner without runtime chown.
ARG AGENT_UID=1000
ARG AGENT_GID=1000

# Rename the base image's "node" user to "agent" and align UID/GID.
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node

# Install Codex CLI (run as root before USER agent)
RUN npm install -g @openai/codex

USER \${AGENT_UID}:\${AGENT_GID}

WORKDIR /home/agent

# In worktree sandbox mode, Shipyard bind-mounts the git worktree at ${SANDBOX_REPO_DIR}
# and overrides the working directory to ${SANDBOX_REPO_DIR} at container start.
# Structure your Dockerfile so that ${SANDBOX_REPO_DIR} can serve as the project root.
ENTRYPOINT ["sleep", "infinity"]
`;

const AGENT_REGISTRY: AgentEntry[] = [
  {
    name: "codex",
    label: "Codex",
    defaultModel: CODEX_MODELS.routine.model,
    factoryImport: "codex",
    dockerfileTemplate: CODEX_DOCKERFILE,
    envExample: `# OpenAI API key
OPENAI_API_KEY=`,
  },
  {
    name: "claude-code",
    label: "Claude Code",
    defaultModel: "claude-opus-4-8",
    factoryImport: "claudeCode",
    dockerfileTemplate: CLAUDE_CODE_DOCKERFILE,
    envExample: `# Claude Code OAuth token — get one by running \`claude setup-token\` on your host.
# Lets the agent use your Claude subscription instead of an API key.
CLAUDE_CODE_OAUTH_TOKEN=
# Or use an Anthropic API key instead — uncomment and fill in:
# ANTHROPIC_API_KEY=`,
  },
];

export const listAgents = (): AgentEntry[] => AGENT_REGISTRY;

// ---------------------------------------------------------------------------
// Issue tracker registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface IssueTrackerEntry {
  readonly name: string;
  readonly label: string;
  readonly templateArgs: {
    readonly LIST_TASKS_COMMAND: string;
    readonly VIEW_TASK_COMMAND: string;
    readonly CLOSE_TASK_COMMAND: string;
    readonly ISSUE_TRACKER_TOOLS: string;
  };
  /** Lines to append to `.env.example` for this issue tracker, or empty string if none needed. */
  readonly envExample: string;
}

const GITHUB_CLI_TOOLS = `# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \\
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \\
  && apt-get update && apt-get install -y gh \\
  && rm -rf /var/lib/apt/lists/*`;

const ISSUE_TRACKER_REGISTRY: IssueTrackerEntry[] = [
  {
    name: "github-issues",
    label: "GitHub Issues",
    templateArgs: {
      LIST_TASKS_COMMAND: `gh issue list --state open --label ${PRODUCT_NAME} --limit 100 --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`,
      VIEW_TASK_COMMAND: "gh issue view <ID>",
      CLOSE_TASK_COMMAND: `gh issue close <ID> --comment "Completed by ${PRODUCT_NAME}"`,
      ISSUE_TRACKER_TOOLS: GITHUB_CLI_TOOLS,
    },
    envExample: `# GitHub personal access token — the agent uses it to read and manage GitHub Issues
# Create a fine-grained token: https://github.com/settings/personal-access-tokens/new
# Required repository permissions: Issues (Read and write) and Metadata (Read)
GH_TOKEN=`,
  },
];

export const listIssueTrackers = (): IssueTrackerEntry[] =>
  ISSUE_TRACKER_REGISTRY;

export const getIssueTracker = (name: string): IssueTrackerEntry | undefined =>
  ISSUE_TRACKER_REGISTRY.find((b) => b.name === name);

export const getAgent = (name: string): AgentEntry | undefined =>
  AGENT_REGISTRY.find((a) => a.name === name);

// ---------------------------------------------------------------------------
// Sandbox provider registry (internal — not part of public API)
// ---------------------------------------------------------------------------

export interface SandboxProviderEntry {
  readonly name: string;
  readonly label: string;
  /** Filename written to .shipyard/. */
  readonly containerfileName: string;
  /** CLI namespace for build/remove commands. */
  readonly cliNamespace: string;
}

const SANDBOX_PROVIDER_REGISTRY: SandboxProviderEntry[] = [
  {
    name: "docker",
    label: "Docker",
    containerfileName: "Dockerfile",
    cliNamespace: "docker",
  },
];

export const listSandboxProviders = (): SandboxProviderEntry[] =>
  SANDBOX_PROVIDER_REGISTRY;

export const getSandboxProvider = (
  name: string,
): SandboxProviderEntry | undefined =>
  SANDBOX_PROVIDER_REGISTRY.find((p) => p.name === name);

// ---------------------------------------------------------------------------
// Next steps
// ---------------------------------------------------------------------------

export function getNextStepsLines(
  template: string,
  mainFilename: string,
  agent: AgentEntry,
  packageManager: PackageManager,
  codexAuth: CodexAuthMode = "api-key",
): string[] {
  const getAuthLines = (step: number): string[] => {
    if (agent.name === "codex") {
      if (codexAuth === "chatgpt") {
        return [
          `${step}. Use your ChatGPT subscription with Codex: run \`codex login\` on the host and make sure \`~/.codex/auth.json\` exists`,
          '   If it does not exist, set `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`, then run the login again',
          "   Shipyard mounts this credential read-only; use this mode only with trusted repositories.",
          `   If subscription auth does not work, rerun init with \`--codex-auth api-key\` and set \`OPENAI_API_KEY\` in ${CONFIG_DIR}/.env instead.`,
          `   Also set any issue-tracker variables shown in ${CONFIG_DIR}/.env.example.`,
        ];
      }
      return [
        `${step}. Use your ChatGPT subscription with Codex (recommended): run \`codex login\` on the host, then initialize with \`--codex-auth chatgpt\` so Shipyard can mount \`~/.codex/auth.json\` read-only`,
        `   If subscription auth does not work, use API-key billing instead by setting \`OPENAI_API_KEY\` in ${CONFIG_DIR}/.env (see ${CONFIG_DIR}/.env.example).`,
        `   Also set any issue-tracker variables shown in ${CONFIG_DIR}/.env.example.`,
      ];
    }

    if (agent.name === "claude-code") {
      return [
        `${step}. Use your Claude subscription (recommended): run \`claude setup-token\` on the host and paste the result into \`CLAUDE_CODE_OAUTH_TOKEN\` in ${CONFIG_DIR}/.env`,
        `   If subscription auth does not work, use API-key billing instead by uncommenting \`ANTHROPIC_API_KEY\` in ${CONFIG_DIR}/.env and setting it to your key.`,
        `   Also set any issue-tracker variables shown in ${CONFIG_DIR}/.env.example.`,
      ];
    }

    return [
      `${step}. Set the required env vars in ${CONFIG_DIR}/.env (see ${CONFIG_DIR}/.env.example)`,
    ];
  };

  if (template === "blank") {
    const lines = ["Next steps:", ...getAuthLines(1)];
    lines.push(
      `2. Read and customize ${CONFIG_DIR}/prompt.md to describe what you want the agent to do`,
      `3. Customize ${CONFIG_DIR}/${mainFilename} — it uses the JS API (\`run()\`) to control how the agent runs`,
      `4. Run \`npx ${CLI_NAME} run\` to build the sandbox image and start the agent`,
    );
    return lines;
  } else {
    const hasReviewer = template.includes("review");
    const usesPlanSchema = getTemplateDependencies(template).includes("zod");
    let step = 1;
    const lines: string[] = ["Next steps:", ...getAuthLines(step++)];
    lines.push(
      `${step++}. Templates use \`copyToWorktree: ["node_modules"]\` to copy your host node_modules into the sandbox for fast startup — the \`npm install\` in the onSandboxReady hook is a safety net for platform-specific binaries. Adjust both if you use a different package manager`,
    );
    if (usesPlanSchema) {
      lines.push(
        `${step++}. Install a schema validator for the planner's \`<plan>\` output — the template uses Zod (\`${addDependencyCommand(packageManager, "zod")}\`), but Valibot, ArkType, or any Standard Schema library works (https://standardschema.dev)`,
      );
    }
    lines.push(
      `${step++}. Read and customize the prompt files in ${CONFIG_DIR}/ — they shape what the agent does`,
    );
    if (hasReviewer) {
      lines.push(
        `${step++}. Customize ${CONFIG_DIR}/CODING_STANDARDS.md with your project's standards — the reviewer agent loads it during review`,
      );
    }
    lines.push(
      `${step++}. Run \`npx ${CLI_NAME} run\` to build the sandbox image and start the workflow`,
    );
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Scaffolding helpers
// ---------------------------------------------------------------------------

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return join(dirname(thisFile), "templates");
}

const getTemplateDir = (
  templateName: string,
): Effect.Effect<string, Error, never> =>
  Effect.gen(function* () {
    const template = TEMPLATES.find((t) => t.name === templateName);
    if (!template) {
      const names = TEMPLATES.map((t) => t.name).join(", ");
      yield* Effect.fail(
        new Error(`Unknown template: "${templateName}". Available: ${names}`),
      );
    }
    return join(getTemplatesDir(), templateName);
  });

const COMPILED_FILE_EXTENSIONS = [
  ".js",
  ".js.map",
  ".d.ts",
  ".d.ts.map",
  ".mjs",
  ".mjs.map",
  ".d.mts",
  ".d.mts.map",
];

const copyTemplateFiles = (
  templateDir: string,
  destDir: string,
  mainFilename: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(templateDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    yield* Effect.all(
      files
        .filter(
          (f) =>
            f !== "template.json" &&
            f !== ".env.example" &&
            !COMPILED_FILE_EXTENSIONS.some((ext) => f.endsWith(ext)),
        )
        .map((f) => {
          const destName = f === "main.mts" ? mainFilename : f;
          return fs
            .copyFile(join(templateDir, f), join(destDir, destName))
            .pipe(Effect.mapError((e) => new Error(e.message)));
        }),
      { concurrency: "unbounded" },
    );
  });

/**
 * Replace the agent factory and sandbox provider in a scaffolded main.ts.
 *
 * Templates use `codex` as the default agent factory and `docker` as the
 * default sandbox provider. When a different agent, model, or sandbox provider
 * is selected, this function rewrites the imports and factory calls.
 */
const rewriteMainTs = (
  configDir: string,
  agent: AgentEntry,
  model: string,
  sandboxProvider: SandboxProviderEntry,
  mainFilename: string,
  codexAuth: CodexAuthMode,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const mainTsPath = join(configDir, mainFilename);

    const exists = yield* fs
      .exists(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    if (!exists) return;

    let content = yield* fs
      .readFileString(mainTsPath)
      .pipe(Effect.mapError((e) => new Error(e.message)));

    // Templates use main.mts as the canonical filename in comments.
    // When the target is main.ts, rewrite those references.
    if (mainFilename === "main.ts") {
      content = content.replace(/main\.mts/g, "main.ts");
    }

    // Replace the default factory function name in imports.
    // and all factory calls with the correct model.
    // Templates always use Codex as the placeholder factory.
    content = content.replace(
      new RegExp(`\\b${TEMPLATE_AGENT_FACTORY}\\b`, "g"),
      agent.factoryImport,
    );
    // Replace model arguments in factory calls. The built-in Codex templates
    // use CODEX_MODELS references so the central model configuration remains
    // live in a default Codex scaffold.
    const factoryCallRe = new RegExp(
      `${agent.factoryImport}\\(([^)\\n]*)\\)`,
      "g",
    );
    content = content.replace(
      factoryCallRe,
      (match, modelExpression: string) => {
        const keepsConfiguredModel =
          agent.name === "codex" &&
          model === CODEX_MODELS.routine.model &&
          /^(?:[A-Za-z_$][\w$]*\.)*CODEX_MODELS\.[A-Za-z_$][\w$]*$/.test(
            modelExpression.trim(),
          );
        return keepsConfiguredModel
          ? match
          : `${agent.factoryImport}("${model}")`;
      },
    );

    // CODEX_MODELS is only needed when the generated file continues using
    // the central Codex configuration. Remove it from named imports when a
    // custom model or another provider has replaced every reference.
    if (agent.name !== "codex" || model !== CODEX_MODELS.routine.model) {
      content = content.replace(/\bCODEX_MODELS,\s*/g, "");
    }

    // ChatGPT subscription auth is stored by the host Codex CLI. Mount the
    // file into the sandbox read-only so Codex can use it without exposing an
    // API key through the generated .env file.
    if (agent.name === "codex" && codexAuth === "chatgpt") {
      content = content.replace(
        /\bdocker\(\)/g,
        `docker(${CODEX_CHATGPT_AUTH_OPTIONS})`,
      );
    }

    // Replace the sandbox provider. Templates always use `docker` as the
    // placeholder, where the registry name doubles as both the factory function
    // name and the `/sandboxes/<name>` import subpath segment. A single
    // case-sensitive word-boundary replace therefore rewrites the named import,
    // the import subpath, and every factory call site — and is a no-op when
    // docker is selected.
    content = content.replace(/\bdocker\b/g, sandboxProvider.name);

    yield* fs
      .writeFileString(mainTsPath, content)
      .pipe(Effect.mapError((e) => new Error(e.message)));
  });

/**
 * When the user opted out of the Shipyard label, strip the corresponding label
 * from all `.md` files in the scaffolded config directory so that `gh issue list`
 * commands work without a label filter.
 */
const rewritePromptFiles = (
  configDir: string,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    yield* Effect.all(
      mdFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          const content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const updated = content.replace(
            new RegExp(` --label ${PRODUCT_NAME}`, "g"),
            "",
          );
          if (updated !== content) {
            yield* fs
              .writeFileString(filePath, updated)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

/** Text file extensions eligible for `{{KEY}}` template argument substitution. */
const TEXT_FILE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".env",
  ".example",
  // Dockerfile / Containerfile have no extension — handled by name check below
]);

const isTextFile = (filename: string): boolean => {
  if (
    filename === "Dockerfile" ||
    filename === "Containerfile" ||
    filename === ".gitignore"
  )
    return true;
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return TEXT_FILE_EXTENSIONS.has(filename.slice(dotIdx));
};

/**
 * Replace `{{KEY}}` template arguments from the issue tracker's
 * `templateArgs` map in all text files in the scaffolded config directory.
 */
const substituteTemplateArgs = (
  configDir: string,
  issueTracker: IssueTrackerEntry,
): Effect.Effect<void, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const files = yield* fs
      .readDirectory(configDir)
      .pipe(Effect.mapError((e) => new Error(e.message)));
    const textFiles = files.filter(isTextFile);
    yield* Effect.all(
      textFiles.map((f) =>
        Effect.gen(function* () {
          const filePath = join(configDir, f);
          let content = yield* fs
            .readFileString(filePath)
            .pipe(Effect.mapError((e) => new Error(e.message)));
          const original = content;
          for (const [key, value] of Object.entries(
            issueTracker.templateArgs,
          )) {
            content = content.replace(
              new RegExp(`\\{\\{${key}\\}\\}`, "g"),
              value,
            );
          }
          if (content !== original) {
            yield* fs
              .writeFileString(filePath, content)
              .pipe(Effect.mapError((e) => new Error(e.message)));
          }
        }),
      ),
      { concurrency: "unbounded" },
    );
  });

// ---------------------------------------------------------------------------
// Main scaffold function
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  agent: AgentEntry;
  model: string;
  templateName?: string;
  createLabel?: boolean;
  issueTracker?: IssueTrackerEntry;
  sandboxProvider?: SandboxProviderEntry;
  codexAuth?: CodexAuthMode;
}

export interface ScaffoldResult {
  mainFilename: string;
}

/**
 * Detect whether the project's package.json has `"type": "module"`.
 * If so, we can use plain `.ts`; otherwise we use `.mts` to ensure ESM.
 */
const detectMainFilename = (
  repoDir: string,
): Effect.Effect<string, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pkgPath = join(repoDir, "package.json");
    const exists = yield* fs
      .exists(pkgPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return "main.mts";
    const content = yield* fs
      .readFileString(pkgPath)
      .pipe(Effect.orElseSucceed(() => ""));
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      return pkg["type"] === "module" ? "main.ts" : "main.mts";
    } catch {
      return "main.mts";
    }
  });

export const scaffold = (
  repoDir: string,
  options: ScaffoldOptions,
): Effect.Effect<ScaffoldResult, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const {
      agent,
      model,
      templateName = "blank",
      createLabel = true,
      issueTracker = ISSUE_TRACKER_REGISTRY[0]!, // default: github-issues
      sandboxProvider = SANDBOX_PROVIDER_REGISTRY[0]!, // default: docker
      codexAuth = "api-key",
    } = options;
    if (codexAuth === "chatgpt" && agent.name !== "codex") {
      return yield* Effect.fail(
        new Error(
          "ChatGPT subscription authentication is only supported for Codex.",
        ),
      );
    }
    const fs = yield* FileSystem.FileSystem;
    yield* assertConfigDirAvailable(repoDir);
    const configDir = join(repoDir, CONFIG_DIR);

    const mainFilename = yield* detectMainFilename(repoDir);

    yield* fs
      .makeDirectory(configDir, { recursive: false })
      .pipe(Effect.mapError((e) => new Error(e.message)));

    const templateDir = yield* getTemplateDir(templateName);

    // Build .env.example from agent + issue tracker env blocks
    const envExampleParts = [
      agent.name === "codex" && codexAuth === "chatgpt"
        ? CODEX_CHATGPT_ENV_EXAMPLE
        : agent.envExample,
    ];
    if (issueTracker.envExample) {
      envExampleParts.push(issueTracker.envExample);
    }
    const envExampleContent = envExampleParts.join("\n") + "\n";

    yield* Effect.all(
      [
        fs
          .writeFileString(
            join(configDir, sandboxProvider.containerfileName),
            agent.dockerfileTemplate,
          )
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".gitignore"), GITIGNORE)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        fs
          .writeFileString(join(configDir, ".env.example"), envExampleContent)
          .pipe(Effect.mapError((e) => new Error(e.message))),
        copyTemplateFiles(templateDir, configDir, mainFilename),
      ],
      { concurrency: "unbounded" },
    );

    // Rewrite main file with the selected agent factory, model, and sandbox provider
    yield* rewriteMainTs(
      configDir,
      agent,
      model,
      sandboxProvider,
      mainFilename,
      codexAuth,
    );

    // Replace issue tracker template arguments in all text files (must run before label stripping)
    yield* substituteTemplateArgs(configDir, issueTracker);

    // Strip the Shipyard label from prompt files when the user declined label creation
    if (!createLabel) {
      yield* rewritePromptFiles(configDir);
    }

    return { mainFilename };
  });
