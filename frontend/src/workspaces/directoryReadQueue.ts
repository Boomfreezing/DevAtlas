export type DirectoryReadQueue = {
  run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T>;
  dispose(): void;
  readonly stats: Readonly<{ active: number; queued: number; disposed: boolean }>;
};

type QueuedRead = {
  signal: AbortSignal;
  start(): void;
  cancel(): void;
  detach(): void;
};

/** A tree-scoped FIFO for directory reads, never shared across projects or mutations. */
export function createDirectoryReadQueue(): DirectoryReadQueue {
  const pending: QueuedRead[] = [];
  let active = 0;
  let disposed = false;
  let draining = false;
  const abortError = () => new DOMException("Directory read cancelled.", "AbortError");

  function drain() {
    // A synchronous task failure may try to drain again before this loop finishes.
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed && active < 4 && pending.length) {
        const entry = pending.shift()!;
        entry.detach();
        if (entry.signal.aborted) entry.cancel();
        else entry.start();
      }
    } finally {
      draining = false;
    }
  }

  return {
    run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
      if (disposed || signal.aborted) return Promise.reject(abortError());
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          const index = pending.indexOf(entry);
          if (index < 0) return;
          pending.splice(index, 1);
          entry.detach();
          entry.cancel();
        };
        const entry: QueuedRead = {
          signal,
          cancel: () => reject(abortError()),
          detach: () => signal.removeEventListener("abort", onAbort),
          start() {
            active += 1;
            try {
              // The task must pass the same signal to fetch. An active abort does
              // not release a slot until the real task settles, even if ignored.
              Promise.resolve(task()).then(
                (value) => { active -= 1; resolve(value); drain(); },
                (error: unknown) => { active -= 1; reject(error); drain(); },
              );
            } catch (error) {
              active -= 1;
              reject(error);
              drain();
            }
          },
        };
        pending.push(entry);
        signal.addEventListener("abort", onAbort, { once: true });
        drain();
      });
    },
    dispose() {
      disposed = true;
      for (const entry of pending.splice(0)) {
        entry.detach();
        entry.cancel();
      }
    },
    get stats() {
      return { active, queued: pending.length, disposed };
    },
  };
}
