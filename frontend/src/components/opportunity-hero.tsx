"use client";

import Image from "next/image";
import { useState } from "react";

import type { Opportunity } from "@/lib/api/opportunities";
import { formatClock, formatEventDate } from "@/lib/format";
import type { OpportunityMotif, OpportunityTheme } from "@/lib/opportunity-theme";

/**
 * The event poster at the top of an opportunity page.
 *
 * Uses the admin-supplied cover when it loads; otherwise draws a local,
 * theme-specific SVG scene — so a missing or broken image still leaves a page
 * that looks made for the event rather than a gray rectangle. The factual row
 * and CTA sit on a strong scrim, keeping them readable over any photograph.
 */
export function OpportunityHero({
  opportunity,
  theme,
  ctaLabel,
  ctaHref,
}: {
  opportunity: Opportunity;
  theme: OpportunityTheme;
  ctaLabel: string;
  ctaHref: string;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const title = opportunity.title ?? "Opportunity";
  const cover = opportunity.cover_image_url;

  // Admin cover first, then the theme photo, then the drawn scene. Tracking
  // every failure (not just the last URL) stops a broken cover from
  // alternating with a broken fallback.
  const themePhoto = theme.photo
    ? {
        src: theme.photo.src,
        alt: theme.photo.alt,
        position: theme.photo.position,
      }
    : null;
  const photo = [cover ? { src: cover, alt: title } : null, themePhoto]
    .filter(
      (entry): entry is { src: string; alt: string; position?: string } =>
        Boolean(entry),
    )
    .find((entry) => !failed.includes(entry.src));

  function handleImageError(src: string) {
    setFailed((current) =>
      current.includes(src) ? current : [...current, src],
    );
  }

  const day = formatEventDate(opportunity.opportunity_date);
  const start = formatClock(opportunity.start_time);
  const end = formatClock(opportunity.end_time);
  const time = start ? (end ? `${start} – ${end}` : start) : null;
  const taxonomy = [opportunity.activity?.name, opportunity.category?.name]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      className="grain relative isolate flex min-h-[min(76svh,760px)] flex-col justify-end overflow-hidden text-white sm:min-h-[min(88svh,820px)]"
      style={{
        backgroundColor: theme.hero.from,
        backgroundImage: `linear-gradient(155deg, ${theme.hero.from} 0%, ${theme.hero.via} 52%, ${theme.hero.to} 100%)`,
      }}
    >
      {photo ? (
        <Image
          key={photo.src}
          src={photo.src}
          alt={photo.alt}
          fill
          priority
          unoptimized={!photo.src.startsWith("/")}
          sizes="100vw"
          style={{ objectPosition: photo.position }}
          onError={() => handleImageError(photo.src)}
          className="animate-fade-in object-cover"
        />
      ) : (
        <ThemeScene motif={theme.motif} glow={theme.hero.glow} />
      )}

      {/* Two scrims: a themed tint for identity, then a dark base for contrast. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `linear-gradient(115deg, ${theme.hero.from}f2 0%, ${theme.hero.from}73 50%, transparent 80%)`,
        }}
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/55 to-black/20"
      />

      <div className="animate-rise relative z-10 mx-auto w-full max-w-6xl px-5 pb-8 pt-24 sm:px-8 sm:pb-14 sm:pt-32">
        {taxonomy && <p className="type-meta text-white/70">{taxonomy}</p>}
        <h1 className="type-display mt-3 max-w-4xl text-[clamp(2.25rem,9vw,7rem)] text-balance sm:mt-4">
          {title}
        </h1>

        <div className="mt-7 flex flex-col gap-5 border-t border-white/25 pt-5 sm:mt-9 sm:gap-7 sm:pt-6 md:flex-row md:items-end md:justify-between">
          <dl className="flex flex-wrap gap-x-7 gap-y-3 sm:gap-x-10 sm:gap-y-5">
            <HeroFact label="Date" value={day || "Date to be announced"} />
            <HeroFact
              label="Time"
              value={time || "Time to be announced"}
            />
            <HeroFact
              label="Where"
              value={opportunity.location || "Location to be announced"}
            />
            {opportunity.capacity !== null && (
              <HeroFact label="Capacity" value={String(opportunity.capacity)} />
            )}
          </dl>

          <a
            href={ctaHref}
            className="group inline-flex min-h-12 w-full shrink-0 items-center justify-center gap-3 self-start rounded-full bg-paper px-6 py-3 text-sm font-semibold text-ink transition-[transform,background-color] duration-150 hover:bg-white active:scale-[0.98] sm:w-auto md:self-auto"
          >
            {ctaLabel}
            <span
              aria-hidden
              className="text-accent transition-transform duration-300 group-hover:translate-x-1"
            >
              →
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}

function HeroFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="max-w-56">
      <dt className="type-meta text-white/60">{label}</dt>
      <dd className="mt-1 text-[15px] font-semibold leading-snug text-white sm:mt-1.5 sm:text-base">
        {value}
      </dd>
    </div>
  );
}

/* --------------------------------------------------------------- artwork -- */

function ThemeScene({
  motif,
  glow,
}: {
  motif: OpportunityMotif;
  glow: string;
}) {
  return (
    <div aria-hidden className="absolute inset-0">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at 78% 22%, ${glow}59 0%, transparent 42%), radial-gradient(circle at 12% 82%, ${glow}24 0%, transparent 52%)`,
        }}
      />
      <svg
        viewBox="0 0 1200 800"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 h-full w-full"
      >
        <SceneMotif motif={motif} glow={glow} />
      </svg>
    </div>
  );
}

function SceneMotif({ motif, glow }: { motif: OpportunityMotif; glow: string }) {
  const line = {
    fill: "none",
    stroke: glow,
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  switch (motif) {
    case "rangoli":
      return (
        <g>
          <g transform="translate(910 280)" opacity="0.7">
            <circle r="220" {...line} opacity="0.45" />
            <circle r="168" {...line} opacity="0.3" />
            <circle r="108" {...line} opacity="0.4" />
            <circle r="54" {...line} opacity="0.5" />
            {Array.from({ length: 12 }, (_, index) => (
              <ellipse
                key={index}
                cx="0"
                cy="-138"
                rx="17"
                ry="46"
                transform={`rotate(${index * 30})`}
                {...line}
                opacity="0.32"
              />
            ))}
            {Array.from({ length: 24 }, (_, index) => {
              const angle = (index / 24) * Math.PI * 2;
              return (
                <circle
                  key={index}
                  cx={Math.cos(angle) * 244}
                  cy={Math.sin(angle) * 244}
                  r="5"
                  fill={glow}
                  opacity="0.55"
                />
              );
            })}
          </g>
          <Dancer x={700} y={610} glow={glow} flip={false} />
          <Dancer x={1080} y={640} glow={glow} flip />
        </g>
      );

    case "diya":
      return (
        <g>
          <g opacity="0.45">
            <path
              d="M0 96Q300 168 600 92T1200 112"
              {...line}
              opacity="0.45"
            />
            {Array.from({ length: 9 }, (_, index) => {
              const x = 90 + index * 132;
              const y = 100 + Math.sin(index * 0.9) * 22;
              return (
                <g key={index}>
                  <circle cx={x} cy={y} r="6" fill={glow} opacity="0.7" />
                  <circle
                    cx={x}
                    cy={y}
                    r="18"
                    {...line}
                    opacity="0.2"
                  />
                </g>
              );
            })}
          </g>
          <Diya x={890} y={580} scale={1.35} glow={glow} />
          <Diya x={700} y={650} scale={0.85} glow={glow} />
          <Diya x={1090} y={670} scale={0.7} glow={glow} />
        </g>
      );

    case "splash":
      return (
        <g>
          <circle cx="900" cy="280" r="190" fill={glow} opacity="0.12" />
          <circle cx="1060" cy="430" r="120" fill={glow} opacity="0.16" />
          <circle cx="760" cy="470" r="86" fill={glow} opacity="0.1" />
          <circle cx="900" cy="280" r="228" {...line} opacity="0.22" />
          <path
            d="M700 180C790 120 1010 130 1080 260"
            {...line}
            opacity="0.4"
          />
          {Array.from({ length: 18 }, (_, index) => (
            <circle
              key={index}
              cx={640 + ((index * 137) % 540)}
              cy={140 + ((index * 91) % 500)}
              r={index % 3 === 0 ? 9 : 5}
              fill={glow}
              opacity="0.5"
            />
          ))}
        </g>
      );

    case "court":
      return (
        <g>
          <g {...line} opacity="0.38">
            <path d="M600 540 1190 470 1190 780 600 780Z" />
            <path d="M745 566v214M930 548v232M600 660l590-26" />
            <path d="M840 500v-8M1040 478v-8" />
          </g>
          <g transform="translate(920 270) rotate(-16)">
            <circle cx="0" cy="0" r="18" fill={glow} opacity="0.55" />
            <path
              d="M-11-9-62-96 62-96 11-9Z"
              {...line}
              opacity="0.6"
              strokeWidth="2.5"
            />
            <path
              d="M-11-9-62-96M11-9l51-87M0-14v-82M-28-50h56"
              {...line}
              opacity="0.45"
              strokeWidth="2"
            />
          </g>
          <circle cx="700" cy="640" r="8" fill={glow} opacity="0.6" />
        </g>
      );

    case "field":
      return (
        <g>
          <circle
            cx="910"
            cy="400"
            r="238"
            {...line}
            opacity="0.24"
            strokeWidth="2"
          />
          <path d="M672 400h476" {...line} opacity="0.2" />
          <rect
            x="1138"
            y="286"
            width="62"
            height="228"
            {...line}
            opacity="0.28"
          />
          <circle cx="732" cy="596" r="26" fill={glow} opacity="0.4" />
          <path
            d="M732 575c14-10 30-4 31 8s-12 20-24 14"
            {...line}
            opacity="0.55"
          />
          <path
            d="M1040 520c41 0 74 33 74 74"
            {...line}
            opacity="0.16"
          />
        </g>
      );

    case "stage":
      return (
        <g>
          <path d="M690 800 400 0h210Z" fill={glow} opacity="0.07" />
          <path d="M1010 800 1220 0h-200Z" fill={glow} opacity="0.06" />
          <g {...line} opacity="0.35">
            <rect x="760" y="150" width="230" height="112" rx="10" />
            <rect x="785" y="280" width="180" height="88" rx="8" />
            <path d="M640 760h460" strokeWidth="3" />
          </g>
          {Array.from({ length: 16 }, (_, index) => (
            <g key={index}>
              <circle
                cx={640 + index * 32}
                cy={760 - (index % 3) * 14}
                r="12"
                fill={glow}
                opacity="0.25"
              />
              <path
                d={`M${634 + index * 32} 772v34M${646 + index * 32} 772v34`}
                {...line}
                opacity="0.2"
              />
            </g>
          ))}
        </g>
      );

    case "screen":
      return (
        <g>
          <path d="M0 700 660 350v390Z" fill={glow} opacity="0.06" />
          <g transform="rotate(-11 900 400)">
            <rect
              x="650"
              y="300"
              width="520"
              height="180"
              rx="14"
              {...line}
              opacity="0.4"
              strokeWidth="2"
            />
            {Array.from({ length: 8 }, (_, index) => (
              <g key={index}>
                <rect
                  x={686 + index * 60}
                  y="316"
                  width="24"
                  height="16"
                  rx="3"
                  {...line}
                  opacity="0.32"
                />
                <rect
                  x={686 + index * 60}
                  y="448"
                  width="24"
                  height="16"
                  rx="3"
                  {...line}
                  opacity="0.32"
                />
              </g>
            ))}
          </g>
          <circle cx="1110" cy="220" r="76" fill={glow} opacity="0.1" />
          <circle cx="1110" cy="220" r="104" {...line} opacity="0.18" />
        </g>
      );

    case "trail":
      return (
        <g>
          <circle cx="930" cy="236" r="88" fill={glow} opacity="0.18" />
          <circle cx="930" cy="236" r="124" {...line} opacity="0.2" />
          <path
            d="M0 700 260 380l170 200 170-146 230 266Z"
            fill={glow}
            opacity="0.09"
          />
          <path
            d="M0 700 260 380l170 200 170-146 230 266"
            {...line}
            opacity="0.35"
            strokeWidth="2"
          />
          <path
            d="M500 820c90-170 340-110 440-270"
            {...line}
            opacity="0.4"
            strokeDasharray="3 12"
            strokeWidth="3"
          />
        </g>
      );

    case "bunting":
      return (
        <g>
          <path
            d="M-20 118C200 210 420 76 620 126s350 96 600 8"
            {...line}
            opacity="0.4"
            strokeWidth="2"
          />
          {Array.from({ length: 10 }, (_, index) => {
            const x = 40 + index * 124;
            const y = 126 + Math.sin(index * 1.2) * 34;
            return (
              <path
                key={index}
                d={`M${x} ${y}l32 4-20 42Z`}
                fill={glow}
                opacity={index % 2 === 0 ? 0.32 : 0.18}
              />
            );
          })}
          <g opacity="0.5">
            <circle cx="930" cy="330" r="150" {...line} opacity="0.2" />
            <path
              d="M930 210v240M810 330h240M845 245l170 170M1015 245 845 415"
              {...line}
              opacity="0.16"
            />
          </g>
          {Array.from({ length: 14 }, (_, index) => (
            <circle
              key={index}
              cx={660 + ((index * 113) % 500)}
              cy={240 + ((index * 79) % 380)}
              r={index % 2 === 0 ? 6 : 3}
              fill={glow}
              opacity="0.45"
            />
          ))}
        </g>
      );

    case "table":
      return (
        <g>
          <ellipse
            cx="900"
            cy="566"
            rx="266"
            ry="66"
            fill={glow}
            opacity="0.07"
          />
          <ellipse cx="900" cy="566" rx="266" ry="66" {...line} opacity="0.2" />
          <g transform="translate(780 480)">
            <path
              d="M-64-42h128v82a64 54 0 0 1-128 0Z"
              {...line}
              opacity="0.5"
              strokeWidth="2"
            />
            <path
              d="M64-18h22a24 24 0 0 1 0 48H64"
              {...line}
              opacity="0.4"
              strokeWidth="2"
            />
            <path
              d="M-22-62c-14-18 14-30 0-48M12-62c-14-18 14-30 0-48"
              {...line}
              opacity="0.3"
            />
          </g>
          <g transform="translate(1030 520)">
            <path
              d="M-46-30h92v58a46 38 0 0 1-92 0Z"
              {...line}
              opacity="0.38"
              strokeWidth="2"
            />
            <path
              d="M-16-46c-10-14 10-22 0-36"
              {...line}
              opacity="0.25"
            />
          </g>
          <circle cx="700" cy="360" r="5" fill={glow} opacity="0.5" />
          <circle cx="1100" cy="330" r="8" fill={glow} opacity="0.35" />
        </g>
      );

    default:
      return (
        <g>
          <path
            d="M670 800V430a300 300 0 0 1 600 0v370"
            {...line}
            opacity="0.22"
            strokeWidth="2"
          />
          <path
            d="M760 800V450a210 210 0 0 1 420 0v350"
            {...line}
            opacity="0.16"
            strokeWidth="2"
          />
          <path
            d="M850 800V470a120 120 0 0 1 240 0v330"
            {...line}
            opacity="0.12"
            strokeWidth="2"
          />
          {Array.from({ length: 12 }, (_, index) => (
            <circle
              key={index}
              cx={690 + ((index * 101) % 570)}
              cy={180 + ((index * 73) % 420)}
              r={index % 3 === 0 ? 7 : 3}
              fill={glow}
              opacity="0.35"
            />
          ))}
        </g>
      );
  }
}

function Dancer({
  x,
  y,
  glow,
  flip,
}: {
  x: number;
  y: number;
  glow: string;
  flip: boolean;
}) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${flip ? -1 : 1} 1)`}
      fill={glow}
      opacity="0.5"
    >
      <circle cx="0" cy="-104" r="15" />
      <path d="M-7-86-3-20-30 54-14 60 2-6 20 60 36 52 10-20Z" />
      <path
        d="M-3-80-42-46M-3-80 32-54"
        stroke={glow}
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M-58-58 32-88"
        stroke={glow}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        opacity="0.6"
      />
      <path
        d="M-14 60 0 86M20 56l16 30"
        stroke={glow}
        strokeWidth="5"
        fill="none"
        strokeLinecap="round"
      />
    </g>
  );
}

function Diya({
  x,
  y,
  scale,
  glow,
}: {
  x: number;
  y: number;
  scale: number;
  glow: string;
}) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="0" cy="34" rx="104" ry="26" fill={glow} opacity="0.12" />
      <path
        d="M-100 18Q0 88 100 18Q88 58 0 66Q-88 58-100 18Z"
        fill={glow}
        opacity="0.5"
      />
      <path
        d="M0 18C-22-4-13-36 0-54 14-34 22-4 0 18Z"
        fill="#fff"
        opacity="0.85"
      />
      <path
        d="M-100 18Q0 88 100 18"
        fill="none"
        stroke={glow}
        strokeWidth="2"
        opacity="0.55"
      />
    </g>
  );
}
