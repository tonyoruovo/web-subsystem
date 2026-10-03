> **Amendments (M6, 2026-10-03).** These override the text below wherever they conflict. See [ARCHITECTURE §18.1](../docs/ARCHITECTURE.md#181-crypto).
>
> - Crypto is a featurized, Tab-scoped subsystem with no required dependency. Its work runs in the processor `crypto` on the hosts shared, dedicated, then virtual.
> - Keys are non-extractable `CryptoKey` objects that persist in IndexedDB (`__platform_crypto`), so every host and every session uses the same keys.
> - Key sources: `device` (made on first use, the default), `material` (injected) and `fetch` (a plain bootstrap fetch, not the Network subsystem).
> - Encryption tokens carry the key id: `v1.<keyId>.<iv>.<ciphertext>`. `rotate` keeps old keys for decryption and verification. `forget` deletes the persisted keys.
> - Storage, not Crypto, reports integrity failures (`storage:corrupt`).
> - Dropped for now: key derivation, the rotation timer, and the expiry of old keys.

# Crypto Manager

**Type**: Featurized  
**Importance/Priority/Weight**: **CRITICAL** - Storage and Auth depend on it for encryption and signing.

The Crypto Manager owns every key and every cryptographic primitive in the
platform. It centralizes work that is now scattered across Storage (encryption
keys) and Auth (the cryptographic processor). It holds keys as non-extractable
`CryptoKey` objects in memory, zeroizes them on shutdown, and runs its operative
in a worker.

---

## States

- **keyRegistry**: `Map<keyId, KeyRecord>` - every key the platform holds
  ```typescript
  interface KeyRecord {
    id: string;
    purpose: 'encrypt' | 'sign' | 'hmac' | 'derive';
    algorithm: 'AES-GCM' | 'HMAC-SHA-256' | 'ECDSA-P256' | 'SHA-256';
    key: CryptoKey;          // non-extractable
    createdAt: number;
    expiresAt: number | null;
    rotatedAt: number | null;
  }
  ```
- **activeKeys**: `Record<'encrypt' | 'sign' | 'hmac', string>` - the current key id per purpose.
- **integrityState**: `{ enabled: boolean; algorithm: 'HMAC-SHA-256' }`.
- **cryptoConfig**: `{ keyFetchMode: 'bootstrap-fetch' | 'injected'; rotationInterval: number | null }`.

---

## Features

### Key Manager
**Purpose**: Owns key life cycle.  
**Responsibilities**:
- Generate keys and import them as non-extractable `CryptoKey`.
- Rotate keys on an interval and keep the previous key for a grace window.
- Zeroize every key on shutdown.
- **Weight**: CRITICAL.

### Encryption Service
**Purpose**: Encrypt and decrypt payloads.  
**Responsibilities**:
- AES-GCM encrypt and decrypt.
- Attach the key id and nonce to the ciphertext so a future key version can decrypt.
- **Weight**: CRITICAL.

### Signature Service
**Purpose**: Sign and verify messages.  
**Responsibilities**:
- ECDSA-P256 sign and verify.
- Support the Queue's message-signing requirement.
- **Weight**: HIGH.

### Integrity Service
**Purpose**: Detect tampered or corrupted data.  
**Responsibilities**:
- Compute an HMAC-SHA-256 tag over each storage envelope.
- Verify the tag on read and report a mismatch.
- **Weight**: HIGH.

### Hash Service
**Purpose**: Hash and derive.  
**Responsibilities**:
- SHA-256/384/512 digests.
- PBKDF2 and HKDF key derivation.
- **Weight**: MEDIUM.

### Secure Random
**Purpose**: Supply randomness.  
**Responsibilities**:
- Wrap `crypto.getRandomValues` for ids, nonces, and salts.
- **Weight**: MEDIUM.

---

## Life Cycle Manager

### Initialization Sequence
1. Read `cryptoConfig` from Global State.
2. Obtain key material at boot: a minimal bootstrap fetch, or injected config.
   The manager does not depend on the full Network manager. This avoids a cycle.
3. Import key material as non-extractable `CryptoKey` objects.
4. Set `activeKeys` per purpose.
5. Start rotation timer if `rotationInterval` is set.
6. Log initialization complete (key count, never key material).

### Destruction Sequence
1. Stop the rotation timer.
2. Zeroize every key and clear `keyRegistry`.
3. Log shutdown complete.

---

## Worker

**Type**: Physical Worker (shared worker default, virtual worker fallback).

Keys are origin-wide, so every tab must share them. A shared worker is the
default. A virtual worker on the main thread is the fallback when the worker
context is unavailable, as in Safari private browsing.

### Receiver
- Receives encrypt, decrypt, sign, verify, hash, and HMAC requests.
- Receives key rotation commands.

### Processor
- **Crypto Processor**: runs every primitive against `WebCrypto`.

### Dispatcher
- Returns results to callers.
- Reports integrity failures to the Logger.

---

## Dependencies

Ordered by initialization priority:

1. **Global State** (MEDIUM) - configuration.
2. **Logger** (MEDIUM) - report integrity failures and key issues.

The manager does not depend on Network. Its key arrives from a bootstrap fetch or
injected config.

### Functional Predicates

```javascript
function canDecrypt(keyId) {
  // The current key and the previous key (grace window) both decrypt.
  return keyRegistry.has(keyId) && (
    activeKeys.encrypt === keyId || isPreviousKey(keyId)
  );
}
```

---

## Control Interface

### Getters (No-arg)
- `isReady(): boolean`.
- `getActiveKeyId(purpose): string | null`.

### Actions
- `encrypt(purpose, data): Promise<{ keyId, ciphertext }>`.
- `decrypt(keyId, ciphertext): Promise<ArrayBuffer>`.
- `sign(data): Promise<ArrayBuffer>`.
- `verify(signature, data): Promise<boolean>`.
- `hmac(data): Promise<ArrayBuffer>`.
- `verifyHmac(tag, data): Promise<boolean>`.
- `hash(data, algorithm?): Promise<ArrayBuffer>`.
- `deriveKey(material, salt): Promise<CryptoKey>`.
- `rotateKey(purpose): Promise<void>`.
- `zeroize(): void`.

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

export interface EncryptPayload {
  purpose: 'encrypt' | 'sign' | 'hmac';
  data: ArrayBuffer;
}
export type EncryptPacket = BasePacket<EncryptPayload, { keyId: string; result: ArrayBuffer }>;
// Event ID: crypto:encrypt | Importance: HIGH | Broadcast: No

export interface DecryptPayload {
  keyId: string;
  ciphertext: ArrayBuffer;
}
export type DecryptPacket = BasePacket<DecryptPayload, { result: ArrayBuffer }>;
// Event ID: crypto:decrypt | Importance: HIGH | Broadcast: No

export interface IntegrityFailurePayload {
  key: string;
  reason: 'tampered' | 'corrupt';
  timestamp: number;
}
export type IntegrityFailurePacket = BasePacket<IntegrityFailurePayload, void>;
// Event ID: crypto:integrity-failed | Importance: HIGH | Broadcast: Yes (Logger)

export type CryptoPacket = EncryptPacket | DecryptPacket | IntegrityFailurePacket;
```

---

## Special Considerations

### Non-extractable keys
Keys never leave the worker as plain bytes. They are imported as non-extractable
`CryptoKey`. The platform can use a key but cannot read it.

### Zeroization
Shutdown zeroizes every key and clears the registry. There is no key material to
dump.

### Key rotation
Rotation keeps the previous key for a grace window. Data written before the
rotation still decrypts during the window. The envelope stores the key id, so a
read resolves the right key.

### Integrity
An HMAC tag per envelope detects tampering and corruption. Encryption alone does
not. A mismatch reports to the Logger and does not return the value.

### Constant-time compare
Signature and HMAC verification use a constant-time compare to resist timing
attacks.

---

## Summary

The Crypto Manager centralizes keys and primitives that Storage and Auth need. It
holds non-extractable keys in a shared worker, zeroizes on shutdown, rotates with
a grace window, and adds an integrity tag that catches tampering. It is featurized
and CRITICAL. Its reliability guarantee is a clean failure: a missing or failed
key warns through the Logger and returns no value. It never crashes.
