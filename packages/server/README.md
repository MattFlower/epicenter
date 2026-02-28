# Epicenter Server

Two server constructors — `createRemoteServer` and `createLocalServer` — implementing a three-tier topology where all workspace knowledge lives on local servers and the remote server knows nothing about workspace schemas.

## Three-Tier Topology

```
Remote Server (cloud)
  - Better Auth (sessions, JWT, JWKS)
  - AI proxy (injects env var API keys, keys never leave remote server)
  - AI streaming (SSE chat for all providers via /ai/chat)
  - Yjs relay (/rooms — EPHEMERAL Y.Docs, pure relay, NO persistence)

  Does NOT have: workspace configs, extensions, actions, any persistence

        ^
        | cross-device Yjs sync + AI requests
        |

Local Server A (Device 1)          Local Server B (Device 2)
  - Workspace CRUD                   - Workspace CRUD
  - Extensions (FS projections)      - Extensions (FS projections)
  - Actions                          - Actions
  - Persisted Y.Docs                 - Persisted Y.Docs
  - Local Yjs relay (SPA <-> Y.Doc)  - Local Yjs relay (SPA <-> Y.Doc)
  - Validates auth against remote     - Validates auth against remote

  Does NOT have: AI streaming, auth issuance, API keys

        ^                                  ^
        | sub-ms WebSocket sync            | sub-ms WebSocket sync
        |                                  |

SPA / WebView A                    SPA / WebView B
```

### Sync Scopes

1. **Local relay** (`/rooms` on local server): SPA Y.Doc <-> server's persisted Y.Doc, same machine, sub-millisecond latency.
2. **Remote relay** (`/rooms` on remote server): cross-device sync between local servers (Phase 4, enabled with `--hub` flag).

### Auth Flow

The remote server issues sessions via Better Auth. Local servers validate tokens by calling the remote server's `/auth/get-session` — they never issue sessions themselves.

### AI Flow

All AI requests go to the remote server's `/ai/chat`. The remote server injects API keys from its environment and streams back to the caller. API keys never leave the remote server.

---

## Remote Server

The remote server is a stateless coordination layer. Its Y.Docs are ephemeral and schema-agnostic — it has no knowledge of what data those documents contain. Workspace schemas, table definitions, and business logic live entirely on local servers.

**What it does:**
- Issues and validates sessions (Better Auth, JWT, JWKS endpoint)
- Relays Yjs sync between devices (`/rooms`)
- Proxies AI requests with server-side API keys (`/ai/chat`, `/proxy/:provider/*`)
- Streams AI responses back to callers (SSE)

**What it does NOT do:**
- Persist Y.Docs (rooms are evicted when empty)
- Know anything about workspace schemas, tables, or extensions
- Store workspace configurations or action definitions
- Issue commands to local servers

```typescript
import { createRemoteServer } from '@epicenter/server';

const remote = createRemoteServer({ port: 3914 });
remote.start();
```

### Remote Server Routes

```
/                        - Discovery root
/rooms/                  - Active rooms (ephemeral)
/rooms/{roomId}          - WebSocket sync relay
/ai/chat                 - AI streaming (SSE)
/auth/*                  - Better Auth endpoints
/proxy/{provider}/*      - AI provider proxy (env var keys)
```

### Remote Server Config

```typescript
type RemoteServerConfig = {
  /** Port to listen on. Defaults to 3913 (or PORT env var). */
  port?: number;
  /** Better Auth configuration for session-based auth. */
  auth?: AuthPluginConfig;
  /** Sync plugin options. */
  sync?: {
    auth?: AuthConfig;
    onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
    onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
  };
};
```

---

## Local Server

The local server is where all workspace knowledge lives. It owns the persisted Y.Docs, understands the workspace schema, and exposes tables and actions over HTTP. The SPA connects to the local server for all reads and writes.

**What it does:**
- Persists Y.Docs to disk
- Serves workspace tables as REST CRUD endpoints
- Runs workspace actions
- Hosts extensions (e.g. filesystem projections)
- Relays Yjs between the SPA and local Y.Doc (`/rooms`)
- Validates auth tokens by calling the remote server

**What it does NOT do:**
- Issue sessions or JWTs
- Hold AI API keys or stream AI responses
- Run cross-device sync directly (that goes through the remote server)

```typescript
import { defineWorkspace, createWorkspace, id, text } from '@epicenter/workspace/static';
import { createLocalServer } from '@epicenter/server';

const blogWorkspace = defineWorkspace({
  id: 'blog',
  tables: {
    posts: { id: id(), title: text() },
  },
});

const blogClient = createWorkspace(blogWorkspace);

const server = createLocalServer({
  clients: [blogClient],
  port: 3913,
  hubUrl: 'https://remote.example.com', // omit for open/dev mode
});
server.start();
```

Tables are immediately available:

```
GET  http://localhost:3913/workspaces/blog/tables/posts
POST http://localhost:3913/workspaces/blog/tables/posts
```

### Local Routes

```
/                                              - Discovery root
/rooms/                                        - Active rooms
/rooms/{workspaceId}                           - WebSocket sync (SPA <-> Y.Doc)
/workspaces/{workspaceId}/tables/{table}       - RESTful table CRUD
/workspaces/{workspaceId}/tables/{table}/{id}  - Single row
/workspaces/{workspaceId}/actions/{action}     - Workspace actions
```

### Local Config

```typescript
type LocalServerConfig = {
  /** Workspace clients to expose via REST CRUD and action endpoints. */
  clients: AnyWorkspaceClient[];
  /** Port to listen on. Defaults to 3913 (or PORT env var). */
  port?: number;
  /** Remote server URL for session token validation. Omit for open mode. */
  hubUrl?: string;
  /** CORS allowed origins. Default: ['tauri://localhost'] */
  allowedOrigins?: string[];
  /** Sync plugin options. */
  sync?: {
    auth?: AuthConfig;
    onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
    onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
  };
};
```

---

## Server Interface

Both constructors return the same interface:

```typescript
server.app;        // Underlying Elysia instance
server.start();    // Start the HTTP server
await server.stop(); // Stop server and clean up resources
```

---

## WebSocket Sync Protocol

Clients connect to `/rooms/{workspaceId}` on either the local or remote server. The recommended client is `createSyncExtension` from `@epicenter/workspace/extensions/sync`:

```typescript
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';

const client = createClient(definition.id)
  .withDefinition(definition)
  .withExtension('sync', createSyncExtension({
    url: 'ws://localhost:3913/rooms/{id}',
  }));
```

The sync plugin implements the y-websocket protocol with one custom extension:

| Message Type    | Tag | Direction                | Purpose                                       |
| --------------- | --- | ------------------------ | --------------------------------------------- |
| SYNC            | 0   | Bidirectional            | Document synchronization (step 1, 2, updates) |
| AWARENESS       | 1   | Bidirectional            | User presence (cursors, names, selections)    |
| QUERY_AWARENESS | 3   | Client → Server          | Request current awareness states              |
| SYNC_STATUS     | 102 | Client → Server → Client | Heartbeat + `hasLocalChanges` tracking        |

**SYNC_STATUS (102):** The client sends its local version counter; the server echoes the bytes back unchanged. Powers "Saving..." / "Saved" UI indicators.

### Room Eviction

When the last client disconnects, a 60-second eviction timer starts. If no client reconnects in that window, the room is destroyed. On the remote server, this means the Y.Doc is gone permanently — it has no backing storage.

---

## Composable Plugins

The servers are built from modular Elysia plugins you can use directly:

```
createLocalServer()
├── Sync Plugin        → /rooms/:room           (local relay)
├── Workspace Plugin   → /workspaces/:id/...    (REST CRUD + actions)
└── CORS + Auth        (Tauri-only protection)

createRemoteServer()
├── Sync Plugin        → /rooms/:room           (cross-device relay, ephemeral)
├── AI Plugin          → /ai/...                (streaming)
├── Auth Plugin        → /auth/...              (Better Auth)
└── Proxy Plugin       → /proxy/:provider/*     (AI provider proxy)
```

```typescript
import { createWorkspacePlugin } from '@epicenter/server/workspace';

// Use workspace plugin standalone in your own Elysia app
const app = new Elysia().use(createWorkspacePlugin([blogClient])).listen(3913);
```

---

## RESTful Tables

| Method   | Path                                          | Description         |
| -------- | --------------------------------------------- | ------------------- |
| `GET`    | `/workspaces/{workspace}/tables/{table}`      | List all valid rows |
| `GET`    | `/workspaces/{workspace}/tables/{table}/{id}` | Get row by ID       |
| `POST`   | `/workspaces/{workspace}/tables/{table}`      | Create or upsert    |
| `PUT`    | `/workspaces/{workspace}/tables/{table}/{id}` | Update row fields   |
| `DELETE` | `/workspaces/{workspace}/tables/{table}/{id}` | Delete row          |

**Success:** `{ "data": { "id": "123", "title": "Hello" } }`

**Error:** `{ "error": { "message": "What went wrong" } }`

---

## Server vs Scripts

Use a direct client (script) for one-off operations; use the server for long-running services.

```typescript
// Script: client disposed after the block
{
  await using client = createWorkspace(blogWorkspace);
  client.tables.posts.upsert({ id: '1', title: 'Hello' });
}

// Server: client lives until server.stop()
const client = createWorkspace(blogWorkspace);
const server = createLocalServer({ clients: [client] });
server.start();
```

If a server is already running, use its HTTP API instead of opening a second client (avoids storage conflicts):

```typescript
await fetch('http://localhost:3913/workspaces/blog/tables/posts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: '1', title: 'New Post' }),
});
```

---

## CLI

```bash
# Start remote server (sync relay + AI + auth)
bun run src/start-hub.ts

# Start local server (sync relay + workspace CRUD)
bun run src/start-local.ts
```

The `serve` command in the Epicenter CLI uses `createLocalServer` internally.
