import type { WorkIdentity } from "../contracts/index.js";
import type {
  DeliveryDependency,
  DeliveryGroup,
  DeliveryKey,
  DeliveryMode,
  DeliveryRecord,
  DeliveryPullRequestReference,
  SpecChildCheckpoint,
  SpecDeliveryCheckpoint,
} from "./types.js";

export interface ResolveDeliveryGroupInput {
  readonly issue: WorkIdentity;
  readonly parent?: WorkIdentity;
  readonly children?: readonly WorkIdentity[];
  readonly dependencies?: readonly DeliveryDependency[];
}

const nonEmpty = (value: string, path: string): string => {
  if (value.trim().length === 0) throw new Error(`${path} must be non-empty`);
  return value;
};

export const deliveryIdFor = (key: DeliveryKey): string =>
  `${nonEmpty(key.repository, "delivery.repository")}#${nonEmpty(key.itemId, "delivery.itemId")}`;

export const deliveryResourceKey = (key: DeliveryKey): string =>
  `${key.repository}\u0000${key.itemId}`;

const sameIdentity = (left: WorkIdentity, right: WorkIdentity): boolean =>
  left.repository === right.repository &&
  left.itemId === right.itemId &&
  left.kind === right.kind;

const compareIdentity = (left: WorkIdentity, right: WorkIdentity): number =>
  left.itemId.localeCompare(right.itemId, undefined, { numeric: true }) ||
  left.kind.localeCompare(right.kind);

const uniqueIdentities = (
  identities: readonly WorkIdentity[],
  repository: string,
): WorkIdentity[] => {
  const byItem = new Map<string, WorkIdentity>();
  for (const identity of identities) {
    if (identity.repository !== repository) {
      throw new Error("Delivery graph items must use the delivery repository");
    }
    const existing = byItem.get(identity.itemId);
    if (existing !== undefined && !sameIdentity(existing, identity)) {
      throw new Error(
        `Delivery graph item ${identity.itemId} has conflicting kinds`,
      );
    }
    byItem.set(identity.itemId, identity);
  }
  return [...byItem.values()].sort(compareIdentity);
};

const normalizeDependencies = (
  dependencies: readonly DeliveryDependency[] | undefined,
  children: readonly WorkIdentity[],
): DeliveryDependency[] => {
  const childIds = new Set(children.map((child) => child.itemId));
  const byItem = new Map<string, Set<string>>();
  for (const dependency of dependencies ?? []) {
    nonEmpty(dependency.itemId, "delivery dependency.itemId");
    if (!childIds.has(dependency.itemId)) {
      throw new Error(
        `Delivery dependency item ${dependency.itemId} is not a child in the delivery graph`,
      );
    }
    const dependsOn = byItem.get(dependency.itemId) ?? new Set<string>();
    for (const dependencyId of dependency.dependsOn) {
      nonEmpty(dependencyId, "delivery dependency.dependsOn");
      if (dependencyId === dependency.itemId) {
        throw new Error(
          `Delivery dependency ${dependency.itemId} cannot depend on itself`,
        );
      }
      if (!childIds.has(dependencyId)) {
        throw new Error(
          `Delivery dependency target ${dependencyId} is not a child in the delivery graph`,
        );
      }
      dependsOn.add(dependencyId);
    }
    byItem.set(dependency.itemId, dependsOn);
  }
  return [...byItem.entries()]
    .map(([itemId, dependsOn]) => ({
      itemId,
      dependsOn: [...dependsOn].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      ),
    }))
    .sort((left, right) =>
      left.itemId.localeCompare(right.itemId, undefined, { numeric: true }),
    );
};

const assertAcyclic = (dependencies: readonly DeliveryDependency[]): void => {
  const graph = new Map(
    dependencies.map((dependency) => [dependency.itemId, dependency.dependsOn]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string): void => {
    if (visited.has(itemId)) return;
    if (visiting.has(itemId)) {
      throw new Error(
        `Delivery graph contains a dependency cycle at ${itemId}`,
      );
    }
    visiting.add(itemId);
    for (const dependencyId of graph.get(itemId) ?? []) visit(dependencyId);
    visiting.delete(itemId);
    visited.add(itemId);
  };
  for (const itemId of graph.keys()) visit(itemId);
};

const modeFor = (root: WorkIdentity): DeliveryMode =>
  root.kind === "planning-spec" ? "planning-spec" : "standalone";

export const resolveDeliveryGroup = (
  input: ResolveDeliveryGroupInput,
): DeliveryGroup => {
  const issue = input.issue;
  nonEmpty(issue.repository, "issue.repository");
  nonEmpty(issue.itemId, "issue.itemId");

  const root = input.parent ?? issue;
  if (root.repository !== issue.repository) {
    throw new Error("Delivery parent must use the issue repository");
  }
  if (input.parent !== undefined && root.kind !== "planning-spec") {
    throw new Error("Only a planning spec can own a child delivery");
  }
  if (input.parent !== undefined && issue.kind === "planning-spec") {
    throw new Error("A planning spec cannot be a child of a delivery");
  }

  const mode = modeFor(root);
  const children = uniqueIdentities(
    mode === "planning-spec"
      ? [issue, ...(input.children ?? [])]
      : (input.children ?? []),
    root.repository,
  ).filter((child) => child.itemId !== root.itemId);
  if (mode === "standalone" && children.length > 0) {
    throw new Error("Standalone deliveries cannot contain child issues");
  }
  if (
    mode === "planning-spec" &&
    children.some((child) => child.kind === "planning-spec")
  ) {
    throw new Error(
      "A planning-spec delivery cannot dispatch another planning spec",
    );
  }

  const key: DeliveryKey = {
    repository: root.repository,
    itemId: root.itemId,
  };
  const graph = {
    root,
    children,
    dependencies: normalizeDependencies(input.dependencies, children),
  };
  assertAcyclic(graph.dependencies);
  return {
    key,
    id: deliveryIdFor(key),
    mode,
    root,
    graph,
  };
};

export const defaultDeliveryGroup = (identity: WorkIdentity): DeliveryGroup =>
  resolveDeliveryGroup({ issue: identity });

export const deliveryContainsIdentity = (
  delivery: DeliveryGroup,
  identity: WorkIdentity,
): boolean => {
  if (delivery.root.repository !== identity.repository) return false;
  if (sameIdentity(delivery.root, identity)) return true;
  return delivery.graph.children.some((child) => sameIdentity(child, identity));
};

export const parseDeliveryRecord = (value: unknown): DeliveryRecord => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored delivery must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const key = candidate.key;
  const root = candidate.root;
  const graph = candidate.graph;
  if (
    typeof key !== "object" ||
    key === null ||
    Array.isArray(key) ||
    typeof root !== "object" ||
    root === null ||
    Array.isArray(root) ||
    typeof graph !== "object" ||
    graph === null ||
    Array.isArray(graph)
  ) {
    throw new Error("Stored delivery has invalid routing data");
  }
  const keyRecord = key as Record<string, unknown>;
  const rootRecord = root as Record<string, unknown>;
  const graphRecord = graph as Record<string, unknown>;
  const identity = (value: unknown, path: string): WorkIdentity => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    const record = value as Record<string, unknown>;
    const repository = record.repository;
    const itemId = record.itemId;
    const kind = record.kind;
    if (
      typeof repository !== "string" ||
      typeof itemId !== "string" ||
      !["planning-spec", "executable-issue", "pr-repair"].includes(
        kind as string,
      )
    ) {
      throw new Error(`${path} is not a work identity`);
    }
    return {
      repository,
      itemId,
      kind: kind as WorkIdentity["kind"],
    };
  };
  const revision = (
    value: unknown,
    path: string,
  ): { branch: string; sha: string } => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.branch !== "string" ||
      record.branch.trim().length === 0 ||
      typeof record.sha !== "string" ||
      record.sha.trim().length === 0
    ) {
      throw new Error(`${path} is not a revision reference`);
    }
    return { branch: record.branch, sha: record.sha };
  };
  const pullRequest = (
    value: unknown,
    path: string,
  ): DeliveryPullRequestReference => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      record.id.trim().length === 0 ||
      typeof record.baseBranch !== "string" ||
      record.baseBranch.trim().length === 0 ||
      typeof record.headBranch !== "string" ||
      record.headBranch.trim().length === 0 ||
      typeof record.draft !== "boolean"
    ) {
      throw new Error(`${path} is not a pull request reference`);
    }
    return {
      id: record.id,
      baseBranch: record.baseBranch,
      headBranch: record.headBranch,
      draft: record.draft,
    };
  };
  const rootIdentity = identity(rootRecord, "delivery.root");
  const children = Array.isArray(graphRecord.children)
    ? graphRecord.children.map((child, index) =>
        identity(child, `delivery.graph.children[${index}]`),
      )
    : [];
  const dependencies = Array.isArray(graphRecord.dependencies)
    ? graphRecord.dependencies.map((dependency, index) => {
        if (
          typeof dependency !== "object" ||
          dependency === null ||
          Array.isArray(dependency)
        ) {
          throw new Error(`delivery.graph.dependencies[${index}] is invalid`);
        }
        const record = dependency as Record<string, unknown>;
        if (
          typeof record.itemId !== "string" ||
          !Array.isArray(record.dependsOn) ||
          !record.dependsOn.every((item) => typeof item === "string")
        ) {
          throw new Error(`delivery.graph.dependencies[${index}] is invalid`);
        }
        return {
          itemId: record.itemId,
          dependsOn: record.dependsOn as string[],
        };
      })
    : [];
  const normalized = resolveDeliveryGroup({
    issue: rootIdentity,
    children,
    dependencies,
  });
  const repository = keyRecord.repository;
  const itemId = keyRecord.itemId;
  if (typeof repository !== "string" || typeof itemId !== "string") {
    throw new Error("Stored delivery key is invalid");
  }
  if (
    normalized.key.repository !== repository ||
    normalized.key.itemId !== itemId
  ) {
    throw new Error("Stored delivery key does not match its root");
  }
  const createdAt = candidate.createdAt;
  const updatedAt = candidate.updatedAt;
  const version = candidate.version;
  if (
    typeof createdAt !== "string" ||
    typeof updatedAt !== "string" ||
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw new Error("Stored delivery metadata is invalid");
  }
  const mergedAt = candidate.mergedAt;
  const mergedSha = candidate.mergedSha;
  if (
    (mergedAt !== undefined && typeof mergedAt !== "string") ||
    (mergedSha !== undefined && typeof mergedSha !== "string") ||
    (mergedAt === undefined) !== (mergedSha === undefined)
  ) {
    throw new Error("Stored delivery merge metadata is invalid");
  }
  let specCheckpoint: SpecDeliveryCheckpoint | undefined;
  if (candidate.specCheckpoint !== undefined) {
    const rawCheckpoint = candidate.specCheckpoint;
    if (
      typeof rawCheckpoint !== "object" ||
      rawCheckpoint === null ||
      Array.isArray(rawCheckpoint)
    ) {
      throw new Error("Stored spec delivery checkpoint must be an object");
    }
    const checkpoint = rawCheckpoint as Record<string, unknown>;
    if (!Array.isArray(checkpoint.children)) {
      throw new Error(
        "Stored spec delivery checkpoint children must be an array",
      );
    }
    const checkpointPullRequest =
      checkpoint.pullRequest === undefined
        ? undefined
        : pullRequest(checkpoint.pullRequest, "specCheckpoint.pullRequest");
    const completedIds = new Set<string>();
    const checkpointChildren: SpecChildCheckpoint[] = checkpoint.children.map(
      (item, index) => {
        const path = `specCheckpoint.children[${index}]`;
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
          throw new Error(`${path} must be an object`);
        }
        const childRecord = item as Record<string, unknown>;
        const child = identity(childRecord.child, `${path}.child`);
        if (
          !normalized.graph.children.some((entry) => sameIdentity(entry, child))
        ) {
          throw new Error(`${path}.child is outside the delivery graph`);
        }
        if (completedIds.has(child.itemId)) {
          throw new Error(`${path}.child is duplicated`);
        }
        completedIds.add(child.itemId);
        const statuses = [
          "working",
          "integrating",
          "publishing",
          "verifying",
          "closing",
          "closed",
        ];
        if (
          typeof childRecord.status !== "string" ||
          !statuses.includes(childRecord.status)
        ) {
          throw new Error(`${path}.status is invalid`);
        }
        const status = childRecord.status as SpecChildCheckpoint["status"];
        const workerBase =
          childRecord.workerBase === undefined
            ? undefined
            : revision(childRecord.workerBase, `${path}.workerBase`);
        const sourceCommit =
          childRecord.sourceCommit === undefined
            ? undefined
            : revision(childRecord.sourceCommit, `${path}.sourceCommit`);
        const rawCandidate = childRecord.candidate;
        let candidate: SpecChildCheckpoint["candidate"] | undefined;
        if (rawCandidate !== undefined) {
          if (
            typeof rawCandidate !== "object" ||
            rawCandidate === null ||
            Array.isArray(rawCandidate)
          ) {
            throw new Error(`${path}.candidate must be an object`);
          }
          const candidateRecord = rawCandidate as Record<string, unknown>;
          if (
            typeof candidateRecord.deliveryId !== "string" ||
            typeof candidateRecord.briefHash !== "string"
          ) {
            throw new Error(`${path}.candidate identity is invalid`);
          }
          candidate = {
            deliveryId: candidateRecord.deliveryId,
            briefHash: candidateRecord.briefHash,
            base: revision(candidateRecord.base, `${path}.candidate.base`),
            head: revision(candidateRecord.head, `${path}.candidate.head`),
            pullRequest: pullRequest(
              candidateRecord.pullRequest,
              `${path}.candidate.pullRequest`,
            ),
          };
        }
        let verification: SpecChildCheckpoint["verification"];
        if (childRecord.verification !== undefined) {
          if (
            typeof childRecord.verification !== "object" ||
            childRecord.verification === null ||
            Array.isArray(childRecord.verification)
          ) {
            throw new Error(`${path}.verification must be an object`);
          }
          const rawVerification = childRecord.verification as Record<
            string,
            unknown
          >;
          const cleanup = rawVerification.cleanup;
          if (
            !Array.isArray(rawVerification.checks) ||
            !rawVerification.checks.every(
              (check) =>
                typeof check === "object" &&
                check !== null &&
                typeof (check as Record<string, unknown>).name === "string" &&
                typeof (check as Record<string, unknown>).command ===
                  "string" &&
                (check as Record<string, unknown>).status === "passed" &&
                typeof (check as Record<string, unknown>).summary === "string",
            ) ||
            typeof cleanup !== "object" ||
            cleanup === null ||
            (cleanup as Record<string, unknown>).status !== "passed" ||
            typeof (cleanup as Record<string, unknown>).summary !== "string" ||
            !Array.isArray(rawVerification.evidence) ||
            !rawVerification.evidence.every(
              (entry) => typeof entry === "string",
            )
          ) {
            throw new Error(`${path}.verification is invalid`);
          }
          verification = {
            checks: rawVerification.checks as NonNullable<
              SpecChildCheckpoint["verification"]
            >["checks"],
            cleanup: {
              status: "passed",
              summary: (cleanup as Record<string, unknown>).summary as string,
            },
            evidence: rawVerification.evidence as string[],
          };
        }
        const closedAt = childRecord.closedAt;
        if (closedAt !== undefined && typeof closedAt !== "string") {
          throw new Error(`${path}.closedAt must be a string`);
        }
        if (
          workerBase === undefined ||
          ([
            "integrating",
            "publishing",
            "verifying",
            "closing",
            "closed",
          ].includes(status) &&
            sourceCommit === undefined) ||
          (["publishing", "verifying", "closing", "closed"].includes(status) &&
            candidate === undefined) ||
          (["closing", "closed"].includes(status) &&
            verification === undefined) ||
          (status === "closed" && typeof closedAt !== "string")
        ) {
          throw new Error(`${path} is missing state required by ${status}`);
        }
        return {
          child,
          status,
          workerBase,
          sourceCommit,
          candidate,
          verification,
          ...(closedAt === undefined ? {} : { closedAt }),
        };
      },
    );
    const currentHead =
      checkpoint.currentHead === undefined
        ? undefined
        : revision(checkpoint.currentHead, "specCheckpoint.currentHead");
    if (
      checkpointChildren.some((child) =>
        ["publishing", "verifying", "closing", "closed"].includes(child.status),
      ) &&
      checkpointPullRequest === undefined
    ) {
      throw new Error("Spec child progress has no pull request identity");
    }
    if (
      checkpointPullRequest !== undefined &&
      currentHead !== undefined &&
      currentHead.branch !== checkpointPullRequest.headBranch
    ) {
      throw new Error("Spec checkpoint head does not match its pull request");
    }
    for (const child of checkpointChildren) {
      if (
        child.candidate !== undefined &&
        (child.candidate.deliveryId !== normalized.id ||
          child.candidate.briefHash.trim().length === 0 ||
          checkpointPullRequest === undefined ||
          child.candidate.base.branch !== checkpointPullRequest.baseBranch ||
          child.candidate.pullRequest.id !== checkpointPullRequest.id ||
          child.candidate.pullRequest.baseBranch !==
            checkpointPullRequest.baseBranch ||
          child.candidate.pullRequest.headBranch !==
            checkpointPullRequest.headBranch ||
          child.candidate.pullRequest.draft !== checkpointPullRequest.draft ||
          child.candidate.head.branch !== checkpointPullRequest.headBranch ||
          (child.sourceCommit !== undefined &&
            child.sourceCommit.branch === checkpointPullRequest.headBranch))
      ) {
        throw new Error(
          `Spec child ${child.child.itemId} candidate is inconsistent`,
        );
      }
    }
    specCheckpoint = {
      pullRequest: checkpointPullRequest,
      currentHead,
      children: checkpointChildren,
    };
  }
  return {
    ...normalized,
    createdAt,
    updatedAt,
    version,
    ...(specCheckpoint === undefined ? {} : { specCheckpoint }),
    ...(mergedAt === undefined
      ? {}
      : { mergedAt, mergedSha: mergedSha as string }),
  };
};

export const deliveryGroupFingerprint = (delivery: DeliveryGroup): string =>
  JSON.stringify(delivery);
