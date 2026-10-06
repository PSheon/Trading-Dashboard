"use client";
// A fixture for test/busy-buttons.test.ts: what the audit must and must not report.
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { TextButton } from "@/components/ui/text-button";

async function save(): Promise<void> {}
function startSaving(mutation: { mutate: () => void }) { mutation.mutate(); }

export function Sample() {
  const mutation = useMutation({ mutationFn: save });
  const query = useQuery({ queryKey: ["x"], queryFn: save });
  const local = () => startSaving(mutation);
  return (
    <div>
      <Button onClick={() => mutation.mutate()}>bad-mutate</Button>
      <Button onClick={async () => { await save(); }}>bad-await</Button>
      <Button onClick={local}>bad-indirect</Button>
      <TextButton onClick={() => void query.refetch()}>bad-refetch</TextButton>
      <button type="button" onClick={() => void save()}>bad-plain</button>
      <form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Button type="submit">bad-submit</Button></form>
      <Button loading={mutation.isPending} onClick={() => mutation.mutate()}>good-mutate</Button>
      <TextButton busy={query.isFetching} onClick={() => void query.refetch()}>good-refetch</TextButton>
      <button type="button" aria-busy={query.isFetching} onClick={() => void query.refetch()}>good-plain</button>
      <Button /* busy-exempt: fixture */ onClick={() => void save()}>good-exempt</Button>
      <Button onClick={() => console.log("sync")}>good-sync</Button>
    </div>
  );
}
