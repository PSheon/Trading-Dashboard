import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { AppProviders } from "@/components/app-providers";
import { AppShell } from "@/components/app-shell";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  // "Hyperliquid Watch" is a placeholder product name pending Paul's
  // naming decision (PRD §10 未決問題) — the repo itself stays
  // "Trading-Dashboard".
  title: "Hyperliquid Watch",
  description: "Hyperliquid 大戶監控與警報 Dashboard",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Dark theme is the default per PRD §4.5; no light-mode toggle in M1.
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <AppProviders>
          <AppShell>{children}</AppShell>
        </AppProviders>
      </body>
    </html>
  );
}
