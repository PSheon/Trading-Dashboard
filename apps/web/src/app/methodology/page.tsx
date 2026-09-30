import { getLocale, getMessages, titled } from "@/i18n/server";

export const generateMetadata = titled(m => m.methodology.title);
export default async function MethodologyPage() {
  const messages = getMessages(await getLocale());
  const m = messages.methodology;
  return <article className="mx-auto flex max-w-3xl flex-col gap-5 rounded-2xl border border-border bg-card p-6 md:p-10">
    <h1 className="text-2xl font-bold">{m.title}</h1>
    {[m.intro, m.scope, m.copyScore, m.flow, m.exclusions, m.risk, m.records, m.history, m.missing, m.crowd].map(text => <p key={text} className="text-sm leading-relaxed">{text}</p>)}
  </article>;
}
