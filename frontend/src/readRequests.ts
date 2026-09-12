import { useEffect, useMemo } from "react";

/** Latest-read-wins within a page. Never use this to cancel submitted mutations. */
export class ReadRequestScope {
  private readonly requests = new Map<string, AbortController>();

  begin(key: string) {
    this.cancel(key);
    const controller = new AbortController();
    this.requests.set(key, controller);
    const isCurrent = () => this.requests.get(key) === controller && !controller.signal.aborted;
    return {
      signal: controller.signal,
      isCurrent,
      finish: () => { if (isCurrent()) this.requests.delete(key); },
    };
  }

  cancel(key: string): boolean {
    const controller = this.requests.get(key);
    this.requests.delete(key);
    controller?.abort();
    return !!controller;
  }

  cancelAll() {
    for (const key of this.requests.keys()) this.cancel(key);
  }
}

export function useReadRequests() {
  const scope = useMemo(() => new ReadRequestScope(), []);
  useEffect(() => () => scope.cancelAll(), [scope]);
  return scope;
}
