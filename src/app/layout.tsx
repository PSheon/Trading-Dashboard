import type { Metadata } from "next";
import { Fira_Code, Fira_Sans } from "next/font/google";

import "./globals.css";

const sans = Fira_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans" });
const mono = Fira_Code({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  title: "Smart Wallets",
  description: "Point-in-time Solana smart-wallet profiles",
};

// Applies the saved theme before first paint so a light-theme user never sees
// a dark flash. Dark is the default.
const THEME_SCRIPT = `try{if(localStorage.getItem("theme")==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
