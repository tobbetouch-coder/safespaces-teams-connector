// Musteringen bor i Safe Spaces-Supabase, inte i Azure Table — Teams och Cloud-skivan
// delar källa. Refs, cards, routing, membership och authority ligger kvar i Azure Table.
// Service-nyckeln kommer ur Key Vault via app setting, aldrig ur kod.
const { medBackoff } = require("../util/retry");
const { dygn } = require("../util/tid");

const URL = process.env.SAFESPACES_SUPABASE_URL;
const NYCKEL = process.env.SAFESPACES_SERVICE_KEY;

function huvuden(extra = {}) {
  if (!URL || !NYCKEL) throw new Error("SAFESPACES_SUPABASE_URL eller SAFESPACES_SERVICE_KEY saknas");
  return { apikey: NYCKEL, Authorization: `Bearer ${NYCKEL}`, "Content-Type": "application/json", ...extra };
}

async function anrop(väg, init = {}, namn = "supabase") {
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

async function hämtaLarm(correlationId) {
  const rader = await anrop(`alarms?correlation_id=eq.${encodeURIComponent(correlationId)}&select=*`, {}, "hämtaLarm");
  return rader?.[0] ?? null;
}

// Statusar som räknas som "står kvar". Förlarmet hör med: har kontakt B aldrig
// slutit är avblåsningen det enda som släcker det. Samma lista som bryggans
// OSLACKTA i edge/site-connect-bridge/supabase_klient.py.
const OSLÄCKTA = "status=in.(aktivt,forlarm)";

/**
 * Det öppna larmet i zonen, nyaste först. Grunden för två regler:
 *
 *   ett aktivt larm per zon — ett nytt trigger återanvänder id:t och
 *   uppdaterar raden i stället för att lägga en andra bredvid
 *
 *   avblåsning hittar sitt larm — clear behöver inte bära något id
 *
 * Matchningen går på `zon_nyckel`, aldrig på visningsnamnet. Det är läxan från
 * 7 oktober: `Plan 2 · Norr` och `plan-2-norr` är inte samma sträng, och den
 * som matchar på visningsnamnet hittar inte larmet.
 *
 * `byggnad` utelämnas när anroparen inte vet den; då räcker zonen.
 */
async function aktivtLarm(byggnad, zonNyckel) {
  if (!zonNyckel) return null;
  const q = [
    `alarms?zon_nyckel=eq.${encodeURIComponent(zonNyckel)}`,
    byggnad ? `byggnad=eq.${encodeURIComponent(byggnad)}` : null,
    OSLÄCKTA,
    "select=*",
    "order=utlost_at.desc",
    "limit=1",
  ].filter(Boolean).join("&");
  const rader = await anrop(q, {}, "aktivtLarm");
  return rader?.[0] ?? null;
}

/**
 * Blåser av ett befintligt larm. PATCH, inte upsert.
 *
 * Rör bara status, avblast_at, avblast_av och uppdaterad. `scenario`, `larm_id`
 * och `utlost_at` lämnas i fred — en avblåsning är inte en ny händelse, den är
 * slutet på den befintliga. Tidigare skrev den här vägen en ny rad med
 * scenario "Faran över" och ett eget larm-id, vilket gav ett spöklarm på tavlan
 * medan de riktiga stod kvar röda.
 *
 * Returnerar den uppdaterade raden, eller null om ingen rad träffades.
 */
async function avblåsLarm(correlationId, avblastAv) {
  const nu = new Date().toISOString();
  const rader = await anrop(
    `alarms?correlation_id=eq.${encodeURIComponent(correlationId)}&${OSLÄCKTA}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        status: "avblast",
        avblast_av: avblastAv || "",
        avblast_at: nu,
        uppdaterad: nu,
      }),
    },
    "avblåsLarm",
  );
  return rader?.[0] ?? null;
}

/**
 * Larm-id i mock-upens format YYMMDD-NNN. Numret är antalet larm samma dygn + 1.
 * Ett befintligt larm behåller sitt nummer — säkraLarm körs om vid varje event.
 */
async function nästaLarmId(befintligt) {
  if (befintligt) return befintligt;
  const dag = dygn();
  const dagens = await anrop(`alarms?larm_id=like.${dag}-*&select=larm_id`, {}, "nästaLarmId");
  return `${dag}-${String((dagens?.length ?? 0) + 1).padStart(3, "0")}`;
}

/** Skapar eller uppdaterar larmets huvudrad. Idempotent på correlation_id. */
async function säkraLarm(event, rutt) {
  const status = event.severity === "cleared" ? "avblast" : event.severity === "prealarm" ? "forlarm" : "aktivt";
  const tidigare = await hämtaLarm(event.correlationId);
  const larmId = await nästaLarmId(tidigare?.larm_id);
  const nu = new Date().toISOString();
  const rad = {
    correlation_id: event.correlationId,
    larm_id: larmId,
    // Visningsfälten skrivs på larmraden så Cloud-skivan visar exakt samma ord som Teams.
    byggnad: event.byggnad ?? rutt?.byggnad ?? event.plats ?? event.site ?? "",
    zon: event.zonEtikett ?? rutt?.zonEtikett ?? event.zone ?? "",
    zon_nyckel: event.zone ?? rutt?.zonNyckel ?? "",
    kalla: event.kalla ?? rutt?.kalla ?? "",
    uppsamlingsplats: event.uppsamlingsplats ?? rutt?.uppsamlingsplats ?? "",
    scenario: event.scenario ?? "",
    status,
    test: event.test === true,
    uppdaterad: nu,
    ...(tidigare ? {} : { utlost_at: event.occurredAt ?? nu }),
    ...(status === "avblast" ? { avblast_av: event.rollSomAgerade ?? "", avblast_at: nu } : {}),
  };
  await anrop("alarms?on_conflict=correlation_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rad),
  }, "säkraLarm");
  return { ...rad, utlost_at: rad.utlost_at ?? tidigare?.utlost_at };
}

/** status: "safe" | "help". Samma person som svarar igen skriver över sitt eget svar. */
async function registrera(correlationId, aadObjectId, status, namn, zon, upn) {
  const rad = {
    alarm_id: correlationId,
    aad_object_id: aadObjectId,
    namn: namn ?? "",
    zon: zon ?? "",
    upn: upn ?? "",
    status,
    responded_at: new Date().toISOString(),
  };
  await anrop("mustering?on_conflict=alarm_id,aad_object_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rad),
  }, "registrera");
  return { ...rad, tid: rad.responded_at };
}

async function svar(correlationId) {
  return (await anrop(`mustering?alarm_id=eq.${encodeURIComponent(correlationId)}&select=aad_object_id,namn,zon,upn,status,responded_at`, {}, "svar")) ?? [];
}

/** En persons eget svar — används av Faran över-kortet, som visar "Ditt svar". */
async function mittSvar(correlationId, aadObjectId) {
  const rader = await anrop(`mustering?alarm_id=eq.${encodeURIComponent(correlationId)}&aad_object_id=eq.${encodeURIComponent(aadObjectId)}&select=status,responded_at`, {}, "mittSvar");
  return rader?.[0] ?? null;
}

/** Underlaget till lägeskortet. Läses ur Supabase, samma källa som Cloud-skivan. */
async function läge(correlationId, antalBerörda) {
  const rader = await svar(correlationId);
  const hjälp = rader.filter((r) => r.status === "help");
  return {
    berörda: antalBerörda,
    svarat: rader.length,
    svarande: rader.map((r) => r.aad_object_id),
    säkra: rader.filter((r) => r.status === "safe").length,
    hjälp: hjälp.map((r) => ({ aadObjectId: r.aad_object_id, namn: r.namn, zon: r.zon, upn: r.upn, tid: r.responded_at })),
    utanSvar: Math.max(0, antalBerörda - rader.length),
  };
}

/** Enkel nåbarhetskoll, används av hälsoendpointen. */
async function pinga() {
  const t0 = Date.now();
  await anrop("alarms?select=correlation_id&limit=1", {}, "pinga");
  return { ok: true, ms: Date.now() - t0 };
}

module.exports = {
  säkraLarm, hämtaLarm, aktivtLarm, avblåsLarm,
  registrera, svar, mittSvar, läge, pinga,
};
