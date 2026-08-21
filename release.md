# Releasing `opencode-vision-router`

Releases are published to npm automatically via GitHub Actions
(`.github/workflows/release.yml`) when a `v*` tag is pushed. Publishing uses **OIDC
provenance** — no `NPM_TOKEN` secret is required.

## What gets published

The package is compiled from TypeScript source to JavaScript before publishing:

- `src/*.ts` is bundled into `dist/index.js` via `bun build` (see the `build` script in
  `package.json`).
- `package.json` points `main` / `exports` at `dist/index.js`, and `files` is `["dist"]`, so
  **only the compiled `dist/` is published — not the raw `src/`**.
- The `@opencode-ai/plugin` import is type-only and is erased at build time, so the published
  package has no runtime dependencies beyond Node built-ins.

This keeps the published tarball small and self-contained. To test the build locally:

```bash
bun run build      # produces dist/index.js
npm publish --dry-run --access public   # inspect the tarball without publishing
```

## One-time setup (npm Trusted Publisher)

Configure a Trusted Publisher for this package in npm so the OIDC token from GitHub Actions is
accepted (no long-lived token needed):

1. Log in to npmjs.com → your package → **Settings → Trusted Publishers → Add Publisher**.
2. Choose **GitHub Actions**.
3. Set:
   - **Repository**: `Chathula/opencode-vision-router`
   - **Workflow**: `release.yml`
   - **Environment** (optional): leave blank

## Publish a new version

1. Bump the version in `package.json` (it must match the tag, without the leading `v`).
2. Commit and push the change.
3. Create and push a tag:
   ```bash
   git tag v0.1.3
   git push origin v0.1.3
   ```
4. The workflow installs deps, runs `bun test`, builds `dist/`, then runs
   `npm publish --provenance --access public`.

> ⚠️ **Version slots are permanent.** Once a `package@version` is published — even briefly, and
> even if later unpublished — npm forbids reusing that version number forever. Never publish
> throwaway test versions. PRs run a `npm publish --dry-run` guard (`.github/workflows/ci.yml`)
> that validates packaging **without** consuming a version.
