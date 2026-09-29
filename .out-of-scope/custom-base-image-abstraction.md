# Custom Base Image Abstraction Layer

**Decision:** Shipyard V1 does not provide an abstraction layer for composing Dockerfiles or managing base images programmatically.

**Why:**

- The `.shipyard-v1/Dockerfile` is scaffolded into the user's project during `shipyard-v1 init` and is fully user-owned from that point — users can change the base image, add packages, or restructure it however they need.
- An abstraction layer (`ISandboxEnvironment` / `IAgentHarness` interfaces) would add complexity for something already achievable by editing the Dockerfile directly.
- Shipyard V1 supports Docker, Vercel Sandbox, and no-sandbox mode — building a Dockerfile composition system couples the init layer too tightly to Docker.
- The init script should give a working starting point, not try to cover every possible tool or stack.

**Principle:** Control is inverted towards the user. Shipyard V1 scaffolds a sensible default; the user owns the result.

**Rejected in:** #283
