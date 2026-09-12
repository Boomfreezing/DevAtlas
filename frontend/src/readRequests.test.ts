import { expect, it } from "vitest";
import { ReadRequestScope } from "./readRequests";

it("aborts replaced reads and fences late completions from their replacements", () => {
  const scope = new ReadRequestScope();
  const old = scope.begin("comparison");
  const latest = scope.begin("comparison");
  expect(old.signal.aborted).toBe(true);
  expect(old.isCurrent()).toBe(false);
  old.finish();
  expect(latest.isCurrent()).toBe(true);
  latest.finish();
  expect(scope.cancel("comparison")).toBe(false);
});

it("cancels independent reads on cleanup and can restart after strict-mode cleanup", () => {
  const scope = new ReadRequestScope();
  const list = scope.begin("list");
  const git = scope.begin("git");
  scope.cancelAll();
  scope.cancelAll();
  expect(list.signal.aborted && git.signal.aborted).toBe(true);
  expect(scope.begin("list").isCurrent()).toBe(true);
});
