// Who this tracker is measuring. Everything brand-specific lives here, so
// pointing the tracker at a different company is an .env edit, not a code edit.
//
//   BRAND_NAME      the product name as an engine would write it ("Acme")
//   BRAND_DOMAIN    your primary domain, no scheme ("acme.com")
//   BRAND_ALIASES   comma-separated extra spellings the engines use
//   COMPETITORS     comma-separated competitor domains for the sitemap diff
//
// BRAND_ALIASES matters more than it looks. Engines write company names
// inconsistently ("Acme", "Acme AI", "acme.com"), and a mention pass that only
// looks for one spelling will under-count you.

const req = (key: string, fallback?: string) => {
  const v = process.env[key] ?? fallback;
  if (!v) {
    console.error(
      `Missing ${key}. Copy .env.example to .env and set your brand.\n` +
        `See the Quickstart in README.md.`,
    );
    process.exit(1);
  }
  return v;
};

export const BRAND_NAME = req("BRAND_NAME", "");
export const BRAND_DOMAIN = req("BRAND_DOMAIN", "").replace(/^https?:\/\//, "").replace(/\/$/, "");
export const BRAND_SITE = `https://${BRAND_DOMAIN}`;

// Lowercased strings that count as "the answer named us". The domain and the
// product name are always in; BRAND_ALIASES adds the rest.
export const BRAND_MARKERS: string[] = [
  BRAND_NAME.toLowerCase(),
  BRAND_DOMAIN.toLowerCase(),
  ...(process.env.BRAND_ALIASES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
];

/** Is this host ours? Matches the apex and any subdomain. */
export const isOwnDomain = (domain: string): boolean => {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return d === BRAND_DOMAIN || d.endsWith(`.${BRAND_DOMAIN}`);
};

/** Competitor domains for the weekly sitemap diff. Empty is fine. */
export const COMPETITORS: string[] = (process.env.COMPETITORS ?? "")
  .split(",")
  .map((s) => s.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""))
  .filter(Boolean);
