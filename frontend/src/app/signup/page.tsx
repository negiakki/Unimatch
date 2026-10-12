import type { Metadata } from "next";

import { AuthShell } from "@/components/auth-shell";

import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "Create your account",
  description:
    "Create a UniMatch account, verify your student status, and start finding people for whatever you're doing.",
};

export default function SignupPage() {
  return (
    <AuthShell
      eyebrow="Join UniMatch"
      title="Create your account"
      lede="Start with an account. Next you'll add your profile and verify your student ID — everyone here is a real student."
    >
      <SignupForm />
    </AuthShell>
  );
}