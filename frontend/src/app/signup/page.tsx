import type { Metadata } from "next";

import { SignupForm } from "./signup-form";

export const metadata: Metadata = {
  title: "Create your account · UniMatch",
  description:
    "Create a UniMatch account to verify your student status and meet verified university students.",
};

export default function SignupPage() {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-16">
      <SignupForm />
    </main>
  );
}
