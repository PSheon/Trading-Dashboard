import { Skeleton } from "@/components/page";

/** What a route shows while its server part is on the way (a `loading.tsx`
 * re-exports this): the page's outline in the site's skeleton, nothing
 * else. Each view draws its own, fuller skeleton as soon as it mounts. */
export function RouteLoading() {
  return (
    <div className="flex flex-col gap-5" aria-busy="true">
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-11 w-full max-w-md" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-[214px]" />)}
      </div>
    </div>
  );
}
