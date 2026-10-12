import type { Metadata } from "next";

import { AuthShell } from "@/components/auth-shell";

import { VerificationFlow } from "./verification-flow";

export const metadata: Metadata = {
  title: "Verify your student status",
  description:
    "Upload your student ID to get verified. Every document is reviewed manually and stays private.",
};

export default function VerifyPage() {
  return (
    <AuthShell
      eyebrow="Verification"
      title="Verify your student status"
      lede="Joining opportunities and finding people both need a verified student ID. Review is manual, and your document stays private."
    >
      <VerificationFlow />
    </AuthShell>
  );
}