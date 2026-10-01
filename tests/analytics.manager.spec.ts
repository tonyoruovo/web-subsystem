import { describe, expect, it } from 'vitest';

import { AnalyticsManager, type AnalyticsSnapshot } from '../src';

describe('AnalyticsManager', () => {
  it('collects counters, gauges, and events', () => {
    const analytics = new AnalyticsManager();
    analytics.increment('page.view');
    analytics.increment('page.view', 2);
    analytics.recordGauge('heap', 42);
    analytics.trackEvent('click', { id: 'btn' });

    const metrics = analytics.getMetrics();
    expect(metrics.counters).toEqual({ 'page.view': 3 });
    expect(metrics.gauges).toEqual({ heap: 42 });
    expect(metrics.events).toHaveLength(1);
    expect(metrics.events[0].name).toBe('click');
  });

  it('flushes to the transport and resets', async () => {
    const sent: AnalyticsSnapshot[] = [];
    const analytics = new AnalyticsManager({
      transport: async (s) => {
        sent.push(s);
      },
    });
    analytics.increment('page.view');

    await analytics.flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].counters).toEqual({ 'page.view': 1 });
    expect(analytics.getMetrics().counters).toEqual({});
  });

  it('does not collect or flush when consent is denied', async () => {
    const sent: AnalyticsSnapshot[] = [];
    const analytics = new AnalyticsManager({
      transport: async (s) => {
        sent.push(s);
      },
      consent: () => false,
    });

    analytics.increment('page.view');
    await analytics.flush();

    expect(analytics.getMetrics().counters).toEqual({});
    expect(sent).toHaveLength(0);
  });

  it('samples at rate 0 by collecting nothing', () => {
    const analytics = new AnalyticsManager({ sampleRate: 0 });
    analytics.increment('page.view');

    expect(analytics.getMetrics().counters).toEqual({});
  });
});
