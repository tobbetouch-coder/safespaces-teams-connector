// C1: seedar BO-016:s konfigurationstabeller. Körs lokalt med kontonyckel i STORAGE_KEY.
//   STORAGE_KEY=... node scripts/seed.js [teamId] [channelId]
// Routingen tas från B:s kanalrad i refs om inga argument ges.
const { TableClient, AzureNamedKeyCredential } = require("@azure/data-tables");

const KONTO = process.env.STORAGE_ACCOUNT ?? "stssflex5541b6";
const cred = new AzureNamedKeyCredential(KONTO, process.env.STORAGE_KEY);
const klient = (t) => new TableClient(`https://${KONTO}.table.core.windows.net`, t, cred);

const ROLLER = [
  { role: "sakerhetsansvarig", entraGroupId: "cfdce823-04c9-465a-9738-b09d81119cd2", etikett: "Säkerhetsansvarig", actions: "confirm,dismiss,standdown,muster.paminn" },
  { role: "platschef", entraGroupId: "b04c48ae-75ff-49d3-9cec-51128ae63b9d", etikett: "Platschef", actions: "confirm,standdown,muster.paminn" },
  { role: "operator", entraGroupId: "f0ac7e7a-fd4d-4147-87c3-baa1efd37383", etikett: "Larmoperatör", actions: "confirm,dismiss" },
  { role: "vaktare", entraGroupId: "8d233f23-73a2-4c87-9650-df46ecc915f6", etikett: "Väktare", actions: "confirm" },
  { role: "medarbetare", entraGroupId: "7866c26f-aab6-4dbb-b4f0-95422f08fcee", etikett: "Medarbetare", actions: "" },
];

// Medlemskapen expanderade ur Entra-grupperna 2026-09-30, en medlem per grupp.
// Statiskt för demon: ingen live-expansion mot Graph på mässgolvet.
// UPN:erna lästa ur Entra 2026-09-30. De driver hjälplistans Öppna chatt-djuplänk
// på lägeskortet; utan UPN faller knappen bort och raden visas ändå.
//
// namn är visningsnamnet i hjälplistan. Säkerhetsansvarig heter Maria Ek, samma
// person som tavlan visar uppe till höger — Teams och tavlan ska säga samma namn.
// Övriga är kvar på rollnamnet; demon namnger bara den rollen.
const MEDLEMMAR = [
  { aadObjectId: "a533691c-f08d-42a5-9647-4a65222f9b8d", role: "sakerhetsansvarig", upn: "demo.sakerhetsansvarig@co-ideation.com", namn: "Maria Ek" },
  { aadObjectId: "7d79549d-6698-45ca-a75c-c65fdc78aa38", role: "platschef", upn: "demo.platschef@co-ideation.com", namn: "Platschef" },
  { aadObjectId: "29f0ac93-aa28-4587-9061-0122f4b0785d", role: "operator", upn: "demo.operator@co-ideation.com", namn: "Larmoperatör" },
  { aadObjectId: "abf263e5-293b-4a3f-8211-b0171aab55a9", role: "vaktare", upn: "demo.vaktare@co-ideation.com", namn: "Väktare" },
  { aadObjectId: "af975cb7-7fbd-4c73-8466-933bd2542d9a", role: "medarbetare", upn: "demo.medarbetare@co-ideation.com", namn: "Medarbetare" },
];

// SITE är rowKey i routing-tabellen. Ändras den måste seed.js köras om —
// annars slår boten upp en site som inte finns och kortet går aldrig ut.
const SITE = process.env.SITE ?? "noname-stockholm";

// Demons kuliss. Demo-kund Noname, beslut 8 okt 2026. Värdena är hämtade ur
// MQTT-kontraktets avsnitt 5 (plats 1, Noname Stockholm, zon 01 Lobby = Pi 1),
// så Site Connect, bryggan, tavlan och Teams säger exakt samma ord.
// Samma ord skrivs på alarms-raden i Supabase. Skolscenariots värden
// (noname-school / Main Hall, inrymning) kommer med det manuset.
const PLATS = {
  byggnad: "Noname Stockholm",
  zonEtikett: "Lobby",
  zonNyckel: process.env.DEMO_ZON ?? "lobby",
  uppsamlingsplats: "Car park · North gate",
  kalla: "Brandlarmcentral",
};

async function säkra(t) {
  try { await klient(t).createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

async function kanalFrånRefs() {
  const c = klient("refs");
  for await (const r of c.listEntities({ queryOptions: { filter: "kind eq 'channel'" } })) {
    return { teamId: r.teamId, channelId: r.channelId };
  }
  return null;
}

(async () => {
  for (const t of ["routing", "roles", "membership", "authority"]) await säkra(t);

  const [argTeam, argKanal] = process.argv.slice(2);
  const rutt = argTeam && argKanal ? { teamId: argTeam, channelId: argKanal } : await kanalFrånRefs();
  if (!rutt) throw new Error("hittar ingen kanalrad i refs och inga argument gavs");

  await klient("routing").upsertEntity({ partitionKey: "COID", rowKey: SITE, teamId: rutt.teamId, channelId: rutt.channelId, ...PLATS }, "Merge");
  console.log(`  routing: ${SITE} → team ${String(rutt.teamId).slice(0, 18)}… kanal ${String(rutt.channelId).slice(0, 18)}…`);

  for (const r of ROLLER) {
    await klient("roles").upsertEntity({ partitionKey: "COID", rowKey: r.role, entraGroupId: r.entraGroupId, etikett: r.etikett }, "Merge");
    await klient("authority").upsertEntity({ partitionKey: "COID", rowKey: r.role, actions: r.actions }, "Merge");
  }
  console.log(`  roles och authority: ${ROLLER.length} roller`);

  for (const m of MEDLEMMAR) {
    await klient("membership").upsertEntity({ partitionKey: "COID", rowKey: m.aadObjectId, role: m.role, upn: m.upn, namn: m.namn, zon: PLATS.zonEtikett }, "Merge");
  }
  console.log(`  membership: ${MEDLEMMAR.length} personer, ${MEDLEMMAR.filter((m) => m.upn).length} med UPN`);

  for (const t of ["routing", "roles", "membership", "authority"]) {
    let n = 0;
    for await (const _ of klient(t).listEntities()) n++;
    console.log(`  ${t}: ${n} rader`);
  }
})().catch((e) => { console.error("FEL:", e.message); process.exit(1); });
