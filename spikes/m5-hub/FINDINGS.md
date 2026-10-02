# M5 spike: does the apex hub share one partition across subdomains?

**Date:** 2026-10-02. **Script:** [`spike.ts`](spike.ts) (`node spikes/m5-hub/spike.ts`). **Raw results:** [`results.json`](results.json).

ARCHITECTURE §11.3 frames a hub page on the site's apex (`https://site/hub.html`) from every subdomain. Window scope works only if every framed copy of the hub, and a tab on the apex itself, see the **same** `BroadcastChannel`, storage and `SharedWorker`.

## Setup

Five tabs in one browser profile, all served by request interception (no DNS, no certificates):

| Tab                          | Hub runs                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| `https://a.site.test/`       | in an iframe of `https://site.test/hub.html`               |
| `https://b.site.test/`       | in an iframe of the same URL                               |
| `https://a.site.test/` (2nd) | in an iframe (same top-level origin as the 1st)            |
| `https://site.test/hub.html` | directly, as the top-level page (apex)                     |
| `https://other.test/`        | in an iframe: **cross-site control**, expected partitioned |

The checks were repeated with `SITE=example.com`, with identical results, so the `.test` name is not a factor.

Playwright disables Chromium's `ThirdPartyStoragePartitioning` by default. The spike turns it back on, so Chromium behaves like users' browsers; the cross-site control proves partitioning was active.

## Results

| Check (hub in `a.` → hub elsewhere) | Chrome 154  | Edge 154    | Chromium 147 | WebKit 26.6 (desktop and iPhone profile)              |
| ----------------------------------- | ----------- | ----------- | ------------ | ----------------------------------------------------- |
| `BroadcastChannel` a → b            | shared      | shared      | shared       | **partitioned**                                       |
| `BroadcastChannel` a → apex tab     | shared      | shared      | shared       | **partitioned**                                       |
| `BroadcastChannel` a → 2nd a tab    | shared      | shared      | shared       | shared                                                |
| IndexedDB a → b, a → apex           | shared      | shared      | shared       | **partitioned**                                       |
| `SharedWorker` a → b, a → apex      | shared      | shared      | shared       | **partitioned**                                       |
| `localStorage` a → b, a → apex      | shared      | shared      | shared       | shared (see note)                                     |
| Cross-site control (`other.test`)   | partitioned | partitioned | partitioned  | `BroadcastChannel` partitioned, `localStorage` shared |

**Not run:** Playwright's own Chromium and Firefox builds fail to launch on this machine (`spawn UNKNOWN`). Firefox keys its partitions by top-level **site**, so it is expected to behave like Chrome, but that is unverified. Real Safari cannot run on Windows; Playwright's WebKit is the closest proxy.

**Note on WebKit `localStorage`:** it was shared even with the cross-site control, which Safari does not do (Safari partitions third-party storage). This Windows WebKit build lacks part of Safari's tracking prevention, so its `localStorage` result says nothing about Safari.

## Conclusion

- **Chromium-based browsers:** the design in §11.3 works as written.
- **WebKit, and therefore Safari and every browser on iOS:** a framed hub's `BroadcastChannel`, IndexedDB and `SharedWorker` are partitioned by the **top-level origin**, not the site. The hub only connects tabs that share a top-level origin, and those can already use a plain `BroadcastChannel`. **Window scope across subdomains does not work through an iframe hub on WebKit.**

Per PLAN M5 ("if it doesn't, stop and revise §11.3"), building stops here until §11.3 is revised.
