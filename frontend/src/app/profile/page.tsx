import type { Metadata } from "next";

import { AppHeader } from "@/components/app-header";

import { ProfileView } from "./profile-view";

export const metadata: Metadata = {
  title: "Your profile · UniMatch",
  description:
    "How other UniMatch students see you — your photos, studies, bio, and interests.",
};

export default function ProfilePage() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-lg px-5 pb-16">
        <ProfileView />
      </main>
    </>
  );
}
