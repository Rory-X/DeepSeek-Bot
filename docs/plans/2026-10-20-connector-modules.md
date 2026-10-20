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
  `oauth-mcp`, `notify`, `rest-tools`, `imap`, `custom`.
- The rest of the object is the definition `connectors.js` already understands, by mode:
  `api`, `mcpUrl`/`url`, `tokenSecret`, `readTools`, `actionTools`, `oauth` scopes,
  `toolbox`/`toolboxKind`, `restTools`, `accountField`/`accountTool`, `needsChatId`, …
- A connector may carry `card: { glyph, about, docsUrl, readOnlyNote, consent?: { title, body, acknowledge? } }`;
  the view passes it through untouched and the client draws the card from it. It is display
  data only and never reaches the tool surface.
- A module that needs more than one secret declares
  `credentials: [{ name, label?, required? }]`; the card then gets `inputs` in the view and
  `connector-connect` takes `{ id, values: { <name>: <value> } }` (the single-token card
  keeps `{ id, token }`). Secret names are DSH secret names; values are written through the
  Secrets seam, never into the team file or a view.
- `verify({ secrets, api })` may replace the GET `checkPath` sign-in (a POST login, an IMAP
  login); it returns `{ account? }`. A connector with neither hook nor `checkPath` is
  accepted once its credentials exist — the service has no "who am I" endpoint to ask.
- Modes `rest-tools`, `imap-read` and `custom` mount through the module:
  - `rest-tools` uses `restTools` definitions (see below), `auth({ token, secrets })`
    headers and an optional `envelope` / `answer` (per connector or per tool);
  - `imap-read` and `custom` use `mountTools({ ctx, rt, connector, secrets, state, output,
    redact })`, returning `{ dispose: [...], close? }`; `close` runs on unmount.
- The `answer` hook or `envelope` turns a service's HTTP-200 error body into a tool error:
  `envelope: { ok, success?, data?, error?, errors? }` (WeRead `errcode`, ima `code`) or
  `answer({ body, status })` for anything more custom.
- A module that fails to import, has a bad id, repeats an id, lacks a display name, has an
  unknown mode, or claims a built-in id (GitHub, Vercel, Cloudflare) fails **plugin load**
  with an error naming the file. Nothing is skipped silently.
- `blockedTools: [name | RegExp]` names tools the connector never offers. They stay out of
  every tool list, and a pre-execute gate denies a call carrying the name (or its
  `<id>_` prefixed form) before a card is made or a request is sent.
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

## Notification connectors

`mode: 'notify'` sends one message the user asked for. The module brings the service; the
framework brings everything the card and the tool need.

- Module: one token (`credentials`/`tokenSecret`), `needsChatId: true` when the service
  sends to a chat, `verify({ token, secrets, api }) → { account? }`, and
  `notify: { send({ token, chatId, text, secrets, api }), discoverChatId({ token, secrets,
  api }) → { chatId?, candidates? }, maxText?, testText?, toolName?, toolDescription?,
  chatIdPattern?, chatIdHint?, missingChatText?, multipleChatsText? }`.
- The framework registers `notify_<id>` (one `text` argument) only while the token and,
  when the service needs one, a chat id exist. A valid token without a chat is still
  connected: the view says `mode: 'notify'`, `chatId: null`, `canTest: true`, and the card
  asks the user to message the bot first.
- `connector-connect` verifies the token, saves it and runs `discoverChatId` once;
  `connector-test` sends one test message through `send` (discovering the chat first when
  missing) and reports a failure on the row without disconnecting; `connector-set-chat`
  stores a typed chat id or clears it with an empty string. All three return the whole view.
- The chat id lives in the team file; the token stays in Secrets and never appears in a
  view, a log or an error.

## Tests

- `ds-bot/test/connector-registry.test.js`: loading, ordering, ignored files, every
  refusal, duplicate ids.
- Each connector module ships its own tests (`ds-bot/test/<id>.test.js`) with a mocked
  service; QA then runs black-box acceptance and a security check against the real
  connector.
