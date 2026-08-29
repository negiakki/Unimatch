import type { Metadata } from "next";

import { ProfileOnboardingForm } from "./profile-onboarding-form";

export const metadata: Metadata = {
  title: "Create your profile · UniMatch",
  description:
    "Tell UniMatch who you are — your studies, your story, and who you're hoping to meet. Only verified university students can join.",
};

export default function OnboardingPage() {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-16">
      <ProfileOnboardingForm />
    </main>
  );
}
