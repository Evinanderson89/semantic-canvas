/** Retired pools reject new work, drain active leases, then release resources once. */
export function leasePool<T>(resources: T[], dispose: (resource: T) => Promise<void> | void) {
  const free = [...resources];
  const waiting: { resolve: (resource: T) => void; reject: (error: Error) => void }[] = [];
  let active = 0, closing = false;
  let drained: (() => void) | undefined;
  let closed: Promise<void> | undefined;
  return {
    acquire(): Promise<T> {
      if (closing) return Promise.reject(new Error("This connection was replaced. Refresh to use the current source."));
      if (free.length) { active++; return Promise.resolve(free.pop()!); }
      if (waiting.length >= 100) return Promise.reject(new Error("The source is busy. Try again shortly."));
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    release(resource: T) {
      const next = waiting.shift();
      if (next) next.resolve(resource);
      else { active--; free.push(resource); if (closing && active === 0) drained?.(); }
    },
    stats: () => ({ poolSize: resources.length, free: free.length, waiting: waiting.length }),
    close(): Promise<void> {
      if (closed) return closed;
      closing = true;
      for (const waiter of waiting.splice(0)) waiter.reject(new Error("This connection was replaced. Refresh to use the current source."));
      const drain = active === 0 ? Promise.resolve() : new Promise<void>(resolve => { drained = resolve; });
      closed = drain.then(async () => {
        const results = await Promise.allSettled(resources.map(dispose));
        const failure = results.find(r => r.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      });
      return closed;
    },
  };
}
