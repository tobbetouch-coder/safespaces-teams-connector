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

```
npm install
func azure functionapp publish func-safespaces-fe85f8 --build remote
```
