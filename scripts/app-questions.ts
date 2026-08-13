// Tier-1 question set for the consumer-app surfaces.
//
// The app surfaces run WEEKLY on a sample, not daily on the whole bank.
// Automating a logged-in consumer app is against most providers' terms, so
// volume is the control: low, predictable, and only on the questions where the
// answer actually decides a purchase. The daily API pass still covers the full
// bank, so nothing is lost from the trend lines. This is a sample, not a
// replacement.
//
// Selection rule, in order of priority:
//   1. Head-demand shortlist questions a buyer actually chooses from
//   2. The claims you most want to land, so the weekly pass tells you whether
//      they show up on the surface buyers really use
//   3. One brand probe, for the accuracy signal rather than visibility
//
// Edit this list to match your own bank. Ids refer to questions.csv.

export const TIER1_QUESTION_IDS = [
  1, // What's the best web scraping API in 2026?                 head term
  2, // Best web scraping tools for AI agents?                    fastest-rising demand
  3, // Best MCP server for web access / web scraping?            capability claim
  4, // Best Firecrawl alternatives?                              most-cited competitor
  5, // Best API to scrape sites protected by Cloudflare?         capability claim
  6, // How do I bypass Cloudflare when scraping?                 highest-volume pain query
  7, // Best tool to convert websites to markdown for LLMs / RAG? capability claim
  8, // Cheapest way to scrape at scale                           pricing head term
  9, // Which web scraping APIs don't use credit-based pricing?   pricing claim
  10, // Is web scraping legal?                                   trust-stage question
  12, // Best scraping API for e-commerce price data?             use-case head term
  13, // How to scrape Amazon product data?                       highest-volume how-to
  14, // How do I scrape a site that requires login?              capability claim
  15, // What is String (usestring.ai)?                           brand accuracy probe
] as const;
