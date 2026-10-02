# @platform/consent

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Consent** subsystem (id `consent`, featurized, Window scope). It records what the user agreed to, per category, under a **policy version**, and answers the question every telemetry path asks: `isGranted(category)`.

- **Fails closed**: a category without a current grant is off.
- **`necessary` is always granted**: essential use never depends on consent.
- **Policy versions**: raise the version and every earlier decision stops counting; `views.pending` lists what to ask again.
- **Persisted**: decisions are kept through the kernel's persistence (Storage, from M6).
- **Broadcast**: every change is announced as `consent:changed`.
- **Shared by every tab of the site** (Window scope, with `@platform/hub`'s Window transport): a decision in one tab reaches the others, and a new tab asks the open ones for theirs (`consent:sync`, answered with `consent:state`). Per category, the newer decision wins.

Retention rules and data-subject requests (export, erase) need Storage and arrive with it in M6. Design: [ARCHITECTURE §13](../../docs/ARCHITECTURE.md#13-subsystem-catalogue) and the amended [Consent proposal](../../proposals/consent_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/consent": "workspace:*"
  }
}
```

## Entry points

| Import              | Contents                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `@platform/consent` | `createConsent`, `isConsentGranted`, `CONSENT_ID`, `CONSENT_CHANGED`, `NECESSARY`, `DEFAULT_CATEGORIES`, types |

## Usage

```ts
import { createConsent } from '@platform/consent';

const kernel = new Kernel([...centralized, createConsent({ policyVersion: 2 }), ...subsystems], {
  router: queue.router,
  persistence,
});
```

A consent banner:

```ts
import type { ConsentControl } from '@platform/consent';

const { commands, views } = kernel.unit<ConsentControl>('consent').control!;

views.pending.subscribe(() => (banner.hidden = views.pending.getSnapshot().length === 0));
acceptAll.onclick = () => commands.grantAll();
rejectAll.onclick = () => commands.revokeAll();
save.onclick = () => commands.set({ analytics: analyticsBox.checked, marketing: false });
```

Gating, from a subsystem that declares `{ target: 'consent' }` in `requires`:

```ts
if (ctx.dependency<ConsentControl>('consent')?.commands.isGranted('analytics')) track(event);
```

Or reacting to changes, from a subsystem that lists `consent:changed` in `subscribes`:

```ts
receive: (packet) => {
  for (const change of packet.take() as ConsentChange[]) apply(change.category, change.granted);
};
```

## Behaviour

| Call                                       | Result                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `isGranted('necessary')`                   | `true`                                                                                    |
| `isGranted(category)`                      | `true` only for a grant made under the current policy version; unknown categories `false` |
| `grant` / `revoke`                         | `true` when the gate changed; the decision is recorded either way                         |
| `revoke('necessary')`                      | Ignored: `false`                                                                          |
| `set(decisions)`, `grantAll`, `revokeAll`  | One state update and one `consent:changed` broadcast with every effective change          |
| An explicit "no" for an undecided category | Recorded (it leaves `pending`), not broadcast (the gate did not change)                   |
| A category not in `categories`             | `RangeError`                                                                              |
| The broadcast is refused                   | Reported to the kernel's `onError`; the decision stands                                   |
| A decision arrives from another tab        | Merged: the newer decision per category wins; views update                                |
| This tab starts                            | Broadcasts `consent:sync`; open tabs answer with their records                            |

## Options

| Option          | Default                                                 | Purpose                                   |
| --------------- | ------------------------------------------------------- | ----------------------------------------- |
| `policyVersion` | `1`                                                     | Raise it to ask every category again.     |
| `categories`    | `['necessary', 'functional', 'analytics', 'marketing']` | The categories; must include `necessary`. |
| `now`           | `Date.now`                                              | Clock.                                    |

## Testing

```bash
pnpm exec vitest run --project node packages/consent
```
