import type { Metadata } from "next";

import { AppHeader } from "@/components/app-header";

import { ProfileEditForm } from "./profile-edit-form";

export const metadata: Metadata = {
  title: "Edit your profile · UniMatch",
  description:
    "Update your UniMatch profile — your studies, bio, and who you're hoping to meet.",
};

export default function ProfileEditPage() {
  return (
    <>
      <AppHeader />
      <main className="mx-auto w-full max-w-md px-5 pb-16">
        <ProfileEditForm />
      </main>
    </>
  );
}
