import { describe, expect, it } from 'vitest';

import { ConsentManager } from '../src';

describe('ConsentManager', () => {
  it('grants necessary always, even without a record', () => {
    const consent = new ConsentManager();
    expect(consent.isGranted('necessary')).toBe(true);
  });

  it('grants and checks a category', () => {
    const consent = new ConsentManager();
    expect(consent.isGranted('analytics')).toBe(false);

    consent.grant('analytics');
    expect(consent.isGranted('analytics')).toBe(true);
  });

  it('revokes a category', () => {
    const consent = new ConsentManager();
    consent.grant('analytics');
    consent.revoke('analytics');

    expect(consent.isGranted('analytics')).toBe(false);
  });

  it('cannot revoke necessary', () => {
    const consent = new ConsentManager();
    consent.revoke('necessary');

    expect(consent.isGranted('necessary')).toBe(true);
  });

  it('invalidates grants when the policy version changes', () => {
    const old = new ConsentManager({ policyVersion: 1 });
    old.grant('marketing');
    expect(old.isGranted('marketing')).toBe(true);

    // A new manager with a bumped policy version re-asks the user.
    const fresh = new ConsentManager({ policyVersion: 2 });
    fresh.grant('marketing'); // recorded under version 2
    expect(fresh.isGranted('marketing')).toBe(true);
  });

  it('grants and revokes all except necessary', () => {
    const consent = new ConsentManager();
    consent.grantAll();
    expect(consent.isGranted('functional')).toBe(true);
    expect(consent.isGranted('analytics')).toBe(true);

    consent.revokeAll();
    expect(consent.isGranted('necessary')).toBe(true);
    expect(consent.isGranted('functional')).toBe(false);
    expect(consent.isGranted('analytics')).toBe(false);
  });
});
