import { afterEach, expect, it, vi } from "vitest";
import { createDirectoryReadQueue } from "./directoryReadQueue";

function deferred<T = number>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function occupy(queue: ReturnType<typeof createDirectoryReadQueue>) {
  const work = Array.from({ length: 4 }, () => deferred());
  const controllers = work.map(() => new AbortController());
  const results = work.map((item, index) => queue.run(controllers[index].signal, () => item.promise));
  return {
    work, controllers, results,
    async release() {
      work.forEach((item, index) => item.resolve(index));
      await Promise.all(results);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("starts at most four reads and starts queued work in FIFO order", async () => {
  const queue = createDirectoryReadQueue();
  const work = Array.from({ length: 8 }, () => deferred());
  const started: number[] = [];
  const results = work.map((item, index) => queue.run(new AbortController().signal, () => {
    started.push(index);
    return item.promise;
  }));
  expect(started).toEqual([0, 1, 2, 3]);
  expect(queue.stats).toEqual({ active: 4, queued: 4, disposed: false });
  work[2].resolve(2);
  await results[2];
  expect(started).toEqual([0, 1, 2, 3, 4]);
  expect(queue.stats.active).toBe(4);
  work[0].resolve(0);
  await results[0];
  expect(started).toEqual([0, 1, 2, 3, 4, 5]);
  work.forEach((item, index) => item.resolve(index));
  expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(queue.stats).toEqual({ active: 0, queued: 0, disposed: false });
});

it("does not share slots between tree instances", async () => {
  const first = createDirectoryReadQueue();
  const occupied = occupy(first);
  const second = createDirectoryReadQueue();
  await expect(second.run(new AbortController().signal, async () => "other tree")).resolves.toBe("other tree");
  expect(first.stats.active).toBe(4);
  await occupied.release();
});

it("rejects an already aborted read without registering listeners or starting it", async () => {
  const queue = createDirectoryReadQueue();
  const controller = new AbortController();
  controller.abort("not an Error object");
  const listen = vi.spyOn(controller.signal, "addEventListener");
  const task = vi.fn(async () => 1);
  await expect(queue.run(controller.signal, task)).rejects.toMatchObject({ name: "AbortError" });
  expect(listen).not.toHaveBeenCalled();
  expect(task).not.toHaveBeenCalled();
  expect(queue.stats.active).toBe(0);
});

it("removes queued cancellation immediately and preserves the remaining FIFO", async () => {
  const queue = createDirectoryReadQueue();
  const occupied = occupy(queue);
  const cancelled = new AbortController();
  const cancelledTask = vi.fn(async () => 5);
  const result = queue.run(cancelled.signal, cancelledTask);
  const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });
  const nextTask = vi.fn(async () => 6);
  const next = queue.run(new AbortController().signal, nextTask);
  expect(queue.stats.queued).toBe(2);
  cancelled.abort();
  expect(queue.stats.queued).toBe(1);
  await rejection;
  expect(cancelledTask).not.toHaveBeenCalled();
  expect(nextTask).not.toHaveBeenCalled();
  await occupied.release();
  await expect(next).resolves.toBe(6);
  expect(nextTask).toHaveBeenCalledOnce();
});

it("keeps an active slot when its task ignores abort until the task really settles", async () => {
  const queue = createDirectoryReadQueue();
  const occupied = occupy(queue);
  const queuedTask = vi.fn(async () => 8);
  const queued = queue.run(new AbortController().signal, queuedTask);
  occupied.controllers[0].abort();
  await Promise.resolve();
  expect(queue.stats).toEqual({ active: 4, queued: 1, disposed: false });
  expect(queuedTask).not.toHaveBeenCalled();
  occupied.work[0].resolve(0);
  await occupied.results[0];
  await expect(queued).resolves.toBe(8);
  expect(queuedTask).toHaveBeenCalledOnce();
  await occupied.release();
});

it("releases the active slot when the task rejects after an abort", async () => {
  const queue = createDirectoryReadQueue();
  const occupied = occupy(queue);
  const rejected = expect(occupied.results[0]).rejects.toMatchObject({ name: "AbortError" });
  const queuedTask = vi.fn(async () => 8);
  const queued = queue.run(new AbortController().signal, queuedTask);
  occupied.controllers[0].abort();
  occupied.work[0].reject(new DOMException("Aborted", "AbortError"));
  await rejected;
  await expect(queued).resolves.toBe(8);
  occupied.work.slice(1).forEach((item, index) => item.resolve(index));
  await Promise.all(occupied.results.slice(1));
  expect(queue.stats.active).toBe(0);
});

it("drains after an immediate synchronous throw or asynchronous failure", async () => {
  const queue = createDirectoryReadQueue();
  const synchronous = new Error("synchronous failure");
  await expect(queue.run(new AbortController().signal, () => { throw synchronous; })).rejects.toBe(synchronous);
  const asynchronous = new Error("asynchronous failure");
  await expect(queue.run(new AbortController().signal, async () => { throw asynchronous; })).rejects.toBe(asynchronous);
  await expect(queue.run(new AbortController().signal, async () => "recovered")).resolves.toBe("recovered");
  expect(queue.stats).toEqual({ active: 0, queued: 0, disposed: false });
});

it("does not recurse through a long backlog of synchronous task failures", async () => {
  const queue = createDirectoryReadQueue();
  const occupied = occupy(queue);
  const failure = new Error("rejected queued read");
  const failed = Array.from({ length: 2_000 }, () => queue.run(new AbortController().signal, () => {
    throw failure;
  }).catch((error: unknown) => error));
  const next = queue.run(new AbortController().signal, async () => "last");
  await occupied.release();
  expect(await Promise.all(failed)).toEqual(Array.from({ length: 2_000 }, () => failure));
  await expect(next).resolves.toBe("last");
  expect(queue.stats.active).toBe(0);
});

it("disposes queued work and rejects new work without pretending active work has stopped", async () => {
  const queue = createDirectoryReadQueue();
  const occupied = occupy(queue);
  const task = vi.fn(async () => 7);
  const queued = queue.run(new AbortController().signal, task);
  const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
  queue.dispose();
  queue.dispose();
  await rejected;
  expect(queue.stats).toEqual({ active: 4, queued: 0, disposed: true });
  await expect(queue.run(new AbortController().signal, task)).rejects.toMatchObject({ name: "AbortError" });
  expect(task).not.toHaveBeenCalled();
  await occupied.release();
  expect(queue.stats).toEqual({ active: 0, queued: 0, disposed: true });
});

it("handles an active task failure after disposal without an orphaned promise rejection", async () => {
  const queue = createDirectoryReadQueue();
  const pending = deferred();
  const result = queue.run(new AbortController().signal, () => pending.promise);
  const error = new Error("active read failed");
  const rejected = expect(result).rejects.toBe(error);
  queue.dispose();
  pending.reject(error);
  await rejected;
  await Promise.resolve();
  expect(queue.stats.active).toBe(0);
});

it.each(["start", "abort", "dispose"])("detaches the queued abort listener on %s", async (outcome) => {
  const queue = createDirectoryReadQueue();
  const occupied = occupy(queue);
  const controller = new AbortController();
  const listen = vi.spyOn(controller.signal, "addEventListener");
  const detach = vi.spyOn(controller.signal, "removeEventListener");
  const task = vi.fn(async () => "done");
  const result = queue.run(controller.signal, task);
  const settled = result.catch((error: unknown) => error);
  expect(listen).toHaveBeenCalledOnce();
  const listener = listen.mock.calls[0][1];
  if (outcome === "abort") controller.abort();
  else if (outcome === "dispose") queue.dispose();
  else await occupied.release();
  await settled;
  expect(detach).toHaveBeenCalledExactlyOnceWith("abort", listener);
  controller.abort();
  expect(detach).toHaveBeenCalledOnce();
  await occupied.release();
  expect(task).toHaveBeenCalledTimes(outcome === "start" ? 1 : 0);
});

it("returns a stats snapshot without exposing mutable queue state", async () => {
  const queue = createDirectoryReadQueue();
  const before = queue.stats;
  const occupied = occupy(queue);
  expect(before).toEqual({ active: 0, queued: 0, disposed: false });
  expect(queue.stats.active).toBe(4);
  await occupied.release();
});
