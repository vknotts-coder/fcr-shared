# @fcr/core

Shared code for the FCR platform (the `robert83976/fcr-*` app fleet). One place to fix,
one version to bump — the antidote to the copy-pasted-and-drifted `auth`/`session`/`rbac`
code the fleet grew. Tracked by epic **robert83976/fcr-dispatch#59** (Slice C/D).

## Consume it (git-URL, no registry)

This repo is **public**, so apps consume it as a plain **HTTPS tag tarball** — anonymous,
no registry, no token, works on local builds, GitHub Actions CI, and Vercel alike:

```jsonc
// package.json
"dependencies": {
  "@fcr/core": "https://github.com/vknotts-coder/fcr-shared/archive/refs/tags/v0.1.0.tar.gz"
}
```

Pin a **tag** (a released version), never a branch. Bump = a new tag here + bump the URL in each app.

> Why the tarball and not `github:…#tag`: npm normalizes the `github:` shortcut to `git+ssh://`
> in the lockfile, and SSH needs a key even for a public repo — so remote builders (GH Actions,
> Vercel), which authenticate only to their own repo, fail to fetch it. The HTTPS tarball is
> anonymous and needs zero wiring across the fleet. (Committed `dist/` is included in the tag tarball.)

## Exports

- `@fcr/core/contracts` — the RBAC shapes (`Principal`, `GrantedPermission`, `CanOptions`, `Decision`, …). The frozen interface every app speaks; additive-only, version-bumped.
- `@fcr/core/rbac` — the decision engine:
  - `can(principal, action, resourceType, opts)` — **pure, synchronous, zero I/O**. Deny-wins, default-deny.
  - `loadPrincipalGrants(pool, username)` — the DB seam. Takes an **injected** `{ query }` (node-postgres / `@neondatabase/serverless`-compatible), so this package has no DB-driver dependency. Each app wraps it in its own per-request memoization (e.g. `resolvePrincipal = cache(u => loadPrincipalGrants(pool(), u))`).

## Build

`dist/` is committed (so a git-URL install needs no build step). To regenerate after a source change:

```
npm install
npm run build
```

Then commit `dist/` and cut a new tag.

## Versioning

Git tags are the versions (`v0.1.0`, …). The `contracts` interface is **frozen**: changes are additive-only and bump the minor; a breaking change bumps the major and every consumer updates deliberately.
