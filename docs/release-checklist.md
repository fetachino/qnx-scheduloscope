# Release readiness

Last checked: 2026-11-27. This is a private npm package and a public GitHub repository; the
checklist does not create a tag, GitHub release, YouTube upload, or Devpost submission.
Those are deliberate account-owner actions.

## Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| Source is clean and public | pass | `main` is public, Apache-2.0, `HEAD` matches `origin/main` |
| Version metadata | pass | `package.json` and `src/version.ts` both report `1.0.2` |
| Build and host tests | pass | 106 tests: 102 pass, 4 QNX-preprocessing skips without host `gcc` |
| Linux C-harness checks | pass | CI job compiles and runs the POSIX harness with sanitizers |
| Native QNX evidence | pass with boundaries | x86_64 KVM and AArch64 TCG JSON; no official QSTI or hardware claim |
| Performance/reliability record | pass | [`performance.md`](performance.md): 3 KVM boots, 1 TCG comparison, blocked-output regression |
| Package contents | pass | `npm pack --dry-run` includes `dist`, docs, examples, licence, and QNX evidence |
| Package install | pass | packed tarball installs; CLI `analyze` and `gen` run from the installed copy |
| GitHub Pages build | pass | `npm run build:pages`; deploy workflow on `main` |
| Demo asset | pass | `assets/scheduloscope-demo.mp4` and matching WebVTT |
| Public YouTube video | **pending** | Rules require a public YouTube upload; project-hosted MP4 is only a mirror |
| Devpost submission | **pending** | Needs the YouTube URL and explicit account-owner authorization |
| Git tag / GitHub release | **not created** | Requires explicit release authorization |

## Commands

```sh
npm ci
npm test
npm run build
npm run check:c        # Linux host with gcc; CI runs the equivalent
npm run bench
npm run check:release
npm run build:pages
npm pack --dry-run
```

Install smoke test:

```sh
npm pack --pack-destination .tmp
npm install --prefix .tmp/pkgtest .tmp/scheduloscope-1.0.2.tgz --no-audit --no-fund
node .tmp/pkgtest/node_modules/scheduloscope/dist/src/cli/main.js analyze examples/motor-control.yaml
node .tmp/pkgtest/node_modules/scheduloscope/dist/src/cli/main.js gen examples/motor-control.yaml --out .tmp/pkg-harness -d 2000ms
```

`analyze` exits 1 for an unschedulable example by design; the smoke test checks that the
installed copy starts, parses, and writes the harness files.

## Release notes

- No npm publish: `private` is `true`, and the CLI is distributed through the repository and
  the documented `npx`/clone path.
- No tag or GitHub release yet. The changelog has an `Unreleased` section; a version bump and
  tag should be a separate, reviewed action.
- The public repository is the submission artifact. The GitHub Pages site is a convenience
  mirror, not the Devpost video requirement.
- QSTI authentication and hardware-level timing remain external gaps, not release blockers for
  the documented QEMU evidence.

## Manual gates before submission

- [ ] Upload `assets/scheduloscope-demo.mp4` to YouTube with **Public** visibility.
- [ ] Add the public YouTube URL to the Devpost video field.
- [ ] Re-read the Devpost form and repository description for accuracy.
- [ ] Obtain explicit account-owner authorization before submitting the form.
- [ ] If a release is wanted, review the version bump, changelog section, tag, and release notes.
