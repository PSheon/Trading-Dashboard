import Link from "next/link";

import { AppBar } from "@/components/AppBar";

export default function NotFound() {
  return (
    <>
      <AppBar />
      <main>
        <div className="card">
          <h2>Not a registered wallet</h2>
          <p className="footnote">
            <Link href="/">Back to all wallets</Link>
          </p>
        </div>
      </main>
    </>
  );
}
