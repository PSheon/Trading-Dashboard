import { SettingsView } from "@/components/settings/settings-view";

/** While this route's server part is on the way: the page itself in its
 * loading state (menu, account cards). Its queries start here and the page
 * picks them up from the cache. */
export default function Loading() {
  return <SettingsView />;
}
