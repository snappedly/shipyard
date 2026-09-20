import { describe, expect, it, vi } from "vitest";
import {
  InMemoryReleaseStore,
  ReleaseIntegration,
  type ReleaseCandidate,
  type ReleasePolicy,
} from "./index.js";

const candidate: ReleaseCandidate = {
  sourceSha: "a".repeat(40),
  reviewedHeadSha: "b".repeat(40),
  briefHash: "e".repeat(64),
  artifactDigest: `sha256:${"c".repeat(64)}`,
  artifactRef: `registry.invalid/shipyard@sha256:${"c".repeat(64)}`,
  version: "0.1.1",
};
const policy: ReleasePolicy = {
  repository: "snappedly/shipyard",
  stagingName: "configured-staging",
  productionName: "configured-production",
  requiredStagingChecks: ["smoke-check"],
  requireHumanApproval: true,
  recoveryMode: "owner-decision",
};

const verification = (
  environment: "staging" | "production",
  deploymentId: string,
) => ({
  environment,
  candidate,
  deploymentId,
  checks: [
    { name: "smoke-check", status: "passed" as const, summary: "passed" },
  ],
  smoke: "passed" as const,
  health: "passed" as const,
  recordedAt: "2026-09-17T12:00:00.000Z",
});

describe("release integration", () => {
  it("blocks production until staging and exact human approval succeed", async () => {
    const requestDeployment = vi
      .fn()
      .mockResolvedValueOnce({ deploymentId: "staging-1" })
      .mockResolvedValueOnce({ deploymentId: "production-1" });
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });
    expect((await integration.requestStaging(candidate)).outcome).toBe(
      "requested",
    );
    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "blocked",
    );
    expect(
      integration.recordStagingVerification({
        ...verification("staging", "staging-1"),
        smoke: "failed",
      }).outcome,
    ).toBe("failed");
    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "blocked",
    );

    const staged = integration.recordStagingVerification(
      verification("staging", "staging-1"),
    );
    expect(staged.outcome).toBe("verified");
    expect(
      integration.approveProduction({
        candidate,
        approval: {
          actor: { id: "maintainer", role: "maintainer" },
          approvedAt: "2026-09-17T12:00:00.000Z",
          candidate,
        },
      }).outcome,
    ).toBe("approved");
    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "requested",
    );
    expect(requestDeployment).toHaveBeenCalledTimes(2);
    expect(requestDeployment.mock.calls[0]?.[0]).toMatchObject({
      environment: "staging",
      environmentName: policy.stagingName,
      candidate,
      actor: { id: "shipyard", role: "release-coordinator" },
    });
    expect(requestDeployment.mock.calls[1]?.[0]).toMatchObject({
      environment: "production",
      environmentName: policy.productionName,
      candidate,
      actor: { id: "shipyard", role: "release-coordinator" },
    });
  });

  it("requires every configured staging check and an exact human approval", async () => {
    const requestDeployment = vi
      .fn()
      .mockResolvedValue({ deploymentId: "staging-1" });
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });

    await integration.requestStaging(candidate);
    const missing = integration.recordStagingVerification({
      ...verification("staging", "staging-1"),
      checks: [],
    });
    expect(missing.outcome).toBe("failed");
    expect(missing.reason).toContain(
      "Required staging check is missing: smoke-check",
    );
    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "blocked",
    );

    expect(
      integration.recordStagingVerification(
        verification("staging", "staging-1"),
      ).outcome,
    ).toBe("verified");
    const missingApproval = await integration.promoteProduction(candidate);
    expect(missingApproval.outcome).toBe("blocked");
    expect(missingApproval.reason).toContain(
      "exact human approval after staging",
    );
    expect(requestDeployment).toHaveBeenCalledTimes(1);
  });

  it("binds every source and artifact field to the approved candidate", async () => {
    const requestDeployment = vi
      .fn()
      .mockResolvedValueOnce({ deploymentId: "stage" })
      .mockResolvedValueOnce({ deploymentId: "production" });
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });
    await integration.requestStaging(candidate);
    integration.recordStagingVerification(verification("staging", "stage"));
    const approval = {
      actor: { id: "owner", role: "owner" as const },
      approvedAt: "2026-09-17T12:00:00.000Z",
      candidate,
    };
    integration.approveProduction({ candidate, approval });

    const changedFields = [
      ["sourceSha", "c".repeat(40)],
      ["reviewedHeadSha", "d".repeat(40)],
      ["briefHash", "different-brief"],
      ["artifactDigest", `sha256:${"d".repeat(64)}`],
      ["artifactRef", `registry.invalid/shipyard@sha256:${"d".repeat(64)}`],
      ["version", "0.1.2"],
    ] as const;
    for (const [field, value] of changedFields) {
      expect(
        (await integration.promoteProduction({ ...candidate, [field]: value }))
          .outcome,
      ).toBe("blocked");
    }

    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "requested",
    );
    expect(requestDeployment.mock.calls[0]?.[0].candidate).toEqual(candidate);
    expect(requestDeployment.mock.calls[1]?.[0].candidate).toEqual(candidate);
  });

  it("reconciles one recoverable deployment intent across retries", async () => {
    const requestDeployment = vi
      .fn()
      .mockRejectedValue(new Error("connection lost"));
    const reconcileDeployment = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ deploymentId: "staging-1" });
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment, reconcileDeployment },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });

    expect((await integration.requestStaging(candidate)).outcome).toBe(
      "failed",
    );
    expect((await integration.requestStaging(candidate)).outcome).toBe(
      "requested",
    );
    expect((await integration.requestStaging(candidate)).outcome).toBe(
      "duplicate",
    );
    expect(requestDeployment).toHaveBeenCalledTimes(1);
    expect(reconcileDeployment).toHaveBeenCalledTimes(2);
    expect(reconcileDeployment.mock.calls[0]?.[0].idempotencyKey).toBe(
      reconcileDeployment.mock.calls[1]?.[0].idempotencyKey,
    );
  });

  it("never accepts an intent marker as deployment verification", async () => {
    const store = new InMemoryReleaseStore();
    const integration = new ReleaseIntegration({
      policy,
      store,
      transport: {
        requestDeployment: async () => {
          throw new Error("transport failed");
        },
      },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });

    const request = await integration.requestStaging(candidate);
    expect(request.outcome).toBe("failed");
    const intentId = request.state?.staging?.deploymentId;
    expect(intentId).toMatch(/^intent:/);
    expect(
      integration.recordStagingVerification(verification("staging", intentId!)),
    ).toMatchObject({ outcome: "blocked" });
  });

  it("rejects malformed immutable candidate identifiers", async () => {
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment: async () => ({ deploymentId: "x" }) },
      actor: { id: "shipyard", role: "release-coordinator" },
    });

    expect(
      await integration.requestStaging({ ...candidate, sourceSha: "main" }),
    ).toMatchObject({ outcome: "blocked" });
    expect(
      await integration.requestStaging({
        ...candidate,
        artifactDigest: "latest",
      }),
    ).toMatchObject({ outcome: "blocked" });
    for (const artifactRef of [
      "registry.invalid/shipyard:latest",
      `registry.invalid/shipyard:latest?expected=${candidate.artifactDigest}`,
      `registry.invalid/shipyard@${candidate.artifactDigest}?mutable=true`,
      "npm:@snappedly-tools/shipyard@next",
      "github:snappedly/shipyard@main",
      `registry.invalid/shipyard@SHA256:${"d".repeat(64)}`,
    ]) {
      expect(
        await integration.requestStaging({ ...candidate, artifactRef }),
      ).toMatchObject({ outcome: "blocked" });
    }
    expect(
      await integration.requestStaging({
        ...candidate,
        artifactRef: "npm:@snappedly-tools/shipyard@0.1.1",
      }),
    ).toMatchObject({ outcome: "requested" });

    const custom = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment: async () => ({ deploymentId: "x" }) },
      actor: { id: "shipyard", role: "release-coordinator" },
      validateArtifactRef: (value) =>
        value.artifactRef.startsWith("provider:immutable:")
          ? undefined
          : "provider locator is mutable",
    });
    expect(
      await custom.requestStaging({
        ...candidate,
        artifactRef: "provider:immutable:artifact-42",
      }),
    ).toMatchObject({ outcome: "requested" });
  });

  it("blocks a production approval that is outside the freshness window", async () => {
    const integration = new ReleaseIntegration({
      policy: { ...policy, approvalFreshnessSeconds: 300 },
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment: async () => ({ deploymentId: "stage" }) },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:10:00.000Z",
    });
    await integration.requestStaging(candidate);
    integration.recordStagingVerification(verification("staging", "stage"));

    const approval = integration.approveProduction({
      candidate,
      approval: {
        actor: { id: "owner", role: "owner" },
        approvedAt: "2026-09-17T12:00:00.000Z",
        candidate,
      },
    });
    expect(approval.outcome).toBe("blocked");
    expect(approval.reason).toContain("approval evidence is not fresh");
  });

  it("rechecks approval freshness before production promotion", async () => {
    let now = "2026-09-17T12:00:00.000Z";
    const requestDeployment = vi.fn(async () => ({ deploymentId: "stage" }));
    const integration = new ReleaseIntegration({
      policy: { ...policy, approvalFreshnessSeconds: 300 },
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => now,
    });
    await integration.requestStaging(candidate);
    integration.recordStagingVerification(verification("staging", "stage"));
    expect(
      integration.approveProduction({
        candidate,
        approval: {
          actor: { id: "owner", role: "owner" },
          approvedAt: now,
          candidate,
        },
      }).outcome,
    ).toBe("approved");

    now = "2026-09-17T12:05:01.000Z";
    const promotion = await integration.promoteProduction(candidate);
    expect(promotion.outcome).toBe("blocked");
    expect(promotion.reason).toContain("approval evidence is not fresh");
    expect(requestDeployment).toHaveBeenCalledOnce();
  });

  it("rejects the release coordinator as a production approver", async () => {
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment: async () => ({ deploymentId: "stage" }) },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });
    await integration.requestStaging(candidate);
    integration.recordStagingVerification(verification("staging", "stage"));

    expect(
      integration.approveProduction({
        candidate,
        approval: {
          actor: { id: "shipyard", role: "release-coordinator" },
          approvedAt: "2026-09-17T12:00:00.000Z",
          candidate,
        },
      }).outcome,
    ).toBe("blocked");
  });

  it("can retry a production request after persisting its intent", async () => {
    const requestDeployment = vi
      .fn()
      .mockResolvedValueOnce({ deploymentId: "stage" })
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValueOnce({ deploymentId: "production-1" });
    const integration = new ReleaseIntegration({
      policy,
      store: new InMemoryReleaseStore(),
      transport: { requestDeployment },
      actor: { id: "shipyard", role: "release-coordinator" },
      now: () => "2026-09-17T12:00:00.000Z",
    });
    await integration.requestStaging(candidate);
    integration.recordStagingVerification(verification("staging", "stage"));
    integration.approveProduction({
      candidate,
      approval: {
        actor: { id: "owner", role: "owner" },
        approvedAt: "2026-09-17T12:00:00.000Z",
        candidate,
      },
    });

    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "failed",
    );
    expect((await integration.promoteProduction(candidate)).outcome).toBe(
      "requested",
    );
    expect(requestDeployment).toHaveBeenCalledTimes(3);
    expect(requestDeployment.mock.calls[1]?.[0].idempotencyKey).toBe(
      requestDeployment.mock.calls[2]?.[0].idempotencyKey,
    );
  });

  it.each(["rollback", "roll-forward"] as const)(
    "stops after failed production verification and records %s recovery",
    async (recoveryMode) => {
      const requestDeployment = vi
        .fn()
        .mockResolvedValueOnce({ deploymentId: "stage" })
        .mockResolvedValueOnce({ deploymentId: "production" });
      const store = new InMemoryReleaseStore();
      const integration = new ReleaseIntegration({
        policy: { ...policy, recoveryMode },
        store,
        transport: { requestDeployment },
        actor: { id: "shipyard", role: "release-coordinator" },
        now: () => "2026-09-17T12:00:00.000Z",
      });
      await integration.requestStaging(candidate);
      integration.recordStagingVerification(verification("staging", "stage"));
      integration.approveProduction({
        candidate,
        approval: {
          actor: { id: "owner", role: "owner" },
          approvedAt: "2026-09-17T12:00:00.000Z",
          candidate,
        },
      });
      await integration.promoteProduction(candidate);

      const failed = integration.recordProductionVerification({
        ...verification("production", "production"),
        checks: [{ name: "smoke-check", status: "failed", summary: "failed" }],
        smoke: "failed",
        health: "unknown",
        failureReason: "Provider health check failed",
      });
      expect(failed.outcome).toBe("failed");
      expect(
        integration.recordStagingVerification(verification("staging", "stage"))
          .outcome,
      ).toBe("blocked");
      expect((await integration.promoteProduction(candidate)).reason).toContain(
        "recovery decision is required",
      );

      const recovery = integration.recordRecovery({
        candidate,
        reason: "Production verification failed",
        authorizedBy: { id: "owner", role: "owner" },
      });
      expect(recovery).toMatchObject({
        action: recoveryMode,
        candidate,
        authorizedBy: { id: "owner", role: "owner" },
      });
      expect(store.get(failed.state!.key)?.recovery).toEqual(recovery);
      expect(
        integration.recordProductionVerification({
          ...verification("production", "production"),
          checks: [
            { name: "smoke-check", status: "passed", summary: "passed" },
          ],
        }).outcome,
      ).toBe("blocked");
    },
  );
});

it.each([
  { repository: "other/repository" },
  { productionName: "other-production" },
  { stagingName: "other-staging" },
  { approvalRoles: ["owner"] as const },
  { requiredStagingChecks: ["additional-security-check"] },
])(
  "does not reuse approval under a different release scope: %j",
  async (change) => {
    const store = new InMemoryReleaseStore();
    const requestDeployment = vi.fn(async () => ({
      deploymentId: "staging-1",
    }));
    const options = {
      policy,
      store,
      transport: { requestDeployment },
      actor: { id: "shipyard", role: "release-coordinator" as const },
      now: () => "2026-09-17T12:00:00.000Z",
    };
    const original = new ReleaseIntegration(options);
    await original.requestStaging(candidate);
    original.recordStagingVerification(verification("staging", "staging-1"));
    expect(
      original.approveProduction({
        candidate,
        approval: {
          candidate,
          actor: { id: "human", role: "maintainer" },
          approvedAt: options.now(),
        },
      }).outcome,
    ).toBe("approved");
    const other = new ReleaseIntegration({
      ...options,
      policy: { ...policy, ...change },
    });
    expect((await other.promoteProduction(candidate)).outcome).toBe("blocked");
    expect(requestDeployment).toHaveBeenCalledTimes(1);
  },
);
