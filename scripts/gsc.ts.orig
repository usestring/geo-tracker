// Google Search Console pull (SEO half of the weekly report).
//
//   bun scripts/gsc.ts auth              one-time browser consent, saves the token
//   bun scripts/gsc.ts queries [--days=28]   search queries -> data/gsc/queries-YYYYMMDD.csv
//   bun scripts/gsc.ts pages   [--days=28]   page performance -> data/gsc/pages-YYYYMMDD.csv
//   bun scripts/gsc.ts coverage              URL-inspect every sitemap URL -> data/gsc/coverage-YYYYMMDD.csv
//
// Setup (once): create an OAuth client of type "Desktop app" in any GCP project
// (APIs & Services -> Credentials -> Create credentials -> OAuth client ID; enable
// the "Google Search Console API" on the project first). Put the pair in .env:
//   GSC_CLIENT_ID=...apps.googleusercontent.com
//   GSC_CLIENT_SECRET=...
// Then `make gsc-auth` opens the browser; sign in as a Google account that has
// access to your Search Console property. The refresh token lands in
// profiles/gsc-token.json (gitignored) and never expires unless revoked.
//
// The URL Inspection API allows 2,000 inspections/day per property; the sitemap
// is ~30 URLs, so `coverage` uses a fraction of a percent of quota.

import { join } from "node:path";
import { BRAND_DOMAIN, BRAND_SITE } from "./brand.ts";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";

const PROPERTY = process.env.GSC_PROPERTY || `sc-domain:${BRAND_DOMAIN}`;
// Both sitemaps: the marketing site and the docs. sc-domain covers every subdomain.
const SITEMAP_URLS = (process.env.GSC_SITEMAPS || `${BRAND_SITE}/sitemap.xml`).split(",");
const TOKEN_PATH = join(import.meta.dir, "..", "profiles", "gsc-token.json");
const OUT_DIR = join(import.meta.dir, "..", "data", "gsc");
const SCOPE = "https://www.googleapis.com/auth/webmasters";

const argOf = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const DAYS = Number(argOf("days")) || 28;
const cmd = process.argv[2];

function requireClient(): { id: string; secret: string } {
  const id = process.env.GSC_CLIENT_ID, secret = process.env.GSC_CLIENT_SECRET;
  if (!id || !secret) {
    console.error("GSC_CLIENT_ID / GSC_CLIENT_SECRET missing from .env - see the setup comment at the top of scripts/gsc.ts");
    process.exit(1);
  }
  return { id, secret };
}

// --- auth: installed-app loopback flow ---------------------------------------
async function auth() {
  const { id, secret } = requireClient();
  const port = 8763;
  const redirect = `http://127.0.0.1:${port}/`;
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(id)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent(SCOPE)}` +
    `&access_type=offline&prompt=consent`;

  console.log(`Opening browser for consent. Sign in as a user on ${PROPERTY}.`);
  console.log(`If no tab opens, paste this URL yourself:\n${authUrl}`);
  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port,
      fetch(req) {
        const u = new URL(req.url);
        const c = u.searchParams.get("code");
        const err = u.searchParams.get("error");
        if (err) { reject(new Error(err)); return new Response("Auth failed: " + err); }
        if (!c) return new Response("Waiting for Google...");
        resolve(c);
        setTimeout(() => server.stop(), 500);
        return new Response("GSC auth complete. Close this tab.");
      },
    });
    Bun.spawn(["open", authUrl]);
    setTimeout(() => reject(new Error("timed out after 5 minutes waiting for consent")), 300_000);
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: "authorization_code" }),
  });
  const tok = await res.json() as any;
  if (!tok.refresh_token) { console.error("no refresh_token in response:", JSON.stringify(tok)); process.exit(1); }
  writeFileSync(TOKEN_PATH, JSON.stringify({ refresh_token: tok.refresh_token }, null, 2));
  console.log(`token saved to ${TOKEN_PATH}`);
}

async function accessToken(): Promise<string> {
  const { id, secret } = requireClient();
  if (!existsSync(TOKEN_PATH)) { console.error("no token - run `make gsc-auth` first"); process.exit(1); }
  const { refresh_token } = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token, client_id: id, client_secret: secret, grant_type: "refresh_token" }),
  });
  const tok = await res.json() as any;
  if (!tok.access_token) { console.error("token refresh failed:", JSON.stringify(tok)); process.exit(1); }
  return tok.access_token;
}

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");
const csvCell = (v: unknown) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// --- queries / pages: Search Analytics ---------------------------------------
async function searchAnalytics(dimension: "query" | "page") {
  const token = await accessToken();
  const end = new Date(); end.setDate(end.getDate() - 1); // GSC data lags ~1 day
  const start = new Date(end); start.setDate(start.getDate() - DAYS);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const res = await fetch(
    `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(PROPERTY)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ startDate: fmt(start), endDate: fmt(end), dimensions: [dimension], rowLimit: 5000 }),
    }
  );
  if (!res.ok) { console.error(`searchAnalytics ${res.status}: ${await res.text()}`); process.exit(1); }
  const rows = ((await res.json()) as any).rows ?? [];

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `${dimension === "query" ? "queries" : "pages"}-${stamp()}.csv`);
  const lines = [`${dimension},clicks,impressions,ctr,position`];
  for (const r of rows) lines.push([csvCell(r.keys[0]), r.clicks, r.impressions, r.ctr.toFixed(4), r.position.toFixed(1)].join(","));
  writeFileSync(out, lines.join("\n"));
  console.log(`${rows.length} rows (${fmt(start)}..${fmt(end)}) -> ${out}`);

  if (dimension === "query") {
    // Question-shaped queries are candidate additions for the tracker bank.
    const q = rows.filter((r: any) => /^(how|what|which|best|is |can |does |why|vs |compare)/i.test(r.keys[0]) || r.keys[0].includes(" vs "));
    console.log(`\nquestion-shaped queries (${q.length}) - candidates for the bank drift line:`);
    for (const r of q.slice(0, 40)) console.log(`  ${String(r.impressions).padStart(5)} impr  ${r.clicks} clicks  ${r.keys[0]}`);
  }
}

// --- coverage: URL Inspection over the sitemap --------------------------------
async function coverage() {
  const token = await accessToken();
  const urls: string[] = [];
  for (const sm of SITEMAP_URLS) {
    const xml = await (await fetch(sm.trim())).text();
    const found = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    if (found.length === 0) console.error(`warning: no <loc> entries at ${sm}`);
    urls.push(...found);
  }
  if (urls.length === 0) { console.error("no sitemap URLs found at all"); process.exit(1); }
  console.log(`${urls.length} sitemap URLs to inspect (quota: 2000/day)`);

  const results: any[] = [];
  for (const url of urls) {
    const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl: url, siteUrl: PROPERTY }),
    });
    if (!res.ok) { results.push({ url, verdict: `HTTP ${res.status}`, state: (await res.text()).slice(0, 120) }); continue; }
    const r = ((await res.json()) as any).inspectionResult?.indexStatusResult ?? {};
    results.push({
      url,
      verdict: r.verdict ?? "",
      state: r.coverageState ?? "",
      lastCrawl: r.lastCrawlTime ?? "",
      canonical: r.googleCanonical ?? "",
      robots: r.robotsTxtState ?? "",
      fetchState: r.pageFetchState ?? "",
    });
    // "Discovered - currently not indexed" contains the word "indexed", so match
    // the healthy states exactly rather than grepping for the word.
    const healthy = /^(submitted and indexed|indexed, not submitted in sitemap)$/i;
    const bad = r.coverageState && !healthy.test(r.coverageState) ? "  <-- NOT INDEXED" : "";
    console.log(`  ${(r.coverageState ?? "?").padEnd(45)} ${url}${bad}`);
    await Bun.sleep(300); // stay polite; quota is generous but bursts get 429s
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, `coverage-${stamp()}.csv`);
  const lines = ["url,verdict,coverageState,lastCrawl,googleCanonical,robotsTxtState,pageFetchState"];
  for (const r of results) lines.push([r.url, r.verdict, r.state, r.lastCrawl, r.canonical, r.robots, r.fetchState].map(csvCell).join(","));
  writeFileSync(out, lines.join("\n"));
  const notIndexed = results.filter(
    (r) => r.state && !/^(submitted and indexed|indexed, not submitted in sitemap)$/i.test(r.state)
  );
  console.log(`\n${results.length} inspected, ${notIndexed.length} not indexed -> ${out}`);
}

switch (cmd) {
  case "auth": await auth(); break;
  case "queries": await searchAnalytics("query"); break;
  case "pages": await searchAnalytics("page"); break;
  case "coverage": await coverage(); break;
  default:
    console.log("usage: bun scripts/gsc.ts auth | queries [--days=28] | pages [--days=28] | coverage");
    process.exit(1);
}
