/** At most `limit` jobs admitted at once; stop admitting after cancellation. */
export async function forEachConcurrent<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>, signal?: AbortSignal) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const item = items[next++];
      await work(item);
    }
  }));
}
