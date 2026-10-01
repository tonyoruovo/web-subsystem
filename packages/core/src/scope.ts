/**
 * @fileoverview
 * @summary Scopes and the send rule.
 * @description
 * Implements docs/ARCHITECTURE.md §11.1 and §11.2 (amendment A1):
 *
 * - A **broadcast** is limited to its sender's scope. It reaches every
 *   subscriber inside that scope's boundary, whatever the subscriber's own
 *   scope ("receive from any").
 * - A **1-to-1 request** may target any reachable subsystem, and its **reply**
 *   always returns to the requester.
 *
 * @author MathAid
 */

/** @summary Every scope, narrowest first. */
export const SCOPES = ['page', 'tab', 'window', 'global'] as const;

/** @summary How far a subsystem's broadcasts reach. */
export type Scope = (typeof SCOPES)[number];

/**
 * @summary Where a receiver is, relative to the sender.
 * - `same-page`: the same document and route.
 * - `same-tab`: the same tab, possibly another page or document.
 * - `same-site`: another tab of the same site (any subdomain), same browser session.
 * - `remote`: another session or device, reached through the server.
 */
export type Relation = 'same-page' | 'same-tab' | 'same-site' | 'remote';

const RELATION_RANK: Readonly<Record<Relation, number>> = {
  'same-page': 0,
  'same-tab': 1,
  'same-site': 2,
  remote: 3,
};

/**
 * @summary True when a broadcast in `scope` reaches a receiver at `relation`.
 * @param {Scope} scope The broadcast's scope (its sender's scope).
 * @param {Relation} relation Where the receiver is, relative to the sender.
 * @returns {boolean} Whether the receiver is inside the scope's boundary.
 */
export function reaches(scope: Scope, relation: Relation): boolean {
  return RELATION_RANK[relation] <= SCOPES.indexOf(scope);
}

/** @summary Thrown when a packet breaks the send rule. */
export class ScopeViolationError extends Error {
  override readonly name = 'ScopeViolationError';
}

/**
 * @summary Enforces the send rule for one outgoing packet.
 * @param {object} send The sender's scope, the packet's scope, and its target (`null` for a broadcast).
 * @throws {ScopeViolationError} When a broadcast's scope differs from its sender's scope.
 */
export function assertSendAllowed(send: {
  readonly sender: string;
  readonly senderScope: Scope;
  readonly packetScope: Scope;
  readonly target: string | null;
}): void {
  if (send.target !== null) return; // requests and replies may cross scopes
  if (send.packetScope !== send.senderScope) {
    throw new ScopeViolationError(
      `[${send.sender}] A ${send.senderScope}-scoped subsystem cannot broadcast in ${send.packetScope} scope.`,
    );
  }
}
