/**
 * Event themes for opportunity landing pages.
 *
 * The catalog is admin-managed, so theming is resolved from whatever the
 * opportunity actually carries: activity, category, title, and (last) the
 * description. Activity and title are weighted highest; an unknown event falls
 * back to a neutral UniMatch atmosphere rather than an arbitrary color.
 *
 * Every theme is a variation of one identity: same type, same paper, different
 * atmosphere. No theme invents event facts — only mood words and palette.
 */

export type OpportunityMotif =
  | "rangoli"
  | "diya"
  | "splash"
  | "court"
  | "field"
  | "stage"
  | "screen"
  | "trail"
  | "bunting"
  | "table"
  | "arch";

export interface OpportunityPhoto {
  /** Local asset in /public/events. Kept local so a theme never depends on a
   * third-party host staying up. */
  src: string;
  alt: string;
  /** CSS object-position for the crop, in both hero and cards. */
  position?: string;
}

export interface OpportunityTheme {
  id: string;
  name: string;
  motif: OpportunityMotif;
  /** Event-appropriate photography. Missing photos fall back to the motif. */
  photo?: OpportunityPhoto;
  /** Three atmosphere words. Descriptive of the activity, never event facts. */
  mood: readonly [string, string, string];
  /** One atmospheric line used as the page's editorial mood statement. */
  atmosphere: string;
  /** Text/button accent with sufficient contrast on paper. */
  accent: string;
  accentInk: string;
  /** Translucent accent tint for bands and cards. */
  soft: string;
  hero: {
    from: string;
    via: string;
    to: string;
    glow: string;
  };
  /**
   * Specific themes outweigh generic ones (badminton over sports), so a
   * generic keyword elsewhere in the record cannot erase the activity signal.
   */
  priority: number;
  keywords: readonly string[];
}

export interface ThemeSource {
  title?: string | null;
  description?: string | null;
  activity?: { name?: string | null; slug?: string | null } | null;
  category?: { name?: string | null; slug?: string | null } | null;
}

export const OPPORTUNITY_THEMES: readonly OpportunityTheme[] = [
  {
    id: "dandiya",
    name: "Dandiya night",
    motif: "rangoli",
    // Photo: "GARBA DANCE GUJARAT" (CC0), Wikimedia Commons.
    photo: {
      src: "/events/dandiya.jpg",
      alt: "Dancers in traditional chaniya choli holding dandiya sticks under festive lights",
      position: "50% 40%",
    },
    mood: ["Music", "Colour", "Community"],
    atmosphere:
      "A floor full of dancers, a beat that carries, and a night that belongs to everyone.",
    accent: "#a3143f",
    accentInk: "#ffffff",
    soft: "#a3143f14",
    hero: {
      from: "#1b0713",
      via: "#57112f",
      to: "#a83a1c",
      glow: "#ffb45e",
    },
    priority: 2,
    keywords: ["dandiya", "garba", "navratri", "navaratri"],
  },
  {
    id: "diwali",
    name: "Diwali",
    motif: "diya",
    // Photo: "Lakshmi Puja. Diwali. 2019." (CC0), Flickr.
    photo: {
      src: "/events/diwali.jpg",
      alt: "Golden diyas and marigold garlands glowing during Diwali",
      position: "50% 55%",
    },
    mood: ["Lights", "Sweets", "Together"],
    atmosphere:
      "Small flames, shared sweets, and a street that glows late into the night.",
    accent: "#7a4b00",
    accentInk: "#ffffff",
    soft: "#7a4b0014",
    hero: {
      from: "#100b05",
      via: "#3a2407",
      to: "#8a5410",
      glow: "#ffcf6b",
    },
    priority: 2,
    keywords: [
      "diwali",
      "deepavali",
      "diya",
      "diyas",
      "rangoli",
      "lakshmi",
      "festival of lights",
    ],
  },
  {
    id: "holi",
    name: "Holi",
    motif: "splash",
    // Photo: "Holi Celebration India" (CC0), Wikimedia Commons.
    photo: {
      src: "/events/holi.jpg",
      alt: "Friends covered in brightly coloured powder during Holi",
      position: "50% 42%",
    },
    mood: ["Colour", "Music", "Mischief"],
    atmosphere:
      "Colour in the air, music in the street, and no clean clothes by the end.",
    accent: "#9c1f63",
    accentInk: "#ffffff",
    soft: "#9c1f6314",
    hero: {
      from: "#160823",
      via: "#4f1245",
      to: "#b94422",
      glow: "#ffe066",
    },
    priority: 2,
    keywords: ["holi", "colors", "colours", "rang barse"],
  },
  {
    id: "badminton",
    name: "Badminton",
    motif: "court",
    // Photo: "Badminton-1428046" (CC0), Wikimedia Commons.
    photo: {
      src: "/events/badminton.jpg",
      alt: "A badminton racket and shuttlecocks on a green court",
      position: "50% 55%",
    },
    mood: ["Court", "Racket", "Rally"],
    atmosphere:
      "The squeak of shoes, a fast shuttle, and a rally that refuses to end.",
    accent: "#00674a",
    accentInk: "#ffffff",
    soft: "#00674a14",
    hero: {
      from: "#041d17",
      via: "#084432",
      to: "#0f6e50",
      glow: "#c8ff7a",
    },
    priority: 2,
    keywords: [
      "badminton",
      "shuttle",
      "shuttlecock",
      "shuttler",
      "racket",
      "racquet",
      "smashers",
    ],
  },
  {
    id: "sports",
    name: "Sports",
    motif: "field",
    // Photo: "Kashima Stadium 1" (CC0), Wikimedia Commons.
    photo: {
      src: "/events/sports.jpg",
      alt: "A floodlit football stadium with players and a full crowd",
      position: "50% 52%",
    },
    mood: ["Play", "Team", "Push"],
    atmosphere:
      "A whistle, a crowd on the sideline, and a game worth showing up for.",
    accent: "#0b5b3a",
    accentInk: "#ffffff",
    soft: "#0b5b3a14",
    hero: {
      from: "#061711",
      via: "#0a3a27",
      to: "#155c3a",
      glow: "#d7ff8a",
    },
    priority: 1,
    keywords: [
      "sport",
      "sports",
      "football",
      "cricket",
      "basketball",
      "tennis",
      "pickleball",
      "volleyball",
      "running",
      "marathon",
      "tournament",
      "match",
      "fitness",
      "league",
      "athletic",
      "athletics",
    ],
  },
  {
    id: "concert",
    name: "Live music",
    motif: "stage",
    // Photo: "Music Fans Film Concert Show with Smart Phones" (CC0), Flickr.
    photo: {
      src: "/events/concert.jpg",
      alt: "A concert crowd filming the stage under blue and white lights",
      position: "50% 55%",
    },
    mood: ["Sound", "Lights", "Crowd"],
    atmosphere:
      "Lights down, volume up, and a room that moves as one.",
    accent: "#5b21b6",
    accentInk: "#ffffff",
    soft: "#5b21b614",
    hero: {
      from: "#100617",
      via: "#2c0d4a",
      to: "#6a1a5f",
      glow: "#ff7ad9",
    },
    priority: 1,
    keywords: [
      "concert",
      "gig",
      "music",
      "band",
      "dj",
      "open mic",
      "singing",
      "singer",
      "entertainment",
      "show",
      "shows",
    ],
  },
  {
    id: "screen",
    name: "Screen night",
    motif: "screen",
    // Photo: "Movie screening at Reading Lighthouse Cafe" (CC0), Wikimedia Commons.
    photo: {
      src: "/events/screen.jpg",
      alt: "An outdoor movie screening at night",
      position: "50% 40%",
    },
    mood: ["Screen", "Snacks", "Late"],
    atmosphere:
      "A dark room, a big screen, and two hours that go somewhere else.",
    accent: "#8a1c1c",
    accentInk: "#ffffff",
    soft: "#8a1c1c14",
    hero: {
      from: "#0a0810",
      via: "#1c1328",
      to: "#43151a",
      glow: "#ffcf7a",
    },
    priority: 1,
    keywords: [
      "movie",
      "movies",
      "film",
      "cinema",
      "screening",
      "watch party",
      "theatre",
      "theater",
      "gaming",
      "gamer",
      "esports",
    ],
  },
  {
    id: "travel",
    name: "Out there",
    motif: "trail",
    // Photo: "Iceland ~ Landmannalaugar Route" (PDM), Flickr.
    photo: {
      src: "/events/travel.jpg",
      alt: "Hikers walking a mountain trail in Iceland",
      position: "50% 58%",
    },
    mood: ["Road", "Open", "Outside"],
    atmosphere:
      "A bag by the door, a road out of town, and a day that doesn't look like campus.",
    accent: "#0d5e69",
    accentInk: "#ffffff",
    soft: "#0d5e6914",
    hero: {
      from: "#041a1f",
      via: "#0a3a43",
      to: "#11606c",
      glow: "#8cebf2",
    },
    priority: 1,
    keywords: [
      "travel",
      "trip",
      "trips",
      "trek",
      "treks",
      "hike",
      "hiking",
      "rishikesh",
      "mussoorie",
      "adventure",
      "outing",
      "road trip",
      "camping",
      "destination",
    ],
  },
  {
    id: "festive",
    name: "Festival",
    motif: "bunting",
    // Photo: "Diwali lights, 2014" (CC0), Flickr.
    photo: {
      src: "/events/festive.jpg",
      alt: "Warm string lights strung across a street at night",
      position: "50% 50%",
    },
    mood: ["Lights", "Crowd", "Celebrate"],
    atmosphere:
      "Bunting overhead, familiar faces, and something worth staying out for.",
    accent: "#a83216",
    accentInk: "#ffffff",
    soft: "#a8321614",
    hero: {
      from: "#1c0703",
      via: "#521508",
      to: "#8f2f12",
      glow: "#ffc46b",
    },
    priority: 1,
    keywords: [
      "event",
      "events",
      "fest",
      "festival",
      "celebration",
      "carnival",
      "christmas",
      "new year",
      "orientation",
      "cultural",
      "college fest",
    ],
  },
  {
    id: "social",
    name: "Good company",
    motif: "table",
    // Photo: "The Cafe Marly" (CC0), Flickr.
    photo: {
      src: "/events/social.jpg",
      alt: "Cafe tables set for an afternoon at the Louvre",
      position: "50% 55%",
    },
    mood: ["Food", "Talk", "Easy"],
    atmosphere:
      "Good food, easy conversation, and no reason to rush off.",
    accent: "#7a3d00",
    accentInk: "#ffffff",
    soft: "#7a3d0014",
    hero: {
      from: "#1d0e04",
      via: "#4a2307",
      to: "#8a4a14",
      glow: "#ffd08a",
    },
    priority: 1,
    keywords: [
      "social",
      "hangout",
      "meetup",
      "club",
      "community",
      "network",
      "food",
      "cafe",
      "cafes",
      "coffee",
      "picnic",
      "games",
      "board games",
      "karaoke",
      "bowling",
    ],
  },
  {
    id: "neutral",
    name: "Something on",
    motif: "arch",
    mood: ["Show up", "Meet", "Do"],
    atmosphere:
      "Something's happening. Join it, and find the people doing it too.",
    accent: "#3f3a33",
    accentInk: "#ffffff",
    soft: "#3f3a3314",
    hero: {
      from: "#101013",
      via: "#26262c",
      to: "#3a3a42",
      glow: "#e6dcc8",
    },
    priority: 1,
    keywords: [],
  },
];

const NEUTRAL_THEME =
  OPPORTUNITY_THEMES[OPPORTUNITY_THEMES.length - 1] ??
  OPPORTUNITY_THEMES[0];

function text(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().trim();
}

function tokens(value: string): Set<string> {
  return new Set(value.split(/[^a-z0-9]+/).filter(Boolean));
}

/**
 * Short keywords are matched as whole tokens ("holi" must not match
 * "holiday"); longer ones may match inside a word ("dance" matches "dancers").
 */
function contains(
  haystack: string,
  tokenSet: Set<string>,
  keyword: string,
): boolean {
  return keyword.length <= 4
    ? tokenSet.has(keyword)
    : haystack.includes(keyword);
}

/**
 * Resolve the atmosphere for an opportunity.
 *
 * Field weight: activity and title (3), category (2), description (1). A field
 * scores at most once per theme, so alias keywords ("event"/"events") cannot
 * stack. The theme's priority then scales the total, letting a specific theme
 * (badminton) beat a generic one (sports) even when the generic keywords appear
 * in more fields. Specific themes come first, so ties go to the specific one.
 */
export function resolveOpportunityTheme(
  source: ThemeSource,
): OpportunityTheme {
  const activity = [text(source.activity?.name), text(source.activity?.slug)]
    .filter(Boolean)
    .join(" ");
  const title = text(source.title);
  const category = [
    text(source.category?.name),
    text(source.category?.slug),
  ]
    .filter(Boolean)
    .join(" ");
  const description = text(source.description);

  const fields = [
    { value: activity, weight: 3 },
    { value: title, weight: 3 },
    { value: category, weight: 2 },
    { value: description, weight: 1 },
  ]
    .filter((field) => field.value.length > 0)
    .map((field) => ({ ...field, tokenSet: tokens(field.value) }));

  if (fields.length === 0) {
    return NEUTRAL_THEME;
  }

  let best = NEUTRAL_THEME;
  let bestScore = 0;

  for (const theme of OPPORTUNITY_THEMES) {
    if (theme.keywords.length === 0) {
      continue;
    }
    let matches = 0;
    for (const field of fields) {
      if (
        theme.keywords.some((keyword) =>
          contains(field.value, field.tokenSet, keyword),
        )
      ) {
        matches += field.weight;
      }
    }
    const score = matches * theme.priority;
    if (score > bestScore) {
      best = theme;
      bestScore = score;
    }
  }

  return best;
}

export function opportunityThemeStyle(
  theme: OpportunityTheme,
): Record<string, string> {
  return {
    "--accent": theme.accent,
    "--accent-ink": theme.accentInk,
    "--event-accent": theme.accent,
    "--event-soft": theme.soft,
    "--event-hero-from": theme.hero.from,
    "--event-hero-via": theme.hero.via,
    "--event-hero-to": theme.hero.to,
    "--event-hero-glow": theme.hero.glow,
  };
}
