import Link from "next/link";

import { OrbieMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { getLocale, getMessages } from "@/i18n/server";

export default async function NotFound() {
  const m = getMessages(await getLocale());
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <OrbieMark size={96} className="opacity-80" />
      <h1 className="mt-6 text-2xl font-extrabold tracking-tight">{m.notFound.title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{m.notFound.body}</p>
      <Button asChild className="mt-6" size="lg">
        <Link href="/">{m.notFound.home}</Link>
      </Button>
    </div>
  );
}
