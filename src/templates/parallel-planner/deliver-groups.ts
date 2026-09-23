/**
 * Route generated planner output to the canonical delivery coordinators.
 *
 * The callbacks own the full standalone or spec lifecycle. This module only
 * runs unrelated groups concurrently and reports their durable outcomes.
 *
 */
export interface DeliveryRouterResult {
  readonly outcome?: string;
}

export interface PlannedDeliveryGroup {
  readonly id: string;
  readonly repository: string;
  readonly mode: "standalone" | "planning-spec";
  readonly root: { readonly id: string; readonly title: string };
  children: {
    id: string;
    title: string;
    dependsOn: string[];
  }[];
  readonly integrationBranch: string;
  readonly activationIssueId?: string;
}

export interface ActivatedDeliveryRoute {
  readonly activatedIssue: { readonly number: number };
  readonly root: { readonly number: number; readonly title: string };
  readonly mode: "standalone" | "planning-spec";
  children: {
    id: string;
    title: string;
    dependsOn: string[];
  }[];
}

/** Try the planned root, then its listed children, until one is actually activated. */
export const findActivatedDeliveryRoute = async (
  planned: PlannedDeliveryGroup,
  readActivated: (
    issueNumber: number,
  ) => Promise<ActivatedDeliveryRoute | undefined>,
): Promise<ActivatedDeliveryRoute | undefined> => {
  const seen = new Set<number>();
  for (const id of [
    planned.root.id,
    ...planned.children.map((child) => child.id),
  ]) {
    if (!/^[1-9]\d*$/.test(id)) continue;
    const issueNumber = Number(id);
    if (seen.has(issueNumber)) continue;
    seen.add(issueNumber);
    const route = await readActivated(issueNumber);
    if (route !== undefined) return route;
  }
  return undefined;
};

/** Replace planner guesses with the activated issue's authoritative delivery graph. */
export const canonicalizeActivatedGroup = (
  planned: PlannedDeliveryGroup,
  route: ActivatedDeliveryRoute,
  resolveId: (group: PlannedDeliveryGroup) => string,
): PlannedDeliveryGroup => {
  const root = { id: String(route.root.number), title: route.root.title };
  const group: PlannedDeliveryGroup = {
    ...planned,
    mode: route.mode,
    root,
    children:
      route.mode === "planning-spec"
        ? route.children.map((child) => ({
            ...child,
            dependsOn: [...child.dependsOn],
          }))
        : [{ id: root.id, title: root.title, dependsOn: [] }],
    integrationBranch:
      route.mode === "planning-spec"
        ? `shipyard/spec-${root.id}`
        : `shipyard/issue-${root.id}`,
    activationIssueId: String(route.activatedIssue.number),
  };
  return { ...group, id: resolveId(group) };
};

export interface DeliveryRouterInput<
  Planned,
  Group,
  Delivery,
  StandaloneResult,
  SpecResult,
> {
  readonly groups: readonly Planned[];
  readonly hydrate: (group: Planned) => Promise<Group> | Group;
  readonly resolve: (group: Group) => Delivery;
  readonly deliverStandalone: (input: {
    readonly group: Group;
    readonly delivery: Delivery;
  }) => Promise<StandaloneResult>;
  readonly deliverSpec: (input: {
    readonly group: Group;
    readonly delivery: Delivery;
  }) => Promise<SpecResult>;
}

export const deliverPlannedGroups = async <
  Planned,
  Group extends { readonly mode: string },
  Delivery extends { readonly id: string; readonly mode: string },
  StandaloneResult extends DeliveryRouterResult,
  SpecResult extends DeliveryRouterResult,
>(
  input: DeliveryRouterInput<
    Planned,
    Group,
    Delivery,
    StandaloneResult,
    SpecResult
  >,
) => {
  const { groups, hydrate, resolve, deliverStandalone, deliverSpec } = input;
  if (groups.length === 0) {
    return { outcome: "no-work", groups: [] };
  }

  const prepared = await Promise.allSettled(
    groups.map(async (planned) => {
      const group = await hydrate(planned);
      const delivery = resolve(group);
      return { group, delivery };
    }),
  );
  const results: unknown[] = new Array(groups.length);
  const seen = new Set<string>();
  const unique: {
    readonly index: number;
    readonly group: Group;
    readonly delivery: Delivery;
  }[] = [];
  prepared.forEach((entry, index) => {
    if (entry.status === "rejected") {
      results[index] = { outcome: "blocked", reason: String(entry.reason) };
      return;
    }
    const { group, delivery } = entry.value;
    if (seen.has(delivery.id)) {
      results[index] = { outcome: "already-routed", group, delivery };
      return;
    }
    seen.add(delivery.id);
    unique.push({ index, group, delivery });
  });

  const settled = await Promise.allSettled(
    unique.map(async ({ index, group, delivery }) => {
      const deliver =
        delivery.mode === "planning-spec" ? deliverSpec : deliverStandalone;
      const result = await deliver({ group, delivery });
      return { index, value: { group, delivery, result } };
    }),
  );
  settled.forEach((entry, index) => {
    const target = unique[index];
    if (target === undefined) return;
    results[target.index] =
      entry.status === "fulfilled"
        ? entry.value.value
        : { outcome: "blocked", reason: String(entry.reason) };
  });
  const ready = results.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      "result" in entry &&
      entry.result !== null &&
      typeof entry.result === "object" &&
      "outcome" in entry.result &&
      entry.result.outcome === "ready-for-human",
  );
  return {
    outcome: ready ? "delivered" : "blocked",
    groups: results,
  };
};
