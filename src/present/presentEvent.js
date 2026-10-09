// C3, reviderad för demo-tight mustering med BO-016:s manus.
// Vid brandlarm får varje person i zonen ett mottagarkort med musteringsknappar —
// inte rollgate:at, alla ska kunna svara. Kanalen får en bot-rad och lägeskortet.
// Förlarmets kommandolager är oförändrat: Bekräfta och Avfärda är rollgate:ade.
const { CardFactory } = require("botbuilder");
const { adapter } = require("../bot/adapter");
const { routing, rollerSomFår, personerIRoller, allaPersoner } = require("../store/config");
const { getByAad, getByChannel } = require("../store/refs");
const { hämtaFörKorrelation, spara, sparaEvent } = require("../store/cards");
const { läge, säkraLarm, avblåsLarm, hämtaLarm, mittSvar } = require("../store/mustering");
const { rendera, väljMall, lägeskort } = require("../cards/render");
const { byggData, klocka } = require("./data");
const { medBackoff } = require("../util/retry");
const { taNyckel, slappNyckel } = require("../store/idempotens");

// Mallen sager hur kortet ser ut; lasnyckeln ska vara radens status, sa att
// larm och ovning inte kan skicka var sin uppsattning for samma overgang.
const STATUS_FOR_MALL = {
  larm: "aktivt", aktivt: "aktivt", ovning: "aktivt",
  forlarm: "forlarm", avblast: "avblast",
};

const COID = process.env.MicrosoftAppTenantId;
const EVAKUERINGSLÄGEN = ["larm", "aktivt", "ovning"];
const SVARSETIKETT = { safe: "I säkerhet", help: "Behöver hjälp" };

async function presentEvent(event) {
  if (COID && event.tenant && event.tenant !== COID && event.tenant !== "COID") {
    console.warn(`presentEvent: främmande tenant ${event.tenant}, ignorerat`);
    return { ignorerat: true, skäl: "tenant" };
  }

  // Webhooken vet exakt vilken overgang det ar och skickar mallen uttryckligen;
  // simulatorn och knapparna later valjMall avgora som forut.
  const mallNamn = event.mall ?? väljMall(event);

  // Kortlåset ligger här, inte hos anroparna, så att ingen väg kan glömma det.
  // Direktvägen och webhooken tävlar om samma övergång; den som får nyckeln
  // skickar korten. Se src/store/idempotens.js.
  //
  // `avsandare` sätts av webhooken; saknas det är det direktvägen.
  const lasstatus = STATUS_FOR_MALL[mallNamn] ?? mallNamn;
  const fickNyckeln = await taNyckel(event.correlationId, lasstatus, event.avsandare ?? "direkt");
  if (!fickNyckeln) {
    return { ignorerat: true, skäl: "kortlås", mall: mallNamn, nya: 0, uppdaterade: 0, mottagare: [] };
  }

  const rutt = await routing("COID", event.site);
  await sparaEvent(event.correlationId, event);

  // Larmets huvudrad i Supabase: Teams och Cloud-skivan delar källa, och larm-id:t
  // kommer därifrån. Ett Supabase-fel får inte stoppa utlarmningen i Teams.
  //
  // Avblåsningen går en annan väg än allt annat. Den SKAPAR inget — den stänger
  // det larm som redan finns, med PATCH. Tidigare gick även clear genom
  // säkraLarm, som upsertar: då fick avblåsningen en egen rad med scenario
  // "Faran över" och ett eget larm-id, medan de riktiga larmen stod kvar röda
  // på tavlan. Kontraktet avsnitt 2 är tydligt — clear är slutet på en incident,
  // inte en ny händelse.
  let larm = null;
  if (mallNamn === "avblast") {
    try {
      larm = await avblåsLarm(event.correlationId, event.rollSomAgerade);
      if (!larm) {
        // Ingen osläckt rad träffades: antingen redan avblåst, eller ett id som
        // aldrig fanns. Korten ska ändå uppdateras, så vi hämtar raden för
        // larm-id:ts skull och går vidare.
        larm = await hämtaLarm(event.correlationId);
        console.warn(`avblåsning träffade ingen osläckt rad för ${event.correlationId}`
          + (larm ? ` — raden har status ${larm.status}` : " — ingen rad alls"));
      }
    } catch (e) {
      console.error("kunde inte blåsa av larmet i Supabase", e.message);
      try { larm = await hämtaLarm(event.correlationId); } catch { /* larmId faller tillbaka */ }
    }
  } else {
    try { larm = await säkraLarm(event, rutt); }
    catch (e) {
      console.error("kunde inte skriva larmet till Supabase", e.message);
      try { larm = await hämtaLarm(event.correlationId); } catch { /* larmId faller tillbaka på correlationId */ }
    }
  }

  const data = byggData(event, rutt, larm);
  const tidigare = await hämtaFörKorrelation(event.correlationId);
  const karta = new Map(tidigare.map((r) => [r.rowKey, r]));
  const resultat = { mall: mallNamn, larmId: data.larmId, nya: 0, uppdaterade: 0, mottagare: [] };

  if (EVAKUERINGSLÄGEN.includes(mallNamn)) {
    // Alla i zonen får musteringskortet. Ingen rollgrind — även medarbetare ska kunna svara.
    const personer = await allaPersoner();
    const mall = mallNamn === "ovning" ? "ovning" : "larm-mottagare";
    for (const p of personer) {
      const ref = await getByAad(p.aadObjectId);
      if (!ref) { console.warn(`presentEvent: ingen referens för ${p.aadObjectId}`); continue; }
      // Larmets zon, inte mottagarens. Kortet beskriver HÄNDELSEN: brinner det i
      // Lobby ska alla läsa "Lobby", även den som själv hör till en annan zon.
      // Tidigare skrev medlemsradens zon över larmets, så kortet kunde säga
      // "Plan 2 · Norr" om ett larm i Lobby.
      await leverera(ref, p.aadObjectId, rendera(mall, data, []), resultat, karta, event, mall);
    }
    // Kanalen är ledningens vy: en bot-rad första gången, sedan lägeskortet.
    if (rutt?.channelId) {
      const ref = await getByChannel(rutt.channelId);
      if (ref) {
        if (!karta.has(nyckel(rutt.channelId))) await botrad(ref, botText(data, personer.length, mallNamn));
        await leverera(ref, rutt.channelId, await byggLägeskort(data, personer.length), resultat, karta, event, "lageskort");
      }
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
    // Faran över: terminalkortet ersätter varje tidigare kort. Mottagaren ser sitt eget
    // svar på kortet, kanalen ser samma kort utan den raden (tomma fakta städas bort).
    const kanalnyckel = rutt?.channelId ? nyckel(rutt.channelId) : null;
    for (const rad of tidigare.filter((r) => r.rowKey !== "__event")) {
      const ärKanal = rad.rowKey === kanalnyckel;
      const ref = ärKanal ? await getByChannel(rutt.channelId) : await getByAad(rad.rowKey);
      if (!ref) continue;
      let dittSvar = "";
      if (!ärKanal) {
        const eget = await mittSvar(event.correlationId, rad.rowKey).catch(() => null);
        if (eget) dittSvar = `${SVARSETIKETT[eget.status] ?? eget.status} ${klocka(eget.responded_at)}`;
      }
      await leverera(ref, rad.rowKey, rendera("avblast", { ...data, dittSvar }, []), resultat, karta, event, "avblast");
    }
  }

  // Gick ingenting ut släpper vi nyckeln igen. Annars hade ett misslyckat
  // försök — ingen kanalreferens, Teams nere — låst övergången för alltid, och
  // nästa försök tystats i tron att korten redan var ute.
  if (resultat.nya === 0 && resultat.uppdaterade === 0) {
    await slappNyckel(event.correlationId, lasstatus);
  }

  if (event.test === true) console.log(`ÖVNING presentEvent ${data.larmId} mall=${mallNamn} mottagare=${resultat.mottagare.length}`);
  else console.log(`presentEvent ${data.larmId} mall=${mallNamn} nya=${resultat.nya} uppdaterade=${resultat.uppdaterade}`);
  return resultat;
}

const nyckel = (v) => String(v ?? "").replace(/[/\#?]/g, "_");

function botText(data, antal, mallNamn) {
  const vad = mallNamn === "ovning" ? "Övningslarm" : "Brandlarm";
  return `${vad} mottaget ${data.klockslag} — ${data.byggnad}, Zon ${data.zon}. Utrymningskort skickat till ${antal} personer.`;
}

async function botrad(reference, text) {
  await medBackoff(() => adapter.continueConversationAsync(process.env.MicrosoftAppId, reference, async (context) => {
    await context.sendActivity(text);
  }), { namn: "botrad" });
}

/** Lägeskortet med totaler, procent och hjälplista. Läser musteringen ur Supabase. */
async function byggLägeskort(data, antalMottagare) {
  const l = await läge(data.correlationId, antalMottagare);
  return lägeskort({
    ...data,
    antalMottagare,
    antalSakra: l.säkra,
    antalHjalp: l.hjälp.length,
    antalUtanSvar: l.utanSvar,
  }, data.musteringUrl, l.hjälp);
}

async function leverera(reference, mottagarnyckel, kort, resultat, karta, event, mallNamn) {
  const befintlig = karta.get(nyckel(mottagarnyckel));
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

module.exports = { presentEvent, byggLägeskort, botrad, nyckel };
