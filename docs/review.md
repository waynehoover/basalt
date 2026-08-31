# Answers to the automated review

The community directory's scanner raises the same points each run. Two were real
and are fixed. The rest are correct readings of the source that do not apply to
the plugin, and this says why, with what was checked rather than what was
assumed.

## Fixed

**Artifact attestations.** `.github/workflows/attest.yml` rebuilds `main.js`,
`manifest.json` and `styles.css`, signs them against this repository and commit,
and replaces the release assets with what it signed. Verify any of them with:

    gh attestation verify main.js --repo waynehoover/basalt-sync

Rebuilding is safe because the build is reproducible: rebuilding tag 0.1.3 from
a clean worktree gives byte-identical files to the published ones.

**Dead code.** `noUnusedLocals` and `noUnusedParameters` are on, and the eight
things they found are gone.

## Node.js built-in imports

Every file named is in `client/src/cli/` or is `core/test-server.ts`. None is in
the plugin. The shipped bundle contains no `node:` reference at all:

    grep -c "node:" client/dist/plugin/main.js   # 0

`esbuild.config.mjs` marks them external and CI builds the bundle on every push,
so a plugin file reaching for one fails there.

The repository holds a plugin, a headless CLI and a server. The scanner reads
all of it; Obsidian loads one file out of it.

## The `no-unsafe-*` warnings

These are an artifact of type-aware linting without the `obsidian` types
resolved. What is flagged gives it away: `super(app)`, `this.setTitle(...)`,
`contentEl.createDiv(...)`, `this.addCommand(...)`. Those are typed by the
`obsidian` package, and every one of them is only `any` if that package was not
installed when the rules ran.

With the types resolved, `tsc` under `strict`, `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes` reports no errors:

    cd client && bunx tsc --noEmit

## `window.setTimeout` rather than `setTimeout`

The timers are in `core/`, which the headless CLI also runs, where `window` does
not exist. The remaining ones in `plugin/main.ts` debounce a sync pass; they are
not bound to any document, so which window owns them changes nothing, and a
popout window has no separate timers to get wrong.

There is also a test cost: `window`, `document` and `activeWindow` are all
undefined in the test environment, so those lines would become untestable. In
this project an untested path is the worse of the two.

## `globalThis`

`core/crypto.ts` reaches for `crypto.subtle`, which has to be found in both a
renderer and Node, and `origin()` reads `location` where there is one. `window`
would work in the plugin and break the CLI.

## `fetch` rather than `requestUrl`

`plugin/vault.ts` uses it twice, both on `app://` resource URLs for files that
are already on this device, with a `Range` header for partial reads. That is not
a network request. `requestUrl` cannot stream a response or ask for a byte
range, and this is what keeps a 256 MB attachment from being read into memory
whole.

## `.obsidian` as a literal

`cli/vault.ts` is the headless client, which has no `Vault` to ask. The other
two are test doubles.

## Logging to the console

One call, in the sync engine's failure path. A note that fails to send is
exactly the kind of silent failure this project exists to avoid; it stays.

## Vault enumeration

It is a sync engine. It cannot sync a vault it is not allowed to list.
