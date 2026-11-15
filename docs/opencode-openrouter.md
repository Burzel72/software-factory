# Betrieb mit OpenCode + OpenRouter (statt Claude Code)

Diese Factory-Variante startet im Job-Container **OpenCode** (MIT-Lizenz) mit einem Modell
deiner Wahl über **OpenRouter**. Claude Code bleibt als Rückfallweg verfügbar, ist aber
standardmäßig nicht installiert.

Der Unterschied steckt in fünf Dateien:

| Datei | Rolle |
| --- | --- |
| `image/bin/factory-agent` | Adapter: startet den Agenten, schreibt ein einheitliches `/work/result.json` |
| `image/opencode.json` | Rechte des Agenten im Container (Deny-Liste) |
| `image/Dockerfile` | installiert OpenCode (und Claude nur mit `--build-arg WITH_CLAUDE=1`) |
| `runner/main.ts` | wählt den API-Key, gibt `AGENT` an den Container, liest `/work/result.json` |
| `setup.sh` | prüft den passenden Key, baut das Image mit dem richtigen Agenten |

## 1. Config

`/etc/software-factory/config.json`:

```json
{
  "repos": ["Burzel72/dein-repo"],
  "agent": "opencode",
  "model": "openrouter/z-ai/glm-4.6",
  "maxParallel": 1
}
```

- `agent`: `opencode` (Standard) oder `claude`.
- `model`: bei OpenCode `provider/model` — z. B.
  - `openrouter/z-ai/glm-4.6` — gutes Verhältnis Preis/Agentenfähigkeit
  - `openrouter/deepseek/deepseek-chat`
  - `openrouter/qwen/qwen3-coder`
  - `openrouter/anthropic/claude-sonnet-4.5` — wenn es doch ein Claude-Modell sein soll
- `apiKeyEnv` (optional): Name der Umgebungsvariable mit dem Key, falls er nicht
  `OPENROUTER_API_KEY` heißt.

### Modell je Projekt und Phase

Ein Eintrag in `repos` darf statt eines Strings ein Objekt sein — dann hat dieses Projekt ein
eigenes Modell, einen eigenen Zugang und optional je Phase ein anderes Modell:

```json
{
  "repos": [
    "Burzel72/familie-zaehler",
    {
      "repo": "pip/uwl-backend",
      "model": "openrouter/anthropic/claude-sonnet-4.5",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "phaseModels": {
        "check":  "openrouter/qwen/qwen3-coder",
        "build":  "openrouter/anthropic/claude-sonnet-4.5",
        "accept": "openrouter/z-ai/glm-4.6"
      }
    }
  ]
}
```

Reihenfolge der Auflösung: **Phase → Projekt → global**. Fehlt etwas, greift die nächste
Stufe; ein reiner String bleibt gültig und nutzt den globalen Standard. Der Runner gibt pro
Lauf genau einen Key weiter — den des Projekts.

Sinn der Aufteilung: Prüfen und Abnehmen brauchen Urteilskraft, Bauen braucht Code-Erfahrung.
Ein starkes Modell nur in der Bauphase spart Geld, ohne die Abnahme zu schwächen.

## 2. Key hinterlegen

```bash
echo 'OPENROUTER_API_KEY=sk-or-...' >> /etc/software-factory/secrets.env
chmod 600 /etc/software-factory/secrets.env
systemctl restart software-factory
```

Der Runner gibt **nur** diese eine Variable an die Job-Container weiter. Kein anderer Key
aus der Umgebung landet im Container.

## 3. Rechte des Agenten

`image/opencode.json` wird als globale OpenCode-Config ins Image kopiert. Der Agent läuft
mit `--auto` (keine Rückfragen), deshalb ist die Deny-Liste die eigentliche Bremse:

- `gh pr merge`, `gh pr close`, `gh repo delete`, `gh release *` — verboten
- `git push … main`, `git push --force` — verboten
- `sudo`, `ssh`, `docker`, `systemctl` — verboten
- Lesen von `*secrets*` und `*.env` — verboten
- `question`-Tool — verboten (im Container antwortet niemand; das Playbook fragt stattdessen
  per `factory-report question` im Issue)

Diese Muster sind **Mustervergleich**, keine Sicherheitsgrenze. Die harte Grenze bleibt:
Branch Protection auf `main`, "Merge nur durch Menschen", und die Factory hat keinen
Zugang zu Prod.

## 4. Ergebnis-Auswertung

`factory-agent` normalisiert beide Agenten auf dieselben Felder in `/work/result.json`
(`result`, `is_error`, `num_turns`, `total_cost_usd`, `duration_ms`). Der Runner liest nur
noch diese Datei; `claude.jsonl` wird als Rückfallweg weiter unterstützt. `factory-stats`
funktioniert damit unverändert, die Kosten kommen aus den `step_finish`-Events von OpenCode.

## 5. Was am Modell anders ist — ehrlich gesagt

- Free-Tier-Modelle sind für 60–90-Minuten-Läufe mit Browser-Tests deutlich schwächer:
  mehr Fehlläufe, mehr Rückfragen, häufiger `failed`. Für den Einstieg: kleine Features,
  `maxParallel: 1`, Playbook kurz halten.
- Kosten pro Lauf stehen in `/var/lib/software-factory/metrics.jsonl` (`costUsd`) und in
  der OpenRouter-Usage. Ein Lauf ist typischerweise Cent-Beträge, kein Abo.
- Prompt-Caching, Kontextfenster und Tool-Calling-Qualität unterscheiden sich je Modell.
  Wenn die Abnahmequote schlecht ist, erst Modell wechseln, dann Playbook anpassen.

## 6. Zurück zu Claude Code

```bash
jq '.agent = "claude" | .model = "opus"' /etc/software-factory/config.json > /tmp/c && mv /tmp/c /etc/software-factory/config.json
docker build -q --build-arg WITH_CLAUDE=1 -t software-factory-job:latest -f image/Dockerfile .
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' >> /etc/software-factory/secrets.env
systemctl restart software-factory
```

## 7. Lokale Skills (auf deinem Rechner)

`scripts/install-local-skills.sh` kopiert die Skills weiterhin nach `~/.claude/skills`.
OpenCode liest diesen Pfad als Kompatibilitätspfad mit — die Skills (`init`, `write-spec`,
`to-factory`) stehen dort also ebenfalls zur Verfügung. Die Slash-Befehle heißen in
OpenCode anders; der Agent findet die Skills über ihren Namen.
