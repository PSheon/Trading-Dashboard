import { AddWallets } from "@/components/AddWallets";
import { JobControl } from "@/components/JobControl";
import { WalletTable } from "@/components/WalletTable";
import { server } from "@/lib/server";
import { listDates, walletList } from "@/lib/views";

// Reads the warehouse on every request; nothing here is prerendered.
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ as_of?: string }> }) {
  const { as_of } = await searchParams;
  const { asOfDate, rows, now } = await walletList(as_of);
  const dates = listDates();
  return (
    <>
      <header className="bar">
        <h1>Smart wallets</h1>
        <span className="spacer" />
        <JobControl initial={{ ...server().runner.state }} now={now} />
      </header>
      <main>
        <WalletTable rows={rows} now={now} dates={dates} asOfDate={asOfDate} />
        <AddWallets />
      </main>
    </>
  );
}
