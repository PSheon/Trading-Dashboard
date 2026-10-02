import { HomeView } from "@/components/home/home-view";
import { APP_NAME } from "@/lib/config";
import { seo } from "@/lib/seo";

export const generateMetadata = seo("/", (m) => ({ title: `${m.meta.homeTitle} | ${APP_NAME}`, description: m.meta.pages.home, absolute: true }));

export default function HomePage() {
  return <HomeView />;
}
