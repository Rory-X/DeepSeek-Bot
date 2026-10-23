# Connector write capabilities: read and write through one access level

## Status

Approved direction. Read-only was the first slice, not the ceiling: a connector takes
every capability its service exposes, and every call that changes something outside DS Bot
asks the user through the plugin's own approval card. The framework work is P0, P1, P2 and
P5 below; P3 (IMAP write session) belongs to the QQ mail line and P4 (`_smtp.js`) to the
Gmail line, both against the contracts written here.

## Principles

- A write tool is **not registered** until the connector's access level allows it. A model
  cannot call what does not exist.
- Every write call asks through `connector-approval` before it does anything: a refusal, a
  dismissal, a timeout and a cancelled Session all leave the call unrun.
- Credentials stay in DSH's credential store and Secrets; the team file, a view, a log and
  diagnostics never hold a credential or a call's arguments.
- No generic proxy: a request carries only the fields the module maps, a mail command
  comes from a fixed list, and a tool name comes from an explicit allow-list.
- Read-only stays the default. The user opts into write per connector and per level.

## Access level

One concept replaces the `actions` and `toolbox` switches: the connector's **level**,
`'read'` or `'write'`. The client shows one row setting. Everything a write level enables
is still gated by the per-call approval card.

### Module fields

```js
export default {
  id, displayName, mode,
  levels: ['read', 'write'],        // default ['read']
  defaultLevel: 'read',             // default 'read'; must be in levels
  settings: [{ name: 'projectId', label: 'Project ID' }],   // plain configuration, never secrets
  normalizeSettings(values) { /* returns the normalized values, throws the form's message */ },
  readiness({ level, settings }) { /* undefined when ready, else the reason the row is off */ },
  authorize({ level, settings }) { return { url, scopes } },  // OAuth only; without it the old url/scopes apply
  toolsOf({ level, settings }) { return { readTools, actionTools } },  // replaces the static lists when present
  actionApproval(name, args, { client }) { return { line, danger, change, reversible, target } },  // async allowed
  capabilities: [{ key, title, description, risk: 'read' | 'write' | 'destructive', preview? }],
  permissions: { summary, scopes? },
  configure(override) { /* may return { unavailable: 'reason' } */ },
}
```

- `levels` and `defaultLevel` are checked when the plugin loads; an unknown level is a
  configuration error naming the file.
- `settings` are declared with `name` and `label` only. **Conditional requirements are
  expressed by `readiness`, not by `required`** (a read level may leave `projectId` empty
  while a write level needs it).
- `toolsOf` replaces the static `readTools` / `actionTools` at mount time. At level
  `read` the framework forces `actionTools` to empty **even if the hook returns some**:
  write tools are never registered at read level.
- `authorize` returns the exact URL and scopes for the chosen level (Neon: a `readonly=true`
  query parameter and repeated `category` parameters for read, none for write; scopes
  `['read']` and `['read','write']`). The OAuth flow uses the returned URL for discovery,
  the authorization request and the stored resource.
- `actionApproval` makes the card's one line from the call's arguments. It may be async and
  receives the mounted client for a read-tools connector, so a hook can resolve a branch
  name through a read call. It must return within three seconds; a throw or a timeout
  falls back to the framework's default line. Besides `line` and `danger` it may return
  `change` (what this call changes), `reversible` (false means the client asks for the
  "I know this cannot be undone" checkbox before Allow) and `target` (the object it acts
  on). The framework writes `target`, `change` and `reversible` onto the approval question,
  so a client can render a preview block without parsing the line.
- `capabilities` and `permissions` are **display only**: the client draws an operation list
  grouped by risk and one permission sentence, and hides a block whose fields are missing.
  They never register a tool. The real capability remains the mounted tool list
  (`readTools`/`actionTools`/`restTools`/the vendor toolbox). `capabilities[].preview` may
  carry `{ target, change, reversible }` as a default example; the per-call values come
  from `actionApproval`.

### Neon example (module side)

```js
// ds-bot/src/host/connectors/neon.js
export default {
  id: 'neon', displayName: 'Neon', mode: 'oauth-mcp',
  levels: ['read', 'write'], defaultLevel: 'read',
  settings: [{ name: 'projectId', label: 'Project ID' }, { name: 'roleName', label: 'Role name' }],
  normalizeSettings: ({ projectId = '', roleName = '' }) => {
    if (projectId !== '' && !/^[a-z0-9-]{1,60}$/.test(projectId)) throw new Error('A project id looks like spring-brook-12345678')
    if (roleName !== '' && !/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(roleName)) throw new Error('A role starts with a letter')
    return { projectId, roleName }
  },
  readiness({ level, settings }) {
    if (level === 'write' && (settings.projectId === '' || settings.roleName === '')) {
      return 'Fill in the project id and role before connecting full capabilities.'
    }
    return undefined
  },
  authorize({ level, settings }) {
    const url = new URL('https://mcp.neon.tech/mcp')
    for (const category of ['projects', 'branches', 'endpoints', 'schema', 'querying']) url.searchParams.append('category', category)
    if (level === 'read') {
      url.searchParams.set('readonly', 'true')
      if (settings.projectId !== '') url.searchParams.set('projectId', settings.projectId)
      return { url: url.href, scopes: ['read'] }
    }
    url.searchParams.set('projectId', settings.projectId)
    url.searchParams.set('roleName', settings.roleName)
    return { url: url.href, scopes: ['read', 'write'] }
  },
  toolsOf({ level }) { return { readTools: NEON_READ, actionTools: level === 'write' ? NEON_WRITE : [] } },
  actionApproval(name, args) { return { line: NEON_LINES[name](args), danger: name === 'delete_branch' } },
}
```

### State

`state.connectors[id]` keeps `level` and `settings` beside whatever the mode already keeps:

```js
{ level: 'write', settings: { projectId: 'spring-brook-12345678', roleName: 'neondb_owner' },
  grant: 'write', account: '…', connectedAt: … }
```

- A new connector starts at `defaultLevel`.
- A legacy team file with `actions: true` or `toolbox: true` maps to `level: 'write'`;
  without either it maps to `defaultLevel`.
- A legacy OAuth grant with no level: a module may declare
  `writeScopes: ['read', 'write']` style help; the framework otherwise infers from the
  stored scopes against the module's read baseline (`oauth.scopes`): a stored scope that
  is not in the read baseline means the grant is a write grant. When the grant records no
  scopes at all the connector is shown at `read` with `needsReauth: true`.
  Cloudflare's live full-access grant therefore stays write; a connector that never
  recorded scopes must be authorized again before it can write.
- `connector-disconnect` clears the grant and the secrets but **keeps `settings` and the
  chosen level**, so a reconnect does not ask for the project id again.

### View

The view row adds:

- `level`: `'read' | 'write'`; `levels`: the declared list;
- `settings`: `[{ name, label, value? }]` — current normalized values, never a secret;
- `levelNote`: the reason the row is off when `readiness` gave one;
- `needsReauth: true` when the stored grant cannot be classified (see above).

`toolbox` stays a separate field from `level`: the level is the authorization boundary
(a change re-authorizes), the toolbox is the vendor catalog mounted **inside** a write
grant. It is derived (`toolbox: level === 'write' && connector.toolbox === true`) and is a
capability flag, not a second switch to toggle. There is no `pendingLevel`: the client
preselects the new level locally, calls `connector-set-level`, and renders whatever level
the view returns after the call.

The old `actions` / `toolbox` fields stay for one release as **derived** values
(`actions: level === 'write'`, `toolbox: level === 'write' && connector.toolbox`) so a
client that has not been updated keeps working; the new client ignores them.

### Endpoints

- `connector-oauth-start { id, level? }` — `level` defaults to
  `settings.level ?? connector.defaultLevel ?? 'read'` and must be declared. The attempt
  remembers the level; the callback writes it into the grant and the state.
- `connector-set-level { id, level }` — validates the level. For an OAuth connector that
  is connected, the grant is cleared (disconnect), the row goes `off` with
  `needsReauth: true` and the client says the level change needs a new authorization. For a
  token/rest/imap/notify connector the secrets stay and the connector remounts at the new
  level.
- `connector-set-settings { id, values }` — runs `normalizeSettings` and stores the
  normalized object; remounts when the connector is configured. A validation error is a
  form error (`{ ok: false }`), not a row state.
- `connector-disconnect` — as above, keeps settings and level.

### Readiness and mounting

`readiness({ level, settings })` is asked before an OAuth start and before a mount. A
returned string leaves the row `off` with `levelNote`, refuses the start with that text and
**skips the mount**; it never becomes a mount error such as "offers none of the read
tools".

### Read-only profile

When `rt.readOnly() !== undefined` (a read-only DSH profile) the connector is forced to
`read`: `connector-set-level` refuses with the profile's reason, no write tool is
registered, and an approval request resolves `unavailable`. Connecting at read level still
works.

## Write-capable modes

### read-tools / mcp-client

A module declares `readTools` (always mounted) and `actionTools` (mounted only at a write
level). Every action tool's execute asks before the call. GitHub moves from `mcp-client` to
`read-tools` (explicit read list plus write list with approval); if that migration proves
too costly it may fall back to a `tools/pre-execute` gate over an explicit write-name
allow-list, with evidence why.

### rest-tools

`restTools` entries gain `write: true`:

```js
{ name, description, method: 'POST', write: true,
  path, body: { field: 'argumentName', other: { const: value },
                list: { items: { field: 'argumentName' | { const: value } } } },
  approval(args) { return { line, danger, change, reversible, target } },  // optional, async allowed
  parameters }
```

Validation at build time: a POST must declare exactly one of `readOnly: true` or
`write: true`, and both need an explicit `body` mapping. A body field may be a **list of
objects** when it names its element schema (`items`): every element is built from the
declared sub-fields only, so an argument the definition does not name never reaches the
request, and a list that does not fit the schema is refused before the call. Only level
`write` registers the write tools; every execute asks first and sends nothing unless
allowed. The body and header rules of read-only POST do not change.

`approval(args, { read })` may be async: a connector that wants to name the target on the
card (ima's note title, WeRead's shelf name) can read it first and return the real name;
the framework waits at most three seconds and falls back to the method and path. `read` runs
one **read-only** tool of the same connector (never a write tool) and returns its text, so
resolving a name cannot change anything; it answers undefined when the connector has no
such read tool. The card's fields match `actionApproval` (`line`, `danger`, `change`,
`reversible`, `target`).

### toolboxes

The vendor toolbox (Cloudflare's endpoint catalog, Vercel's server) is a capability subset
of the write level: at read level only the named read tools are mounted; at write level the
search/call tools are mounted too and every write-class target asks before it runs.
Blocked targets (Cloudflare credential tools, Vercel environment values) stay permanently
denied — no level and no approval can run them.

### notify

A message send is a write: at read level no send tool is registered. At write level a
messaging connector sends **automatically by default** (`autoPush !== false`), so a Bot
that reports progress does not raise one approval card per message. The card shows the
value in force — an unset switch reads as on — and a switch can turn the per-message card
back on (`connector-set-auto-push { id, enabled: false }`); a change takes effect at once.
With the card on, the chat and the message text are shown (redacted and cut at 200
characters) and a refusal sends nothing. Each automatic send appends one audit entry to the
team state (`{ at, source, result }`, never the message body).

A messaging connector sends at most 20 messages a minute, counted per host and per
connector, so one connector's burst never blocks another's. The limit covers the automatic
and the approved path alike, and the refused attempt is audited as a failure without the
message. The WeChat channel follows the same rule through its own module tool (webhook and
ClawBot transports: automatic sends, one audit entry per send without the body, 20 a
minute). Every other connector write keeps the approval described above unchanged.

## Approval card with arguments

`approve` grows an optional summary:

```js
approve({ sessionId, connector, tool, summary: { line, danger }, signal })
```

- The module supplies `summary.line` (`actionApproval` for read-tools/mcp-client,
  `restTools[].approval` for REST, the shared helpers for IMAP/SMTP, the framework for
  notify). The framework redacts it and cuts it at 200 characters, then writes it into the
  card's `detail`; `danger` adds the destructive wording to the same line.
- Without a hook: `<tool>` plus the redacted JSON arguments cut at 200 characters.
- Diagnostics record only connector, tool, Bot and outcome — never the arguments.
- Outcomes stay `allow` / `deny` / `timeout` / `cancelled` / `unavailable`; only `allow`
  runs the call, once.

## P3 contract: IMAP write session (`_imap.js`, QQ mail line)

Extend the shared core; the read tools keep EXAMINE and BODY.PEEK unchanged.

- `ImapClient` gains `select(folder)`, `storeFlags(uids, add, remove)`,
  `move(uids, folder)`, `append(folder, flags, date, raw)` and `uidExpunge(uids)`.
  Delete means "move to Trash" by default; a permanent delete uses `UID EXPUNGE` only when
  the server advertises UIDPLUS and otherwise refuses (never a bare EXPUNGE).
  `MOVE` is used when advertised, else COPY + STORE `\Deleted` for the move case.
- `createImapWriteTools({ id, displayName, credential, account, host, port, approve })`
  registers `mark_read`, `mark_unread`, `move_messages`, `delete_messages` and
  `save_draft` (APPEND to Drafts). Each execute calls
  `approve({ tool, line, danger, exec })` first, with a summary naming the folder, the
  number of messages and the UIDs; `exec` is the tool call's exec, so the framework can
  address the card to the Session running it. Nothing is sent when refused.
- Modules opt in with `imap: { write: true }` and mount `createImapWriteTools(...)`
  themselves inside `mountTools`, which receives `{ level, settings, approve }`: they add
  the write tools only when `level === 'write'`. The framework does not mount them
  itself; it supplies the approval entry that turns a helper's summary into the card.
- Tests: a mocked IMAP server asserts the command list (no write command at read level,
  no bare EXPUNGE), refusal means no command at all, UID limits and folder quoting.

## P4 contract: `_smtp.js` (Gmail line)

A new shared module beside `_imap.js`, no new dependency:

- `SmtpClient`: implicit TLS (465 by default), AUTH LOGIN, `MAIL FROM` / `RCPT TO` /
  `DATA`, dot stuffing, timeouts, friendly errors without credentials.
- MIME builder: RFC 2047 header encoding, text/plain plus optional HTML, base64
  attachments (at most 10 files and 15 MB in all), Message-ID and Date, In-Reply-To and
  References for a reply, attachments kept on forward.
- `createSmtpTools({ id, displayName, credential, account, smtp, approve })` registers
  `send_email`, `reply_email` and `forward_email`. **The From address must equal the
  connected account**; To/Cc are capped (20 recipients); every execute calls
  `approve({ tool, line, danger, exec })` with a summary of recipients, subject, the first
  80 characters of the body and the attachment names; `exec` addresses the card to the
  running Session.
- Modules opt in with `smtp: { host, port }` and mount `createSmtpTools(...)` themselves
  inside `mountTools` (`{ level, settings, approve }`), only when `level === 'write'`;
  they pass the same app password / authorization code the IMAP side uses. The framework
  supplies the approval entry.
- Tests: a mock TLS SMTP server, MIME parsing of a sent message, refusal means no
  connection, a mismatched From is refused before connecting.

## P2/P5 order and tests

P0 (level, authorize, settings, readiness, view, endpoints), P1 (approval summary,
capability registration, read-only profile, configure unavailable), P2 (REST write POST),
then P3 and P4 in parallel, then P5 hardening.

The framework test matrix: a write tool is absent at read level; allow runs it once; deny,
timeout, dismissal and a cancelled Session run nothing (the mock service sees no request);
a read-only profile refuses the level and the tools; blocked targets stay denied; a
readiness reason keeps the row off without a mount error; arguments never reach
diagnostics; a legacy team file maps to the right level.

## Effort

P0 6–8h, P1 5–7h, P2 4–6h, P5 6–8h; P3 10–14h and P4 12–16h in their lines. Calendar
target with the split: 3–4 days.
