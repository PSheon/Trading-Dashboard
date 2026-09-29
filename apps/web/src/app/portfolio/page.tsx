import { PortfolioView } from "@/components/portfolio-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.portfolio.title);

export default function PortfolioPage() {
  return <PortfolioView />;
}
