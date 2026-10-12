import type { Metadata } from "next";

import { AppNav, TAB_BAR_SPACE } from "@/components/app-nav";

import { ProfileEditForm } from "./profile-edit-form";

export const metadata: Metadata = {
  title: "Edit your profile",
  description:
    "Update the photos, studies, bio, and interests people see across every UniMatch opportunity.",
};

export default function ProfileEditPage() {
  return (
    <>
      <AppNav />
      <main
        className={`mx-auto w-full max-w-2xl px-5 sm:px-8 ${TAB_BAR_SPACE}`}
      >
        <ProfileEditForm />
      </main>
    </>
  );
}