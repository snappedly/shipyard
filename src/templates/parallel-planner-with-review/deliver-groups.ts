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
  Delivery extends { readonly mode: string },
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

  const settled = await Promise.allSettled(
    groups.map(async (planned) => {
      const group = await hydrate(planned);
      const delivery = resolve(group);
      const deliver =
        delivery.mode === "planning-spec" ? deliverSpec : deliverStandalone;
      const result = await deliver({ group, delivery });
      return { group, delivery, result };
    }),
  );
  const results = settled.map((entry) =>
    entry.status === "fulfilled"
      ? entry.value
      : { outcome: "blocked", reason: String(entry.reason) },
  );
  const ready = results.some(
    (entry) => "result" in entry && entry.result.outcome === "ready-for-human",
  );
  return {
    outcome: ready ? "delivered" : "blocked",
    groups: results,
  };
};
