# Playbook: SoftwareFactory aufbauen

Von „hier ist ein Proxmox" bis „der Runner läuft und wartet auf den ersten Auftrag".
Dokumentiert ist der Aufbau, der am **16. November 2026** real durchgeführt wurde — mit den
Werten, die dabei tatsächlich verwendet wurden, und den Fehlern, die dabei aufgetreten sind.
Alles wiederholbar, alles nachprüfbar.

**Ergebnis:** VM `300` (`softwarefactory`) auf dem Proxmox-Node `majestix`, Ubuntu 24.04,
192.168.0.85, darin die Factory mit OpenCode als Agent und OpenRouter als Modellzugang.

**Zeitbedarf real:** etwa 45 Minuten inklusive Rechte-Einrichtung und Cloud-Image-Download.
Der reine Aufbau nach dem ersten Login: rund 8 Minuten.

---

## 0. Überblick: was wo läuft

| Ebene | Wo | Zweck |
|---|---|---|
| Proxmox `majestix` | 192.168.0.12 | Hypervisor, hält die VM |
| VM `300` `softwarefactory` | 192.168.0.85 | Ubuntu 24.04, 4 vCPU, 12 GB, 80 GB |
| Runner (systemd) | in der VM | pollt GitHub, startet Agenten-Container |
| Agenten-Container | in der VM, pro Auftrag | OpenCode + Modell, ohne Netzzugang außer API |
| Deine Ablage | Mac Mini, `~/.hermes/secrets/` | Zugänge, die nie in ein Repo gehören |

Zwei Schlüssel, zwei Zwecke — nicht vermischen: Hermes hat einen eigenen OpenRouter-Key,
die Factory einen zweiten mit eigenem Limit.

---

## 1. Voraussetzungen

- Proxmox VE 8 oder 9, Web-Oberfläche erreichbar (hier: 9.2.25)
- Ein Netz, in dem eine feste IP frei ist (hier: 192.168.0.85/24, Gateway 192.168.0.1)
- GitHub-Konto mit `repo`-Recht
- OpenRouter-Key **mit Ausgabenlimit** (hier: 50 $)

---

## 2. Zugang zum Proxmox einrichten

### 2.1 API-Token anlegen

Web-Oberfläche → Datacenter → Permissions → API Tokens → *Add*:
Benutzer `nio@pam`, Token-ID `SoftwareFactoryAccess`, **Privilege Separation an lassen**.

### 2.2 Rechte — an *beide* Adressen

Proxmox rechnet die Rechte eines Tokens mit Separation als **Schnittmenge** aus
Benutzer- und Token-Rechten. Eine Rolle nur am Token ergibt null Rechte.

```bash
pveum acl modify / --tokens nio@pam!SoftwareFactoryAccess --roles PVEAdmin
pveum acl modify / --users  nio@pam                        --roles PVEAdmin
pveum acl list    # erwartet ZWEI Zeilen, type=user und type=token
```

`PVEAdmin` auf `/` genügt: VM anlegen/ändern/starten, `Datastore.AllocateSpace`, `Sys.Audit`.
Nicht enthalten und nicht nötig: Systemeinstellungen, Netzwerk am Node, Rechtevergabe.

### 2.3 SSH-Benutzer auf dem Host

Der Proxmox-Eintrag `nio@pam` existiert ohne Linux-Konto — `chown nio:nio` scheitert dann mit
`invalid user`. In der root-Shell auf `majestix`:

```bash
adduser --disabled-password --gecos "" nio
usermod -aG sudo nio
apt-get update && apt-get install -y sudo          # auf schlanken Hosts oft nicht vorhanden
echo 'nio ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/nio && chmod 440 /etc/sudoers.d/nio
echo 'Defaults secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"' \
  > /etc/sudoers.d/secure-path && chmod 440 /etc/sudoers.d/secure-path
# Schlüssel eintragen (Datei /tmp/factory.pub vorher anlegen)
H=$(getent passwd nio | cut -d: -f6); mkdir -p "$H/.ssh"
cat /tmp/factory.pub >> "$H/.ssh/authorized_keys"
chmod 700 "$H/.ssh"; chmod 600 "$H/.ssh/authorized_keys"; chown -R nio:nio "$H/.ssh"
```

Prüfen:

```bash
ssh -i ~/.ssh/proxmox_nio nio@192.168.0.12 'sudo -n qm list'
```

### 2.4 Fehlerbilder, die Zeit kosten

| Symptom | Ursache | Lösung |
|---|---|---|
| `Permission check failed (Sys.Audit)` | Rolle nur am Token, Benutzer ohne Rechte | ACL auch für `nio@pam` setzen |
| 40 Rechte, alle `0` | Rolle `NoAccess` erwischt (erster Eintrag im Menü) | Rolle auf `PVEAdmin` ändern |
| `chown: invalid user: 'nio:nio'` | kein Linux-Konto hinter `nio@pam` | `adduser` (Schritt 2.3) |
| `sudo: command not found` | schlankes Debian ohne sudo | `apt install sudo` |
| `qm: command not found` unter sudo | `/usr/sbin` nicht im `secure_path` | `secure-path`-Datei (Schritt 2.3) |

**Ping ist kein Frei-Test.** 192.168.0.13 und 192.168.0.85 antworteten beide nicht auf ICMP —
eine der beiden war trotzdem vergeben. Die IP vom Betreiber vorgeben lassen oder DHCP-Leases
prüfen, nie „kein Ping" als Beweis nehmen.

---

## 3. VM anlegen

### 3.1 Bestätigte Werte

| Feld | Wert |
|---|---|
| VMID / Name | `300` / `softwarefactory` |
| CPU / RAM | 4 vCPU (`--cpu host`) / 12288 MB |
| Platte | 80 GB auf `local-lvm` (thin) |
| Netz | `vmbr0`, `192.168.0.85/24`, Gateway + DNS `192.168.0.1` |
| Gast-Benutzer | `factory`, nur SSH-Schlüssel, kein Passwort-Login |
| Sonstiges | Guest-Agent, serielle Konsole, Start bei Boot |

Nicht angefasst: VM 100 (Windows), VM 200/201 (Home Assistant), Host-Netzwerk.

### 3.2 Cloud-Image laden und VM bauen

```bash
# auf dem Host, als root bzw. mit sudo
curl -fsSL -o /var/lib/vz/template/iso/ubuntu-24.04-cloudimg-amd64.img \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img   # 593 MB

qm create 300 --name softwarefactory --memory 12288 --cores 4 --sockets 1 \
  --cpu host --ostype l26 --scsihw virtio-scsi-single --net0 virtio,bridge=vmbr0 \
  --agent enabled=1 --serial0 socket --vga serial0 --onboot 1 --tags software-factory

qm importdisk 300 /var/lib/vz/template/iso/ubuntu-24.04-cloudimg-amd64.img local-lvm
qm set 300 --scsi0 local-lvm:vm-300-disk-0,discard=on,ssd=1,iothread=1
qm set 300 --boot order=scsi0 --ide2 local-lvm:cloudinit
qm resize 300 scsi0 80G
qm set 300 --ciuser factory --sshkeys /tmp/factory.pub \
  --ipconfig0 ip=192.168.0.85/24,gw=192.168.0.1 --nameserver 192.168.0.1 --ciupgrade 0
qm start 300
```

Reihenfolge zählt: **erst `--scsi0` setzen, dann `resize`** — vorher gibt es keine Platte, die
wachsen könnte. `qm importdisk` nennt das Volume `local-lvm:vm-300-disk-0`; genau diesen Namen
beim Anhängen verwenden, nicht raten.

### 3.3 Boot prüfen (nicht annehmen)

```bash
ssh -i ~/.ssh/proxmox_nio factory@192.168.0.85
hostname; uname -r; grep PRETTY /etc/os-release
ip -4 -br addr show | grep -v '^lo'; ip route | head -2
nproc; free -h | head -2; df -h / | tail -1
cloud-init status
```

Real gemessen: SSH erreichbar nach **15 s**, Ubuntu 24.04.5, Kernel 6.8.0-147,
4 Kerne, 11 GiB nutzbar, `/` 77 GB mit 1,6 GB belegt (3 %).

`cloud-init status: running` direkt nach dem Login ist normal; für Installationen, die davon
abhängen, auf `done` warten.

---

## 4. Factory installieren

### 4.1 Konfiguration anlegen

`/etc/software-factory/config.json` (root, 600). Start ohne Projekte:

```json
{
  "repos": [],
  "label": "factory",
  "maxParallel": 1,
  "agent": "opencode",
  "model": "openrouter/z-ai/glm-4.6",
  "workflow": "starter-kit",
  "pollSeconds": 60,
  "jobTimeoutMinutes": 90,
  "containerMemory": "4g",
  "allowedUsers": [],
  "preview": { "host": "AUTO", "domain": "", "password": "AUTO", "max": 1 },
  "factoryRepo": "Burzel72/software-factory",
  "improve": { "everyDays": 0 }
}
```

`repos` bleibt leer, bis ein echtes Projekt angebunden ist. `improve.everyDays: 0` heißt:
keine Selbstverbesserungsläufe — später bewusst einschalten.

### 4.2 Zugänge in `secrets.env`

Datei `/etc/software-factory/secrets.env`, root, 600, eine Zeile:

```
OPENROUTER_API_KEY=sk-or-v1-…
```

Übertragen wird sie **über stdin**, nie als Argument — sonst steht der Key in der
Shell-Historie:

```bash
sed -n 's/^OPENROUTER_API_KEY=//p' ~/.hermes/secrets/softwarefactory-openrouter.env \
 | ssh -i ~/.ssh/proxmox_nio factory@192.168.0.85 \
   'printf "OPENROUTER_API_KEY=%s" "$(cat)" | sudo tee /etc/software-factory/secrets.env >/dev/null && \
    sudo chmod 600 /etc/software-factory/secrets.env'
```

### 4.2b Eigene Identität für die Fabrik (GH_TOKEN)

Ohne eigenes Konto arbeitet die Fabrik mit dem Zugang des Repo-Eigentümers. Folge: Alle PRs
erscheinen als dessen Arbeit, und GitHub verweigert die Freigabe („You cannot approve your own
pull request"). Für den Testbetrieb ist das hinnehmbar, für echte Nutzung nicht.

**Umstellung ohne Codeänderung:** `gh` liest `GH_TOKEN` aus der Umgebung. Zeile in
`/etc/software-factory/secrets.env` ergänzen und Dienst neu starten:

```
GH_TOKEN=ghp_…        # Token des Fabrik-Kontos, Scope: repo
```

Das Konto braucht Schreibrecht am Projekt (Collaborator oder Team). Danach meldet der Runner
beim Start `identity:token` statt `identity:warning`, und die PRs stammen vom Fabrik-Konto —
formale Reviews sind damit möglich.

Beim Einrichten einer neuen Identität prüfen, dass sie **nicht** der Eigentümer ist:

```bash
sudo bash -lc 'gh api user --jq .login'      # muss das Fabrik-Konto zeigen
```

### 4.3 Repository und Setup

```bash
# in der VM
sudo git clone -b opencode-openrouter https://github.com/Burzel72/software-factory.git /opt/software-factory
cd /opt/software-factory && sudo ./setup.sh
```

`setup.sh` ist nicht interaktiv und mehrfach ausführbar. Es installiert Docker, `gh`, Bun,
legt `/etc/software-factory/` an, zieht das Caddy-Image (Vorschau), baut
`software-factory-job:latest` und richtet den systemd-Dienst ein. Vorhandene `config.json`
und `secrets.env` werden **nicht** überschrieben.

Realdauer: rund 5 Minuten, davon der Image-Bau den größten Teil, ~2 GB Platte.

### 4.4 GitHub-Anmeldung des Runners

Der Runner arbeitet als root, also dort anmelden:

```bash
gh auth token | ssh -i ~/.ssh/proxmox_nio factory@192.168.0.85 \
  'sudo gh auth login --with-token -h github.com'
```

Prüfen: `sudo gh auth status` in der VM.

### 4.5 Dienst starten und verifizieren

```bash
sudo systemctl enable --now software-factory
sudo systemctl is-active software-factory      # active
sudo journalctl -u software-factory -n 12 --no-pager
```

Erwartete Logzeile (real):

```json
{"event":"runner:started","login":"Burzel72","repos":[],"maxParallel":1,
 "agent":"opencode","model":"openrouter/z-ai/glm-4.6","workflow":"starter-kit"}
```

Erscheint diese Zeile, ist der Runner wach und wartet auf Projekte. `repos: []` ist korrekt,
solange kein Projekt angebunden ist.

---

## 5. Erstes Projekt anbinden (noch offen)

```bash
cd /opt/software-factory && sudo ./scripts/add-repo.sh besitzer/repo
sudo systemctl restart software-factory
```

Voraussetzung auf GitHub: Label `factory` am Repo, ein Issue mit diesem Label beschreibt den
Auftrag. Der Runner legt daraus einen Branch, lässt den Agenten arbeiten und stellt einen
Änderungsvorschlag ein.

Für Firmencode gilt zusätzlich: nur freigegebene Teilmenge, nur Demo-Daten, Rückfluss
ausschließlich nach `dev` — QS und Produktivstellung bleiben bei der Firma.

---

## 6. Betrieb

| Aufgabe | Befehl |
|---|---|
| Status | `systemctl status software-factory` |
| Log verfolgen | `journalctl -u software-factory -f` |
| Neu starten | `systemctl restart software-factory` |
| Kennzahlen | `sudo factory-stats` (nach Läufen gefüllt: `metrics.jsonl`) |
| Neue Version übernehmen | `sudo factory-rollout` (git pull + Image neu bauen + Neustart) |
| Vorschau | `http://192.168.0.85:4001` — Login `factory`, Passwort in `config.json` |

Kostenkontrolle: Der OpenRouter-Key hat ein Limit von 50 $. Der Verbrauch steht auf der
OpenRouter-Seite pro Key, getrennt vom Hermes-Key.

---

## 7. AppServer: wohin released wird

Zweite VM, auf der Projekte **produktiv** laufen — getrennt von der Fabrik.

| Feld | Wert |
|---|---|
| VMID / Name | `400` / `AppServer` |
| CPU / RAM / Platte | 2 vCPU / 4096 MB / 40 GB auf `local-lvm` |
| Netz | `vmbr0`, `192.168.0.86/24`, GW + DNS `192.168.0.1` |
| Benutzer | `factory` (Schlüssel, sudo), wie auf der Fabrik-VM |
| Inhalt | Docker 29.10, Compose 5.7.1, Release-Befehl |

Aufbau identisch zu VM 300 (gleiches Cloud-Image, gleiche cloud-init-Werte). Danach:

```bash
apt-get install -y ca-certificates curl jq git rsync
# Docker nach offizieller Anleitung (docker-ce, buildx, compose-plugin)
install -m 0755 /tmp/release /usr/local/bin/release
mkdir -p /srv/apps /var/log/release
```

### 7.1 Aufbau je Projekt

```
/srv/apps/<projekt>/
  compose.yml     wie gebaut und gestartet wird (restart: unless-stopped)
  release.conf    REPO=…  BRANCH=main  PORT=8080  HEALTH=/health
  src/            ausgecheckter Code (maschinell)
  data/           dauerhafte Daten als Volume — überlebt jeden Release
```

### 7.2 Release-Ablauf

```bash
release <projekt>             # git pull, build, up, Health-Prüfung (30 s)
release <projekt> --status    # Container und Health
release --list                # alle Projekte mit Port
```

Der Befehl bricht ab, wenn der Health-Pfad nach 30 Sekunden nicht antwortet, und zeigt dann die
letzten 30 Logzeilen der Anwendung. **Kein automatisches Durchreichen**: nach dem Merge in
`main` löst der Mensch den Release aus.

### 7.3 Ports statt Namen (Namen später)

Jedes Projekt bekommt einen festen Port: `http://192.168.0.86:<PORT>`. Namen wie
`ferienhaussuche.lan` kommen dazu, sobald ein Eintrag im Router oder eine hosts-Zeile pro Gerät
existiert — die Ports bleiben dann als Rückfallweg bestehen.

### 7.4 Verifiziert am 16.11.2026

Wegwerf-Projekt `hello` (python:3.12-alpine, Port 8080): `release hello` meldete
`bereit nach 2s (HTTP 200)`, Status und Liste korrekt, Zugriff vom Mac
`http://192.168.0.86:8080 → 200`. Danach vollständig entfernt (Container, Netz, Ordner, Log),
Port wieder geschlossen. Die Mechanik ist damit belegt, nicht nur beschrieben.

---

### 7.5 Erstes Projekt: Ferienhaussuche

Repo `Burzel72/ferienhaussuche` (privat), übernommen aus `~/.hermes/scripts/schweden`
(Original auf dem Mac unverändert). Einzige Codeänderung: Datenpfad über `SCHWEDEN_DATA`
steuerbar, weil der Container seine Daten als Volume bekommt.

```bash
# auf dem AppServer
sudo mkdir -p /srv/apps/ferienhaussuche/data
sudo cp compose.yml release.conf /srv/apps/ferienhaussuche/   # aus deploy/ des Repos
rsync -a ~/.hermes/data/schweden/ <ziel>:/srv/apps/ferienhaussuche/data/   # vom Mac
sudo release ferienhaussuche
```

Ergebnis (geprüft): `/health` → `{"ok": true}`, Startseite HTTP 200 nach 2 s, `/api/data`
liefert **38 Objekte und 3 Favoriten** — identisch zur Mac-Instanz. Zugriff:
`http://192.168.0.86:8080`.

**Privates Repo braucht einen Lesezugang auf dem Server.** Zwei Fallen, die je einen Anlauf
kosten:

```bash
# 1. Deploy-Key (nur Lesen) anlegen und bei GitHub eintragen
sudo ssh-keygen -t ed25519 -N "" -f /root/.ssh/<projekt> -C "appserver@<projekt>"
gh api repos/<owner>/<repo>/keys -X POST -f title="AppServer" \
  -f key="$(sudo cat /root/.ssh/<projekt>.pub)" -F read_only=true

# 2. git muss diesen Schlüssel nehmen UND den Host kennen
cat > /root/.ssh/config <<EOF
Host github.com
  User git
  IdentityFile /root/.ssh/<projekt>
  IdentitiesOnly yes
EOF
ssh-keyscan -T 5 github.com >> /root/.ssh/known_hosts    # als root, direkt schreiben
```

Ohne `IdentityFile` greift git den Standard-Schlüssel (der hier nicht existiert) und meldet
`Permission denied`; ohne `known_hosts` bricht es mit `Host key verification failed` ab.
`ssh-keyscan ... | sudo tee` hat auf diesem Host eine leere Datei hinterlassen — `sudo bash -c`
mit `>>` schreibt zuverlässig.

### 7.6 Datenfluss und Fabrik-Bindung

```
Mac (Quelle)                     AppServer (Anzeige)
~/.hermes/data/schweden/  --rsync-->  /srv/apps/ferienhaussuche/data
   ^                                        |
   |                                        v
täglicher Hermes-Job 07:30           Container :8080  → Familie (iPad)
   + stündlicher Push-Cronjob (ohne Modell, schweigt bei Erfolg)
```

Der Mac bleibt die Quelle der Wahrheit; der AppServer liest nur. Wer `houses.json` ändert,
ruft `push_to_appserver.sh` auf, sonst wartet die Familie bis zur nächsten vollen Stunde.

Fabrik-Bindung (Vorbereitung, noch ohne Auftrag):

```bash
sudo ./scripts/add-repo.sh Burzel72/ferienhaussuche
```

Legt elf Labels an, trägt das Repo in `config.json` ein und verknüpft das Board. Für das Board
braucht der GitHub-Token den Scope **`project`** — ohne ihn bricht `add-repo.sh` mitten drin ab
(„missing required scopes [project read:project]"). Nachziehen:

```bash
gh auth refresh -s project,read:project     # auf dem Mac, interaktiv
gh auth token | ssh … 'sudo gh auth login --with-token -h github.com'   # in die VM
```

Ergebnis: Board „Software Factory" mit zehn Spalten (Neu … Fehlgeschlagen), verknüpft als
`project: {owner, number}` in der Config. Der Runner meldet die Spalten im Log
(`event: board:columns`) — das ist der Beweis, dass die Anbindung greift.

---

## 8. Sicherheit — was nach dem Aufbau zu tun bleibt

1. **Proxmox-Token erneuern.** Das Secret wurde beim Aufbau im Chat übertragen und steht damit
   im Verlauf. Nach dem Aufbau löschen und neu anlegen; die ACL-Zeilen bleiben gültig, weil sie
   an der Token-ID hängen.
2. **GitHub-Token der VM ist dein persönliches.** Für Dauerbetrieb besser einen eigenen Token
   oder eine GitHub App mit Recht nur auf die freigegebenen Repos.
3. **`preview` ohne HTTPS** ist LAN-only. Für Zugriff von außen: Subdomain + Zertifikat, sonst
   bleibt es offen.
4. **Firmencode** berührt die Fabrik nur als freigegebene Teilmenge. Ein Dauerbetrieb braucht
   eine eigene Freigabe oder ein Modell im Firmennetz.

---

## 9. Abweichungen von der Original-Anleitung

| Original (Hostinger-VPS) | Hier |
|---|---|
| Hostinger KVM 2, Ubuntu 24.04 mit Claude Code | eigener Proxmox, Ubuntu 24.04 Cloud-Image |
| Claude-Abo oder Anthropic-Key | OpenCode als Agent, OpenRouter als Zugang |
| Root-Login per Passwort | SSH-Schlüssel, eigener Benutzer, sudo ohne Passwort |
| IP vom Anbieter | feste LAN-IP 192.168.0.85 |
| Vorschau über öffentliche Subdomain | Vorschau im LAN, HTTPS später |

Der Rest des Repos bleibt unverändert nutzbar: Board-Labels, Branches, PR-Ablauf,
Abnahme und Selbstverbesserung funktionieren identisch.
