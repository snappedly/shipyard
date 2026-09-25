import type { WorkIdentity } from "../contracts/index.js";
import { sameWorkIdentity } from "../shared.js";
import type {
  BranchLease,
  CoordinatorStorage,
  CoordinatorStorageTransaction,
  DispatchIntent,
  EffectIntent,
  RepositoryControl,
  StoredEvent,
  WorkKey,
  WorkflowJob,
} from "./types.js";

interface MemoryState {
  readonly events: Map<string, StoredEvent>;
  readonly jobs: Map<string, WorkflowJob>;
  readonly dispatches: Map<string, DispatchIntent>;
  readonly effects: Map<string, EffectIntent>;
  readonly leases: Map<string, BranchLease>;
  readonly repositoryControls: Map<string, RepositoryControl>;
}

const clone = <T>(value: T): T => structuredClone(value);

const cloneState = (state: MemoryState): MemoryState => ({
  events: new Map(
    [...state.events.entries()].map(([key, value]) => [key, clone(value)]),
  ),
  jobs: new Map(
    [...state.jobs.entries()].map(([key, value]) => [key, clone(value)]),
  ),
  dispatches: new Map(
    [...state.dispatches.entries()].map(([key, value]) => [key, clone(value)]),
  ),
  effects: new Map(
    [...state.effects.entries()].map(([key, value]) => [key, clone(value)]),
  ),
  leases: new Map(
    [...state.leases.entries()].map(([key, value]) => [key, clone(value)]),
  ),
  repositoryControls: new Map(
    [...state.repositoryControls.entries()].map(([key, value]) => [
      key,
      clone(value),
    ]),
  ),
});

const sameKey = (left: WorkKey, right: WorkKey): boolean =>
  left.repository === right.repository &&
  left.itemId === right.itemId &&
  left.briefRevision === right.briefRevision &&
  left.phase === right.phase &&
  left.relevantRevision === right.relevantRevision;

const effectKey = (jobId: string, kind: string, marker: string): string =>
  `${jobId}\u0000${kind}\u0000${marker}`;

const resourceKey = (repository: string, branch: string): string =>
  `${repository}\u0000${branch}`;

class MemoryTransaction implements CoordinatorStorageTransaction {
  constructor(private readonly state: MemoryState) {}

  async insertEventIfAbsent(
    event: StoredEvent,
  ): Promise<{ readonly event: StoredEvent; readonly inserted: boolean }> {
    const existing = this.state.events.get(event.deliveryId);
    if (existing !== undefined) {
      return { event: clone(existing), inserted: false };
    }
    this.state.events.set(event.deliveryId, clone(event));
    return { event: clone(event), inserted: true };
  }

  async saveEvent(event: StoredEvent): Promise<void> {
    this.state.events.set(event.deliveryId, clone(event));
  }

  async lockWorkIdentity(_identity: WorkIdentity): Promise<void> {
    // In-memory transactions are already serialized by transactionTail.
  }

  async getJob(jobId: string): Promise<WorkflowJob | undefined> {
    const job = this.state.jobs.get(jobId);
    return job === undefined ? undefined : clone(job);
  }

  async findJobByKey(
    key: WorkKey,
    briefHash: string,
  ): Promise<WorkflowJob | undefined> {
    const job = [...this.state.jobs.values()].find(
      (candidate) =>
        sameKey(candidate.key, key) && candidate.brief.hash === briefHash,
    );
    return job === undefined ? undefined : clone(job);
  }

  async findCurrentJob(
    identity: WorkIdentity,
  ): Promise<WorkflowJob | undefined> {
    const jobs = [...this.state.jobs.values()]
      .filter(
        (candidate) =>
          candidate.control !== "superseded" &&
          sameWorkIdentity(candidate.brief.identity, identity),
      )
      .sort((left, right) => {
        const observed = right.latestObservedAt.localeCompare(
          left.latestObservedAt,
        );
        return observed !== 0
          ? observed
          : right.updatedAt.localeCompare(left.updatedAt);
      });
    const job = jobs[0];
    return job === undefined ? undefined : clone(job);
  }

  async insertJob(job: WorkflowJob): Promise<void> {
    if (this.state.jobs.has(job.id)) {
      throw new Error(`Workflow job ${job.id} already exists`);
    }
    this.state.jobs.set(job.id, clone(job));
  }

  async saveJob(job: WorkflowJob): Promise<void> {
    const current = this.state.jobs.get(job.id);
    if (current === undefined) {
      throw new Error(`Workflow job ${job.id} does not exist`);
    }
    if (current.version !== job.version - 1) {
      throw new Error(`Workflow job ${job.id} was updated concurrently`);
    }
    this.state.jobs.set(job.id, clone(job));
  }

  async findDispatchByDedupeKey(
    dedupeKey: string,
  ): Promise<DispatchIntent | undefined> {
    const dispatch = [...this.state.dispatches.values()].find(
      (candidate) => candidate.dedupeKey === dedupeKey,
    );
    return dispatch === undefined ? undefined : clone(dispatch);
  }

  async findDispatchByAssignmentId(
    assignmentId: string,
  ): Promise<DispatchIntent | undefined> {
    const dispatch = [...this.state.dispatches.values()].find(
      (candidate) => candidate.assignment?.id === assignmentId,
    );
    return dispatch === undefined ? undefined : clone(dispatch);
  }

  async findPendingDispatch(
    repository: string,
    nowMilliseconds: number,
    selector: {
      readonly jobId?: string;
      readonly dispatchId?: string;
    } = {},
  ): Promise<DispatchIntent | undefined> {
    const dispatch = [...this.state.dispatches.values()]
      .filter(
        (candidate) =>
          candidate.key.repository === repository &&
          (selector.jobId === undefined ||
            candidate.jobId === selector.jobId) &&
          (selector.dispatchId === undefined ||
            candidate.id === selector.dispatchId) &&
          (candidate.status === "pending" ||
            ((candidate.status === "claimed" ||
              candidate.status === "started") &&
              candidate.claimExpiresAt !== undefined &&
              candidate.claimExpiresAt <= nowMilliseconds)),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    return dispatch === undefined ? undefined : clone(dispatch);
  }

  async insertDispatchIfAbsent(dispatch: DispatchIntent): Promise<{
    readonly dispatch: DispatchIntent;
    readonly inserted: boolean;
  }> {
    const existing = [...this.state.dispatches.values()].find(
      (candidate) => candidate.dedupeKey === dispatch.dedupeKey,
    );
    if (existing !== undefined) {
      return { dispatch: clone(existing), inserted: false };
    }
    this.state.dispatches.set(dispatch.id, clone(dispatch));
    return { dispatch: clone(dispatch), inserted: true };
  }

  async saveDispatch(dispatch: DispatchIntent): Promise<void> {
    if (!this.state.dispatches.has(dispatch.id)) {
      throw new Error(`Dispatch intent ${dispatch.id} does not exist`);
    }
    this.state.dispatches.set(dispatch.id, clone(dispatch));
  }

  async findEffect(
    jobId: string,
    kind: string,
    marker: string,
  ): Promise<EffectIntent | undefined> {
    const effect = this.state.effects.get(effectKey(jobId, kind, marker));
    return effect === undefined ? undefined : clone(effect);
  }

  async insertEffectIfAbsent(
    effect: EffectIntent,
  ): Promise<{ readonly effect: EffectIntent; readonly inserted: boolean }> {
    const key = effectKey(effect.jobId, effect.kind, effect.marker);
    const existing = this.state.effects.get(key);
    if (existing !== undefined) {
      return { effect: clone(existing), inserted: false };
    }
    this.state.effects.set(key, clone(effect));
    return { effect: clone(effect), inserted: true };
  }

  async saveEffect(effect: EffectIntent): Promise<void> {
    this.state.effects.set(
      effectKey(effect.jobId, effect.kind, effect.marker),
      clone(effect),
    );
  }

  async getLease(
    repository: string,
    branch: string,
  ): Promise<BranchLease | undefined> {
    const lease = this.state.leases.get(resourceKey(repository, branch));
    return lease === undefined ? undefined : clone(lease);
  }

  async lockLeaseResource(_repository: string, _branch: string): Promise<void> {
    // In-memory transactions are already serialized by transactionTail.
  }

  async saveLease(lease: BranchLease): Promise<void> {
    this.state.leases.set(lease.resourceKey, clone(lease));
  }

  async findLeasesForJob(jobId: string): Promise<readonly BranchLease[]> {
    return [...this.state.leases.values()]
      .filter((lease) => lease.jobId === jobId)
      .map(clone);
  }

  async findLeasesForRepository(
    repository: string,
  ): Promise<readonly BranchLease[]> {
    return [...this.state.leases.values()]
      .filter((lease) => lease.repository === repository)
      .map(clone);
  }

  async getRepositoryControl(
    repository: string,
  ): Promise<RepositoryControl | undefined> {
    const control = this.state.repositoryControls.get(repository);
    return control === undefined ? undefined : clone(control);
  }

  async saveRepositoryControl(control: RepositoryControl): Promise<void> {
    this.state.repositoryControls.set(control.repository, clone(control));
  }
}

/**
 * Deterministic storage for coordinator tests. Each transaction runs against
 * an isolated draft and commits atomically when the callback succeeds.
 */
export class InMemoryCoordinatorStorage implements CoordinatorStorage {
  private state: MemoryState = {
    events: new Map(),
    jobs: new Map(),
    dispatches: new Map(),
    effects: new Map(),
    leases: new Map(),
    repositoryControls: new Map(),
  };

  private transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(
    operation: (transaction: CoordinatorStorageTransaction) => Promise<T>,
  ): Promise<T> {
    let release!: () => void;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.transactionTail;
    this.transactionTail = previous.then(() => turn);
    await previous;

    const draft = cloneState(this.state);
    try {
      const result = await operation(new MemoryTransaction(draft));
      this.state = draft;
      return result;
    } finally {
      release();
    }
  }
}
