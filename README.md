# safespaces-teams-connector

WIAAS Safe Spaces — Teams-connector. Byggorder **BO-015** i SKYDD-paketet (B-021).

## Läge

**Milestone A:** `/api/messages` tar emot aktiviteter och ekar texten. Syftet är att
bevisa kedjan Key Vault-hemlighet → SingleTenant-auth → Bot Service → Function App
innan resten byggs.

Kommande: **B** conversation references och proaktiv sändning, **C** kortmallar,
routing, `Action.Execute` mot `confirm/{zone}` och tenant-verifiering.

## Miljö

| Resurs | Namn |
|---|---|
| Function App | `func-safespaces-fe85f8` |
| Bot | `bot-safespaces-demo` (SingleTenant, B-026) |
| Key Vault | `kv-safespaces-fe85f8`, hemlighet `bot-app-secret` |
| App Insights | `ai-safespaces-demo` |

Autentiseringen läses ur app settings: `MicrosoftAppId`, `MicrosoftAppType`,
`MicrosoftAppTenantId` och `MicrosoftAppPassword`, där den sista är en Key
Vault-referens som löses med den användartilldelade identiteten.

## Gränser

- **Inga hemligheter i koden.** Bara app settings och Key Vault-referensen.
- **Connectorn publicerar aldrig MQTT.** `confirm/{zone}` går via BO-017, och
  `trigger`/`clear` ut ägs av Site Connect (BO-F).

## Deploy

Den levande appen är **`func-safespaces-flex`** (Flex Consumption). Den har
bot-inställningarna och Key Vault-referenserna. `func-safespaces-fe85f8` är en
rest från uppsättningen och svarar inte — deploya inte dit.

```
npm ci --omit=dev
npm run deploy
```

**Paketet ska innehålla `node_modules`.** Fjärrbygget (`--build-remote true`)
användes tidigare och gav den 8 oktober en lyckad deploy som ändå installerade
noll beroenden: varje `require` föll, noll funktioner registrerades och
`/api/messages` svarade 404 i stället för att ta emot Teams-trafik. Appen såg
frisk ut i Azure hela tiden. Vi packar beroendena själva i stället.

Verifiera efter varje deploy — en lyckad deploy betyder inte att appen kör:

```
curl -H "x-functions-key: $MASTER" \
  https://func-safespaces-flex.azurewebsites.net/admin/functions
```

Listan ska innehålla `health-supabase` och `messages`. Är den tom laddade inte
värden koden. `GET /api/health/supabase?code=$KEY` ska svara
`{"supabase":"nåbar","ok":true,...}`.

## Kommandot `vakt`

Vilka källor som får larma på platsen. Teams skriver **inte** till Pi:n: raden
ändras i `site_settings` i safespaces-demo, bryggans nedlänk ser den inom ett
pollvarv och publicerar `safespaces/<site>/sys/vakt` retainat, och
Axis-adaptern lyder meddelandet.

| Kommando | Gör |
|---|---|
| `vakt` | visar läget: `Kamera: av · Knappar: på · ändrat 21:14` |
| `vakt kamera på` / `vakt kamera av` | kameraanalysen får ge förlarm, eller inte |
| `vakt knappar på` / `vakt knappar av` | nödknappen och brandlarmcentralen får larma, eller inte |

`pa` utan ring fungerar — ingen skriver ringar på ett telefontangentbord i en
monter. Okända eller extra ord ger hjälptext, aldrig en gissning: att av
misstag slå av knapparna är precis det ett slarvigt skrivet kommando inte ska
kunna orsaka.

Varje ändring svarar med nya läget och raden *"Slår igenom på Site Connect inom
några sekunder. Kameran ger högst ett förlarm per 3 minuter och inget medan ett
larm är öppet."* Faller anropet säger svaret att läget är **oförändrat** — den
som tror att kameran är avslagen men inte är det fattar fel beslut.

`simulera status` visar vaktläget på en egen rad. En demo som inte ger förlarm
beror oftare på att kameran är avslagen än på att något är trasigt.

Standardläget, när ingen rad finns: **kameran av, knapparna på.**

## Tester

```
npm test
```

Kör `node --test` mot `test/`. Testerna är rena: ingen Teams-tur, ingen
databas. De följer med i repot men inte i deploypaketet.
