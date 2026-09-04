# @fcr/core

Shared code for the FCR platform (the `robert83976/fcr-*` app fleet). One place to fix,
one version to bump — the antidote to the copy-pasted-and-drifted `auth`/`session`/`rbac`
code the fleet grew. Tracked by epic **robert83976/fcr-dispatch#59** (Slice C/D).

## Consume it (git-URL, no registry)

FCR apps deploy **prebuilt locally** (`vercel build --prebuilt`), so `npm install` runs on
your machine with your GitHub creds — a git-URL dependency needs no registry or Vercel token:

```jsonc
// package.json
"dependencies": {
  "@fcr/core": "github:vknotts-coder/fcr-shared#v0.1.0"
}
```

Pin a **tag** (a released version), never a branch. Bump = a new tag here + bump the range in each app.

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
