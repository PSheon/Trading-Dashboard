import { ComingSoon } from "@/components/coming-soon";

export default async function LeaderDetailPage({
  params,
}: PageProps<"/leaders/[address]">) {
  const { address } = await params;
  return (
    <ComingSoon
      title={`Leader detail — ${address}`}
      prdId="D3"
      description="Coming soon — position table, fill history, self-stored equity curve, coin distribution, and alert history for this address."
    />
  );
}
