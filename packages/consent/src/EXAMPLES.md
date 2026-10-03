# Examples: `@platform/consent`

Consent records what the user agreed to, for each category, under a policy version. It answers `isGranted`, fails closed, keeps `necessary` granted, and shares the decisions with the other tabs of the site.

## Drive a consent banner

<!-- example id="consent/banner" runtime="any" -->

The banner shows while a category has no decision. The user accepts functional cookies and refuses analytics and marketing. One `set` call records the three decisions.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CONSENT_ID, createConsent, type ConsentControl } from '@platform/consent';

const kernel = new Kernel([createConsent()]);
await kernel.start();
const { commands, views } = kernel.unit<ConsentControl>(CONSENT_ID).control!;

console.log('ask about:', JSON.stringify(views.pending.getSnapshot()));

// The user clicks "Save choices".
commands.set({ functional: true, analytics: false, marketing: false });

console.log('ask about:', JSON.stringify(views.pending.getSnapshot()));
console.log('grants:', JSON.stringify(views.grants.getSnapshot()));
console.log('analytics allowed?', commands.isGranted('analytics'));
await kernel.stop();
```

```text output
ask about: ["functional","analytics","marketing"]
ask about: []
grants: {"necessary":true,"functional":true,"analytics":false,"marketing":false}
analytics allowed? false
```

## Start analytics only after consent

<!-- example id="consent/gate-analytics" runtime="any" -->

An analytics subsystem listens to `consent:changed`. It starts to collect when the user grants analytics, and stops and deletes its buffer when the user revokes it.

```ts file=main.ts
import { Kernel, defineSubsystem } from '@platform/core';
import {
  CONSENT_CHANGED,
  CONSENT_ID,
  createConsent,
  type ConsentChange,
  type ConsentControl,
} from '@platform/consent';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

const analytics = defineSubsystem({
  id: 'analytics',
  scope: 'tab',
  kind: 'featurized',
  requires: [{ target: 'consent', kind: 'optional' }],
  subscribes: [CONSENT_CHANGED],
  state: { initial: { collecting: false, events: [] as string[] } },
  init: (ctx) => {
    const consent = ctx.dependency<ConsentControl>('consent');
    ctx.state.update((s) => void (s.collecting = consent?.commands.isGranted('analytics') ?? false));
  },
  receive: (packet, ctx) => {
    for (const change of packet.take() as ConsentChange[]) {
      if (change.category !== 'analytics') continue;
      ctx.state.update((s) => {
        s.collecting = change.granted;
        if (!change.granted) s.events = []; // delete what was collected
      });
      console.log(change.granted ? 'analytics: started' : 'analytics: stopped and cleared');
    }
  },
  control: (ctx) => ({
    commands: {
      track(event: string) {
        if (ctx.state.get().collecting) ctx.state.update((s) => void s.events.push(event));
      },
      count: () => ctx.state.get().events.length,
    },
    views: {},
  }),
});

const notification = createNotificationCenter();
const queue = createQueue({ fanOut: notification.fanOut });
const kernel = new Kernel([queue.subsystem, notification.subsystem, createConsent(), analytics], {
  router: queue.router,
});
await kernel.start();
const consent = kernel.unit<ConsentControl>(CONSENT_ID).control!;
const tracker = kernel.unit<ReturnType<typeof analytics.control>>('analytics').control!;

tracker.commands.track('page_view');
console.log('events before consent:', tracker.commands.count());

consent.commands.grant('analytics');
await new Promise((resolve) => setTimeout(resolve, 0));
tracker.commands.track('page_view');
console.log('events after consent:', tracker.commands.count());

consent.commands.revoke('analytics');
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('events after revoke:', tracker.commands.count());
await kernel.stop();
```

```text output
events before consent: 0
analytics: started
events after consent: 1
analytics: stopped and cleared
events after revoke: 0
```

## Ask again when the policy changes

<!-- example id="consent/policy-version" runtime="any" -->

Decisions persist across visits. When the legal team publishes version 2 of the policy, the old decisions stop counting and the banner asks again.

```ts file=main.ts
import { Kernel, type PersistedState, type StatePersistence } from '@platform/core';
import { CONSENT_ID, createConsent, type ConsentControl } from '@platform/consent';

const disk = new Map<string, PersistedState<object>>();
const persistence: StatePersistence = {
  load: (id) => disk.get(id),
  save: (id, state) => void disk.set(id, state),
};

async function visit(policyVersion: number, action?: (c: ConsentControl) => void) {
  const kernel = new Kernel([createConsent({ policyVersion })], { persistence });
  await kernel.start();
  const consent = kernel.unit<ConsentControl>(CONSENT_ID).control!;
  console.log(
    `policy v${policyVersion}: analytics=${consent.commands.isGranted('analytics')},`,
    `ask about [${consent.views.pending.getSnapshot().join(', ')}]`,
  );
  action?.(consent);
  await kernel.stop();
}

await visit(1, (consent) => consent.commands.grantAll()); // first visit: the user accepts all
await visit(1); // second visit: nothing to ask
await visit(2); // the policy changed
```

```text output
policy v1: analytics=false, ask about [functional, analytics, marketing]
policy v1: analytics=true, ask about []
policy v2: analytics=false, ask about [functional, analytics, marketing]
```

## Share decisions with the other tabs

<!-- example id="consent/share-between-tabs" runtime="any" -->

Consent is Window-scoped. A decision in one tab reaches the other tabs, and a tab that opens later gets the decisions of the open tabs. This example runs two kernels in one page as two tabs of a single-origin app.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { CONSENT_ID, createConsent, type ConsentControl } from '@platform/consent';
import { WINDOW_TRANSPORT_ID, createWindowTransport, type WindowTransportControl } from '@platform/hub';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';

const kernels: Kernel[] = [];
async function openTab(): Promise<ConsentControl> {
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createWindowTransport({ origin: 'https://shop.example', channel: 'consent-demo' }),
      createConsent(),
    ],
    { router: queue.router },
  );
  kernels.push(kernel);
  await kernel.start();
  const transport = kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!;
  while (transport.views.state.getSnapshot().connection !== 'connected') {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return kernel.unit<ConsentControl>(CONSENT_ID).control!;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

const first = await openTab();
const second = await openTab();
first.commands.grant('analytics');
await settle();
console.log('second tab, analytics:', second.commands.isGranted('analytics'));

const late = await openTab(); // a tab that opens after the decision
await settle();
console.log('new tab, analytics:', late.commands.isGranted('analytics'));

for (const kernel of kernels) await kernel.stop();
```

```text output
second tab, analytics: true
new tab, analytics: true
```
