import type { Metadata } from "next";

import { AuthShell } from "@/components/auth-shell";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Sign in to UniMatch to browse opportunities and find people to do them with.",
};

export default function LoginPage() {
  return (
    <AuthShell
      eyebrow="Welcome back"
      title="Sign in"
      lede="Pick up where you left off — the opportunities you joined and the people you're looking for."
    >
      <LoginForm />
    </AuthShell>
  );
}