# Fixes: core

> Temporary record of fixes. Delete it when the pull request merges.

| File | Problem | Fix |
|---|---|---|
| `scheduler.ts` | In Node, the `message-channel` scheduler called `unref()` on its port one time, at creation. A task queued while nothing else kept the process alive never ran: Node exited first. A processor on the virtual host in a Node script did not finish. The `core/processor` example in `EXAMPLES.md` found it. | The port is referenced while tasks wait and released when the queue is empty. The `unref()` call now comes after `onmessage` is set, because setting `onmessage` references a Node port. A test in `test/processors.spec.ts` checks the order of the calls. |
