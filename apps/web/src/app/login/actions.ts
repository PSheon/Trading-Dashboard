"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  LOGIN_PATH,
  SESSION_COOKIE,
  authConfig,
  createSessionValue,
  passwordMatches,
  safeNextPath,
  sessionCookieOptions,
} from "@/lib/session";

export interface LoginState {
  error?: string;
}

export async function login(
  _prev: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const config = authConfig();
  if (!config) {
    // Fail closed: no WEB_PASSWORD / WEB_SESSION_SECRET means no logins.
    return { error: "Login is not configured on this server." };
  }

  const password = formData.get("password");
  if (typeof password !== "string" || !passwordMatches(password, config)) {
    return { error: "Wrong password." };
  }

  const cookieStore = await cookies();
  cookieStore.set(
    SESSION_COOKIE,
    createSessionValue(config),
    sessionCookieOptions(),
  );
  redirect(safeNextPath(formData.get("next")));
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  redirect(LOGIN_PATH);
}
