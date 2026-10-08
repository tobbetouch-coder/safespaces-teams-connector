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
