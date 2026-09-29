import { redirect } from "next/navigation";

/**
 * §9 順序原則: "M1 的 dashboard 只需要一個匯入頁" — the dashboard root sends
 * you straight to it.
 */
export default function Home() {
  redirect("/import");
}
