# Realtime Manager

**Type**: Featurized  
**Importance/Priority/Weight**: **HIGH** - The offline-navigation example depends on a reliable socket.

The Realtime Manager owns the WebSocket. It connects, reconnects with backoff,
sends heartbeats, tracks presence, and multiplexes many logical subscriptions
over one socket. It feeds incoming messages into the Notification Center.

---

## States

- **connectionState**:
  ```typescript
  interface ConnectionState {
    status: 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting';
    lastError: string | null;
    reconnectAttempts: number;
    lastOpenAt: number | null;
    lastMessageAt: number | null;
  }
  ```
- **subscriptionRegistry**: `Map<topic, Set<subscriberId>>` - logical topics over the one socket.
- **presenceState**: `Map<peerId, { status: 'online' | 'away' | 'offline'; lastSeen: number }>`.
- **realtimeConfig**: `{ url: string; heartbeatInterval: number; reconnectStrategy: string; maxReconnectAttempts: number }`.

---

## Features

### Connection Manager
**Purpose**: Own the socket life cycle.  
**Responsibilities**:
- Connect and close.
- Reconnect with backoff on drop.
- Respect `maxReconnectAttempts`.
- **Weight**: HIGH.

### Heartbeat Manager
**Purpose**: Detect dead connections.  
**Responsibilities**:
- Send pings on an interval.
- Treat a missed pong as a dead connection and reconnect.
- **Weight**: MEDIUM.

### Subscription Multiplexer
**Purpose**: Carry many topics over one socket.  
**Responsibilities**:
- Map `subscribe(topic)` to one physical socket.
- Re-subscribe every topic on reconnect.
- **Weight**: HIGH.

### Presence Tracker
**Purpose**: Track peers.  
**Responsibilities**:
- Record peer status from messages.
- Mark a peer offline after a timeout.
- **Weight**: MEDIUM.

### Message Router
**Purpose**: Feed messages into the bus.  
**Responsibilities**:
- Route an incoming message to its topic subscribers.
- Emit the message as a Notification event.
- **Weight**: HIGH.

---

## Life Cycle Manager

### Initialization Sequence
1. Read `realtimeConfig` from Global State.
2. Obtain the auth token from Auth for an authenticated socket.
3. Open the socket.
4. Subscribe to `global:network-status-changed` to reconnect on reconnect.
5. Log initialization complete.

### Destruction Sequence
1. Close the socket.
2. Clear `subscriptionRegistry` and `presenceState`.
3. Log shutdown complete.

---

## Worker

**Type**: Physical Worker (dedicated worker default, virtual worker fallback).

The socket I/O can run off the main thread. A dedicated worker is the default. A
virtual worker on the main thread is the fallback when the worker context is
unavailable.

### Receiver
- Receives connect, disconnect, subscribe, and publish commands.

### Processor
- **Connection Processor**: manages the socket and heartbeats.
- **Message Processor**: parses and routes incoming messages.

### Dispatcher
- Returns connection status.
- Emits incoming messages to the Notification Center.

---

## Dependencies

Ordered by initialization priority:

1. **Global State** (HIGH) - online status.
2. **Network** (MEDIUM) - the backoff strategy for reconnect.
3. **Auth** (MEDIUM) - the token for an authenticated socket.
4. **Notification Center** (HIGH) - emit incoming messages.

### Functional Predicates

```javascript
function shouldReconnect() {
  return globalState.isOnline() &&
         connectionState.reconnectAttempts < realtimeConfig.maxReconnectAttempts;
}

function reconnectDelay() {
  return computeBackoff(timeout, attempts, maxRetries, maxCap, retryMultiplier, retryStrategy);
}
```

---

## Control Interface

### Getters (No-arg)
- `getConnectionStatus(): ConnectionState['status']`.
- `isConnected(): boolean`.
- `getSubscriptions(): string[]`.
- `getPresence(peerId?): unknown`.

### Actions
- `connect(): void`.
- `disconnect(): void`.
- `subscribe(topic, subscriberId): void`.
- `unsubscribe(topic, subscriberId): void`.
- `publish(topic, payload): void`.
- `getPresence(peerId): void`.

### Subscriptions
- `global:network-status-changed` - reconnect on reconnect.
- `auth:login-success` / `auth:logout` - reconnect the socket with the new token.

---

## Message Packets

```typescript
export interface BasePacket<P, R = any> {
  eventId: symbol;
  actionName: string;
  payload: P;
  importance: 'HIGH' | 'MEDIUM' | 'LOW';
  onComplete: (result: R) => void;
  onError: (error: Error) => void;
  onLog: ((fingerprints: Fingerprint[]) => void) | null;
  fingerprints: Fingerprint[];
}

export interface MessageReceivedPayload {
  topic: string;
  data: unknown;
  receivedAt: number;
}
export type MessageReceivedPacket = BasePacket<MessageReceivedPayload, void>;
// Event ID: realtime:message | Importance: MEDIUM | Broadcast: Yes (to subscribers)

export interface ConnectionChangedPayload {
  oldStatus: string;
  newStatus: string;
  attempt: number;
}
export type ConnectionChangedPacket = BasePacket<ConnectionChangedPayload, void>;
// Event ID: realtime:connection-changed | Importance: HIGH | Broadcast: Yes

export type RealtimePacket = MessageReceivedPacket | ConnectionChangedPacket;
```

---

## Special Considerations

### Reconnect with backoff
A dropped socket reconnects with the backoff engine from Network. The delay grows
with each attempt and stops at the cap.

### Heartbeats
A ping and pong pair detects a dead connection that did not close cleanly. This is
how the platform knows a socket is stale before the browser times it out.

### Multiplexing
One physical socket carries many logical topics. Re-subscription is automatic on
reconnect. No caller re-subscribes by hand.

### Token refresh
When Auth refreshes the token, the socket reconnects with the new token. This
keeps an authenticated socket valid without a manual step.

---

## Summary

The Realtime Manager owns the WebSocket. It reconnects with backoff, detects dead
connections with heartbeats, tracks presence, and multiplexes many topics over one
socket. It is featurized and HIGH. Its reliability guarantee is that a dropped
socket reconnects on its own and re-subscribes, so the offline-navigation example
always has a live channel when the network returns.
