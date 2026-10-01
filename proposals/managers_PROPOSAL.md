### Auth Manager

Manages auth credential, authentication & authorization tokens and cookie management, login & logout, roles and permissions (configurable)

This makes use of the sync manager to keep the JWT tokens (or JWKs) up-to-date via the refresh token. Also makes use of the storage manager to store tokens and credentials (such as username, email, password etc). It maps permisson tokens to protected page urls, elements (or their selector) and even subsystems and their events can be blocked. These have to be registered independently

This is meant to be the security manager of the platform than hands temporary elevation to subsystems. An elevation gives subsystems access to sensitive parts of subsystems that requires elevated usage to use them

### Network Request Manager

Manages fetch & cache api. It maintains a dictionary of `AbortSignal` objects and the promise of the request.

There is the dilemma of merging this with the sync manager and using google's workbox underhood or just going with the specified setup

Each fetch action must be able to

- Perform incremental retries on fail using the config of the request
- Use the cache API tp prevent redundant network calls

### Storage manager

Manages the storage and indexedDb apis by imposing a schematic structure on the data stored within and validating (using zod validation) each call to store and update data

It provides a shared interface for indexedDB and storages (localStorage and sessionStorage) such as open and close semantics (even though this is only used by indexedDB), transactional ops. It needs a way to for users of this subsystem to specify the type of storage for the op

CRUD events are emitted from this subsystem to enable inter-subsystem communication
Critical status events are also emitted including:

- Low storage

### Sync manager

The sync manager allows subsystems to define:

- An endpoint for fetching data (without using intercommunication with any other subsystem)
- The data type of the data to be fetched
- The rules for determining changes to properties in the local state or cache i.e caching rules
- The syncing intervals
- The retry intervals (for failed syncs)
- Conflicts & data mismatch resolutions i.e Which of the server or client take precedence when the local cache is not compatible with the server response?

These definition must be done once at the subscription time
