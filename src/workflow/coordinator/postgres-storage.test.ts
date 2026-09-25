import { describe, expect, it, vi } from "vitest";
import {
  PostgresCoordinatorStorage,
  type PostgresQueryClient,
} from "./index.js";
import type { Assignment, WorkIdentity } from "../contracts/index.js";
import type { DispatchIntent } from "./types.js";

const identity: WorkIdentity = {
  repository: "snappedly/shipyard",
  itemId: "42",
  kind: "executable-issue",
};

const assignment: Assignment = {
  contractVersion: 1,
  id: "assignment-42",
  phase: "implementation",
  attempt: 1,
  identity,
  briefId: "snappedly/shipyard:executable-issue:42",
  briefRevision: 1,
  briefHash: "b".repeat(64),
  policyRevision: "policy-1",
  skillRevision: "skills-1",
  agentSelection: {
    provider: "selected-provider",
    model: "routine-model",
    role: "routine",
  },
  base: { branch: "main", sha: "a".repeat(40) },
  createdAt: "2026-09-17T12:00:00.000Z",
};

const dispatch: DispatchIntent = {
  id: "dispatch-42",
  dedupeKey: "issue-42-implementation",
  jobId: "job-42",
  key: {
    repository: identity.repository,
    itemId: identity.itemId,
    briefRevision: assignment.briefRevision,
    phase: assignment.phase,
    relevantRevision: assignment.base.sha,
  },
  status: "pending",
  assignment,
  createdAt: assignment.createdAt,
  updatedAt: assignment.createdAt,
};

const persistDispatch = async (input: DispatchIntent) => {
  let persistedAssignment: unknown;
  const query: PostgresQueryClient["query"] = async <
    Row extends Record<string, unknown>,
  >(
    text: string,
    values?: readonly unknown[],
  ) => {
    if (!text.startsWith("INSERT INTO shipyard_dispatches"))
      return { rows: [] };
    persistedAssignment = JSON.parse(String(values?.[9])) as unknown;
    return {
      rows: [
        {
          id: input.id,
          dedupe_key: input.dedupeKey,
          job_id: input.jobId,
          repository: input.key.repository,
          item_id: input.key.itemId,
          brief_revision: input.key.briefRevision,
          phase: input.key.phase,
          relevant_revision: input.key.relevantRevision,
          status: input.status,
          assignment: persistedAssignment,
          worker_id: null,
          claimed_at: null,
          claim_expires_at: null,
          error: null,
          created_at: input.createdAt,
          updated_at: input.updatedAt,
        } as unknown as Row,
      ],
    };
  };
  const storage = new PostgresCoordinatorStorage({ client: { query } });
  const result = await storage.transaction((transaction) =>
    transaction.insertDispatchIfAbsent(input),
  );

  return { ...result, persistedAssignment };
};

describe("PostgresCoordinatorStorage", () => {
  it("loads persisted assignments with their selected provider and model", async () => {
    const result = await persistDispatch(dispatch);

    expect(result.persistedAssignment).toEqual(assignment);
    expect(result.dispatch.assignment).toEqual(assignment);
  });

  it("loads legacy assignments without a persisted model selection", async () => {
    const { agentSelection: _agentSelection, ...legacyAssignment } = assignment;
    const result = await persistDispatch({
      ...dispatch,
      assignment: legacyAssignment as Assignment,
    });

    expect(result.persistedAssignment).toEqual(legacyAssignment);
    expect(result.dispatch.assignment).toEqual(legacyAssignment);
  });

  it("wraps coordinator operations in a transaction and releases pooled clients", async () => {
    const query = vi.fn(
      async (_text: string, _values?: readonly unknown[]) => ({
        rows: [],
      }),
    );
    const release = vi.fn();
    const client: PostgresQueryClient & {
      connect: () => Promise<{ query: typeof query; release: typeof release }>;
    } = {
      query,
      connect: async () => ({ query, release }),
    };
    const storage = new PostgresCoordinatorStorage({ client });

    await expect(storage.transaction(async () => "ok")).resolves.toBe("ok");
    expect(query.mock.calls.map(([text]) => text)).toEqual(["BEGIN", "COMMIT"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and preserves the operation error", async () => {
    const query = vi.fn(async (_text: string) => ({ rows: [] }));
    const storage = new PostgresCoordinatorStorage({ client: { query } });
    const failure = new Error("operation failed");

    await expect(
      storage.transaction(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN",
      "ROLLBACK",
    ]);
  });

  it("locks mutable jobs and absent lease resources inside the transaction", async () => {
    const query = vi.fn(
      async (_text: string, _values?: readonly unknown[]) => ({
        rows: [],
      }),
    );
    const storage = new PostgresCoordinatorStorage({ client: { query } });

    await storage.transaction(async (transaction) => {
      expect(await transaction.getJob("missing")).toBeUndefined();
      await transaction.lockLeaseResource("snappedly/shipyard", "main");
    });

    const statements = query.mock.calls.map(([text]) => text);
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements[2]).toContain("pg_advisory_xact_lock");
    expect(query.mock.calls[2]?.[1]).toEqual(["snappedly/shipyard\u0000main"]);
  });
});
