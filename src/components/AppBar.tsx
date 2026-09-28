import Link from "next/link";

import { Icon } from "./Icon";
import { ThemeToggle } from "./ThemeToggle";

export function AppBar({ children }: { children?: React.ReactNode }) {
  return (
    <header className="appbar">
      <Link href="/" className="brand">
        <span className="brand-mark">
          <Icon name="activity" size={16} />
        </span>
        Smart Wallets
      </Link>
      <span className="spacer" />
      <div className="appbar-actions">
        {children}
        <ThemeToggle />
      </div>
    </header>
  );
}
