// One politeness lane per upstream HOSTNAME.
//
// Sluice is the whole fleet's downloader, and "every source gets its own timer"
// quietly means "every source that shares an upstream fires at the same instant".
// 24 `eu-power-<country>` sources were registered in the same minute, all at
// `refresh: 6h`, all pointing at api.energy-charts.info — so every six hours that
// host got 24 simultaneous requests and answered 429 to all of them, for a day and
// a half, until someone looked. 109 of the 195 sources sit on www.data.gouv.fr:
// the next time is a question of when, not if.
//
// The upstream cannot be batched away (energy-charts has no multi-country
// endpoint — `country=all` is the aggregate, not the breakdown), so the fix is
// pacing, and it belongs HERE rather than in any one adapter: the scheduler is
// what clusters, and every adapter downloads.
//
// Three mechanisms, all keyed by hostname:
//
//   • a FIFO queue with a minimum gap between the STARTS of two requests. Not a
//     concurrency cap: a slot held by a 700 MB transfer would stall every other
//     source on the same host, and a fetch with no timeout would stall it forever.
//     Each waiter reads the lane's state when its turn comes rather than being
//     handed a timestamp up front — a cooldown that starts while it is queued has
//     to reach it, or the queue simply re-forms the thundering herd behind it.
//
//   • a cooldown the whole host enters when it answers 429/503, honouring
//     Retry-After. The point of rate limiting is that the refusal applies to the
//     CALLER, not the URL — country #19 being refused must slow 20…24 down too.
//
//   • an adaptive floor under the gap. Measured against energy-charts: at 1.5 s
//     apart, 18 of 23 countries got through and the rest were refused with
//     Retry-After: 23 — a sliding window, not a per-request limit. A fixed gap
//     therefore cannot be guessed right from a descriptor; the lane widens its
//     own on every refusal and relaxes again only after a long clean run.
const DEFAULT_GAP_MS = Number(process.env.SLUICE_HOST_GAP_MS || 1000);
// A host that says "later" is believed, within reason: an hour-long Retry-After
// would park a daily source until its next refresh anyway, and a mistaken or
// hostile one must not be able to freeze a lane indefinitely.
const MAX_COOLDOWN_MS = Number(process.env.SLUICE_HOST_MAX_COOLDOWN_MS || 5 * 60 * 1000);
// Ceiling on the learned gap. 23 sources at 30 s is 11 minutes to walk a host —
// slow, but these are six-hourly ETLs, and being slow beats being refused.
const MAX_GAP_MS = Number(process.env.SLUICE_HOST_MAX_GAP_MS || 30 * 1000);
// Clean requests needed before a lane relaxes a gap it learned. Deliberately
// more than the biggest cluster of sources on one host, so a widened gap holds
// for the whole storm that widened it and only decays across later ones.
const RELAX_AFTER = 25;

const lanes = new Map();

function laneFor(host) {
  let l = lanes.get(host);
  if (!l) {
    l = {
      chain: Promise.resolve(), // FIFO: admission is serialized, the transfer is not
      lastStart: 0,
      cooldownUntil: 0,
      gapFloor: 0, // learned from refusals
      strikes: 0,
      clean: 0,
    };
    lanes.set(host, l);
  }
  return l;
}

function hostOf(url) {
  try { return new URL(url).hostname || 'unknown'; } catch { return 'unknown'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for this host's turn. Returns the hostname so the caller can report the
 * outcome back with `noteResponse`.
 */
export async function waitTurn(url, { gapMs = DEFAULT_GAP_MS } = {}) {
  const host = hostOf(url);
  const l = laneFor(host);
  const mine = l.chain.then(async () => {
    // Read the lane HERE, not when queueing: everything ahead of us may have
    // learned something since (a 429 usually arrives while we wait).
    for (;;) {
      const gap = Math.max(gapMs, l.gapFloor);
      const at = Math.max(Date.now(), l.lastStart + gap, l.cooldownUntil);
      const wait = at - Date.now();
      if (wait <= 0) break;
      if (wait > 5000) {
        console.log(`[sluice] ${host}: holding a request ${Math.round(wait / 1000)}s for politeness`);
      }
      await sleep(wait);
      // Loop: a cooldown may have been extended, or the gap widened, while we slept.
    }
    l.lastStart = Date.now();
  });
  // The chain must never reject, or every later waiter on this host inherits it.
  l.chain = mine.catch(() => {});
  await mine;
  return host;
}

/**
 * Record what the host answered. A 429/503 puts the whole lane in cooldown and
 * widens its gap; anything else counts towards relaxing it again.
 */
export function noteResponse(host, res, { gapMs = DEFAULT_GAP_MS } = {}) {
  const l = laneFor(host);
  if (!res || (res.status !== 429 && res.status !== 503)) {
    l.strikes = 0;
    if (l.gapFloor && ++l.clean >= RELAX_AFTER) {
      l.clean = 0;
      l.gapFloor = l.gapFloor <= gapMs ? 0 : Math.round(l.gapFloor / 2);
    }
    return;
  }
  l.clean = 0;
  l.strikes = Math.min(l.strikes + 1, 6);
  // Widen before cooling down: the cooldown ends the burst, the gap is what
  // stops the next one from re-running straight into the same window.
  l.gapFloor = Math.min(Math.max(l.gapFloor * 2, gapMs * 2), MAX_GAP_MS);
  const ra = retryAfterMs(res.headers && res.headers.get('retry-after'));
  // No Retry-After (many hosts send none): back off exponentially from the gap
  // rather than guessing a fixed number.
  const wait = Math.min(ra ?? gapMs * 2 ** l.strikes, MAX_COOLDOWN_MS);
  l.cooldownUntil = Math.max(l.cooldownUntil, Date.now() + wait);
  console.warn(
    `[sluice] ${host}: HTTP ${res.status} — pausing this host ${Math.round(wait / 1000)}s, ` +
      `spacing it ${(l.gapFloor / 1000).toFixed(1)}s`,
  );
}

/** Retry-After is either delta-seconds or an HTTP date. Both are legal. */
function retryAfterMs(v) {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * How much room a source asks its upstream to be given between requests.
 * Declared per source but felt per HOST — the lane honours whatever gap the
 * request entering it names, so the 24 country sources of one API all asking
 * for 4 s is how that API ends up paced at 4 s. It is a FLOOR, not a promise:
 * the lane widens it further if the host keeps refusing.
 */
export function gapFor(descriptor) {
  const g = Number(descriptor?.options?.hostGapMs);
  return Number.isFinite(g) && g >= 0 ? g : DEFAULT_GAP_MS;
}

/** For the operator surface: what each upstream lane is currently doing. */
export function laneState() {
  const now = Date.now();
  return [...lanes.entries()]
    .map(([host, l]) => ({
      host,
      cooldownMs: Math.max(0, l.cooldownUntil - now),
      gapMs: l.gapFloor,
      strikes: l.strikes,
    }))
    .filter((l) => l.cooldownMs || l.gapMs);
}
