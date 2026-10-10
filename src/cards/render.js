// Renderar en mall med data och lägger på de knappar mottagarens roll faktiskt får använda.
// Knappsynligheten är steg 1 i default deny: syns inte knappen kan den inte tryckas.
// Texten är låst mot BO-016:s manus. [V] = verifierad mock-up-text, [F] = förslag som
// gäller tills manuset låses: behöver-hjälp-varianten, övningen och förlarmet.
const fs = require("node:fs");
const path = require("node:path");
const { klocka } = require("../util/tid");

const MALLAR = ["larm", "aktivt", "forlarm", "avblast", "ovning", "valkomst", "placeholder",
  "larm-mottagare", "inrymning", "svar-sakerhet", "svar-hjalp", "lageskort"];

// Scenarier som inte ska ge något Teams-kort alls. `fara` är kameraanalysens
// egen flagga: den hör hemma på tavlan och på skärmarna, men ett BRANDLARM i
// allas chatt för något som kanske är en kvarglömd väska lär folk att ignorera
// korten. Kontraktet avsnitt 2.
const UTAN_KORT = new Set(["fara"]);

// Scenarier med egen mall i aktivt läge. Resten får "aktivt" (brandlarm).
const SCENARIOMALL = { inrymning: "inrymning" };
const cache = new Map();

function mall(namn) {
  if (!MALLAR.includes(namn)) throw new Error(`okänd mall: ${namn}`);
  if (!cache.has(namn)) cache.set(namn, fs.readFileSync(path.join(__dirname, `${namn}.json`), "utf8"));
  return JSON.parse(cache.get(namn));
}

// Behålls för statuskorten och bakåtkompatibilitet; korttexten bor numera i mallarna.
const RUBRIKBAND = { larm: "BRANDLARM", aktivt: "BRANDLARM", "larm-mottagare": "BRANDLARM", inrymning: "INRYMNING", forlarm: "FÖRLARM", avblast: "HÄNDELSEN ÖVER", ovning: "ÖVNING", lageskort: "UTRYMNING PÅGÅR" };

const KNAPP = {
  confirm: { titel: "Bekräfta", stil: "positive" },
  dismiss: { titel: "Avfärda", stil: "default" },
  standdown: { titel: "Avblås", stil: "destructive" },
};

/** Ska scenariot ge ett Teams-kort alls? */
function girKort(scenario) {
  return !UTAN_KORT.has(String(scenario ?? "").trim().toLowerCase());
}

/**
 * Vilken mall ett event ska renderas med.
 *
 * Läget avgörs först — avblåsning, förlarm eller aktivt — och sedan scenariot.
 * En inrymning och ett brandlarm är samma läge men motsatta instruktioner:
 * det ena säger gå ut, det andra säger stanna inne och lås dörren. Att skicka
 * fel kort är inte ett skönhetsfel.
 *
 * `test` gäller bara det AKTIVA läget. Tidigare vann det alltid, vilket gjorde
 * att en övnings avblåsning renderade övningskortet i stället för
 * Händelsen över. Webhooken kringgick det genom att skicka mallen uttryckligen.
 */
function väljMall(event) {
  const s = String(event.scenario ?? "").toLowerCase();
  const sev = String(event.severity ?? "").toLowerCase();

  if (sev === "cleared" || s.includes("clear") || s.includes("avblås")) return "avblast";
  if (sev === "prealarm" || s.includes("förlarm") || s.includes("prealarm")) return "forlarm";

  if (event.test === true || event.test === "true") return "ovning";
  if (SCENARIOMALL[s]) return SCENARIOMALL[s];
  return sev === "active" ? "aktivt" : "larm";
}

function fyll(nod, data) {
  if (typeof nod === "string") return nod.replace(/\{\{(\w+)\}\}/g, (_, k) => (data[k] ?? ""));
  if (Array.isArray(nod)) return nod.map((n) => fyll(n, data));
  if (nod && typeof nod === "object") return Object.fromEntries(Object.entries(nod).map(([k, v]) => [k, fyll(v, data)]));
  return nod;
}

/**
 * Tar bort faktarader och textblock som blev tomma när data saknades. Utan det
 * visar kanalens Faran över-kort en tom "Ditt svar"-rad, och ett larm utan källa
 * får en naken faktarubrik.
 */
function städa(nod) {
  if (Array.isArray(nod)) return nod.map(städa).filter((n) => n !== null);
  if (!nod || typeof nod !== "object") return nod;
  if (nod.type === "TextBlock" && !String(nod.text ?? "").trim()) return null;
  if (nod.type === "FactSet") {
    const facts = (nod.facts ?? []).filter((f) => String(f.value ?? "").trim());
    return facts.length ? { ...nod, facts } : null;
  }
  const ut = Object.fromEntries(Object.entries(nod).map(([k, v]) => [k, städa(v)]));
  // En tom container med id är en plats som koden fyller efteråt (hjälplistan) — den behålls.
  if (ut.type === "Container" && Array.isArray(ut.items) && !ut.items.length && !ut.id) return null;
  return ut;
}

/**
 * @param {string} mallNamn
 * @param {object} data fälten som mallen binder mot
 * @param {string[]} tillåtnaActions åtgärder mottagarens roll får utföra
 */
function rendera(mallNamn, data, tillåtnaActions = []) {
  const kort = städa(fyll(mall(mallNamn), { ...data, rubrikband: data.rubrikband ?? RUBRIKBAND[mallNamn] ?? "" }));
  // Terminalkort och välkomst bär aldrig rollknappar.
  // Mottagarkortet och övningen bär sina musteringsknappar i mallen.
  const knappbara = ["larm", "aktivt", "forlarm"].includes(mallNamn);
  if (knappbara && tillåtnaActions.length) {
    kort.actions = tillåtnaActions.map((action) => ({
      type: "Action.Execute",
      title: KNAPP[action].titel,
      style: KNAPP[action].stil,
      verb: action,
      data: { correlationId: data.correlationId, zone: data.zonNyckel ?? data.zon, site: data.site, action },
    }));
  }

  // Visa kamera på förlarmkortet. Den som ska bedöma om något är skarpt behöver
  // se bilden, inte gissa. Knappen finns bara när zonen har en URL satt — en
  // knapp som leder ingenstans är värre än ingen knapp.
  if (mallNamn === "forlarm" && String(data.kameraUrl ?? "").trim()) {
    kort.actions = [
      ...(kort.actions ?? []),
      { type: "Action.OpenUrl", title: "📹 Visa kamera", url: data.kameraUrl },
    ];
  }
  return kort;
}

/** Kort som ersätter originalet när trycket avvisas eller är på väg. Alltid ett riktigt kort, aldrig en bubbla. */
function statuskort(rubrik, text, data = {}) {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.5",
    body: [
      { type: "TextBlock", text: rubrik, weight: "Bolder", size: "Medium", wrap: true },
      { type: "TextBlock", text, wrap: true },
      ...(data.larmId || data.correlationId ? [{ type: "TextBlock", text: `Larm ${data.larmId ?? data.correlationId}`, size: "Small", isSubtle: true }] : []),
    ],
  };
}

const procent = (del, av) => (av > 0 ? `${Math.round((del / av) * 100)} %` : "");

/**
 * Lägeskortet i kanalen: fyra rutor, hjälplista och knappar. Avblås och Påminn visas
 * alltid — rollgrinden slår till vid trycket (steg 1 är UX, steg 2 är Site Connect).
 * Auto-uppdatering var 10:e sekund och per-zon-staplarna är capade till efter SKYDD;
 * Uppdatera läget är den manuella vägen ur fas 1-förenklingen.
 */
function lägeskort(data, musteringUrl, hjälp = []) {
  const antal = Number(data.antalMottagare ?? 0);
  const kort = rendera("lageskort", {
    ...data,
    pctSakra: procent(data.antalSakra, antal),
    pctUtanSvar: procent(data.antalUtanSvar, antal),
    uppdaterat: klocka(),
  }, []);

  // Hjälplistan: en rad per person med Öppna chatt-djuplänk när UPN finns seedad.
  const block = kort.body.find((b) => b.id === "hjalpblock");
  if (block) {
    if (!hjälp.length) block.items = [{ type: "TextBlock", text: "Ingen har begärt hjälp.", wrap: true, isSubtle: true }];
    else {
      block.items = [{ type: "TextBlock", text: `**Behöver hjälp (${hjälp.length}):**`, wrap: true, color: "Attention" }];
      for (const h of hjälp) {
        const text = `${h.namn || h.aadObjectId.slice(0, 8)} · ${h.zon || data.zon} · svarade ${klocka(h.tid)}`;
        block.items.push({
          type: "ColumnSet",
          columns: [
            { type: "Column", width: "stretch", verticalContentAlignment: "Center", items: [{ type: "TextBlock", text, wrap: true }] },
            ...(h.upn ? [{ type: "Column", width: "auto", items: [{ type: "ActionSet", actions: [
              { type: "Action.OpenUrl", title: "Öppna chatt", url: `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(h.upn)}` },
            ] }] }] : []),
          ],
        });
      }
    }
  }

  const bas = { correlationId: data.correlationId, zone: data.zonNyckel ?? data.zon, site: data.site };
  kort.actions = [];
  if (musteringUrl) kort.actions.push({ type: "Action.OpenUrl", title: "Öppna mustering i Safespaces", url: musteringUrl });
  kort.actions.push(
    { type: "Action.Execute", title: `Påminn ej svarat (${data.antalUtanSvar ?? 0})`, verb: "muster.paminn", data: { ...bas, action: "muster.paminn" } },
    { type: "Action.Execute", title: "Avblås larm", style: "destructive", verb: "standdown", data: { ...bas, action: "standdown" } },
    { type: "Action.Execute", title: "Uppdatera läget", verb: "muster.refresh", data: { ...bas, action: "muster.refresh" } },
  );
  return kort;
}

module.exports = { rendera, väljMall, girKort, statuskort, lägeskort, procent, RUBRIKBAND, MALLAR, SCENARIOMALL };
