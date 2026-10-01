import { describe, expect, it } from 'vitest';

import { TranslationManager, type MessageCatalog } from '../src';

function catalog(
  messages: Record<string, string>,
  plurals?: MessageCatalog['plurals'],
): MessageCatalog {
  return { locale: 'en', namespace: 'common', messages, plurals };
}

describe('TranslationManager', () => {
  it('translates a key', () => {
    const i18n = new TranslationManager();
    i18n.addCatalog('en', 'common', catalog({ hello: 'Hello' }));

    expect(i18n.t('hello')).toBe('Hello');
  });

  it('interpolates placeholders', () => {
    const i18n = new TranslationManager();
    i18n.addCatalog('en', 'common', catalog({ greet: 'Hello, {name}!' }));

    expect(i18n.t('greet', { name: 'Alice' })).toBe('Hello, Alice!');
  });

  it('falls back to the base locale then the fallback locale', () => {
    const i18n = new TranslationManager({ fallbackLocale: 'en' });
    i18n.addCatalog('en', 'common', catalog({ hi: 'Hi from en' }));
    i18n.setLocale('en-US');

    expect(i18n.t('hi')).toBe('Hi from en');
  });

  it('returns the key itself for a missing key and reports it', () => {
    const missing: string[] = [];
    const i18n = new TranslationManager({ onMissingKey: (key) => missing.push(key) });

    expect(i18n.t('does.not.exist')).toBe('does.not.exist');
    expect(i18n.getMissingKeys()).toEqual(['does.not.exist']);
    expect(missing).toEqual(['does.not.exist']);
  });

  it('selects the correct plural category', () => {
    const i18n = new TranslationManager();
    i18n.addCatalog(
      'en',
      'common',
      catalog(
        {},
        {
          items: { one: '{count} item', other: '{count} items' },
        },
      ),
    );

    expect(i18n.tPlural('items', 1)).toBe('1 item');
    expect(i18n.tPlural('items', 5)).toBe('5 items');
  });

  it('derives rtl direction for arabic', () => {
    const i18n = new TranslationManager();
    i18n.setLocale('ar');
    expect(i18n.getDirection()).toBe('rtl');

    i18n.setLocale('en');
    expect(i18n.getDirection()).toBe('ltr');
  });
});
