# Examples: the OPFS backend

The OPFS backend keeps each entry in a file of the Origin Private File System. In a worker it uses fast synchronous file handles. On the main thread it uses writable streams. A write-ahead log makes its transactions `compensating`: after a crash, the next start completes or undoes them.

## Keep large values in files

<!-- example id="storage/opfs-files" runtime="browser" -->

A photo editor keeps large drafts. OPFS stores each one as a file, so a large value does not slow down other reads.

```ts file=main.ts
import { OPFSBackend, buildCanonicalKey } from '@platform/storage';

const backend = new OPFSBackend({ rootDirName: 'editor' });
const probe = await backend.probe();
console.log('available:', probe.available);
await backend.initialize();

const key = buildCanonicalKey({ domain: 'editor', platform: 'browser', platformVersion: 1, callingModule: 'drafts', actualKey: 'beach' });
const big = 'pixel'.repeat(20_000);
await backend.write(key, { payload: big, schema_version: 1, written_at: 1, expires_at: null, weight: 1, backend: 'opfs' });

const read = await backend.read(key);
console.log('read length:', read?.payload.length);
console.log('entries:', await backend.count('editor:browser:1:drafts:'));
await backend.delete(key);
console.log('after delete:', await backend.count());
await backend.close();
```

```text output
available: true
read length: 100000
entries: 1
after delete: 0
```

## Undo a group of writes

<!-- example id="storage/opfs-transaction" runtime="browser" -->

An import writes several files. When one step fails, a rollback leaves the folder as it was. OPFS transactions are `compensating`, so ask for that strength.

```ts file=main.ts
import { OPFSBackend, buildCanonicalKey } from '@platform/storage';

const backend = new OPFSBackend({ rootDirName: 'import' });
await backend.initialize();
const key = (name: string) =>
  buildCanonicalKey({ domain: 'editor', platform: 'browser', platformVersion: 1, callingModule: 'import', actualKey: name });
const file = { payload: 'data', schema_version: 1, written_at: 1, expires_at: null, weight: 1, backend: 'opfs' as const };

const tx = await backend.beginTransaction('compensating');
await backend.write(key('a'), file, { transactionId: tx.id });
await backend.write(key('b'), file, { transactionId: tx.id });
console.log('strength:', tx.strength, 'buffered:', tx.operations.length);
await tx.rollback();
console.log('files after rollback:', await backend.count());
await backend.close();
```

```text output
strength: compensating buffered: 2
files after rollback: 0
```
