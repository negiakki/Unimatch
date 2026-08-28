import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-md px-5 pb-16">
      <section className="flex flex-col items-center pt-20 text-center">
        <h1 className="text-4xl font-bold tracking-tight">UniMatch</h1>
        <p className="mt-3 text-lg text-muted">
          Dating, exclusively for verified university students.
        </p>
        <div className="mt-8 flex w-full flex-col gap-3">
          <span className="w-full rounded-2xl bg-accent py-3.5 font-semibold text-white shadow-card transition-transform active:scale-[0.98]">
            Get started
          </span>
          <Link
            href="/login"
            className="w-full rounded-2xl border border-line bg-surface py-3.5 text-center font-semibold text-ink shadow-card transition-transform active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            I have an account
          </Link>
        </div>
        <p className="mt-6 max-w-xs text-sm text-muted">
          Every member is a real student with a verified university ID.
        </p>
      </section>

      <section aria-hidden className="relative mx-auto mt-16 h-80 w-64">
        <div className="absolute inset-x-0 top-0 h-[19rem] rotate-[7deg] rounded-card border border-line bg-surface opacity-70" />
        <div className="absolute inset-x-0 top-0 h-72 overflow-hidden rounded-card border border-line bg-surface shadow-card">
          <div className="flex h-52 items-center justify-center bg-background text-4xl">
            🎓
          </div>
          <div className="px-4 py-3 text-left">
            <div className="h-3.5 w-28 rounded-full bg-line" />
            <div className="mt-2 h-3 w-40 rounded-full bg-line/70" />
            <div className="mt-3 flex gap-1.5">
              <div className="h-6 w-16 rounded-full bg-accent/15" />
              <div className="h-6 w-12 rounded-full bg-accent/15" />
              <div className="h-6 w-14 rounded-full bg-accent/15" />
            </div>
          </div>
        </div>
      </section>

      <section className="mt-10 rounded-card border border-line bg-surface p-5 text-left shadow-card">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-xl bg-accent/15 text-lg">
            ✅
          </span>
          <div>
            <h2 className="font-semibold leading-snug">Student ID required</h2>
            <p className="mt-1 text-sm text-muted">
              Verification is manual and reviewed by our team. Your document
              stays private and never appears on your profile.
            </p>
          </div>
        </div>
      </section>

      <footer className="pt-10 text-center text-xs text-muted">
        © {new Date().getFullYear()} UniMatch · Verification-first dating for
        students
      </footer>
    </main>
  );
}
