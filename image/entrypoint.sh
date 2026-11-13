#!/usr/bin/env bash
# Startet einen Factory-Job: Repo holen, Branch auschecken, Agent mit Playbook laufen lassen.
# Erwartet: REPO, ISSUE, BRANCH, MODEL, WORKFLOW, GH_TOKEN, AGENT (opencode|claude),
#           OPENROUTER_API_KEY (bzw. ANTHROPIC_API_KEY bei AGENT=claude) und /work/prompt.md.
set -euo pipefail

log() { echo "[factory] $*"; }

: "${REPO:?}" "${ISSUE:?}" "${BRANCH:?}"
MODEL="${MODEL:-openrouter/z-ai/glm-4.6}"
export AGENT="${AGENT:-opencode}"
export PHASE="${PHASE:-build}"   # check = prüfen, build = entwickeln, accept = unabhängige Abnahme
WORKFLOW="${WORKFLOW:-starter-kit}"

# Workflow-Skills als Nutzer-Skills bereitstellen (landen nicht im Ziel-Repo).
# ~/.claude/skills ist der Kompatibilitätspfad, den OpenCode ebenfalls liest.
mkdir -p "$HOME/.claude/skills"
if [ -d "/factory/workflows/$WORKFLOW/skills" ]; then
  cp -r "/factory/workflows/$WORKFLOW/skills/." "$HOME/.claude/skills/"
fi

gh auth setup-git >/dev/null
GH_LOGIN=$(gh api user --jq .login)
GH_ID=$(gh api user --jq .id)
git config --global user.name "$GH_LOGIN (Software Factory)"
git config --global user.email "${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
git config --global init.defaultBranch main

cd /work
if [ ! -d repo/.git ]; then
  log "Klone $REPO"
  gh repo clone "$REPO" repo -- --quiet
fi
cd repo
git fetch --quiet origin
DEFAULT_BRANCH=$(gh repo view "$REPO" --json defaultBranchRef --jq .defaultBranchRef.name)
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  git checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  # Die Abnahme startet immer mit genau dem gepushten Stand, ohne Reste früherer Läufe
  if [ "$PHASE" = "accept" ]; then git reset --quiet --hard "origin/$BRANCH" && git clean -ffdxq; fi
else
  git checkout --quiet -B "$BRANCH" "origin/$DEFAULT_BRANCH"
fi

# Abhängigkeiten installieren (zum Entwickeln und für die Abnahme nötig)
if [ "$PHASE" != "check" ] && [ -f .factory/setup.json ]; then
  INSTALL=$(jq -r '.install // empty' .factory/setup.json)
  if [ -n "$INSTALL" ]; then
    log "Setup: $INSTALL"
    bash -lc "$INSTALL" > /work/setup.log 2>&1 || log "Setup fehlgeschlagen (siehe /work/setup.log), der Agent kümmert sich"
  fi
fi

export FACTORY_DEFAULT_BRANCH="$DEFAULT_BRANCH"
# Skills des Workflows liegen zusätzlich unter /factory/workflows/<workflow> (nicht im Ziel-Repo)
if [ -d "/factory/workflows/$WORKFLOW" ]; then export FACTORY_WORKFLOW_DIR="/factory/workflows/$WORKFLOW"; fi

log "Starte Agent=$AGENT ($MODEL, Phase: $PHASE, Workflow: $WORKFLOW) für $REPO#$ISSUE auf $BRANCH"
set +e
PROMPT_FILE=/work/prompt.md PLAYBOOK=/factory/playbook.md OUT=/work/result.json factory-agent
CODE=$?
set -e
log "Lauf beendet mit Exit-Code $CODE"
exit $CODE
