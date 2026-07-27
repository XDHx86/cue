# Releasing cue

`cue` releases are **tag-driven** and build for both macOS and Windows. There is **no CI test
gate** — the only workflow is the release build.

## Tag a release

A release is triggered by pushing a `v*` tag:

```bash
git tag v0.x.y
git push origin v0.x.y
```

That tag trip [.github/workflows/release.yml](../.github/workflows/release.yml), which builds
mac + Windows and attaches the artifacts (mac zip and the Windows NSIS installer) to a GitHub
Release.

## Local builds (no release)

```bash
npm run pack        # electron-builder --dir — local unpackaged app (mac)
npm run dist        # electron-builder --mac zip  — macOS distributable
npm run dist:win    # electron-builder --win      — Windows NSIS installer
```

## Things to know about a build

- **`asar: false`** — the packaged app ships files unpacked. The `files` allowlist in
  [`package.json`](../package.json) (`main.js`, `preload.js`, `src/**`, `renderer/**`) decides
  what ships. Add any new top-level asset to that allowlist or it won't be included.
- **Ad-hoc signing on macOS** — there is no paid Apple certificate, so the app is ad-hoc signed.
  macOS ties mic/screen permission grants to the exact build identity, so **rebuilding resets
  them** — users re-grant after a rebuild (the System Settings checkbox can linger, misleadingly;
  toggle it off and on). For everyday use, build once and keep it.
- **Model names drift** — provider model names in [`src/store.js`](../src/store.js) `DEFAULTS`
  are user-editable and change often; treat them as defaults, not facts, when bumping a release.
- **Version** lives in [`package.json`](../package.json) `version`. The tag should match it
  (the tag landed on `v0.1.0` at the initial open-source release).

## What is *not* gated

- `npm test` is **not** run by the release workflow. Run it locally before tagging.
- There is no changelog automation. Write release notes by hand on the GitHub Release.
