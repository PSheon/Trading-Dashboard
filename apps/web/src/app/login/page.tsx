import type { Metadata } from "next";

import { safeNextPath } from "@/lib/session";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Log in · Hyperliquid Watch",
};

/** Single-password gate for the whole dashboard (PRD §8 安全). No accounts —
 * the password is the server-only WEB_PASSWORD env var. */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return <LoginForm next={safeNextPath(next)} />;
}
