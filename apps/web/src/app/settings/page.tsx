import { SettingsView } from "@/components/settings-view";
import { titled } from "@/i18n/server";

export const generateMetadata = titled((m) => m.settings.title);

export default function SettingsPage() {
  return <SettingsView />;
}
