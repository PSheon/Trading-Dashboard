import { FavoritesView } from "@/components/favorites-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.favorites.title);

export default function FavoritesPage() {
  return <FavoritesView />;
}
