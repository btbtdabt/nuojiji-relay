# Local Findings

## Proactive profile may not reflect app UI settings

Status: unconfirmed local finding. Do not file upstream until reproduced from a clean app settings flow.

Observed on 2026-06-13 while inspecting the deployed relay KV record for one proactive pair:

```json
{
  "mode": "impulse",
  "enabled": true,
  "intensity": "normal",
  "proactiveBias": 0,
  "interval": 20,
  "intervalUnit": "minutes",
  "probability": "low",
  "proactiveProfile": {
    "threshold": 0.45,
    "randomLifeChancePerDay": 4,
    "silenceSaturationHours": 8,
    "quietHours": [23, 8],
    "source": "llm"
  },
  "rootQuietHours": [23, 8],
  "lifeState.proactiveProfile.quietHours": [23, 8]
}
```

Question:

Do these values come from the current app UI settings, a generated role profile, or stale/default app state?

Next verification:

1. Change quiet hours and proactive intensity in the app.
2. Toggle cloud relay proactive registration off/on.
3. Inspect only safe fields in the relay record.
4. Confirm whether `quietHours`, `proactiveProfile`, `intensity`, and `proactiveBias` change.

Keep this local until the source is confirmed.
