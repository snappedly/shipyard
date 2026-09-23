import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const gh = (...args) =>
  execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const json = (...args) => JSON.parse(gh(...args));
const repository =
  process.env.GH_REPO ||
  gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
const pendingDir = resolve(
  execFileSync("git", ["rev-parse", "--git-path", "shipyard-pending"], {
    encoding: "utf8",
  }).trim(),
);
if (existsSync(pendingDir)) {
  for (const filename of readdirSync(pendingDir)
    .filter((name) => name.endsWith(".pending"))
    .sort()) {
    const contents = readFileSync(resolve(pendingDir, filename), "utf8");
    const separator = contents.indexOf("\n");
    if (separator < 0)
      throw new Error(`Invalid pending block record: ${filename}`);
    const [root, failed, recordedRepo, scope, branch, confirmed = ""] = contents
      .slice(0, separator)
      .split("\t");
    if (
      recordedRepo !== repository ||
      !/^\d+-\d+\.pending$/.test(filename) ||
      filename !== `${root}-${failed}.pending` ||
      (confirmed !== "" && !/^\d+(,\d+)*$/.test(confirmed)) ||
      confirmed
        .split(",")
        .filter(Boolean)
        .some((id) => !scope.split(",").includes(id))
    )
      throw new Error(`Invalid pending block record: ${filename}`);
    const reactivated = confirmed
      .split(",")
      .filter(Boolean)
      .some((id) => {
        const labels = execFileSync(
          "gh",
          [
            "issue",
            "view",
            id,
            "--repo",
            repository,
            "--json",
            "labels",
            "--jq",
            ".labels[].name",
          ],
          { encoding: "utf8" },
        ).split(/\r?\n/);
        return (
          labels.includes("shipyard") && !labels.includes("shipyard:blocked")
        );
      });
    if (reactivated) {
      // A fresh activation in GitHub supersedes this local failure report.
      unlinkSync(resolve(pendingDir, filename));
      continue;
    }
    execFileSync(
      "bash",
      [
        fileURLToPath(new URL("./block-scope.sh", import.meta.url)),
        root,
        failed,
        recordedRepo,
        scope,
        branch,
      ],
      { input: contents.slice(separator + 1), encoding: "utf8" },
    );
  }
}
const endpoint = (id, suffix) => `repos/${repository}/issues/${id}/${suffix}`;
const number = (value) => {
  const id = String(value);
  if (!/^\d+$/.test(id)) throw new Error(`Invalid GitHub issue number: ${id}`);
  return id;
};
class SelectionError extends Error {
  constructor(message, issueId) {
    super(message);
    this.issueId = issueId;
  }
}
const invalid = (message, issueId) => {
  throw new SelectionError(message, issueId);
};
const notFound = (error) => /HTTP 404/.test(String(error.stderr));
const api = (id, suffix) => json("api", `${endpoint(id, suffix)}?per_page=100`);
const parentLink = (id) => {
  try {
    return number(json("api", endpoint(id, "parent")).number);
  } catch (error) {
    if (notFound(error)) return undefined;
    throw error;
  }
};
const children = (id) => {
  const result = api(id, "sub_issues");
  if (!Array.isArray(result) || result.length === 100)
    invalid(`Could not resolve complete child scope for #${id}`, id);
  return result;
};
const dependencies = (id) => {
  const result = api(id, "dependencies/blocked_by");
  if (!Array.isArray(result) || result.length === 100)
    invalid(`Could not resolve complete dependencies for #${id}`, id);
  return result.map((item) => ({
    id: number(item.number),
    title: item.title,
    state: item.state,
  }));
};
const planningSpec = (body) =>
  /work item type:\*?\*?\s*planning spec/i.test(body ?? "");
const textParent = (body, issueId) => {
  const match = /^##?\s*Parent\b[^\n]*\n/im.exec(body ?? "");
  if (!match) return undefined;
  const tail = body.slice(match.index + match[0].length);
  const next = /^##?\s/m.exec(tail);
  const section = next ? tail.slice(0, next.index) : tail;
  const refs = [...section.matchAll(/#(\d+)/g)].map((entry) => entry[1]);
  if (new Set(refs).size !== 1 || refs.length === 0)
    invalid("Ambiguous or missing ## Parent issue reference", issueId);
  return refs[0];
};
let issueCatalog;
const allIssues = () => {
  if (!issueCatalog) {
    issueCatalog = json(
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "1000",
      "--json",
      "number,title,body,state,labels",
    );
    if (!Array.isArray(issueCatalog) || issueCatalog.length === 1000)
      invalid("Could not resolve complete issue relationship catalog");
  }
  return issueCatalog;
};
let specPRCatalog;
const specPRs = () => {
  if (!specPRCatalog) {
    specPRCatalog = json(
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--limit",
      "1000",
      "--json",
      "number,headRefName,body",
    );
    if (!Array.isArray(specPRCatalog) || specPRCatalog.length === 1000)
      invalid("Could not resolve complete open PR catalog");
  }
  return specPRCatalog.filter(
    (pr) =>
      /^shipyard\/spec-\d+$/.test(pr.headRefName ?? "") &&
      pr.body?.includes("<!-- shipyard:verified-handoff -->"),
  );
};
const sourceIds = (body) =>
  body
    ?.match(/^Source issues:[ \t]*((?:#[0-9]+[ \t]*)+)$/m)?.[1]
    ?.match(/#[0-9]+/g)
    ?.map((issue) => issue.slice(1)) ?? [];
const prParentLink = (id) => {
  const roots = specPRs()
    .filter((pr) => sourceIds(pr.body).includes(id))
    .map((pr) => number(pr.headRefName.slice("shipyard/spec-".length)))
    .filter((root) => root !== id);
  if (new Set(roots).size > 1)
    invalid(`Ticket #${id} is linked to multiple Shipyard spec PRs`, id);
  return roots[0];
};
const prChildren = (rootId) => {
  const ids = new Set(
    specPRs()
      .filter((pr) => pr.headRefName === `shipyard/spec-${rootId}`)
      .flatMap((pr) => sourceIds(pr.body))
      .filter((id) => id !== rootId),
  );
  if (!ids.size) return [];
  const tickets = allIssues().filter((item) => ids.has(number(item.number)));
  if (tickets.length !== ids.size)
    invalid(`Spec PR for #${rootId} references an unknown ticket`, rootId);
  return tickets;
};
const fullIssue = (id) =>
  json(
    "issue",
    "view",
    id,
    "--repo",
    repository,
    "--json",
    "number,title,body,state,labels",
  );
const statusLabels = [
  "shipyard:blocked",
  "shipyard:complete",
  "shipyard:outstanding-tasks",
];
const statusFor = (tickets) =>
  tickets.some(
    (ticket) =>
      ticket.labels.some((label) => label.name === "shipyard:blocked") &&
      !ticket.labels.some((label) => label.name === "shipyard:complete"),
  )
    ? "shipyard:blocked"
    : tickets.every((ticket) =>
          ticket.labels.some((label) => label.name === "shipyard:complete"),
        )
      ? "shipyard:complete"
      : "shipyard:outstanding-tasks";
const syncStatus = (root, tickets, pr) => {
  const status = statusFor(tickets);
  let synced = true;
  const cosmetic = (...args) => {
    try {
      gh(...args);
    } catch (error) {
      synced = false;
      console.error(`Could not synchronize ${status}: ${String(error)}`);
    }
  };
  const currentLabels = (kind, id) => {
    try {
      return json(
        kind,
        "view",
        id,
        "--repo",
        repository,
        "--json",
        "labels",
      ).labels.map((label) => label.name);
    } catch (error) {
      synced = false;
      console.error(
        `Could not inspect ${kind} #${id} labels: ${String(error)}`,
      );
      return [];
    }
  };
  cosmetic(
    "label",
    "create",
    status,
    "--repo",
    repository,
    "--color",
    status === "shipyard:blocked"
      ? "B60205"
      : status === "shipyard:complete"
        ? "0E8A16"
        : "FBCA04",
    "--description",
    status === "shipyard:blocked"
      ? "Shipyard work needs intervention"
      : status === "shipyard:complete"
        ? "Shipyard work ready for human review"
        : "Spec has uncompleted tickets",
    "--force",
  );
  cosmetic(
    "issue",
    "edit",
    number(root.number),
    "--repo",
    repository,
    "--add-label",
    status,
  );
  if (pr)
    cosmetic(
      "pr",
      "edit",
      String(pr.number),
      "--repo",
      repository,
      "--add-label",
      status,
    );
  const rootLabels = currentLabels("issue", number(root.number));
  const prLabels = pr ? currentLabels("pr", String(pr.number)) : [];
  for (const stale of statusLabels.filter((label) => label !== status)) {
    if (rootLabels.includes(stale))
      cosmetic(
        "issue",
        "edit",
        number(root.number),
        "--repo",
        repository,
        "--remove-label",
        stale,
      );
    if (pr && prLabels.includes(stale))
      cosmetic(
        "pr",
        "edit",
        String(pr.number),
        "--repo",
        repository,
        "--remove-label",
        stale,
      );
  }
  return synced;
};
const activated = json(
  "issue",
  "list",
  "--state",
  "open",
  "--label",
  "shipyard",
  "--limit",
  "100",
  "--json",
  "number,title,body,labels",
);
if (activated.length === 100)
  throw new Error("Could not resolve complete activated issue set");
const scopes = new Map();
const processedBranches = new Set();
const blockedIds = new Set();
const activeIds = new Set(activated.map((item) => number(item.number)));
for (const candidate of activated) {
  const id = number(candidate.number);
  if (blockedIds.has(id)) continue;
  let resolvedRootId;
  let resolvedSpec = false;
  let selectedTicketIds = new Set();
  try {
    const nativeParent = parentLink(id);
    const bodyParent = textParent(candidate.body, id);
    const prParent = prParentLink(id);
    if (new Set([nativeParent, bodyParent, prParent].filter(Boolean)).size > 1)
      invalid(`Conflicting parent links for #${id}`, id);
    const parentId = nativeParent ?? bodyParent ?? prParent;
    const root = parentId ? fullIssue(parentId) : candidate;
    const rootId = number(root.number);
    resolvedRootId = rootId;
    const nativeChildren = children(rootId);
    const isSpec =
      planningSpec(root.body) || nativeChildren.length > 0 || !!parentId;
    resolvedSpec = isSpec;
    const linked = isSpec
      ? [
          ...new Map(
            [
              ...nativeChildren,
              ...allIssues().filter(
                (item) => textParent(item.body, number(item.number)) === rootId,
              ),
              ...prChildren(rootId),
            ].map((item) => [number(item.number), item]),
          ).values(),
        ]
      : [];
    if (isSpec && !planningSpec(root.body))
      invalid(`Parent #${rootId} is not a planning spec`, id);
    if (isSpec && linked.length === 0)
      invalid(`Planning spec #${rootId} has no linked executable tickets`, id);
    const branch = isSpec ? `shipyard/spec-${rootId}` : `shipyard/issue-${id}`;
    if (processedBranches.has(branch)) continue;
    processedBranches.add(branch);
    if (
      !isSpec &&
      candidate.labels?.some((label) => label.name === "shipyard:complete")
    ) {
      const existing = json(
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,isDraft,labels,body",
      );
      const synced = syncStatus(candidate, [candidate], existing[0]);
      if (candidate.labels.some((label) => label.name === "shipyard:pending"))
        gh(
          "issue",
          "edit",
          id,
          "--repo",
          repository,
          "--remove-label",
          "shipyard:pending",
        );
      if (synced)
        gh(
          "issue",
          "edit",
          id,
          "--repo",
          repository,
          "--remove-label",
          "shipyard",
        );
      continue;
    }
    if (
      !isSpec &&
      candidate.labels?.some((label) => label.name === "shipyard:blocked")
    ) {
      gh(
        "issue",
        "edit",
        id,
        "--repo",
        repository,
        "--remove-label",
        "shipyard",
      );
      continue;
    }
    const linkedTickets = isSpec
      ? linked.map((child) => ({
          id: number(child.number),
          title: child.title,
          body: child.body ?? "",
          state: child.state,
          labels: child.labels ?? [],
        }))
      : [];
    const blockedActiveIds = [];
    for (const ticket of linkedTickets) {
      if (
        ticket.labels.some((label) => label.name === "shipyard:blocked") &&
        ticket.labels.some((label) => label.name === "shipyard")
      )
        blockedActiveIds.push(ticket.id);
      if (
        ticket.labels.some((label) => label.name === "shipyard:complete") &&
        ticket.labels.some((label) => label.name === "shipyard:pending")
      )
        gh(
          "issue",
          "edit",
          ticket.id,
          "--repo",
          repository,
          "--remove-label",
          "shipyard:pending",
        );
    }
    const selectableTickets = linkedTickets.filter(
      (ticket) =>
        ticket.labels.some((label) => label.name === "shipyard") &&
        !ticket.labels.some((label) =>
          ["shipyard:complete", "shipyard:blocked"].includes(label.name),
        ),
    );
    selectedTicketIds = new Set(selectableTickets.map((ticket) => ticket.id));
    const tickets = selectableTickets.map(({ labels: _labels, ...ticket }) => ({
      ...ticket,
      blockedBy: dependencies(ticket.id),
    }));
    const completedTicketIds = linkedTickets
      .filter((ticket) =>
        ticket.labels.some((label) => label.name === "shipyard:complete"),
      )
      .map((ticket) => ticket.id);
    const selectedIds = new Set(tickets.map((ticket) => ticket.id));
    const outstandingTicketIds = linkedTickets
      .filter(
        (ticket) =>
          !selectedIds.has(ticket.id) &&
          !completedTicketIds.includes(ticket.id),
      )
      .map((ticket) => ticket.id);
    if (isSpec) {
      if (parentId && !linkedTickets.some((ticket) => ticket.id === id))
        invalid(
          `Activated child #${id} is absent from parent #${rootId}'s linked scope`,
          id,
        );
      for (const ticket of tickets) {
        if (!/work item type:\*?\*?\s*executable/i.test(ticket.body))
          invalid(
            `Linked child #${ticket.id} is not an executable ticket`,
            ticket.id,
          );
        const native = parentLink(ticket.id);
        const textual = textParent(ticket.body, ticket.id);
        const linkedPR = prParentLink(ticket.id);
        if (
          (native && native !== rootId) ||
          (textual && textual !== rootId) ||
          (linkedPR && linkedPR !== rootId)
        )
          invalid(`Conflicting parent links for #${ticket.id}`, ticket.id);
      }
    }
    const existing = json(
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,isDraft,labels,body",
    );
    const ready = existing.find(
      (pr) =>
        !pr.isDraft && pr.body?.includes("<!-- shipyard:verified-handoff -->"),
    );
    const statusSynced = isSpec
      ? syncStatus(root, linkedTickets, existing[0])
      : true;
    if (statusSynced) {
      for (const blockedId of blockedActiveIds)
        gh(
          "issue",
          "edit",
          blockedId,
          "--repo",
          repository,
          "--remove-label",
          "shipyard",
        );
    }
    if (ready) {
      const recordedIds = ready.body
        ?.match(/^Source issues:[ \t]*((?:#[0-9]+[ \t]*)+)$/m)?.[1]
        ?.match(/#[0-9]+/g)
        ?.map((issue) => issue.slice(1));
      const implementedIds =
        ready.body
          ?.match(/^Implemented tickets:[ \t]*((?:#[0-9]+[ \t]*)*)$/m)?.[1]
          ?.match(/#[0-9]+/g)
          ?.map((issue) => issue.slice(1)) ??
        recordedIds?.slice(1) ??
        [];
      const recordedSet = new Set(recordedIds ?? []);
      const implementedSet = new Set(implementedIds);
      const knownIds = new Set([
        rootId,
        ...linkedTickets.map((ticket) => ticket.id),
      ]);
      if (
        !recordedIds ||
        !recordedSet.has(rootId) ||
        recordedIds.length !== recordedSet.size ||
        recordedIds.some((issue) => !knownIds.has(issue))
      )
        invalid(
          `PR #${ready.number} issue scope differs from current #${rootId} scope`,
          id,
        );
      if (tickets.every((ticket) => implementedSet.has(ticket.id))) {
        for (const ticket of tickets) {
          gh(
            "issue",
            "edit",
            ticket.id,
            "--repo",
            repository,
            "--add-label",
            "shipyard:complete",
          );
          if (
            linkedTickets
              .find((item) => item.id === ticket.id)
              ?.labels.some((label) => label.name === "shipyard:blocked")
          )
            gh(
              "issue",
              "edit",
              ticket.id,
              "--repo",
              repository,
              "--remove-label",
              "shipyard:blocked",
            );
          if (
            linkedTickets
              .find((item) => item.id === ticket.id)
              ?.labels.some((label) => label.name === "shipyard:pending")
          )
            gh(
              "issue",
              "edit",
              ticket.id,
              "--repo",
              repository,
              "--remove-label",
              "shipyard:pending",
            );
        }
        for (const ticket of linkedTickets) {
          if (
            ticket.labels.some((label) => label.name === "shipyard:complete") &&
            ticket.labels.some((label) => label.name === "shipyard:blocked")
          )
            gh(
              "issue",
              "edit",
              ticket.id,
              "--repo",
              repository,
              "--remove-label",
              "shipyard:blocked",
            );
        }
        let completedStatusSynced = statusSynced;
        if (isSpec) {
          const completed = new Set(tickets.map((ticket) => ticket.id));
          completedStatusSynced = syncStatus(
            root,
            linkedTickets.map((ticket) =>
              completed.has(ticket.id)
                ? { ...ticket, labels: [{ name: "shipyard:complete" }] }
                : ticket,
            ),
            ready,
          );
        } else {
          gh(
            "issue",
            "edit",
            rootId,
            "--repo",
            repository,
            "--add-label",
            "shipyard:complete",
          );
          if (root.labels?.some((label) => label.name === "shipyard:pending"))
            gh(
              "issue",
              "edit",
              rootId,
              "--repo",
              repository,
              "--remove-label",
              "shipyard:pending",
            );
          gh(
            "pr",
            "edit",
            String(ready.number),
            "--repo",
            repository,
            "--add-label",
            "shipyard:complete",
          );
        }
        const activatedIds = [
          rootId,
          ...tickets.map((ticket) => ticket.id),
          ...completedTicketIds,
        ].filter((item) => activeIds.has(item));
        if (completedStatusSynced)
          for (const activeId of activatedIds)
            gh(
              "issue",
              "edit",
              activeId,
              "--repo",
              repository,
              "--remove-label",
              "shipyard",
            );
        continue;
      }
    }
    if (isSpec) {
      if (root.state && String(root.state).toLowerCase() !== "open")
        invalid(`Planning spec #${rootId} is closed`, id);
      const ticketIds = new Set(tickets.map((ticket) => ticket.id));
      const completedIds = new Set(completedTicketIds);
      for (const ticket of tickets) {
        if (String(ticket.state).toLowerCase() !== "open")
          invalid(
            `Linked executable ticket #${ticket.id} is closed`,
            ticket.id,
          );
        for (const blocker of ticket.blockedBy) {
          if (
            String(blocker.state).toLowerCase() !== "closed" &&
            !ticketIds.has(blocker.id) &&
            !completedIds.has(blocker.id)
          )
            invalid(
              `Ticket #${ticket.id} has unresolved external dependency #${blocker.id}`,
              ticket.id,
            );
        }
      }
      const waiting = new Set(ticketIds);
      while (waiting.size) {
        const ready = tickets.filter(
          (ticket) =>
            waiting.has(ticket.id) &&
            ticket.blockedBy.every(
              (blocker) =>
                String(blocker.state).toLowerCase() === "closed" ||
                !waiting.has(blocker.id),
            ),
        );
        if (!ready.length)
          invalid(`Spec #${rootId} has cyclic dependencies`, id);
        for (const ticket of ready) waiting.delete(ticket.id);
      }
    }
    if (isSpec && tickets.length === 0) {
      if (statusSynced)
        for (const activeId of [rootId, ...completedTicketIds].filter((item) =>
          activeIds.has(item),
        ))
          gh(
            "issue",
            "edit",
            activeId,
            "--repo",
            repository,
            "--remove-label",
            "shipyard",
          );
      continue;
    }
    scopes.set(
      branch,
      isSpec
        ? {
            id: rootId,
            title: root.title,
            body: root.body ?? "",
            branch,
            kind: "spec",
            tickets,
            completedTicketIds,
            outstandingTicketIds,
          }
        : { id, title: candidate.title, branch, kind: "standalone" },
    );
  } catch (error) {
    if (!(error instanceof SelectionError)) throw error;
    const affectedId =
      error.issueId &&
      (activeIds.has(error.issueId) || selectedTicketIds.has(error.issueId))
        ? error.issueId
        : id;
    const specChild = resolvedSpec && resolvedRootId !== affectedId;
    const blockRoot = specChild ? resolvedRootId : affectedId;
    execFileSync(
      "bash",
      [
        fileURLToPath(new URL("./block-scope.sh", import.meta.url)),
        blockRoot,
        affectedId,
        repository,
        specChild ? `${blockRoot},${affectedId}` : affectedId,
        specChild
          ? `shipyard/spec-${blockRoot}`
          : `shipyard/issue-${affectedId}`,
      ],
      { input: error.message, encoding: "utf8" },
    );
    blockedIds.add(affectedId);
    console.error(`Shipyard blocked issue #${affectedId}: ${error.message}`);
  }
}
process.stdout.write(`${JSON.stringify([...scopes.values()])}\n`);
