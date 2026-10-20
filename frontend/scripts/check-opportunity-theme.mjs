import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPPORTUNITY_THEMES,
  resolveOpportunityTheme,
} from "../src/lib/opportunity-theme.ts";

const cases = [
  {
    name: "Dandiya title wins over its Events category",
    source: {
      title: "Dandiya Night",
      category: { name: "Events", slug: "events" },
    },
    expected: "dandiya",
  },
  {
    name: "Badminton activity wins over its Sports category",
    source: {
      title: "Doubles tournament",
      activity: { name: "Badminton", slug: "badminton" },
      category: { name: "Sports", slug: "sports" },
    },
    expected: "badminton",
  },
  {
    name: "Diwali is matched from the title",
    source: {
      title: "Diwali celebration",
      category: { name: "Events", slug: "events" },
    },
    expected: "diwali",
  },
  {
    name: "Unknown event falls back to the category atmosphere",
    source: {
      title: "Orientation evening",
      category: { name: "Events", slug: "events" },
    },
    expected: "festive",
  },
  {
    name: "Unmatched opportunity uses the neutral theme",
    source: {
      title: "Something new",
      category: { name: "Other", slug: "other" },
    },
    expected: "neutral",
  },
  {
    name: "Missing fields do not throw",
    source: {},
    expected: "neutral",
  },
];

for (const entry of cases) {
  const theme = resolveOpportunityTheme(entry.source);
  assert.equal(theme.id, entry.expected, entry.name);
}

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
let photos = 0;

for (const theme of OPPORTUNITY_THEMES) {
  if (!theme.photo) {
    continue;
  }
  photos += 1;
  assert.ok(
    theme.photo.src.startsWith("/events/"),
    `${theme.id} photo should be a local event asset`,
  );
  assert.ok(
    existsSync(join(publicDir, theme.photo.src)),
    `${theme.id} photo asset is missing: ${theme.photo.src}`,
  );
}

console.log(
  `opportunity theme checks passed (${cases.length} cases, ${photos} photo assets)`,
);
