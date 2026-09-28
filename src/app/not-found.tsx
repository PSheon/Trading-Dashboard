import Link from "next/link";

export default function NotFound() {
  return (
    <main>
      <p>Not a registered wallet. <Link href="/">Back to the list</Link></p>
    </main>
  );
}
