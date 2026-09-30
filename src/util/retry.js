// C6: backoff med jitter. Retries är idempotenta eftersom allt nycklas på correlationId.
// Microsofts gränser: 50/s per app, 7/s och 1800/h per konversation.
const sov = (ms) => new Promise((r) => setTimeout(r, ms));

function väntetid(försök, svar) {
  const retryAfter = Number(svar?.headers?.["retry-after"] ?? svar?.retryAfter ?? 0);
  if (retryAfter > 0) return retryAfter * 1000;
  const bas = Math.min(1000 * 2 ** (försök - 1), 16000);
  return bas / 2 + Math.random() * bas; // jitter: halva basen plus slump
}

const börRetry = (err) => {
  const kod = err?.statusCode ?? err?.status ?? err?.code;
  return kod === 429 || (typeof kod === "number" && kod >= 500 && kod < 600) || kod === "ETIMEDOUT" || kod === "ECONNRESET";
};

/** Kör fn med upp till fyra försök vid 429 och 5xx. Andra fel kastas direkt. */
async function medBackoff(fn, { försök = 4, namn = "anrop" } = {}) {
  let senaste;
  for (let i = 1; i <= försök; i++) {
    try { return await fn(); }
    catch (err) {
      senaste = err;
      if (!börRetry(err) || i === försök) throw err;
      const ms = Math.round(väntetid(i, err));
      console.warn(`${namn}: försök ${i} gav ${err?.statusCode ?? err?.code}, väntar ${ms} ms`);
      await sov(ms);
    }
  }
  throw senaste;
}

module.exports = { medBackoff, väntetid, börRetry };
