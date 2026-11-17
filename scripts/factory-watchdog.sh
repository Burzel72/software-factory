#!/usr/bin/env bash
# Software Factory – Wächter
#
# Prüft in kurzen Abständen, ob die Fabrik hängt, ob etwas auf einen Menschen wartet
# oder ob ein Pull Request nicht mehr zusammenpasst. Meldet nur Abweichungen.
#
# Kanäle (alle optional, in dieser Reihenfolge):
#   1. GitHub-Kommentar auf dem Wächter-Issue (funktioniert immer, wenn gh eingerichtet ist)
#   2. Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in /etc/software-factory/secrets.env)
#   3. Home Assistant (HA_URL + HA_TOKEN, z. B. http://192.168.0.82:8123)
#
# Aufruf:  factory-watchdog            (einmal prüfen)
#          factory-watchdog --status   (nur ausgeben, nichts senden)
set -uo pipefail

CONFIG="${FACTORY_CONFIG:-/etc/software-factory/config.json}"
STATE="${WATCHDOG_STATE:-/var/lib/software-factory/watchdog.state}"
SECRETS="${WATCHDOG_SECRETS:-/etc/software-factory/secrets.env}"
STUCK_MINUTES="${STUCK_MINUTES:-90}"
REVIEW_HOURS="${REVIEW_HOURS:-3}"
REMIND_HOURS="${REMIND_HOURS:-6}"
MODE="${1:-}"

# Zugangsdaten Zeile für Zeile lesen statt "sourcen": ein Wert mit Sonderzeichen
# (oder ein Platzhalter) darf nicht die ganze Datei unbrauchbar machen.
secret() { [ -r "$SECRETS" ] && sed -n "s/^$1=//p" "$SECRETS" | head -1 | tr -d '"' || true; }
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(secret TELEGRAM_BOT_TOKEN)}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-$(secret TELEGRAM_CHAT_ID)}"
HA_URL="${HA_URL:-$(secret HA_URL)}"
HA_TOKEN="${HA_TOKEN:-$(secret HA_TOKEN)}"
export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID HA_URL HA_TOKEN
# Im systemd-Dienst ist HOME oft leer; gh sucht seine Zugangsdaten dort.
export HOME="${HOME:-/root}"
export PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

REPOS=$(jq -r '.repos[] | if type == "string" then . else .repo end' "$CONFIG" 2>/dev/null)
[ -z "$REPOS" ] && { echo "Keine Repos in $CONFIG gefunden." >&2; exit 2; }

ALERTS=()
NOTE=()

# Tageskosten einmal ermitteln
COST=$(journalctl -u software-factory --since today --no-pager 2>/dev/null \
  | grep -o '"costUsd":[0-9.]*' | cut -d: -f2 \
  | awk '{s+=$1} END {printf "%.2f", s+0}')
[ -z "$COST" ] && COST="0.00"

alert() { ALERTS+=("$1"); }

# --- 0. Sieht der Wächter überhaupt? ----------------------------------------
# Wenn die Abfragen scheitern, darf hier nicht "alles ruhig" stehen.
PREFLIGHT_FAIL=0
if ! gh api user --jq .login >/dev/null 2>&1; then
  alert "GitHub-Abfrage fehlgeschlagen — der Wächter ist blind (Token, Netz oder gh-Einrichtung prüfen)."
  PREFLIGHT_FAIL=1
fi
if ! jq -e . "$CONFIG" >/dev/null 2>&1; then
  alert "Konfiguration ${CONFIG} ist nicht lesbar — der Wächter kennt die Projekte nicht."
  PREFLIGHT_FAIL=1
fi

# --- 1. Läuft der Runner überhaupt? -----------------------------------------
if ! systemctl is-active --quiet software-factory; then
  alert "Der Runner-Dienst ist nicht aktiv. Es wird gerade nichts gebaut."
fi

# --- 2. Laufende Container ohne Fortschritt ---------------------------------
while read -r NAME; do
  [ -z "$NAME" ] && continue
  OUT=$(sudo docker inspect "$NAME" --format '{{.State.StartedAt}}' 2>/dev/null) || continue
  START=$(date -d "$OUT" +%s 2>/dev/null) || continue
  MIN=$(( ( $(date +%s) - START ) / 60 ))
  [ "$MIN" -lt "$STUCK_MINUTES" ] && continue
  alert "Ein Lauf arbeitet seit ${MIN} Minuten (${NAME}). Grenze: ${STUCK_MINUTES}."
done < <(sudo docker ps --format '{{.Names}}' 2>/dev/null | grep '^sf-' | grep -v caddy)

# --- 3. Je Projekt -----------------------------------------------------------
for REPO in $REPOS; do
  [ "$PREFLIGHT_FAIL" = 1 ] && break
  # Aufträge, die einen Menschen brauchen: failed
  while IFS=$'\t' read -r N T; do
    [ -z "${N:-}" ] && continue
    alert "[${REPO##*/}] Auftrag #${N} ist fehlgeschlagen: ${T} — Kommentar im Issue lesen, dann Label factory:new setzen."
  done < <(gh issue list -R "$REPO" --label factory:failed --state open --json number,title --jq '.[] | [.number, .title] | @tsv' 2>/dev/null)

  # Aufträge, die auf eine Freigabe warten (Review) — Erinnerung nach REVIEW_HOURS
  while IFS=$'\t' read -r N T U; do
    [ -z "${N:-}" ] && continue
    THEN=$(date -d "$U" +%s 2>/dev/null) || continue
    AGE=$(( ( $(date +%s) - THEN ) / 3600 ))
    [ "$AGE" -lt "$REVIEW_HOURS" ] && continue
    alert "[${REPO##*/}] PR für #${N} wartet seit ${AGE} h auf deine Freigabe: ${T}"
  done < <(gh issue list -R "$REPO" --label factory:review --state open --json number,title,updatedAt --jq '.[] | [.number, .title, .updatedAt] | @tsv' 2>/dev/null)

  # Pull Requests: Konflikt oder veraltete Grundlage
  while IFS=$'\t' read -r N BR; do
    [ -z "${N:-}" ] && continue
    STATUS=$(gh api "repos/$REPO/compare/main...${BR}" --jq '.status' 2>/dev/null)
    case "$STATUS" in
      behind|diverged) alert "[${REPO##*/}] PR #${N} enthält \`main\` nicht (${STATUS}) — beim Merge können Funktionen verloren gehen." ;;
    esac
  done < <(gh pr list -R "$REPO" --state open --json number,headRefName --jq '.[] | [.number, .headRefName] | @tsv' 2>/dev/null)

  while IFS=$'\t' read -r N T; do
    [ -z "${N:-}" ] && continue
    alert "[${REPO##*/}] PR #${N} hat einen Konflikt mit \`main\` und braucht eine neue Grundlage: ${T}"
  done < <(gh pr list -R "$REPO" --state open --json number,title,mergeable --jq '.[] | select(.mergeable=="CONFLICTING") | [.number, .title] | @tsv' 2>/dev/null)

done

# --- Meldung zusammenbauen ---------------------------------------------------
if [ ${#ALERTS[@]} -eq 0 ]; then
  NOTE=("Alles ruhig. Keine Aufträge hängen, nichts wartet auf dich.")
else
  NOTE=("${ALERTS[@]}")
fi
COSTLINE="Kosten heute: ${COST:-0} $."
BODY="$(printf '%s\n' "${NOTE[@]}")"$'\n\n'"${COSTLINE}"

if [ "$MODE" = "--status" ]; then
  printf '%s\n' "$BODY"; exit 0
fi

# Doppelte Meldungen vermeiden: nur bei geänderter Lage oder nach REMIND_HOURS
FP=$(printf '%s' "$BODY" | sha256sum | cut -d' ' -f1)
mkdir -p "$(dirname "$STATE")"
LAST_FP=""; LAST_AT=0
[ -r "$STATE" ] && { read -r LAST_FP LAST_AT < "$STATE" || true; }
NOW=$(date +%s)
AGE_H=$(( (NOW - ${LAST_AT:-0}) / 3600 ))
if [ "$FP" = "${LAST_FP:-}" ] && [ "$AGE_H" -lt "$REMIND_HOURS" ]; then
  exit 0
fi
echo "$FP $NOW" > "$STATE"

send_telegram() {
  [ -z "${TELEGRAM_BOT_TOKEN:-}" ] || [ -z "${TELEGRAM_CHAT_ID:-}" ] && return 1
  curl -sf -m 10 -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=$1" >/dev/null
}

# Meldung über ein HA-Skript an alle Geräte (Wandtablets + Handy).
# Das Skript heißt standardmäßig script.factory_wache; die Ziele stehen dort,
# damit man sie in Home Assistant ändern kann, ohne hier etwas anzufassen.
send_ha() {
  [ -z "${HA_URL:-}" ] || [ -z "${HA_TOKEN:-}" ] && return 1
  curl -sf -m 15 -X POST "$HA_URL/api/services/script/factory_wache" \
    -H "Authorization: Bearer $HA_TOKEN" -H "Content-Type: application/json" \
    -d "$(jq -n --arg m "$1" '{message:$m}')" >/dev/null
}

send_github() {
  local issue="${WATCHDOG_ISSUE:-}"
  [ -z "$issue" ] && return 1
  local repo="${REPOS%%$'\n'*}"
  printf '%s\n' "$1" | gh issue comment "$issue" -R "$repo" --body-file - >/dev/null 2>&1
}

STATUS=""
send_telegram "🛠 Software Factory"$'\n'"$BODY" && STATUS+="telegram=ok " || STATUS+="telegram=- "
send_ha "$BODY" && STATUS+="ha=ok " || STATUS+="ha=- "
send_github "### 🩺 Wächter-Bericht"$'\n\n'"$(printf '%s\n' "${NOTE[@]}" | sed 's/^/- /')"$'\n\n'"$COSTLINE" && STATUS+="github=ok" || STATUS+="github=-"

printf '%s\n' "$BODY"
echo "Kanäle: ${STATUS:-keiner eingerichtet}"
case "$STATUS" in
  *ok*) : ;;
  *) echo "(Kein Kanal hat geantwortet — bitte Zugangsdaten in $SECRETS prüfen.)" >&2 ;;
esac
exit 0
