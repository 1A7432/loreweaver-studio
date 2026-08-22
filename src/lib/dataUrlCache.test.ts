import { afterEach, describe, expect, it, vi } from "vitest"
import {
  clearDataUrlCache,
  DATA_URL_CACHE_CAP,
  dataUrlCacheHas,
  dataUrlCacheSize,
  loadDataUrl,
} from "./dataUrlCache"

afterEach(() => {
  clearDataUrlCache()
})

function hash(n: number): string {
  return n.toString(16).padStart(64, "0")
}

describe("dataUrlCache", () => {
  it("evicts the oldest settled entry once the cap is passed", async () => {
    for (let i = 0; i < DATA_URL_CACHE_CAP; i += 1) {
      await loadDataUrl(hash(i), () => Promise.resolve(`data:${i}`))
    }
    expect(dataUrlCacheSize()).toBe(DATA_URL_CACHE_CAP)
    expect(dataUrlCacheHas(hash(0))).toBe(true)

    await loadDataUrl(hash(DATA_URL_CACHE_CAP), () => Promise.resolve("data:new"))
    expect(dataUrlCacheSize()).toBe(DATA_URL_CACHE_CAP)
    expect(dataUrlCacheHas(hash(0))).toBe(false)
    expect(dataUrlCacheHas(hash(DATA_URL_CACHE_CAP))).toBe(true)
  })

  it("drops settled entries on clear and leaves in-flight pulls sharing one fetch", async () => {
    let finish: (value: string) => void = () => {}
    const resolve = vi.fn(
      () =>
        new Promise<string>((res) => {
          finish = res
        }),
    )
    const first = loadDataUrl(hash(1), resolve)
    const second = loadDataUrl(hash(1), resolve)
    expect(first).toBe(second)
    expect(resolve).toHaveBeenCalledTimes(1)

    await loadDataUrl(hash(2), () => Promise.resolve("data:settled"))
    expect(dataUrlCacheHas(hash(2))).toBe(true)
    clearDataUrlCache()
    expect(dataUrlCacheHas(hash(2))).toBe(false)
    expect(dataUrlCacheHas(hash(1))).toBe(true)

    const third = loadDataUrl(hash(1), resolve)
    expect(third).toBe(first)
    expect(resolve).toHaveBeenCalledTimes(1)

    finish("data:live")
    await expect(first).resolves.toBe("data:live")
  })
})
