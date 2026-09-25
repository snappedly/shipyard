import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryPolicy,
  type RepositoryPolicy,
  type RevisionReference,
} from "../contracts/index.js";
import {
  InMemoryTriageStore,
  runTriage,
  type TriageAssessment,
  type TriageInvestigator,
  type TriageSource,
  type TriageStore,
} from "./index.js";

const repository = "snappedly/shipyard";
const base: RevisionReference = { branch: "main", sha: "a".repeat(40) };
const policy: RepositoryPolicy = createRepositoryPolicy({
  repository,
  revision: "policy-1",
  baseBranch: "main",
  issueClosure: "merge-and-ci",
  authorization: {
    required: true,
    allowedActors: ["maintainer"],
    autoStartRisk: ["low"],
  },
  worker: {
    provider: "fixture",
    model: "fixture",
    sandbox: "fixture",
    skillRevision: "skills-1",
  },
  checks: [{ name: "typecheck", command: "npm run typecheck", required: true }],
  phaseBudgets: {
    triage: { maxAttempts: 1, timeoutSeconds: 60 },
    implementation: { maxAttempts: 1, timeoutSeconds: 60 },
    checking: { maxAttempts: 1, timeoutSeconds: 60 },
    review: { maxAttempts: 1, timeoutSeconds: 60 },
    repair: { maxAttempts: 1, timeoutSeconds: 60 },
    handoff: { maxAttempts: 1, timeoutSeconds: 60 },
    merge: { maxAttempts: 1, timeoutSeconds: 60 },
    "release-verification": { maxAttempts: 1, timeoutSeconds: 60 },
  },
  repairBudget: { maxBatches: 1, maxFollowUps: 1 },
});

const source = (overrides: Partial<TriageSource> = {}): TriageSource => ({
  provider: "github",
  repository,
  itemId: "42",
  title: "Add bounded intake",
  body: "The intake should preserve the source and return a result.",
  author: "reporter",
  url: `https://github.com/${repository}/issues/42`,
  updatedAt: "2026-09-17T12:00:00.000Z",
  ...overrides,
});

const assessment = (
  overrides: Partial<TriageAssessment> = {},
): TriageAssessment => ({
  category: "enhancement",
  evidence: ["The request describes a bounded change."],
  relevantFiles: ["src/workflow/triage/index.ts"],
  acceptanceCriteria: ["The source is retained in the resulting brief."],
  exclusions: ["No external activation."],
  risk: "low",
  verification: ["npm run typecheck"],
  unresolvedQuestions: [],
  requirementsConfirmed: true,
  ...overrides,
});

const run = async (
  inputSource: TriageSource,
  investigator: TriageInvestigator,
  store: TriageStore = new InMemoryTriageStore(),
) =>
  runTriage({
    source: inputSource,
    policy,
    base,
    store,
    investigator,
  });

describe("workflow triage", () => {
  it("classifies a clear bug and enhancement without authorizing from source prose", async () => {
    const investigator = vi.fn(
      async ({ source: item }: { source: TriageSource }) =>
        assessment({
          category: item.title.startsWith("Fix") ? "bug" : "enhancement",
        }),
    );

    const bug = await run(source({ title: "Fix intake crash" }), investigator);
    const enhancement = await run(source({ itemId: "43" }), investigator);

    expect(bug.outcome).toBe("completed");
    expect(bug.category).toBe("bug");
    expect(bug.brief?.authorization.status).toBe("pending");
    expect(bug.brief?.evidence).toContain(
      "The request describes a bounded change.",
    );
    expect(enhancement.outcome).toBe("completed");
    expect(enhancement.category).toBe("enhancement");
    expect(investigator).toHaveBeenCalledTimes(2);
  });

  it("returns one clarification request and resumes the same item", async () => {
    const store = new InMemoryTriageStore();
    const investigator = vi
      .fn<() => Promise<TriageAssessment>>()
      .mockResolvedValueOnce(
        assessment({
          requirementsConfirmed: false,
          acceptanceCriteria: [],
          unresolvedQuestions: ["Which user-visible behavior should change?"],
        }),
      )
      .mockResolvedValue(
        assessment({
          evidence: ["The reporter answered the behavior question."],
        }),
      );

    const first = await run(source(), investigator, store);
    const replay = await run(source(), investigator, store);
    expect(first.outcome).toBe("needs-info");
    expect(first.questions).toEqual([
      "Which user-visible behavior should change?",
    ]);
    expect(replay.questions).toEqual(first.questions);
    expect(investigator).toHaveBeenCalledOnce();

    const resumed = await runTriage({
      source: source(),
      policy,
      base,
      store,
      investigator,
      clarificationReply: {
        id: "comment-1",
        body: "Change the issue-to-brief transition.",
        author: "reporter",
        updatedAt: "2026-09-17T12:01:00.000Z",
      },
    });
    expect(resumed.outcome).toBe("completed");
    expect(resumed.brief?.revision).toBe(2);

    const replyReplay = await runTriage({
      source: source(),
      policy,
      base,
      store,
      investigator,
      clarificationReply: {
        id: "comment-1",
        body: "Change the issue-to-brief transition.",
        author: "reporter",
        updatedAt: "2026-09-17T12:01:00.000Z",
      },
    });
    expect(replyReplay.record.id).toBe(resumed.record.id);
    expect(investigator).toHaveBeenCalledTimes(2);
  });

  it("routes duplicates and sensitive reports without echoing private source content", async () => {
    const duplicate = await run(source({ body: "private duplicate details" }), {
      investigate: async () =>
        assessment({ category: "duplicate", duplicateOf: "7" }),
    });
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.publicMessage).toContain("#7");
    expect(duplicate.publicMessage).not.toContain("private duplicate details");

    const sensitive = await run(
      source({ body: "private token=super-secret" }),
      {
        investigate: async () =>
          assessment({
            category: "sensitive",
            sensitiveReason: "The report may contain a credential.",
          }),
      },
    );
    expect(sensitive.outcome).toBe("sensitive");
    expect(sensitive.publicMessage).not.toContain("super-secret");
  });

  it("excludes planning and repair work from ordinary implementation triage", async () => {
    const investigator: TriageInvestigator = {
      investigate: async () => assessment({ category: "enhancement" }),
    };
    const planning = await run(
      source({ itemId: "100", kind: "planning-spec" }),
      investigator,
    );
    const repair = await run(
      source({ itemId: "101", kind: "pr-repair" }),
      investigator,
    );

    expect(planning.outcome).toBe("blocked");
    expect(planning.brief?.identity.kind).toBe("planning-spec");
    expect(repair.outcome).toBe("blocked");
    expect(repair.brief?.identity.kind).toBe("pr-repair");
  });

  it("increments the brief revision when source facts change", async () => {
    const store = new InMemoryTriageStore();
    const investigator: TriageInvestigator = {
      investigate: async () => assessment(),
    };
    const first = await run(source(), investigator, store);
    const revised = await run(
      source({
        body: "The acceptance behavior is now explicitly different.",
        updatedAt: "2026-09-17T12:02:00.000Z",
      }),
      investigator,
      store,
    );

    expect(first.brief?.revision).toBe(1);
    expect(revised.brief?.revision).toBe(2);
    expect(revised.brief?.source.originalBody).toContain(
      "explicitly different",
    );
  });

  it("holds ambiguous source edits and resumes a queued reply on a newer snapshot", async () => {
    const store = new InMemoryTriageStore();
    const receivedReplies: string[] = [];
    const investigator: TriageInvestigator = async ({ clarificationReply }) => {
      if (clarificationReply !== undefined) {
        receivedReplies.push(clarificationReply.body);
      }
      return assessment({
        evidence: [clarificationReply?.body ?? "Initial assessment."],
      });
    };
    const first = await run(source(), investigator, store);
    const conflictingSource = source({ body: "A concurrent source edit." });
    const conflict = await run(conflictingSource, investigator, store);

    expect(conflict.outcome).toBe("blocked");
    expect(conflict.brief).toBeUndefined();
    expect(conflict.record.source.body).toBe(source().body);
    expect(conflict.record.sourceConflict).toBeDefined();

    const reply = {
      id: "comment-conflict",
      body: "Please retain the new source behavior.",
      author: "reporter",
      updatedAt: "2026-09-17T12:01:00.000Z",
    };
    const unresolved = await runTriage({
      source: conflictingSource,
      policy,
      base,
      store,
      investigator,
      clarificationReply: reply,
    });
    expect(unresolved.record.pendingClarificationReplies).toEqual([reply]);

    const resumed = await runTriage({
      source: source({
        body: conflictingSource.body,
        updatedAt: "2026-09-17T12:02:00.000Z",
      }),
      policy,
      base,
      store,
      investigator,
    });

    expect(resumed.outcome).toBe("completed");
    expect(resumed.record.sourceConflict).toBeUndefined();
    expect(resumed.record.clarificationIds).toContain(reply.id);
    expect(resumed.record.pendingClarificationReplies).toBeUndefined();
    expect(receivedReplies).toEqual([reply.body]);
    expect(first.record.id).toBe(resumed.record.id);
  });

  it("retries triage after a compare-and-save conflict", async () => {
    const backingStore = new InMemoryTriageStore();
    let rejectFirstWrite = true;
    const compareAndSave = vi.fn(
      (
        record: Parameters<TriageStore["compareAndSave"]>[0],
        revision: number | undefined,
      ) => {
        if (rejectFirstWrite) {
          rejectFirstWrite = false;
          return false;
        }
        return backingStore.compareAndSave(record, revision);
      },
    );
    const store: TriageStore = {
      get: (sourceKey) => backingStore.get(sourceKey),
      compareAndSave,
    };

    const result = await run(
      source(),
      {
        investigate: async () => assessment(),
      },
      store,
    );

    expect(result.outcome).toBe("completed");
    expect(compareAndSave).toHaveBeenCalledTimes(2);
    expect(backingStore.get(result.record.sourceKey)?.revision).toBe(1);
  });
});
