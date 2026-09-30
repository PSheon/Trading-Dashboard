import type { Metadata } from "next";

import { AboutPage } from "@/components/content/about-page";
import { getLocale } from "@/i18n/server";
import { contentBlocks, splitTitle } from "@/lib/content";
import { inlineText } from "@/lib/markdown";

export async function generateMetadata(): Promise<Metadata> {
  return { title: inlineText(splitTitle(contentBlocks("about", await getLocale())).title) };
}

/** CopyDog's /about. Text: docs/content/about.*.md (copied by content:sync). */
export default async function About() {
  return <AboutPage blocks={contentBlocks("about", await getLocale())} />;
}
