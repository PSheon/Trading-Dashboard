import { AdminBodySkeleton } from "@/components/admin/admin-shell";

/** While an admin page's server part is on the way (inside the admin
 * frame, whose title and menu stay): a card with a table's outline. */
export default function Loading() {
  return <AdminBodySkeleton />;
}
