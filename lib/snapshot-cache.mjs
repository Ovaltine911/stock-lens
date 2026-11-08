// App-local singleflight cache. Shares only market snapshots, never user prompts.
export function createSnapshotCache({ load, now = () => Date.now(), ttlMs = 15 * 60_000, maxEntries = 8 }) {
  const entries = new Map();
  const pending = new Map();
  function day() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now())); }
  return {
    async get(mode) {
      const existing = entries.get(mode);
      if (existing && now() - existing.at < ttlMs && existing.day === day()) {
        return { ...structuredClone(existing.value), cached: true, cacheAgeSeconds: Math.floor((now() - existing.at) / 1000) };
      }
      if (pending.has(mode)) {
        const value = await pending.get(mode);
        return { ...structuredClone(value), cached: true, cacheAgeSeconds: 0 };
      }
      const operation = (async () => {
        const value = await load(mode);
        entries.set(mode, { value: structuredClone(value), at: now(), day: day() });
        while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
        return value;
      })();
      pending.set(mode, operation);
      try { return { ...structuredClone(await operation), cached: false, cacheAgeSeconds: 0 }; }
      finally { pending.delete(mode); }
    },
  };
}
