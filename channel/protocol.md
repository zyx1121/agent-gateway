# `outpost-channel` ↔ `outpost-daemon` protocol — v0

Wire protocol between the Claude Code channel plugin and the outpost daemon. Both run on the same host. The channel is a stdio MCP subprocess spawned by `claude --channels`; the daemon is a long-running process that owns the Telegram bot and Claude's lifecycle.

This doc covers the wire only. For the broader architecture rationale see [`README.md`](../README.md).

## Topology

```
                 ┌──────────────────────────────────────────┐
                 │              outpost-daemon              │
                 │   (Telegram bot · supervisor · router)   │
                 └────────────────┬─────────────────────────┘
                                  │ Unix domain socket
                                  │ NDJSON, bidirectional
                 ┌────────────────┴────────────────┐
                 │         outpost-channel         │  ← MCP stdio server
                 └────────────────┬────────────────┘
                                  │ stdio
                                  ▼
                 ┌──────────────────────────────────────────┐
                 │ claude --channels server:outpost-channel │
                 └──────────────────────────────────────────┘
```

The daemon is the parent of `claude`; `claude` is the parent of `outpost-channel`. The socket inverts this: the channel (grandchild) connects up to the daemon (grandparent).

## Transport

| | |
|---|---|
| Type | Unix domain socket |
| Default path | `/run/outpost.sock`, overridable via `OUTPOST_SOCK` |
| Permissions | `0600`, owned by the daemon's user — filesystem ACL is the only auth boundary |
| Encoding | UTF-8 NDJSON — one JSON object per line, terminated by `\n` |
| Max line | 1 MiB. Longer lines are dropped with a stderr log on the receiving side |

## Connection lifecycle

1. **Daemon start** — bind socket, listen.
2. **Channel start** — spawned by claude reading `.mcp.json`. The channel opens the socket and immediately sends `hello`.
   - On `ECONNREFUSED` / `ENOENT`: log to stderr and keep the stdio MCP side alive. Claude still works; reply calls are dropped until daemon is back. No automatic reconnect — claude will be restarted by the daemon when it recovers, which respawns this channel.
3. **Daemon receives `hello`** — register the channel as the active downstream. Subsequent inbound messages route here.
4. **Reply round-trip** — channel sends `reply`, daemon answers `ack`. The channel surfaces the ack as the MCP tool result (`sent` on success, error text otherwise).
5. **Socket close** — clear active downstream on the daemon side. Inbound messages buffer (max 16) until the next channel connects or are dropped.
6. **Claude exit** — channel exits with it (stdio EOF). Daemon's process supervisor sees `claude` die and respawns.

There is at most one channel connected at a time. Multi-claude routing is out of scope for v0.

## Messages

Every message has a `type`. Unknown types are ignored with a stderr log.

### Daemon → Channel

#### `inbound`

Forward an external event to claude as a `<channel>` notification.

```json
{
  "type": "inbound",
  "content": "where is the auth middleware?",
  "meta": {
    "chat_id": "tg:12345",
    "user": "loki",
    "ts": "2026-05-14T10:32:00Z"
  }
}
```

- `content` — the message body. Lands as the body of the `<channel>` tag.
- `meta` — `Record<string, string>`. Each key becomes an attribute on the `<channel>` tag. Keys must match `[a-z][a-z0-9_]*`; non-conformant keys are silently dropped by Claude Code itself.

The channel forwards this verbatim to claude via `notifications/claude/channel`.

### Channel → Daemon

#### `hello`

Sent once on socket connect. The daemon expects this before forwarding any `inbound`.

```json
{
  "type": "hello",
  "protocol": "v0",
  "channel_version": "0.1.0",
  "pid": 12345
}
```

- `protocol` — protocol version. Daemon closes the connection if the value isn't recognized.
- `channel_version` — informational, for logs.
- `pid` — channel pid. Daemon uses this for liveness checks.

#### `reply`

Claude called the `reply` MCP tool. Forward to the chat platform.

```json
{
  "type": "reply",
  "chat_id": "tg:12345",
  "text": "It's in src/auth/middleware.ts:45."
}
```

- `chat_id` — must echo a previously-sent `inbound`'s `chat_id`. Daemon maps this back to the Telegram chat.
- `text` — raw markdown. The daemon does the markdown → Telegram HTML transform.

The daemon must answer with `ack` (next section). Tool calls are single-threaded on Claude's side, so at most one `reply` is in flight at a time — no correlation id is needed in v0.

### Daemon → Channel

#### `ack`

Response to the most recent `reply`.

```json
{ "type": "ack", "for": "reply", "ok": true }
```

On failure:

```json
{ "type": "ack", "for": "reply", "ok": false, "error": "chat not found" }
```

The channel returns `'sent'` from the `reply` tool on `ok: true`, otherwise the error string. Claude sees this and can decide whether to retry or surface the failure.

## Future extensions — not in v0

- `edit` (channel → daemon) — implements `edit_message` MCP tool. Requires the daemon to track outbound Telegram message ids keyed by `chat_id`.
- `react` (channel → daemon) — emoji reaction on a previous inbound.
- `permission_request` (daemon → channel) + `permission` (channel → daemon) — implements the [permission relay capability](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts) so Bash / Write approvals can come from Telegram. Adds `claude/channel/permission` to the MCP capabilities.
- `metrics` (channel → daemon, periodic) — RSS, tool call counts, last activity timestamp.
- `seq` correlation ids on `reply` / `ack` — only needed if multi-channel ever becomes a thing.

## Out of scope

- **Streaming partial replies.** `reply` is atomic by MCP-tool design. Claude calls `reply` once at the end of a turn, not incrementally during. Streaming-style "edit-in-place as Claude thinks" UX is not feasible without faking it with multiple `reply` calls, which we're not doing.
- **Multiple concurrent claudes per daemon.** v0 is strictly 1 daemon : 1 claude : 1 channel. If multi-workspace ever needs concurrent processes, that's a v1 redesign.
- **Inbound persistence across daemon restarts.** If the daemon is down when a Telegram message arrives, that message is lost. The daemon is meant to be the most stable process in the system; if it isn't, fix the daemon, don't add a queue.
- **Cross-host transport.** Unix socket only. Channel and daemon must share a filesystem.

## Reference: minimal channel sketch

Stripped-down, omitting reconnect and graceful shutdown. See `channel.ts` for the real one once it lands.

```ts
import { connect } from 'net'

const sock = connect(process.env.OUTPOST_SOCK ?? '/run/outpost.sock')
sock.write(JSON.stringify({ type: 'hello', protocol: 'v0', channel_version: '0.1.0', pid: process.pid }) + '\n')

let buf = ''
sock.on('data', (chunk) => {
  buf += chunk.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
    const msg = JSON.parse(line)
    if (msg.type === 'inbound') {
      mcp.notification({ method: 'notifications/claude/channel', params: { content: msg.content, meta: msg.meta } })
    } else if (msg.type === 'ack') {
      pendingAck?.resolve(msg)
    }
  }
})

mcp.tool('reply', async ({ chat_id, text }) => {
  sock.write(JSON.stringify({ type: 'reply', chat_id, text }) + '\n')
  const ack = await new Promise<Ack>((resolve) => { pendingAck = { resolve } })
  return ack.ok ? 'sent' : `failed: ${ack.error}`
})
```

## Versioning

This is `v0`. Breaking changes bump the major. Additive fields (new message types, new optional fields on existing types) do not bump.

If the daemon receives a `hello` with an unrecognized `protocol`, it closes the connection with an error logged to stderr — no error message back to the channel because the channel might not understand the response format anyway.
