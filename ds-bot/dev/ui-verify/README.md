# Mobile style verification

Render the plugin's real UI at phone viewports and report what breaks, so a mobile change
can be re-checked with one command instead of by eye on a phone.

```sh
dev/ui-verify/run.sh                       # every default viewport, bench started if needed
dev/ui-verify/run.sh --viewports 390x844   # one viewport
dev/ui-verify/run.sh --static              # CSS pass only: no browser, no bench
dev/ui-verify/run.sh --stop                # stop the bench this service started
```

Screenshots and a report land in `shots/ui-verify/` (gitignored): one PNG per screen and
viewport, `report.json`, and `report.md`. The exit code is 1 when a check failed,
0 otherwise; `--no-fail` always exits 0.

## What it does

Two passes over the same source of truth, `src/client/` — the CSS is read from
`src/client/styles.js`, so no build is needed.

**Static pass** (always runs) scans the plugin's own CSS and layout constants for what a
phone cannot hold: fixed widths and `min-width` over 360px, `100vh` and `vw` units,
missing `env(safe-area-inset-*)`, `:hover` rules with no `@media (hover:none)` fallback,
and layout constants like `browser-pane.js`'s `MIN_CHAT`.

**Live pass** opens the plugin from this checkout in a bench (mock model + `dsh web`, the
layout `dev/bench.sh` uses, in `.dsh-test-uiverify/`) and measures the rendered page in
headless Chromium at each viewport: sideways scrolling, elements past the viewport edge,
tap targets under 24x24, text clipped inside a fixed-width box, and the fixed boxes and
message box near the bottom edge. It walks the screens a phone breaks on: the sidebar, the
chat, the model dock, the details drawer, the memory dialog, Bot settings and the settings
pages.

It also walks the navigation: `nav-1-list` (the Bot list as it stands), `nav-2-chat` (a
conversation) and, when the conversation has a back control, `nav-3-back`. Each step
records the shape it found — the sidebar's width and whether it is the collapsed rail, how
many list rows are on screen, and whether the message box is there — so a change from a
sidebar to a list page of its own shows up as numbers, not only as a screenshot. At 1024px
and wider it asserts the desktop shape instead: the Bot list and the chat side by side, not
a rail and not a list page.

The live pass needs a DeepSeek Harness install: set `DSH_HARNESS`, or keep a
`../deepseek-harness` checkout beside the repository. It reuses a bench already running on
the port (3097 by default), so after `npm run build` a re-run picks up the new `client.js`.
With no harness and no bench it prints the static pass and says the live pass was skipped.

`browser-pane.js` only renders where the shell has a browser (DSH Desktop, not `dsh web`),
so the panel itself cannot be measured here; its constants are covered by the static pass.

## First run on a machine

```sh
dev/ui-verify/setup.sh
```

Installs playwright and Chromium into `dev/ui-verify/node_modules` (gitignored). Chromium
needs libnss3, libatk, libgbm and about a dozen more system libraries; where installing
them needs root, the script downloads the packages with `dnf download` and unpacks only
their shared objects into `.dsh-test-uiverify/libs`, which the service puts on the
browser's `LD_LIBRARY_PATH`. Nothing outside the repository is written.

A directory of libraries that is already on the machine is reused instead of downloaded
again: `UI_VERIFY_LIBS`, then `.dsh-test-uiverify/libs`, then `~/.local/chromium-libs`.
