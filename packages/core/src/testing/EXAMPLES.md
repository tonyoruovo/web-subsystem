# Examples: `@platform/core/testing`

Tools to test subsystems without a browser. The test platform runs the real kernel with stable ids, a test clock, a router that records each packet, and a list of the errors that the kernel reports.

## Test a subsystem with the real kernel

<!-- example id="core/test-a-subsystem" runtime="any" -->

A rate limiter allows three calls in each minute. The test platform gives it a clock that the test controls, so the test does not wait one real minute.

```ts file=main.ts
import { defineSubsystem } from '@platform/core';
import { createTestClock, createTestPlatform } from '@platform/core/testing';

const clock = createTestClock(0);

const limiter = defineSubsystem({
  id: 'limiter',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: { calls: [] as number[] } },
  control: (ctx) => ({
    commands: {
      tryCall(): boolean {
        const recent = ctx.state.get().calls.filter((t) => clock.now() - t < 60_000);
        if (recent.length >= 3) return false;
        ctx.state.update((s) => void (s.calls = [...recent, clock.now()]));
        return true;
      },
    },
    views: {},
  }),
});

const platform = createTestPlatform([limiter], { clock });
await platform.start();
const { commands } = platform.unit<ReturnType<typeof limiter.control>>('limiter').control!;

console.log('first minute:', JSON.stringify([1, 2, 3, 4].map(() => commands.tryCall())));
clock.advance(60_000);
console.log('next minute:', commands.tryCall());
console.log('status:', platform.status('limiter'));
await platform.stop();
```

```text output
first minute: [true,true,true,false]
next minute: true
status: READY
```

## Check what a subsystem sends

<!-- example id="core/test-recorded-packets" runtime="any" -->

The router of the test platform records each envelope. A test can check the event, the target and the trail, and the ids are stable from one run to the next.

```ts file=main.ts
import { NO_CONTROL, defineSubsystem } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';

const cart = defineSubsystem({
  id: 'cart',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  control: (ctx) => ({
    commands: {
      checkout: () => ctx.port.send({ eventId: 'cart:checkout', payload: { total: 42 } }),
    },
    views: {},
  }),
});
const analytics = defineSubsystem({
  id: 'analytics',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  subscribes: ['cart:checkout'],
  receive: (packet) => void packet.take(),
  control: () => NO_CONTROL,
});

const platform = createTestPlatform([cart, analytics]);
await platform.start();
await platform.unit<ReturnType<typeof cart.control>>('cart').control!.commands.checkout();

const [sent] = platform.routed;
console.log('event:', sent.eventId, 'target:', sent.metadata.target);
console.log('message id:', sent.metadata.messageId);
console.log('trail:', JSON.stringify(sent.fingerprints.entries.map((e) => `${e.actionName}:${e.subsystemId}`)));
await platform.stop();
```

```text output
event: cart:checkout target: null
message id: id-1
trail: ["sent:cart"]
```

## Test what a subsystem persists

<!-- example id="core/test-persistence" runtime="any" -->

Memory persistence stands in for real storage. A test can fill it before the start, and read what the subsystem saved after the stop.

```ts file=main.ts
import { defineSubsystem } from '@platform/core';
import { createMemoryPersistence, createTestPlatform } from '@platform/core/testing';

const onboarding = defineSubsystem({
  id: 'onboarding',
  scope: 'tab',
  kind: 'featurized',
  state: {
    initial: { step: 1 },
    policy: { step: { readable: true, persisted: true } },
  },
  control: (ctx) => ({
    commands: { next: () => ctx.state.update((s) => void s.step++) },
    views: { state: ctx.state.readable },
  }),
});

// The user finished step 2 in an earlier visit.
const persistence = createMemoryPersistence({ onboarding: { version: 1, data: { step: 3 } } });
const platform = createTestPlatform([onboarding], { persistence });
await platform.start();

const control = platform.unit<ReturnType<typeof onboarding.control>>('onboarding').control!;
console.log('resumed at step:', control.views.state.getSnapshot().step);
control.commands.next();
await platform.stop();
console.log('saved:', JSON.stringify(persistence.saved.get('onboarding')));
```

```text output
resumed at step: 3
saved: {"version":1,"data":{"step":4}}
```
