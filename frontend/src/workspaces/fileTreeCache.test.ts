import { describe, expect, it } from "vitest";
import { BoundedDirectoryCache } from "./fileTreeCache";

type Entry = { data?: { items: unknown[] }; error?: { message: string } };
const entry = (count: number): Entry => ({ data: { items: Array.from({ length: count }, (_, index) => index) } });
const makeCache = (items = 4, directories = 3) => new BoundedDirectoryCache<Entry>({ maxInactiveItems: items, maxInactiveDirectories: directories });

describe("BoundedDirectoryCache", () => {
  it("uses separate node-record and directory budgets for inactive entries", () => {
    const cache = makeCache();
    cache.set("a", entry(2)).set("b", entry(2)).set("c", entry(1));
    expect([...cache.keys()]).toEqual(["b", "c"]);
    expect(cache.stats).toEqual({ directories: 2, activeDirectories: 0, inactiveDirectories: 2, totalItems: 3, activeItems: 0, inactiveItems: 3, pinnedPaths: 0 });
  });

  it("promotes reads in the inactive LRU without sorting or moving active entries", () => {
    const cache = makeCache();
    const first = entry(2);
    cache.set("a", first).set("b", entry(2));
    expect(cache.get("a")).toBe(first);
    cache.set("c", entry(1));
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
    expect(cache.has("c")).toBe(true);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("protects active directories and requests, even when they exceed the inactive budget", () => {
    const cache = makeCache(2, 1);
    const releaseRoot = cache.pin("");
    const releasePending = cache.pin("pending");
    const pending: Entry = {};
    cache.set("", entry(20)).set("pending", pending).set("folded", entry(2));
    pending.data = entry(10).data;
    cache.refresh("pending");
    expect(cache.get("pending")).toBe(pending);
    expect(cache.stats).toMatchObject({ activeItems: 30, inactiveItems: 2, activeDirectories: 2, inactiveDirectories: 1 });
    releasePending();
    expect(cache.has("pending")).toBe(false);
    expect(cache.has("folded")).toBe(true);
    expect(cache.get("")?.data?.items.length).toBe(20);
    releaseRoot();
    expect(cache.size).toBe(1);
    expect(cache.has("folded")).toBe(true);
  });

  it("does not let a large active tree consume the collapsed-cache budget", () => {
    const cache = makeCache(4);
    cache.pin("");
    cache.set("", entry(100));
    const release = cache.pin("small");
    cache.set("small", entry(3));
    release();
    expect(cache.get("small")?.data?.items.length).toBe(3);
    expect(cache.stats).toMatchObject({ activeItems: 100, inactiveItems: 3 });
  });

  it("evicts older collapsed directories when releasing a newly collapsed directory", () => {
    const cache = makeCache(3);
    cache.set("older", entry(2));
    const release = cache.pin("recent");
    cache.set("recent", entry(2));
    release();
    expect(cache.has("older")).toBe(false);
    expect(cache.has("recent")).toBe(true);
    expect(cache.stats.inactiveItems).toBe(2);
  });

  it("counts empty and failed directory placeholders toward the entry budget", () => {
    const cache = makeCache(100, 2);
    cache.set("empty", entry(0)).set("pending", {}).set("failed", { error: { message: "retry" } });
    expect(cache.has("empty")).toBe(false);
    expect(cache.get("failed")?.error?.message).toBe("retry");
    expect(cache.stats).toMatchObject({ inactiveItems: 0, inactiveDirectories: 2 });
  });

  it("drops a single oversized inactive entry without discarding smaller cached directories", () => {
    const cache = makeCache(3);
    cache.set("small", entry(2)).set("oversized", entry(4));
    expect(cache.has("small")).toBe(true);
    expect(cache.has("oversized")).toBe(false);
    const growing = entry(1);
    cache.set("growing", growing);
    growing.data = entry(4).data;
    cache.refresh("growing");
    expect(cache.has("growing")).toBe(false);
    expect(cache.has("small")).toBe(true);
    expect(cache.stats.inactiveItems).toBe(2);
  });

  it("recounts both growing and shrinking in-place entries without double counting", () => {
    const cache = makeCache(6);
    const cached = entry(2);
    cache.set("updated", cached).set("other", entry(2));
    cached.data = entry(4).data;
    cache.refresh("updated");
    expect(cache.stats.totalItems).toBe(6);
    cached.data = entry(1).data;
    cache.refresh("updated");
    expect(cache.stats.totalItems).toBe(3);
    cache.refresh("updated");
    expect(cache.stats.totalItems).toBe(3);
    cached.data = entry(6).data;
    cache.refresh("updated");
    expect(cache.has("other")).toBe(false);
    expect(cache.stats.inactiveItems).toBe(6);
    cache.refresh("missing");
    expect(cache.stats.inactiveItems).toBe(6);
  });

  it("updates active weights and invalidates the old identity on replacement", () => {
    const cache = makeCache(2);
    const release = cache.pin("src");
    const original = entry(1);
    cache.set("src", original);
    original.data = entry(4).data;
    cache.refresh("src");
    expect(cache.stats.activeItems).toBe(4);
    const replacement = entry(2);
    cache.set("src", replacement);
    expect(cache.get("src")).not.toBe(original);
    expect(cache.get("src")).toBe(replacement);
    expect(cache.stats.activeItems).toBe(2);
    release();
    expect(cache.stats).toMatchObject({ activeItems: 0, inactiveItems: 2 });
  });

  it("reference-counts independent pins and makes each release idempotent", () => {
    const cache = makeCache(0, 0);
    const first = cache.pin("src");
    const second = cache.pin("src");
    cache.set("src", entry(2));
    first();
    first();
    expect(cache.has("src")).toBe(true);
    second();
    second();
    expect(cache.has("src")).toBe(false);
    expect(cache.stats).toMatchObject({ totalItems: 0, pinnedPaths: 0 });
  });

  it("supports explicit unpin without allowing its old callback to release another pin", () => {
    const cache = makeCache(0, 0);
    const first = cache.pin("src");
    const second = cache.pin("src");
    cache.set("src", entry(1));
    cache.unpin("src");
    first();
    expect(cache.has("src")).toBe(true);
    second();
    expect(cache.has("src")).toBe(false);
    cache.unpin("src");
    cache.unpin("unknown");
    expect(cache.stats.totalItems).toBe(0);
  });

  it("deletes exact subtrees without deleting similarly prefixed or differently cased paths", () => {
    const cache = makeCache(100, 20);
    const release = cache.pin("src/nested");
    for (const path of ["src", "src/nested", "src/nested/deep", "src_extra", "src2/file", "SRC", "other/src"]) cache.set(path, entry(1));
    cache.deleteSubtree("src");
    expect([...cache.keys()]).toEqual(["src_extra", "src2/file", "SRC", "other/src"]);
    expect(cache.stats).toMatchObject({ totalItems: 4, inactiveItems: 4, activeItems: 0, pinnedPaths: 1 });
    cache.set("src/nested", entry(30));
    expect(cache.stats.activeItems).toBe(30);
    release();
    expect(cache.stats.activeItems).toBe(0);
    cache.deleteSubtree("");
    expect(cache.size).toBe(0);
    expect(cache.stats.totalItems).toBe(0);
  });

  it("removes entries using their stored weights even after unrefreshed mutations", () => {
    const cache = makeCache(10);
    const item = entry(2);
    cache.set("src", item);
    item.data = entry(6).data;
    expect(cache.delete("src")).toBe(true);
    expect(cache.delete("src")).toBe(false);
    expect(cache.stats.totalItems).toBe(0);
  });

  it("clears identities and prevents stale cleanup from unpinning a new lifecycle", () => {
    const cache = makeCache(0, 0);
    const oldRelease = cache.pin("src");
    const original = entry(1);
    cache.set("src", original);
    cache.clear();
    expect(cache.get("src")).toBeUndefined();
    expect(cache.stats).toEqual({ directories: 0, activeDirectories: 0, inactiveDirectories: 0, totalItems: 0, activeItems: 0, inactiveItems: 0, pinnedPaths: 0 });
    const newRelease = cache.pin("src");
    cache.set("src", entry(3));
    oldRelease();
    expect(cache.get("src")).not.toBe(original);
    expect(cache.stats).toMatchObject({ activeItems: 3, pinnedPaths: 1 });
    newRelease();
    expect(cache.size).toBe(0);
  });

  it("uses the production defaults without limiting active nodes", () => {
    const cache = new BoundedDirectoryCache<Entry>();
    cache.set("older", entry(1)).set("large", entry(4000));
    expect(cache.has("older")).toBe(false);
    expect(cache.has("large")).toBe(true);
    cache.clear();
    for (let index = 0; index < 65; index += 1) cache.set(String(index), {});
    expect(cache.size).toBe(64);
    expect(cache.has("0")).toBe(false);
  });

  it.each([-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid budget %s", (limit) => {
    expect(() => makeCache(limit)).toThrow(RangeError);
    expect(() => makeCache(4, limit)).toThrow(RangeError);
  });
});
