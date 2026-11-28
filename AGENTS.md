# nestjs-router-eth

`@ethberry/nestjs-router-eth`: a NestJS microservice transport on viem that routes blockchain events to controllers. A single package, not a monorepo.

## Place in the package levels

Level 1: no dependencies on other `@ethberry/*` runtime packages. Released before the repositories that use it.

## Commands

- Base branch: `main`.
- Install: `npm ci` (the lockfile is committed; it resolves the `@ethberry` dev packages from GitHub Packages, so an install needs a token with `read:packages`).
- Build: `npm run build` (`tsc`). Test: `npm run test`. Lint: `npm run lint`.
- The tests need the local nodes of `docker-compose.yml`: `besu` (`JSON_RPC_ADDR`) and `tron` (TRE on 9190, `docs/tron.md`; a stopped one is recreated, never restarted: `docker compose up -d --force-recreate tron`).
- CI (`ci-test.yml`) on a PR: install, build, lint, test.
- Release: `gh workflow run manual.yml --repo ethberry/nestjs-router-eth --ref main -f bump=patch|minor|major`. The workflow runs `npm version` and publishes to GitHub Packages and to npmjs (public).

## Gotchas

- ESM only (`nodenext`, `.js` in relative imports). Jest runs with `NODE_OPTIONS=--experimental-vm-modules`.
- The version is set by the release workflow (`npm version`), not by conventional commits. Choose `bump` by the change: a breaking export change is `major`.
- `viem` is a peer: one copy per app.
- Dependency versions change only through Renovate.

## Docs

Usage is in `README.md`. Rules are in `.claude/rules/`, synced from the shared agent kit.
