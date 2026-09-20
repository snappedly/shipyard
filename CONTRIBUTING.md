# Contributing to Shipyard

Thanks for helping improve Shipyard.

This is a source-available repository licensed under the
[PolyForm Strict License 1.0.0](LICENSE). Contributions are welcome, but the
license does not permit redistributing the repository or creating derivative
works outside this contribution process.

To preserve Snappedly's ability to offer commercial licenses, we can accept
only contributions for which Snappedly has separate relicensing rights through
an employment agreement, contractor agreement, or written contributor
agreement. Open an issue before preparing a contribution if no such agreement
is already in place.

## Before coding

Open a GitHub issue for bugs and proposed changes before starting substantial
work. Keep security reports private and follow [SECURITY.md](SECURITY.md).

## Development

Shipyard requires Node.js, npm, Git, and Docker for integration tests involving
the Docker provider.

```sh
git clone https://github.com/snappedly/shipyard.git
cd shipyard
npm ci
npm run check
```

Use focused tests while developing. Run `npm run check` before submitting a
pull request; it checks formatting, types, package output, and tests.

User-facing changes require a file in `.changeset/`:

```sh
npx changeset
```

Use a patch changeset for fixes and a minor changeset for features or breaking
changes while Shipyard is pre-1.0.

## Pull requests

Keep each pull request focused and link its issue. Describe the behavior
change, verification performed, known limitations, and any security or
compatibility implications. Maintainers may ask for changes before accepting
the contribution.

By submitting a contribution, you confirm that Snappedly has the relicensing
rights described above.
