export enum PortalKind {
  WEBSITE,
  LEGAL,
  USER,
  CORPORATE = 4,
  INTERNAL = 8,
}
export enum PortalContext {
  IDLE,
  BLOCKING,
  BUSY,
}

/**
 * @summary An opaque reference to the location the user came from.
 * @description
 * Framework-agnostic: the portal stores referers without knowing what a route
 * looks like. The host framework supplies and consumes these values.
 */
export type IPathReferer = unknown;

/**
 * @summary The Portal store, a plain framework-agnostic singleton.
 */
export interface PortalStore {
  /** A bitmap using one of the values from `PortalKind` */
  kind: number;
  context: PortalContext;
  referer: IPathReferer[];
}

const store: PortalStore = {
  kind: 0,
  context: PortalContext.BUSY,
  referer: [],
};

/**
 * @summary Returns the shared Portal store.
 * @returns {PortalStore} The singleton store.
 */
export function usePortalStore(): PortalStore {
  return store;
}
