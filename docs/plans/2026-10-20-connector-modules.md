# Connector modules: one file per connector

## Status

Implemented. `ds-bot/src/host/connectors/registry.js` loads connector modules at plugin
load; `ds-bot/src/host/connectors.js` keeps the built-in connectors (GitHub, Vercel,
Cloudflare) and merges the loaded ones after them.

## Why

Connector work is split across several lines at once. When every connector is a block in
one `connectors.js`, each line edits the same file and the others rebase. A module per
connector lets a line add one file and nothing else.

## Loading contract

- Directory: `ds-bot/src/host/connectors/`.
- Every `.js` file there is loaded, except `registry.js`, files starting with `_`, and
  `*.test.js`.
- Each module has a **default export**: a connector definition object with an `id`.
  `export const connector = { ... }` is accepted too.
- `id`: lowercase, starts with a letter, letters/digits/hyphens, at most 40 characters.
  The id names the tools (`<id>_<tool>`), the team-file entry, the profile config key and
  the view row.
- Required fields: `id`, `displayName`, `mode`. Modes: `mcp-client`, `read-tools`,
  `oauth-mcp`, `notify`, `rest-tools`.
- The rest of the object is the definition `connectors.js` already understands, by mode:
  `api`, `mcpUrl`/`url`, `tokenSecret`, `readTools`, `actionTools`, `oauth` scopes,
  `toolbox`/`toolboxKind`, `restTools`, `accountField`/`accountTool`, `needsChatId`, …
- A module that fails to import, has a bad id, repeats an id, lacks a display name, has an
  unknown mode, or claims a built-in id (GitHub, Vercel, Cloudflare) fails **plugin load**
  with an error naming the file. Nothing is skipped silently.
- Load order is file-name order; external connectors appear in the Connectors view after
  the built-ins.
- A profile still hides a connector with `<id>: false` and still overrides `url`/`api`.

## Read-only POST for REST tools

`restTools` definitions may use `GET`, or `POST` when the definition says
`readOnly: true` and gives an explicit `body` mapping (`field: 'argumentName'` or
`field: { const: value }`). Only the mapped fields are sent; an argument the definition
does not name never reaches the request; no header comes from model arguments; results are
redacted and cut at 20,000 characters; any other method is refused when the tools are
built. There is no generic pass-through or proxy.

## Tests

- `ds-bot/test/connector-registry.test.js`: loading, ordering, ignored files, every
  refusal, duplicate ids.
- Each connector module ships its own tests (`ds-bot/test/<id>.test.js`) with a mocked
  service; QA then runs black-box acceptance and a security check against the real
  connector.
