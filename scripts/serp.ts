// SERP parsing: turn a stored Google fetch envelope into the three
// things the tracker actually measures — was an AI answer shown, what did it
// say, and what did it cite.
//
// The two Google surfaces store the raw Web Access API envelope
// ({ statusCode, headers, data }) with `data` holding the rendered HTML. Since
// Aug 6 the runner fetches them with executeJS, so `data` is a real rendered
// page rather than a JS shell.
//
// Three states come out of a rendered page, and telling them apart is the whole
// point. Google declining to generate an answer is a measurement; a page that
// never rendered is a fetch problem. Scoring them the same way would bury the
// second inside the first.
//
//   "answer"      - an AI answer is present. Text and citations extracted.
//   "unavailable" - the page rendered and Google explicitly showed no AI answer
//                   ("An AI Overview is not available for this search"), or the
//                   AI Mode answer container came back empty. A real negative.
//   "shell"       - the page did not render enough to tell. Not a measurement.

export type SerpState = "answer" | "unavailable" | "shell";

export interface SerpParse {
  state: SerpState;
  /** AI answer text when state is "answer"; the page's visible text otherwise. */
  answerText: string;
  /** Outbound URLs from the page, Google's own properties removed. */
  citations: string[];
  /** Visible text length, the signal that separates a rendered page from a shell. */
  textLength: number;
}

// Google says this out loud when it declines. Keep the list short and literal:
// these strings are user-visible copy, so they change slowly and obviously.
const UNAVAILABLE_MARKERS = [
  "An AI Overview is not available for this search",
  "Can't generate an AI overview right now",
  "An AI Overview isn't available for this search",
];

const AI_MARKERS = ["AI Overview", "AI overview"];

// A rendered SERP carries the chrome (nav, tools, footer) even with no results,
// which is roughly 500 characters. Below this, nothing rendered.
const SHELL_TEXT_LIMIT = 900;

const GOOGLE_HOSTS =
  /(^|\.)(google\.[a-z.]+|gstatic\.com|googleusercontent\.com|googleapis\.com|google\.com|policies\.google\.com|support\.google\.com|accounts\.google\.com|schema\.org|w3\.org)$/i;

export function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function outboundLinks(html: string): string[] {
  const seen = new Set<string>();
  for (const match of html.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    let url = match[1];
    // Google wraps some results in /url?q=<target>.
    const wrapped = url.match(/[?&]q=(https?%3A%2F%2F[^&"]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    try {
      const host = new URL(url).hostname;
      if (GOOGLE_HOSTS.test(host)) continue;
      seen.add(url.split("#")[0]);
    } catch {
      // Unparseable href, skip it.
    }
  }
  return [...seen];
}

/**
 * Pull the AI answer out of a rendered SERP.
 *
 * Google's DOM class names are obfuscated and rotate, so anchoring on them would
 * break within weeks. This anchors on the user-visible label instead and takes
 * the text that follows it, which survives markup churn.
 */
function extractAnswer(text: string): string | null {
  for (const marker of AI_MARKERS) {
    const at = text.indexOf(marker);
    if (at === -1) continue;
    const after = text.slice(at + marker.length, at + marker.length + 6000).trim();
    // "Web results" / "People also ask" mark the end of the overview block.
    const end = ["Web results", "People also ask", "Videos", "Sponsored"]
      .map((stop) => after.indexOf(stop))
      .filter((i) => i > 200)
      .sort((a, b) => a - b)[0];
    const body = (end ? after.slice(0, end) : after).trim();
    if (body.length > 200) return body;
  }
  return null;
}

export function parseSerp(rawAnswer: string, model: string): SerpParse {
  let html = "";
  try {
    const envelope = JSON.parse(rawAnswer);
    html = typeof envelope?.data === "string" ? envelope.data : "";
  } catch {
    // Older rows stored the body directly rather than the envelope.
    html = rawAnswer;
  }

  const text = visibleText(html);
  const citations = outboundLinks(html);

  if (text.length < SHELL_TEXT_LIMIT && !UNAVAILABLE_MARKERS.some((m) => text.includes(m))) {
    return { state: "shell", answerText: "", citations, textLength: text.length };
  }

  if (UNAVAILABLE_MARKERS.some((m) => text.includes(m))) {
    return { state: "unavailable", answerText: text.slice(0, 4000), citations, textLength: text.length };
  }

  if (model === "google-ai-mode") {
    // AI Mode is the answer: the whole page is the response, so rendered text
    // beyond the chrome means an answer arrived. It streams in after load, which
    // is why a snapshot often catches the shell instead.
    if (text.length < 3000) {
      return { state: "shell", answerText: "", citations, textLength: text.length };
    }
    return { state: "answer", answerText: text.slice(0, 12000), citations, textLength: text.length };
  }

  const answer = extractAnswer(text);
  if (answer) return { state: "answer", answerText: answer.slice(0, 12000), citations, textLength: text.length };

  // Rendered, organic results present, no overview block and no explicit notice.
  return { state: "unavailable", answerText: text.slice(0, 4000), citations, textLength: text.length };
}
