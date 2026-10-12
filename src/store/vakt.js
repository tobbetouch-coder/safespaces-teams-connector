// Vaktläget: vilka källor som får larma på platsen.
//
// Raden bor i safespaces-demo, tabellen `site_settings`. Bryggans nedlänk läser
// den i samma pollvarv som larmen och publicerar `safespaces/<site>/sys/vakt`
// retainat; Axis-adaptern lyder meddelandet. Teams är alltså inte vägen fram
// till Pi:n — databasen är det, och bryggan gör resten inom ett pollvarv.
//
// Service-nyckeln kommer ur Key Vault via app setting, samma som musteringen.
// Inga nya hemligheter.
const { medBackoff } = require("../util/retry");

const URL = process.env.SAFESPACES_SUPABASE_URL;
const NYCKEL = process.env.SAFESPACES_SERVICE_KEY;

// Samma standard som adaptern och migrationen: kameran av, knapparna på.
// Kameran är av med flit — en rörelsedetektor på ett mässgolv larmar på vem som
// helst som går förbi, och ett förlarm ingen bett om är värre än inget alls.
const STANDARD = { site: null, kamera_aktiv: false, knappar_aktiva: true, uppdaterad: null };

function huvuden(extra = {}) {
  if (!URL || !NYCKEL) throw new Error("SAFESPACES_SUPABASE_URL eller SAFESPACES_SERVICE_KEY saknas");
  return { apikey: NYCKEL, Authorization: `Bearer ${NYCKEL}`, "Content-Type": "application/json", ...extra };
}

async function anrop(väg, init = {}, namn = "vakt") {
  return medBackoff(async () => {
    const r = await fetch(`${URL}/rest/v1/${väg}`, { ...init, headers: huvuden(init.headers) });
    if (!r.ok) {
      const text = await r.text();
      const fel = new Error(`${namn}: HTTP ${r.status} ${text.slice(0, 200)}`);
      fel.statusCode = r.status;
      throw fel;
    }
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }, { namn });
}

/**
 * Läget för platsen. Saknas raden gäller standardläget.
 *
 * Raden får vara skriven med slugen eller med visningsnamnet — bryggan slår upp
 * på båda, och då ska Teams inte kunna visa något annat än det som faktiskt
 * gäller.
 */
async function hämtaVakt(site, byggnad) {
  const nycklar = [site, byggnad].filter(Boolean).map((n) => `site.eq.${encodeURIComponent(n)}`);
  const villkor = nycklar.length > 1 ? `or=(${nycklar.join(",")})` : `site=eq.${encodeURIComponent(site)}`;
  const rader = await anrop(`site_settings?${villkor}&select=*&limit=1`, {}, "hämtaVakt");
  const rad = rader?.[0];
  return rad ? { ...rad, fannsRad: true } : { ...STANDARD, site, fannsRad: false };
}

/**
 * Sätter ett fält och lämnar det andra orört.
 *
 * Upsert på `site`: finns raden uppdateras bara kolumnen vi skickar, och
 * triggern sätter `uppdaterad`. Finns den inte skapas den med tabellens
 * defaultvärden för det fält vi inte nämner — alltså samma standardläge som
 * adaptern ändå hade använt.
 */
async function sättVakt(site, fält, värde) {
  if (!["kamera_aktiv", "knappar_aktiva"].includes(fält)) {
    throw new Error(`okänt fält: ${fält}`);
  }
  const rader = await anrop(
    "site_settings?on_conflict=site",
    {
      method: "POST",
      body: JSON.stringify({ site, [fält]: värde }),
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    },
    "sättVakt",
  );
  return rader?.[0] ?? { ...STANDARD, site, [fält]: värde };
}

module.exports = { hämtaVakt, sättVakt, STANDARD };
