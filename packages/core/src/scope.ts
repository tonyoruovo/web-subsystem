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
 * ```text
 *   scope     reaches receivers at
 *   page      same-page
 *   tab       same-page, same-tab
 *   window    same-page, same-tab, same-site
 *   global    everything, including remote (through the server)
 *   ```
 *
 * @example
 * Checking whether a broadcast reaches another tab
 * ```ts
 * import { reaches } from '@platform/core';
 *
 * reaches('tab', 'same-site');    // false: a tab broadcast stays in its tab
 * reaches('window', 'same-site'); // true
 * ```
 *
 * @example
 * Enforcing the send rule in a router or transport
 * ```ts
 * import { assertSendAllowed } from '@platform/core';
 *
 * assertSendAllowed({ sender: 'ui', senderScope: 'page', packetScope: 'page', target: null }); // ok
 * ```
 *
 * @throws {ScopeViolationError} From {@linkcode assertSendAllowed} for a broadcast outside its sender's scope.
 * @author MathAid
 */

/**
 * @summary Every scope, narrowest first: `page`, `tab`, `window`, `global`.
 * @description The order is meaningful: a scope's index is how far its
 * broadcasts reach. {@linkcode Scope} is derived from this tuple.
 *
 * @example
 * Validating a configured scope
 * ```ts
 * if (!SCOPES.includes(config.scope)) throw new Error('Unknown scope');
 * ```
 *
 * @constant
 * @public
 */
export const SCOPES = ['page', 'tab', 'window', 'global'] as const;

/**
 * @summary How far a subsystem's broadcasts reach.
 * @description
 * - `page`: one document and route.
 * - `tab`: one browser tab, across the documents it loads.
 * - `window`: every tab of the same site, across subdomains, in one browser session.
 * - `global`: every session and device, through the server.
 *
 * @public
 */
export type Scope = (typeof SCOPES)[number];

/**
 * @summary Where a receiver is, relative to the sender.
 * @description
 * - `same-page`: the same document and route.
 * - `same-tab`: the same tab, possibly another page or document.
 * - `same-site`: another tab of the same site (any subdomain), same browser session.
 * - `remote`: another session or device, reached through the server.
 *
 * Transports know the relation of the subscribers they deliver to, and use it
 * with {@linkcode reaches}.
 *
 * @public
 */
export type Relation = 'same-page' | 'same-tab' | 'same-site' | 'remote';

/**
 * @summary How far away each relation is, comparable with a scope's index in {@linkcode SCOPES}.
 * @internal
 */
const RELATION_RANK: Readonly<Record<Relation, number>> = {
  'same-page': 0,
  'same-tab': 1,
  'same-site': 2,
  remote: 3,
};

/**
 * @summary Tells whether a broadcast in `scope` reaches a receiver at `relation`.
 *
 * @description
 * A broadcast reaches a receiver when the receiver is inside the boundary of
 * the broadcast's scope (which is always its sender's scope). Transports call
 * it to decide which subscribers get a copy.
 *
 * @example
 * Example 1: A page broadcast stays on its page
 * ```ts
 * reaches('page', 'same-page'); // true
 * reaches('page', 'same-tab');  // false
 * ```
 *
 * @example
 * Example 2: A global broadcast reaches other devices
 * ```ts
 * reaches('global', 'remote'); // true
 * ```
 *
 * @param {Scope} scope The broadcast's scope.
 * @param {Relation} relation Where the receiver is, relative to the sender.
 * @returns {boolean} `true` when the receiver is inside the scope's boundary.
 *
 * @public
 */
export function reaches(scope: Scope, relation: Relation): boolean {
  return RELATION_RANK[relation] <= SCOPES.indexOf(scope);
}

/**
 * @summary Thrown when a packet breaks the send rule.
 *
 * @description
 * Raised by {@linkcode assertSendAllowed} when a broadcast claims a scope
 * other than its sender's, for example a `page` subsystem trying to
 * broadcast to the whole site.
 *
 * @example
 * Example 1: A page subsystem broadcasting globally
 * ```ts
 * assertSendAllowed({ sender: 'ui', senderScope: 'page', packetScope: 'global', target: null });
 * // throws ScopeViolationError
 * ```
 *
 * @example
 * Example 2: Telling it apart from other errors
 * ```ts
 * if (error instanceof ScopeViolationError) report('Packet blocked by the send rule');
 * ```
 *
 * @public
 */
export class ScopeViolationError extends Error {
  override readonly name = 'ScopeViolationError';
}

/**
 * @summary Enforces the send rule for one outgoing packet.
 *
 * @description
 * Requests and replies (packets with a `target`) pass unchecked: they may
 * cross scopes. A broadcast (`target: null`) must carry exactly its sender's
 * scope. The kernel calls this for every packet a port sends; a router or
 * transport that accepts envelopes from elsewhere should call it too.
 *
 * @example
 * Example 1: A request may cross scopes
 * ```ts
 * assertSendAllowed({ sender: 'ui', senderScope: 'page', packetScope: 'page', target: 'storage' });
 * ```
 *
 * @example
 * Example 2: Checking an envelope received from another realm
 * ```ts
 * const { source, scope, target } = envelope.metadata;
 * assertSendAllowed({ sender: source, senderScope: scopeOf(source), packetScope: scope, target });
 * ```
 *
 * @param {object} send The sender's id and scope, the packet's scope, and its target (`null` for a broadcast).
 * @throws {ScopeViolationError} When a broadcast's scope differs from its sender's scope.
 *
 * @public
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
