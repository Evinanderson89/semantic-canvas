import type { Source } from "./registry.ts";

const close = (sources: Source[]) => Promise.allSettled(sources.map(source => Promise.resolve().then(() => source.conn?.close())));

/** Prepare a replacement before publishing it; a failed preparation leaves the current sources usable. */
export function sourceReloader<T extends { sources: Source[] }>(
  load: () => Promise<T>, prepare: (sources: Source[]) => Promise<void>, commit: (loaded: T) => Source[],
) {
  let pending: Promise<unknown> = Promise.resolve();
  return () => {
    const result = pending.then(async () => {
      const loaded = await load();
      let retired: Source[];
      try { await prepare(loaded.sources); retired = commit(loaded); }
      catch (error) { await close(loaded.sources); throw error; }
      // Pooled connectors drain active leases. Their retirement must not block new requests.
      void close(retired);
      return loaded;
    });
    pending = result.catch(() => {});
    return result;
  };
}
