# Architecture Documentation

System architecture documentation for Epicenter's distributed sync system.

## Documents

| Document                                  | Description                                                      |
| ----------------------------------------- | ---------------------------------------------------------------- |
| [Network Topology](./network-topology.md) | Node types (client/server), connection rules, example topologies |
| [Device Identity](./device-identity.md)   | How devices identify themselves, server URLs, registry entries   |
| [Action Dispatch](./action-dispatch.md)   | Cross-device action invocation via YJS command mailbox           |
| [Security](./security.md)                 | Security layers (Tailscale, content-addressing), threat model    |

## Quick Reference

> **Topology note:** Epicenter uses a three-tier architecture. The diagrams below show the local-mesh layer (Phase 3): browsers talking to their local sidecar (`createLocalServer`), and sidecars syncing peer-to-peer. The remote server (`createRemoteServer`) is a separate cloud tier that handles auth (Better Auth), AI streaming (`/ai/chat`), and an ephemeral Yjs relay. The SPA routes data sync to the local sidecar and AI requests to the remote server. Cross-device sync via the remote server (Phase 4) is not yet wired. See [Network Topology](./network-topology.md) for the full picture.

### Node Types

| Type          | Runtime  | Can Accept Connections | Can Serve Blobs | Notes                                         |
| ------------- | -------- | ---------------------- | --------------- | --------------------------------------------- |
| Client (SPA)  | Browser  | No                     | No              | Data → local sidecar; AI → remote server      |
| Local Sidecar | Bun/Node | Yes                    | Yes             | `createLocalServer`; workspace CRUD, actions  |
| Remote Server | Bun/Node | Yes                    | No              | `createRemoteServer`; auth, AI proxy, Yjs relay |

### Connection Rules

```
Client ──► Local Sidecar   ✅  (WebSocket, HTTP — data sync)
Client ──► Hub             ✅  (HTTP — AI streaming, auth)
Client ──► Client          ✅  (via YJS action dispatch, not direct connection)
Server ──► Server          ✅  (WebSocket)
Server ──► Client          ✅  (via YJS action dispatch, not direct connection)
```

Note: Direct connections are only possible **to** servers. However, any device can invoke actions on any other device via [action dispatch](./action-dispatch.md) through the shared Y.Doc.

### Typical Setup (Local Mesh — Phase 3)

```
         ┌─────────┐           ┌─────────┐
         │LAPTOP A │           │LAPTOP B │
         │ Browser │           │ Browser │
         │    ▼    │           │    ▼    │
         │ Sidecar ◄├───────────┼► Sidecar│     ┌────────┐
         └────▲────┘           └────▲────┘     │ PHONE  │
              │                     │          │Browser │
              └─────────────────────┴──────────┴───┘
```

AI requests from all browsers go to the remote server (cloud), not to the local sidecar.

## Related Documentation

- [Blob System](../blobs/README.md): How binary files sync
- [SYNC_ARCHITECTURE.md](../../SYNC_ARCHITECTURE.md): Yjs sync details
