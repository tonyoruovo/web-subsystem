// A worker that fails while loading: the host must see an `error` event.
throw new Error('crash.worker: failed while loading');
