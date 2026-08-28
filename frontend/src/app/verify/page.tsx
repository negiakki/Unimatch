import type { Metadata } from "next";

import { VerificationFlow } from "./verification-flow";

export const metadata: Metadata = {
  title: "Verify your student status · UniMatch",
  description:
    "Upload your student ID to get verified and unlock UniMatch. Every document is reviewed manually and stays private.",
};

export default function VerifyPage() {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-16">
      <VerificationFlow />
    </main>
  );
}
