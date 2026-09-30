// Musteringen bor i Safe Spaces-Supabase, inte i Azure Table — Teams och Cloud-skivan
// delar källa. Refs, cards, routing, membership och authority ligger kvar i Azure Table.
// Service-nyckeln kommer ur Key Vault via app setting, aldrig ur kod.
const { medBackoff } = require("../util/retry");

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

/** Skapar eller uppdaterar larmets huvudrad. Idempotent på correlation_id. */
async function säkraLarm(event) {
  const status = event.severity === "cleared" ? "avblast" : event.severity === "prealarm" ? "forlarm" : "aktivt";
  const rad = {
    correlation_id: event.correlationId,
    byggnad: event.plats ?? event.site ?? "",
    zon: event.zone ?? "",
    scenario: event.scenario ?? "",
    status,
    test: event.test === true,
    uppdaterad: new Date().toISOString(),
    ...(status === "avblast" ? { avblast_av: event.rollSomAgerade ?? "", avblast_at: new Date().toISOString() } : {}),
  };
  await anrop("alarms?on_conflict=correlation_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rad),
  }, "säkraLarm");
  return rad;
}

/** status: "safe" | "help". Samma person som svarar igen skriver över sitt eget svar. */
async function registrera(correlationId, aadObjectId, status, namn, zon) {
  const rad = {
    alarm_id: correlationId,
    aad_object_id: aadObjectId,
    namn: namn ?? "",
    zon: zon ?? "",
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
  return (await anrop(`mustering?alarm_id=eq.${encodeURIComponent(correlationId)}&select=aad_object_id,namn,status,responded_at`, {}, "svar")) ?? [];
}

/** Underlaget till lägeskortet. Läses ur Supabase, samma källa som Cloud-skivan. */
async function läge(correlationId, antalBerörda) {
  const rader = await svar(correlationId);
  const hjälp = rader.filter((r) => r.status === "help");
  return {
    berörda: antalBerörda,
    svarat: rader.length,
    säkra: rader.filter((r) => r.status === "safe").length,
    hjälp: hjälp.map((r) => ({ aadObjectId: r.aad_object_id, namn: r.namn, tid: r.responded_at })),
    utanSvar: Math.max(0, antalBerörda - rader.length),
  };
}

/** Enkel nåbarhetskoll, används av hälsoendpointen. */
async function pinga() {
  const t0 = Date.now();
  await anrop("alarms?select=correlation_id&limit=1", {}, "pinga");
  return { ok: true, ms: Date.now() - t0 };
}

module.exports = { säkraLarm, registrera, svar, läge, pinga };
