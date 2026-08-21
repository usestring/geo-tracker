// Anthropic Message Batches helper (added Aug 19 2026).
//
// Why: the tracker pays full price for work that nobody reads until the next
// morning. Batched requests are half price on input AND output tokens, and
// server tools - web search included - are batchable, so both the `claude`
// measurement surface and the extract pass qualify. Measured over Aug 4-19,
// that is roughly $10-24 of a $50-81 bill.
//
// The one hazard is the 24-hour expiry. An unfinished batch returns `expired`
// results and is not billed, but the day's measurement is gone, and a hole in
// the data costs more than the money saved. So every call here takes a deadline
// and hands back whatever is missing. Callers run the misses synchronously.
// Cheaper must never mean thinner.
//
// The per-search fee ($10/1,000) is not a token charge and is not discounted.

const BATCH_API = "https://api.anthropic.com/v1/messages/batches";

function headers(): Record<string, string> {
  return {
    "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };
}

export interface BatchRequest {
  /** Must match ^[a-zA-Z0-9_-]{1,64}$ and be unique within the batch. */
  custom_id: string;
  params: Record<string, unknown>;
}

/** One finished request. `message` on success, `error` otherwise. */
export interface BatchOutcome {
  message?: any;
  error?: string;
}

export interface BatchOptions {
  /** Shown in progress lines, e.g. "claude surface" or "mentions". */
  label: string;
  /** Give up and fall back to sync after this long. Default 45 min. */
  deadlineMs?: number;
  /** Status poll interval. Default 20s. */
  pollMs?: number;
}

/**
 * Submit a batch and return a map of custom_id -> outcome. Any request that did
 * not finish is simply absent from the map: the caller decides whether to run
 * it synchronously or let it fail. Never throws for a partial batch - only for
 * a batch that could not be created at all.
 */
export async function runBatch(
  requests: BatchRequest[],
  opts: BatchOptions
): Promise<Map<string, BatchOutcome>> {
  const out = new Map<string, BatchOutcome>();
  if (requests.length === 0) return out;

  const deadlineMs = opts.deadlineMs ?? 45 * 60 * 1000;
  const pollMs = opts.pollMs ?? 20_000;

  const created = await fetch(BATCH_API, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ requests })
  });
  if (!created.ok) {
    throw new Error(`batch create ${created.status}: ${(await created.text()).slice(0, 300)}`);
  }
  const batch = (await created.json()) as any;
  const id = batch.id as string;
  console.log(`batch ${opts.label}: submitted ${requests.length} requests as ${id}`);

  const startedAt = Date.now();
  let status = batch.processing_status as string;
  let resultsUrl: string | null = batch.results_url ?? null;

  while (status !== "ended") {
    if (Date.now() - startedAt > deadlineMs) {
      // Cancel rather than abandon: a canceled batch still returns whatever
      // finished, and stops us paying for work we are about to redo in sync.
      console.log(`batch ${opts.label}: past the ${Math.round(deadlineMs / 60000)}m deadline, canceling`);
      await fetch(`${BATCH_API}/${id}/cancel`, { method: "POST", headers: headers() }).catch(() => {});
      // Cancellation is not instant; give it one poll interval to settle.
      await Bun.sleep(pollMs);
      break;
    }
    await Bun.sleep(pollMs);
    const res = await fetch(`${BATCH_API}/${id}`, { headers: headers() });
    if (!res.ok) {
      console.log(`batch ${opts.label}: status check ${res.status}, retrying`);
      continue;
    }
    const body = (await res.json()) as any;
    status = body.processing_status;
    resultsUrl = body.results_url ?? resultsUrl;
    const c = body.request_counts ?? {};
    console.log(
      `batch ${opts.label}: ${status} - ${c.succeeded ?? 0} ok, ${c.errored ?? 0} errored, ` +
        `${c.processing ?? 0} processing, ${c.expired ?? 0} expired`
    );
  }

  if (!resultsUrl) {
    const res = await fetch(`${BATCH_API}/${id}`, { headers: headers() });
    if (res.ok) resultsUrl = ((await res.json()) as any).results_url ?? null;
  }
  if (!resultsUrl) {
    console.log(`batch ${opts.label}: no results url; treating every request as unfinished`);
    return out;
  }

  const results = await fetch(resultsUrl, { headers: headers() });
  if (!results.ok) {
    console.log(`batch ${opts.label}: results fetch ${results.status}; treating every request as unfinished`);
    return out;
  }

  // JSONL, one finished request per line, in arbitrary order - always key off
  // custom_id, never position.
  for (const line of (await results.text()).split("\n")) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.result?.type;
    if (type === "succeeded") {
      out.set(row.custom_id, { message: row.result.message });
    } else if (type === "errored") {
      out.set(row.custom_id, { error: `batch errored: ${JSON.stringify(row.result.error).slice(0, 200)}` });
    }
    // canceled / expired are deliberately left out of the map so the caller
    // retries them synchronously.
  }
  console.log(`batch ${opts.label}: ${out.size}/${requests.length} returned a result`);
  return out;
}
