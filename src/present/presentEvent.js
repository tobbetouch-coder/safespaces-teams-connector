// C3, reviderad för demo-tight mustering.
// Vid brandlarm får varje person i zonen ett mottagarkort med musteringsknappar —
// inte rollgate:at, alla ska kunna svara. Kanalen får lägeskortet med totalerna.
// Förlarmets kommandolager är oförändrat: Bekräfta och Avfärda är rollgate:ade.
const { CardFactory } = require("botbuilder");
const { adapter } = require("../bot/adapter");
const { routing, rollerSomFår, personerIRoller, allaPersoner } = require("../store/config");
const { getByAad, getByChannel } = require("../store/refs");
const { hämtaFörKorrelation, spara, sparaEvent } = require("../store/cards");
const { läge, säkraLarm } = require("../store/mustering");
const { rendera, väljMall, lägeskort } = require("../cards/render");
const { medBackoff } = require("../util/retry");

const COID = process.env.MicrosoftAppTenantId;
const KARTA_URL = process.env.UTRYMNINGSKARTA_URL ?? "https://tower.co-ideation.com/safespaces/utrymningskarta";
const MUSTERING_URL = process.env.MUSTERING_URL ?? "https://tower.co-ideation.com/safespaces/mustering";
const EVAKUERINGSLÄGEN = ["larm", "aktivt", "ovning"];

async function presentEvent(event) {
  if (COID && event.tenant && event.tenant !== COID && event.tenant !== "COID") {
    console.warn(`presentEvent: främmande tenant ${event.tenant}, ignorerat`);
    return { ignorerat: true, skäl: "tenant" };
  }

  const mallNamn = väljMall(event);
  const rutt = await routing("COID", event.site);
  await sparaEvent(event.correlationId, event);
  // Larmets huvudrad i Supabase: Teams och Cloud-skivan delar källa.
  try { await säkraLarm(event); } catch (e) { console.error("kunde inte skriva larmet till Supabase", e.message); }

  const data = {
    correlationId: event.correlationId,
    scenario: event.scenario ?? "",
    zon: event.zone ?? "",
    site: event.site ?? "",
    plats: event.plats ?? event.site ?? "",
    klockslag: (event.occurredAt ?? new Date().toISOString()).slice(11, 16),
    instruktion: event.instruktion ?? "",
    ingress: event.ingress ?? "",
    status: event.severity ?? "",
    rollSomAgerade: event.rollSomAgerade ?? "",
    larmintervall: event.larmintervall ?? "",
    kartaUrl: event.kartaUrl ?? KARTA_URL,
  };

  const tidigare = await hämtaFörKorrelation(event.correlationId);
  const karta = new Map(tidigare.map((r) => [r.rowKey, r]));
  const resultat = { mall: mallNamn, nya: 0, uppdaterade: 0, mottagare: [] };

  if (EVAKUERINGSLÄGEN.includes(mallNamn)) {
    // Alla i zonen får musteringskortet. Ingen rollgrind — även medarbetare ska kunna svara.
    const personer = await allaPersoner();
    for (const p of personer) {
      const ref = await getByAad(p.aadObjectId);
      if (!ref) { console.warn(`presentEvent: ingen referens för ${p.aadObjectId}`); continue; }
      const kort = rendera(mallNamn === "ovning" ? "ovning" : "larm-mottagare", data, []);
      if (mallNamn === "ovning") kort.actions = rendera("larm-mottagare", data, []).actions;
      await leverera(ref, p.aadObjectId, kort, resultat, karta, event, mallNamn);
    }
    // Kanalen får lägeskortet i stället för ett larmkort: den är ledningens vy.
    if (rutt?.channelId) {
      const ref = await getByChannel(rutt.channelId);
      if (ref) await leverera(ref, rutt.channelId, await byggLägeskort(event, data, personer.length), resultat, karta, event, "lageskort");
    }
  } else if (mallNamn === "forlarm") {
    // Kommandolagret: bara roller som får agera ser knapparna.
    const rollerPerAction = { confirm: await rollerSomFår("confirm"), dismiss: await rollerSomFår("dismiss") };
    const berörda = [...new Set([...rollerPerAction.confirm, ...rollerPerAction.dismiss])];
    for (const p of await personerIRoller(berörda)) {
      const ref = await getByAad(p.aadObjectId);
      if (!ref) continue;
      const mina = ["confirm", "dismiss"].filter((a) => rollerPerAction[a].includes(p.role));
      await leverera(ref, p.aadObjectId, rendera("forlarm", data, mina), resultat, karta, event, "forlarm");
    }
    if (rutt?.channelId) {
      const ref = await getByChannel(rutt.channelId);
      if (ref) await leverera(ref, rutt.channelId, rendera("forlarm", data, []), resultat, karta, event, "forlarm");
    }
  } else if (mallNamn === "avblast") {
    // Faran över: terminalkortet ersätter varje tidigare kort, både hos personer och i kanalen.
    for (const rad of tidigare.filter((r) => r.rowKey !== "__event")) {
      const ärKanal = rutt?.channelId && rad.rowKey === String(rutt.channelId).replace(/[/\\#?]/g, "_");
      const ref = ärKanal ? await getByChannel(rutt.channelId) : await getByAad(rad.rowKey);
      if (!ref) continue;
      await leverera(ref, rad.rowKey, rendera("avblast", data, []), resultat, karta, event, "avblast");
    }
  }

  if (event.test === true) console.log(`ÖVNING presentEvent ${event.correlationId} mall=${mallNamn} mottagare=${resultat.mottagare.length}`);
  else console.log(`presentEvent ${event.correlationId} mall=${mallNamn} nya=${resultat.nya} uppdaterade=${resultat.uppdaterade}`);
  return resultat;
}

async function byggLägeskort(event, data, antalBerörda) {
  const l = await läge(event.correlationId, antalBerörda);
  return lägeskort({
    ...data,
    antalSakra: l.säkra,
    antalHjalp: l.hjälp.length,
    antalUtanSvar: l.utanSvar,
    hjalplista: l.hjälp.length ? `Behöver hjälp: ${l.hjälp.map((h) => h.namn || h.aadObjectId.slice(0, 8)).join(", ")}` : "",
  }, MUSTERING_URL);
}

async function leverera(reference, mottagarnyckel, kort, resultat, karta, event, mallNamn) {
  const befintlig = karta.get(String(mottagarnyckel).replace(/[/\\#?]/g, "_"));
  await medBackoff(() => adapter.continueConversationAsync(process.env.MicrosoftAppId, reference, async (context) => {
    const aktivitet = { attachments: [CardFactory.adaptiveCard(kort)] };
    if (befintlig?.activityId) {
      await context.updateActivity({ ...aktivitet, id: befintlig.activityId, type: "message" });
      resultat.uppdaterade++;
    } else {
      const svar = await context.sendActivity(aktivitet);
      await spara(event.correlationId, mottagarnyckel, svar?.id, mallNamn);
      resultat.nya++;
    }
  }), { namn: `presentEvent:${mottagarnyckel}` });
  resultat.mottagare.push(mottagarnyckel);
}

module.exports = { presentEvent, byggLägeskort };
