import { createContext, useContext, useEffect, useRef, useSyncExternalStore } from "react";

/** Counts displayed metadata across mounted directories, not DOM rows or bytes. */
export class TreeRenderBudget {
  private readonly weights = new Map<symbol, number>();
  private readonly listeners = new Set<() => void>();
  private total = 0;
  private windowed = false;

  getSnapshot = () => this.windowed;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  register() {
    const token = Symbol("visible-directory");
    this.weights.set(token, 0);
    return {
      update: (weight: number) => {
        const previous = this.weights.get(token);
        if (previous === undefined) return;
        if (!Number.isSafeInteger(weight) || weight < 0) throw new RangeError("Tree weight must be a non-negative safe integer.");
        this.weights.set(token, weight);
        this.total += weight - previous;
        this.publish();
      },
      release: () => {
        const weight = this.weights.get(token);
        if (weight === undefined) return;
        this.weights.delete(token);
        this.total -= weight;
        this.publish();
      },
    };
  }

  private publish() {
    const next = this.total > 600;
    if (next === this.windowed) return;
    this.windowed = next;
    // Only threshold crossings notify consumers, not every page or directory.
    for (const listener of this.listeners) listener();
  }
}

export const TreeRenderBudgetContext = createContext<TreeRenderBudget | null>(null);
const noSubscription = () => () => {};
const notWindowed = () => false;

export function useTreeMetadataBudget(weight: number) {
  const budget = useContext(TreeRenderBudgetContext);
  const latestWeight = useRef(weight);
  latestWeight.current = weight;
  const registration = useRef<ReturnType<TreeRenderBudget["register"]> | null>(null);
  useEffect(() => {
    const lease = budget?.register() ?? null;
    registration.current = lease;
    lease?.update(latestWeight.current);
    return () => {
      lease?.release();
      if (registration.current === lease) registration.current = null;
    };
  }, [budget]);
  useEffect(() => { registration.current?.update(weight); }, [budget, weight]);
}

export function useTreeWindowing() {
  const budget = useContext(TreeRenderBudgetContext);
  return useSyncExternalStore(budget?.subscribe ?? noSubscription, budget?.getSnapshot ?? notWindowed, notWindowed);
}
