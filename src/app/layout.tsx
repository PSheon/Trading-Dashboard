import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Wallets",
  description: "Point-in-time Solana smart-wallet profiles",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
