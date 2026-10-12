import type { Metadata } from "next";

import { AuthShell } from "@/components/auth-shell";

import { ProfileOnboardingForm } from "./profile-onboarding-form";

export const metadata: Metadata = {
  title: "Create your profile",
  description:
    "One profile for everything you do — your studies, your interests, and who you'd like to discover.",
};

export default function OnboardingPage() {
  return (
    <AuthShell
      eyebrow="One profile, everything you do"
      title="Create your profile"
      lede="The same profile follows you through every opportunity — you never need a separate one for anything you do."
    >
      <ProfileOnboardingForm />
    </AuthShell>
  );
}