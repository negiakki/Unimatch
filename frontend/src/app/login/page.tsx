import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in · UniMatch",
  description:
    "Sign in to UniMatch to verify your student status and meet verified university students.",
};

export default function LoginPage() {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-16">
      <LoginForm />
    </main>
  );
}
