// Resolved `data:` URLs for content-addressed pictures (ui image / map_pin).
// The hash is the identity — the same bytes are safe to reuse across rooms —
// but the decoded URLs are large and the map is process-wide, so it is capped
// and dropped on session clear.
//
// In-flight pulls stay in the map until they settle: two mounts of the same
// hash must share one native fetch, even while a session is being torn down.

const inflight = new Set<string>()
const cache = new Map<string, Promise<string>>()

/** Settled entries kept after LRU eviction. In-flight pulls may push size
 * above this briefly; that is cheaper than starting a second fetch. */
export const DATA_URL_CACHE_CAP = 32

export function dataUrlCacheSize(): number {
  return cache.size
}

export function dataUrlCacheHas(hash: string): boolean {
  return cache.has(hash)
}

/** Drop settled URLs. In-flight pulls keep deduping; they land in the cache
 * when they finish and then follow the same cap. */
export function clearDataUrlCache(): void {
  for (const hash of [...cache.keys()]) {
    if (!inflight.has(hash)) cache.delete(hash)
  }
}

function evictSettled(): void {
  for (const hash of cache.keys()) {
    if (cache.size <= DATA_URL_CACHE_CAP) return
    if (inflight.has(hash)) continue
    cache.delete(hash)
  }
}

function touch(hash: string, pending: Promise<string>): void {
  cache.delete(hash)
  cache.set(hash, pending)
}

export function loadDataUrl(hash: string, resolve: () => Promise<string>): Promise<string> {
  const cached = cache.get(hash)
  if (cached) {
    touch(hash, cached)
    return cached
  }
  inflight.add(hash)
  const pending = resolve()
    .catch((error: unknown) => {
      cache.delete(hash)
      throw error
    })
    .finally(() => {
      inflight.delete(hash)
      evictSettled()
    })
  cache.set(hash, pending)
  evictSettled()
  return pending
}
