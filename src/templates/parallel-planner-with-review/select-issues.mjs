import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
    const [root, failed, recordedRepo, scope, branch] = contents
      .slice(0, separator)
      .split("\t");
    if (
      recordedRepo !== repository ||
      !/^\d+-\d+\.pending$/.test(filename) ||
      filename !== `${root}-${failed}.pending`
    )
      throw new Error(`Invalid pending block record: ${filename}`);
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
    throw new Error(`Could not resolve complete child scope for #${id}`);
  return result;
};
const dependencies = (id) => {
  const result = api(id, "dependencies/blocked_by");
  if (!Array.isArray(result) || result.length === 100)
    throw new Error(`Could not resolve complete dependencies for #${id}`);
  return result.map((item) => ({
    id: number(item.number),
    title: item.title,
    state: item.state,
  }));
};
const planningSpec = (body) =>
  /work item type:\*?\*?\s*planning spec/i.test(body ?? "");
const textParent = (body) => {
  const match = /^##?\s*Parent\b[^\n]*\n/im.exec(body ?? "");
  if (!match) return undefined;
  const tail = body.slice(match.index + match[0].length);
  const next = /^##?\s/m.exec(tail);
  const section = next ? tail.slice(0, next.index) : tail;
  const refs = [...section.matchAll(/#(\d+)/g)].map((entry) => entry[1]);
  if (new Set(refs).size !== 1 || refs.length === 0)
    throw new Error("Ambiguous or missing ## Parent issue reference");
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
      throw new Error("Could not resolve complete issue relationship catalog");
  }
  return issueCatalog;
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
const activeIds = new Set(activated.map((item) => number(item.number)));
for (const candidate of activated) {
  const id = number(candidate.number);
  const nativeParent = parentLink(id);
  const bodyParent = textParent(candidate.body);
  if (nativeParent && bodyParent && nativeParent !== bodyParent)
    throw new Error(
      `Conflicting parent links for #${id}: #${nativeParent} and #${bodyParent}`,
    );
  const parentId = nativeParent ?? bodyParent;
  const root = parentId ? fullIssue(parentId) : candidate;
  const rootId = number(root.number);
  const nativeChildren = children(rootId);
  const isSpec =
    planningSpec(root.body) || nativeChildren.length > 0 || !!parentId;
  const linked = isSpec
    ? [
        ...new Map(
          [
            ...nativeChildren,
            ...allIssues().filter((item) => textParent(item.body) === rootId),
          ].map((item) => [number(item.number), item]),
        ).values(),
      ]
    : [];
  if (isSpec && !planningSpec(root.body))
    throw new Error(`Parent #${rootId} is not a planning spec`);
  if (isSpec && linked.length === 0)
    throw new Error(
      `Planning spec #${rootId} has no linked executable tickets`,
    );
  const branch = isSpec ? `shipyard/spec-${rootId}` : `shipyard/issue-${id}`;
  if (processedBranches.has(branch)) continue;
  processedBranches.add(branch);
  const linkedTickets = isSpec
    ? linked.map((child) => ({
        id: number(child.number),
        title: child.title,
        body: child.body ?? "",
        state: child.state,
        labels: child.labels ?? [],
      }))
    : [];
  const tickets = linkedTickets
    .filter(
      (ticket) =>
        ticket.labels.some((label) => label.name === "shipyard") &&
        !ticket.labels.some((label) =>
          ["shipyard:complete", "shipyard:blocked"].includes(label.name),
        ),
    )
    .map(({ labels: _labels, ...ticket }) => ({
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
        !selectedIds.has(ticket.id) && !completedTicketIds.includes(ticket.id),
    )
    .map((ticket) => ticket.id);
  if (
    root.labels?.some((label) => label.name === "shipyard:blocked") ||
    linkedTickets.some(
      (ticket) =>
        ticket.labels.some((label) => label.name === "shipyard:blocked") &&
        !ticket.labels.some((label) => label.name === "shipyard:complete"),
    )
  ) {
    continue;
  }
  if (isSpec) {
    if (parentId && !linkedTickets.some((ticket) => ticket.id === id))
      throw new Error(
        `Activated child #${id} is absent from parent #${rootId}'s linked scope`,
      );
    for (const ticket of tickets) {
      if (!/work item type:\*?\*?\s*executable/i.test(ticket.body))
        throw new Error(
          `Linked child #${ticket.id} is not an executable ticket`,
        );
      const native = parentLink(ticket.id);
      const textual = textParent(ticket.body);
      if ((native && native !== rootId) || (textual && textual !== rootId))
        throw new Error(`Conflicting parent links for #${ticket.id}`);
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
      !pr.isDraft &&
      (pr.labels.some((label) => label.name === "ready-for-human") ||
        pr.body?.includes("<!-- shipyard:verified-handoff -->")),
  );
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
      throw new Error(
        `PR #${ready.number} issue scope differs from current #${rootId} scope`,
      );
    if (
      tickets.length === 0 &&
      ready.labels.some((label) => label.name === "shipyard:blocked")
    ) {
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
    if (tickets.every((ticket) => implementedSet.has(ticket.id))) {
      if (!ready.labels.some((label) => label.name === "ready-for-human"))
        gh(
          "pr",
          "edit",
          String(ready.number),
          "--repo",
          repository,
          "--add-label",
          "ready-for-human",
        );
      const parentStatus = outstandingTicketIds.length
        ? "shipyard:outstanding-tasks"
        : "shipyard:complete";
      gh(
        "label",
        "create",
        parentStatus,
        "--repo",
        repository,
        "--color",
        outstandingTicketIds.length ? "FBCA04" : "0E8A16",
        "--description",
        outstandingTicketIds.length
          ? "Spec has uncompleted tickets"
          : "Shipyard work ready for human review",
        "--force",
      );
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
      gh(
        "issue",
        "edit",
        rootId,
        "--repo",
        repository,
        "--add-label",
        parentStatus,
      );
      gh(
        "pr",
        "edit",
        String(ready.number),
        "--repo",
        repository,
        "--add-label",
        parentStatus,
      );
      for (const label of [
        "shipyard:complete",
        "shipyard:outstanding-tasks",
        "shipyard:blocked",
      ]) {
        if (label === parentStatus) continue;
        if (root.labels?.some((item) => item.name === label))
          gh(
            "issue",
            "edit",
            rootId,
            "--repo",
            repository,
            "--remove-label",
            label,
          );
        if (ready.labels.some((item) => item.name === label))
          gh(
            "pr",
            "edit",
            String(ready.number),
            "--repo",
            repository,
            "--remove-label",
            label,
          );
      }
      const activatedIds = [
        rootId,
        ...tickets.map((ticket) => ticket.id),
        ...completedTicketIds,
      ].filter((item) => activeIds.has(item));
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
      throw new Error(`Planning spec #${rootId} is closed`);
    const ticketIds = new Set(tickets.map((ticket) => ticket.id));
    const completedIds = new Set(completedTicketIds);
    for (const ticket of tickets) {
      if (String(ticket.state).toLowerCase() !== "open")
        throw new Error(`Linked executable ticket #${ticket.id} is closed`);
      for (const blocker of ticket.blockedBy) {
        if (
          String(blocker.state).toLowerCase() !== "closed" &&
          !ticketIds.has(blocker.id) &&
          !completedIds.has(blocker.id)
        )
          throw new Error(
            `Ticket #${ticket.id} has unresolved external dependency #${blocker.id}`,
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
        throw new Error(`Spec #${rootId} has cyclic dependencies`);
      for (const ticket of ready) waiting.delete(ticket.id);
    }
  }
  if (isSpec && tickets.length === 0) {
    if (outstandingTicketIds.length) {
      gh(
        "label",
        "create",
        "shipyard:outstanding-tasks",
        "--repo",
        repository,
        "--color",
        "FBCA04",
        "--description",
        "Spec has uncompleted tickets",
        "--force",
      );
      gh(
        "issue",
        "edit",
        rootId,
        "--repo",
        repository,
        "--add-label",
        "shipyard:outstanding-tasks",
      );
      if (root.labels?.some((label) => label.name === "shipyard:complete"))
        gh(
          "issue",
          "edit",
          rootId,
          "--repo",
          repository,
          "--remove-label",
          "shipyard:complete",
        );
    }
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
}
process.stdout.write(`${JSON.stringify([...scopes.values()])}\n`);
