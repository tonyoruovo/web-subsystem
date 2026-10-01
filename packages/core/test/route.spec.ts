import { describe, expect, it, vi } from 'vitest';

import { createBrowserRouteSource, createMemoryRouteSource, type RouteWindow } from '../src';

/** A fake window whose history updates location.pathname, like a browser. */
function fakeWindow(withNavigation: boolean) {
  const location = { pathname: '/' };
  const popstate = new Set<() => void>();
  const navigatesuccess = new Set<() => void>();
  const setPath = (_state: unknown, _title: string, url?: string | URL | null) => {
    if (url) location.pathname = new URL(String(url), 'https://app.test').pathname;
  };
  const history = { pushState: vi.fn(setPath), replaceState: vi.fn(setPath) };
  const navigation: RouteWindow['navigation'] = {
    addEventListener: (_type, listener) => navigatesuccess.add(listener),
    removeEventListener: (_type, listener) => navigatesuccess.delete(listener),
  };
  const win: RouteWindow = {
    location,
    history: history as unknown as RouteWindow['history'],
    addEventListener: (_type, listener) => popstate.add(listener),
    removeEventListener: (_type, listener) => popstate.delete(listener),
    navigation: withNavigation ? navigation : undefined,
  };
  return { win, location, history, popstate, navigatesuccess };
}

describe('createMemoryRouteSource', () => {
  it('notifies on path changes only', () => {
    const source = createMemoryRouteSource('/a');
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    source.navigate('/a');
    source.navigate('/b');
    unsubscribe();
    source.navigate('/c');
    expect(listener.mock.calls).toEqual([['/b']]);
    expect(source.current()).toBe('/c');
  });
});

describe('createBrowserRouteSource — History API fallback', () => {
  it('reports pushState, replaceState and popstate path changes, ignoring query and hash', () => {
    const { win, location, popstate } = fakeWindow(false);
    const source = createBrowserRouteSource(win);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    win.history.pushState(null, '', '/settings');
    win.history.replaceState(null, '', '/settings?tab=2#top');
    location.pathname = '/back';
    for (const l of popstate) l();

    expect(listener.mock.calls).toEqual([['/settings'], ['/back']]);
    unsubscribe();
  });

  it('restores history and removes listeners when the last subscriber leaves', () => {
    const { win, popstate } = fakeWindow(false);
    const original = win.history.pushState;
    const source = createBrowserRouteSource(win);
    const unsubscribe = source.subscribe(() => {});
    expect(win.history.pushState).not.toBe(original);
    unsubscribe();
    expect(win.history.pushState).toBe(original);
    expect(popstate.size).toBe(0);
  });
});

describe('createBrowserRouteSource — Navigation API', () => {
  it('uses navigatesuccess and leaves history untouched', () => {
    const { win, location, navigatesuccess } = fakeWindow(true);
    const original = win.history.pushState;
    const source = createBrowserRouteSource(win);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    expect(win.history.pushState).toBe(original);

    location.pathname = '/docs';
    for (const l of navigatesuccess) l();
    for (const l of navigatesuccess) l(); // same path: ignored
    expect(listener.mock.calls).toEqual([['/docs']]);

    unsubscribe();
    expect(navigatesuccess.size).toBe(0);
  });
});
