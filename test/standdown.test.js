// Självtest av Avblås larm-knappen.
//
// Knappen fanns på lägeskortet från början, men ingen gren hanterade den.
// Trycket föll igenom till standardsvaret och kortet svarade "Avblåsning
// skickad — inväntar bekräftelse från anläggningen". Ingenting skickades.
// Larmet stod kvar rött i sex minuter den 16 oktober, och hela tiden
// påstod kortet att något var på väg.
//
// Tre saker provas här:
//
//   1. **Att knappen gör något.** avblåsningen går samma väg som
//      `simulera clear`: presentEvent, som PATCHar larmraden och ritar om
//      korten.
//   2. **Att okänd åtgärd säger som det är.** Ett kort som påstår att något
//      skickats när inget skickats är värre än ett som säger ifrån — särskilt
//      i ett larmläge där någon står och väntar på att det ska ta.
//   3. **Att rollgrinden håller.** Den utan roll ska nekas, och ingenting
//      får hända på vägen dit.

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const KATALOG = path.join(__dirname, "..", "src");

// Attrapperna läggs i require-cachen innan execute.js laddas, eftersom den
// destrukturerar sina beroenden vid inladdning.
const anrop = { presentEvent: [], avblåsLarm: [], emit: [] };
const larm = { rad: null };
const roller = { "per-aad": "sakerhetsansvarig", "ingen-roll-aad": null };

function lägg(relativ, exports) {
  const full = require.resolve(path.join(KATALOG, relativ));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
}

lägg("store/config.js", {
  rollFörPerson: async (aad) => roller[aad] ?? null,
  // "framtida.knapp" star med pa flit: rollgrinden slapper igenom den, men
  // ingen gren hanterar den. Det ar exakt det lage standdown befann sig i,
  // och det enda satt att na fallbacken.
  fårGöra: async (roll, action) => roll === "sakerhetsansvarig"
    && ["confirm", "dismiss", "standdown", "muster.paminn", "framtida.knapp"].includes(action),
  routing: async () => ({ byggnad: "Noname Stockholm", zonEtikett: "Lobby", zonNyckel: "lobby" }),
  allaPersoner: async () => [],
  personFörAad: async () => ({ namn: "Per Nordbrandt", zon: "Lobby" }),
});
lägg("bridge/stub.js", {
  emitCommand: async (...a) => { anrop.emit.push(a); },
});
lägg("store/mustering.js", {
  registrera: async () => {},
  läge: async () => ({ säkra: 0, hjälp: [], utanSvar: 0 }),
  hämtaLarm: async () => larm.rad,
  eskaleraLarm: async () => larm.rad,
  avblåsLarm: async (...a) => { anrop.avblåsLarm.push(a); return larm.rad; },
});
lägg("store/cards.js", {
  hämtaEvent: async () => ({ site: "noname-stockholm", zone: "lobby", scenario: "brand" }),
});
lägg("store/refs.js", { getByAad: async () => null });
lägg("present/mustering.js", { uppdateraLägeskort: async () => ({ uppdaterat: true }) });
lägg("present/presentEvent.js", {
  botrad: async () => {},
  presentEvent: async (ev) => { anrop.presentEvent.push(ev); return { nya: 0, uppdaterade: 3 }; },
  byggLägeskort: async () => ({}),
  nyckel: (k) => k,
});

const { hanteraExecute } = require(path.join(KATALOG, "actions", "execute.js"));

function tryck(action, aad = "per-aad") {
  return {
    activity: {
      value: { action: { data: { correlationId: "cid-1", zone: "lobby", site: "noname-stockholm", action } } },
      from: { aadObjectId: aad, name: "Per Nordbrandt" },
      channelData: {},
    },
  };
}

function text(svar) {
  return JSON.stringify(svar?.value ?? svar);
}

test.beforeEach(() => {
  anrop.presentEvent = []; anrop.avblåsLarm = []; anrop.emit = [];
  larm.rad = { larm_id: "261016-031", status: "aktivt", scenario: "brand", kalla: "brandlarmcentral" };
});

test("Avblås på ett aktivt larm går samma väg som simulera clear", async () => {
  const svar = await hanteraExecute(tryck("standdown"));
  assert.strictEqual(anrop.presentEvent.length, 1, "presentEvent anropades inte");
  const ev = anrop.presentEvent[0];
  assert.strictEqual(ev.severity, "cleared");
  assert.strictEqual(ev.correlationId, "cid-1");
  assert.strictEqual(ev.avsandare, "knapp:standdown");
  // Scenariot får INTE skickas med: avblåsningen ska inte skriva om vad
  // larmet handlade om.
  assert.strictEqual(ev.scenario, undefined, "scenario skickades med");
  // Den som tryckte hamnar i avblast_av.
  assert.strictEqual(ev.rollSomAgerade, "Per Nordbrandt");
  assert.match(text(svar), /Per Nordbrandt/);
  assert.match(text(svar), /Avblåst av/);
});

test("ett redan avblåst larm blåses inte av igen", async () => {
  larm.rad = { larm_id: "261016-031", status: "avblast", scenario: "brand" };
  const svar = await hanteraExecute(tryck("standdown"));
  assert.strictEqual(anrop.presentEvent.length, 0, "presentEvent anropades ändå");
  assert.match(text(svar), /Redan avblåst/);
});

test("ett förlarm avfärdas, inte avblåses", async () => {
  larm.rad = { larm_id: "261016-031", status: "forlarm", scenario: "inrymning" };
  const svar = await hanteraExecute(tryck("standdown"));
  assert.strictEqual(anrop.presentEvent.length, 0);
  assert.match(text(svar), /Går inte att blåsa av/);
});

test("utan larmrad händer ingenting", async () => {
  larm.rad = null;
  const svar = await hanteraExecute(tryck("standdown"));
  assert.strictEqual(anrop.presentEvent.length, 0);
  assert.match(text(svar), /hittades inte/i);
});

test("okänd åtgärd säger att ingenting skickades", async () => {
  const svar = await hanteraExecute(tryck("framtida.knapp"));
  const t = text(svar);
  assert.match(t, /Okänd åtgärd/);
  assert.match(t, /Ingenting skickades/);
  // Den gamla texten lovade att något var på väg. Den får aldrig komma
  // tillbaka för en åtgärd som ingen gren hanterar.
  assert.doesNotMatch(t, /Avblåsning skickad/i);
  assert.doesNotMatch(t, /Inväntar bekräftelse/);
  assert.strictEqual(anrop.presentEvent.length, 0);
});

test("rollgrinden nekar den utan roll, och ingenting händer", async () => {
  const svar = await hanteraExecute(tryck("standdown", "ingen-roll-aad"));
  assert.strictEqual(anrop.presentEvent.length, 0, "presentEvent anropades trots nekad roll");
  assert.strictEqual(anrop.avblåsLarm.length, 0);
  assert.match(text(svar), /behörighet|Nekad|inte behörig/i);
});
