// Tag parsing for questions.tags (semicolon-separated, e.g.
// "theme:ai-data;cat:use-case;tier:daily;type:validation;prio:1").
// The axes are documented in docs/question-bank.md.
//
// The type:/prio: tags are optional, so every consumer here must degrade
// gracefully when they are absent: no type: tag means a discovery question,
// no prio: tag means unweighted.

/** theme:* value, or null when the question carries none. */
export const themeOf = (tags: string): string | null =>
  tags.match(/theme:([a-z-]+)/)?.[1] ?? null;

/** type:* value (validation | sentiment | market-perception | competitor |
 *  accuracy), or null - and null means a discovery question by convention. */
export const typeOf = (tags: string): string | null =>
  tags.match(/type:([a-z-]+)/)?.[1] ?? null;

/** prio:1|2|3, or null when unprioritized. */
export const prioOf = (tags: string): number | null => {
  const m = tags.match(/prio:([123])/);
  return m ? Number(m[1]) : null;
};

/** Branded = cat:company; every headline number excludes these. */
export const isBranded = (tags: string): boolean => tags.includes("cat:company");
