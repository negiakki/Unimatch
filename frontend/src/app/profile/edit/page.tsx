import type { Metadata } from "next";

import { AppNav } from "@/components/app-nav";

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
        className="mx-auto w-full max-w-2xl px-5 pb-nav sm:px-8 md:pb-16"
      >
        <ProfileEditForm />
      </main>
    </>
  );
}