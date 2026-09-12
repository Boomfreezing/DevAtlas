import { expect, it, vi } from "vitest";
import { TreeRenderBudget } from "./treeRenderBudget";

it("activates windowing across many individually small directories", () => {
  const budget = new TreeRenderBudget();
  const listener = vi.fn();
  budget.subscribe(listener);
  const registrations = Array.from({ length: 24 }, () => budget.register());
  for (const registration of registrations.slice(0, 6)) registration.update(100);
  expect(budget.getSnapshot()).toBe(false);
  expect(listener).not.toHaveBeenCalled();
  for (const registration of registrations.slice(6)) registration.update(100);
  expect(budget.getSnapshot()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  registrations.slice(6).forEach((registration) => registration.release());
  expect(budget.getSnapshot()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
});

it("recounts a page instead of adding its full length again", () => {
  const budget = new TreeRenderBudget();
  const directory = budget.register();
  directory.update(200);
  directory.update(400);
  directory.update(600);
  expect(budget.getSnapshot()).toBe(false);
  directory.update(601);
  expect(budget.getSnapshot()).toBe(true);
  directory.update(600);
  expect(budget.getSnapshot()).toBe(false);
});

it("fences stale updates and cleanup after StrictMode registration replacement", () => {
  const budget = new TreeRenderBudget();
  const old = budget.register();
  old.update(1000);
  old.release();
  const current = budget.register();
  current.update(1000);
  old.release();
  old.update(0);
  expect(budget.getSnapshot()).toBe(true);
  current.release();
  expect(budget.getSnapshot()).toBe(false);
});

it("keeps budgets isolated and removes subscriptions", () => {
  const first = new TreeRenderBudget(), second = new TreeRenderBudget();
  const listener = vi.fn();
  const unsubscribe = first.subscribe(listener);
  unsubscribe();
  first.register().update(800);
  expect(first.getSnapshot()).toBe(true);
  expect(second.getSnapshot()).toBe(false);
  expect(listener).not.toHaveBeenCalled();
});

it("rejects invalid weights without corrupting the current total", () => {
  const budget = new TreeRenderBudget();
  const registration = budget.register();
  registration.update(200);
  for (const invalid of [-1, 0.5, Infinity, NaN]) expect(() => registration.update(invalid)).toThrow(RangeError);
  registration.update(600);
  expect(budget.getSnapshot()).toBe(false);
});
