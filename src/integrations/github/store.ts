import type {
  GitHubDeliveryRecord,
  GitHubDeliveryStore,
  GitHubTrackedPullRequest,
  GitHubTrackingStore,
} from "./types.js";

/**
 * Small in-memory adapter for tests and local development. Production callers
 * should provide a durable adapter with the same atomic insert semantics.
 */
export class InMemoryGitHubStore
  implements GitHubDeliveryStore, GitHubTrackingStore
{
  private readonly deliveries = new Map<string, GitHubDeliveryRecord>();
  private readonly trackedPullRequests = new Map<
    string,
    GitHubTrackedPullRequest
  >();

  async recordDeliveryIfAbsent(delivery: GitHubDeliveryRecord): Promise<{
    readonly delivery: GitHubDeliveryRecord;
    readonly inserted: boolean;
  }> {
    const existing = this.deliveries.get(delivery.deliveryId);
    if (existing !== undefined) {
      return { delivery: existing, inserted: false };
    }
    this.deliveries.set(delivery.deliveryId, delivery);
    return { delivery, inserted: true };
  }

  async getDelivery(
    deliveryId: string,
  ): Promise<GitHubDeliveryRecord | undefined> {
    return this.deliveries.get(deliveryId);
  }

  async updateDelivery(delivery: GitHubDeliveryRecord): Promise<void> {
    const existing = this.deliveries.get(delivery.deliveryId);
    if (existing === undefined) {
      throw new Error(`GitHub delivery ${delivery.deliveryId} does not exist`);
    }
    this.deliveries.set(delivery.deliveryId, delivery);
  }

  async findTrackedPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubTrackedPullRequest | undefined> {
    return this.trackedPullRequests.get(
      `${repository.toLowerCase()}\u0000${pullRequestNumber}`,
    );
  }

  async saveTrackedPullRequest(
    pullRequest: GitHubTrackedPullRequest,
  ): Promise<void> {
    this.trackedPullRequests.set(
      `${pullRequest.repository.toLowerCase()}\u0000${pullRequest.pullRequestNumber}`,
      pullRequest,
    );
  }
}
