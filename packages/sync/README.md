# @webkrnl/sync

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/sync) and [JSR](https://jsr.io/@webkrnl/sync).

The **Sync** subsystem (id `sync`, featurized, Tab scope). It gets the changes of the user to the server, **exactly once**, also after hours offline:

- **Entities**: `entity({ name, push, pull?, apply?, merge?, conflict? })` declares an entity type and returns a handle with `create`, `update`, `remove` and `pending`.
- **Outbox**: each change waits in an outbox until the server confirms it. When Storage runs, the outbox is the collection `sync.outbox.<name>`, so changes survive a reload.
- **No duplicates**: each change has a stable id. The push handler sends it as the `Idempotency-Key`, so a retry is applied once by the server. Two waiting changes to one entity merge, but only when the first was never sent.
- **One replayer**: the outbox is shared by every tab of the origin, and a Web Lock lets one tab send it at a time.
- **Failures**: transient failures retry with backoff, and later changes to the same entity wait behind them. Permanent failures (4xx) go to `failed` and `sync:failed`.
- **Conflicts**: `server-wins`, `client-wins`, `merge`, or `manual` with `resolve(id, choice)`.
- **Pull**: `pull(cursor)` gives changes from the server, and `apply` writes them. A waiting local change wins.
- **Pending work**: Global State shows what waits, one entry for each entity type ("3 changes to todos waiting").

Network is required; Storage is late-bound. Design: [ARCHITECTURE §19.3](../../docs/ARCHITECTURE.md#193-sync) and the amended [Sync proposal](../../docs/proposals/sync_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/network": "workspace:*",
    "@webkrnl/sync": "workspace:*"
  }
}
```

## Entry points

| Import          | Contents                                                         |
| --------------- | ---------------------------------------------------------------- |
| `@webkrnl/sync` | `createSync`, `Outbox`, `mergeOps`, `isPermanent`, and the types |

## Usage

```ts
import { createSync, type SyncControl } from '@webkrnl/sync';

const kernel = new Kernel([...centralized, createStorage(), createNetwork(), createSync()], {
  router: queue.router,
});
await kernel.start();

const { commands, views } = kernel.unit<SyncControl>('sync').control!;
const todos = commands.entity<Todo>({
  name: 'todos',
  push: async (change, { network }) => {
    const response = await network.commands.request<Todo>({
      url: `/todos/${change.entityId}`,
      method: change.op === 'delete' ? 'DELETE' : 'PUT',
      body: change.data ?? undefined,
      idempotencyKey: change.id,
      allowErrorStatus: true,
    });
    if (response.status === 409) return { conflict: response.data };
    if (response.status >= 400)
      throw Object.assign(new Error('push failed'), { status: response.status });
  },
  conflict: 'server-wins',
});

await todos.update('t1', { title: 'Buy tea', done: false }); // works offline too
views.state.subscribe(() => showBadge(views.state.getSnapshot().pending));
```

The push handler decides how a change reaches your API. Throw an error with a `status` of 4xx for a permanent failure.

## Recommended flow

1. **Push through Network** (`tools.network`), not `fetch`. Then the Auth token, the `401` refresh, the retries and the offline check all apply.
2. **Send `change.id` as the `Idempotency-Key`** on every push. On the server, keep each key with its result for as long as a device can stay offline (days), and scope it to the user. A key that comes back returns the first result and applies nothing.
3. **Answer conflicts with `409` and the current version**, and choose a strategy for each entity: `server-wins` for data that the server owns, `merge` for documents, `manual` when the user must decide.
4. **Return permanent errors as 4xx** (for example, `422` for invalid data), so Sync stops retrying, and transient errors as `5xx` or `429`, so it retries.
5. **Use Storage**, so the outbox survives a reload. The outbox holds user data, so it follows the sign-out rule (ARCHITECTURE §5.1): the changes of a user must not reach the next user of the device. Sync wipes the outbox and the cursors on sign-out by itself.
6. **Pull with a cursor** that the server gives, and let `apply` write to your local data (a Storage collection). A waiting local change wins over the server's version until it is pushed.

## Behaviour

| Situation                                               | Result                                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sign-out, or another user signs in (ARCHITECTURE §5.1)  | The outbox (waiting, failed and conflicting changes) and the pull cursors are wiped, in memory and in Storage |
| A change while online                                   | Sent at once                                                                                                  |
| A change while offline                                  | Waits; `status` is `OFFLINE`; the pending work shows the count                                                |
| Back online                                             | The outbox is sent, oldest first, then a pull                                                                 |
| A response is lost and the request is sent again        | The server applies the change once (same idempotency key)                                                     |
| Transient failure (offline, timeout, 5xx, 429)          | The change stays; retry with backoff; later changes of the entity wait                                        |
| Permanent failure (other 4xx)                           | `failed`; `sync:failed`; `retryFailed()` puts it back                                                         |
| The server answers with a conflict                      | The entity's strategy decides; `manual` waits for `resolve`                                                   |
| Two tabs with the same outbox                           | One tab sends it at a time                                                                                    |
| A reload with changes in the outbox (Storage)           | The changes come back and are sent                                                                            |
| No Web Locks API (outside the supported browsers, §1.1) | Two tabs can push the same change at the same time; the idempotency key still makes the server apply it once  |
| `pause()`                                               | No automatic runs until `resume()`                                                                            |

## Options

| Option        | Default   | Purpose                                     |
| ------------- | --------- | ------------------------------------------- |
| `intervalMs`  | `300_000` | Automatic runs while visible, or `false`.   |
| `retryBaseMs` | `1_000`   | The base wait after a transient failure.    |
| `name`        | `default` | The name of the outbox and of the Web Lock. |

## Testing

```bash
pnpm exec vitest run --project node packages/sync
```

`test/gate.spec.ts` is the M7 gate: offline work, then online with failures, and every change applied once while the pending work matches the outbox.
