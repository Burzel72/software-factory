# Leitplanken: was die Fabrik stoppt, bevor es teuer wird

Diese Seite beschreibt die Bremsen der Fabrik und **warum** sie existieren. Sie ist die
Grundlage für jede Änderung an den Werten: Wer eine Grenze verschiebt, muss hier nachlesen,
welchen Fall sie abfängt.

## Der Anlass

Ein Bau-Lauf rief **2591-mal** ein Werkzeug auf, das es gar nicht gibt
(`No tool named "factory-report" is currently available`). Der Agent las den Fehler nicht, sondern wiederholte
ihn. Ergebnis: **18,27 $ in einem Lauf**, dann Abbruch, weil das Guthaben aufgebraucht war.

Zeitlimit und Stillstandserkennung haben **nicht** gegriffen: Beide erkennen „nichts passiert"
— die Schleife hat aber ständig Ausgabe produziert und damit beschäftigt ausgesehen. Das ist
die wichtigste Lehre: **Aktivität ist kein Fortschritt.**

## Die Bremsen

### Ebene 1 — einzelner Lauf

| Bremse | Wert | Fängt ab |
|---|---|---|
| Zeitlimit | 90 Min | Läufe, die hängen, ohne Ausgabe zu erzeugen |
| Stillstand | 30 Min ohne Datei-Aktivität | Prozesse, die auf etwas warten, das nie kommt |
| **Kosten** | **2 $** | Teure Schleifen — unabhängig davon, wie beschäftigt sie aussehen |
| **Schritte** | **300** | Viele billige Schritte ohne Ergebnis (billige Modelle dürfen viel, aber nicht endlos) |
| **Schleife** | **10 gleiche Aufrufe** in den letzten 40 | Der 2591-Schritte-Fall: derselbe Aufruf immer wieder |

Die drei letzten sind redundant zueinander — mit Absicht. Die Schleifenerkennung greift nach
etwa einer Minute, die Kostenbremse nach zwei Dollar, die Schrittbremse bei billigen Modellen
später. Wer zuerst anschlägt, gewinnt.

### Ebene 2 — Auftrag

| Bremse | Wert | Fängt ab |
|---|---|---|
| Nachbesserungsrunden | 2 | Bau und Abnahme schieben sich endlos Fehler zu |
| Kosten je Auftrag | 6 $ | Ein Auftrag, der über viele Runden das Budget frisst |
| Abhängigkeiten (`blocked by`) | — | Zwei Aufträge, die dieselbe Datei umbauen |

### Ebene 3 — Tag und Betrieb

| Bremse | Wert | Fängt ab |
|---|---|---|
| Tagesgrenze je Projekt | 5 $ | Drei Schleifen an einem Tag wären dreistellig |
| Guthaben-Fehler (402) | Sperre 1 Std | Weiterlaufen, obwohl kein Geld mehr da ist |
| Gleichzeitige Läufe | 1 | Konkurrierende Umbauten, Speicherdruck |

### Ebene 4 — Prüfung statt Vertrauen

| Regel | Fängt ab |
|---|---|
| Vor der Abnahme: Checks auf **genau dem gepushten** Commit | Abnahme eines Standes, der nicht der PR ist |
| Branch muss `main` enthalten | Merge, der inzwischen gemergte Funktionen verwirft |
| Spec unverändert im PR | Agent, der sich seine Aufgabe selbst passend macht |
| Kein Ergebnis gemeldet → Arbeit prüfen statt verwerfen | Doppelarbeit wegen vergessener Meldung |
| Rechte im Container begrenzt | Merge, Push auf `main`, `sudo`, `docker`, `ssh` |

## Wie die Grenzen wirken

Alle vier Ebenen melden **Klartext am Issue** und nennen die Zahl, nicht nur „fehlgeschlagen":

> Kostenbremse: der Lauf hat 2,10 $ verbraucht (Grenze 2 $). Das deutet auf eine Schleife hin —
> bitte den Auftrag enger fassen (ein Ziel, klare Grenzen) statt nur neu zu starten.

Das ist Absicht: Eine Grenze ohne Begründung erzieht dazu, sie hochzusetzen statt den Auftrag
zu verbessern.

## Werte ändern

Alles steht in `/etc/software-factory/config.json`:

```json
{
  "maxParallel": 1,
  "jobTimeoutMinutes": 90,
  "stallMinutes": 30,
  "maxCostPerRun": 2,
  "maxTurnsPerRun": 300,
  "maxRepeatCalls": 10,
  "maxCostPerDay": 5,
  "maxCostPerIssue": 6,
  "maxReworks": 2
}
```

Nach einer Änderung: `sudo systemctl restart software-factory`. Die Werte werden bei jedem
Durchlauf neu gelesen, ein Neustart ist nur für Code-Änderungen nötig — **aber ein Neustart
beendet laufende Aufträge**: entweder warten, bis nichts läuft, oder
`/usr/local/bin/rollout-when-free` benutzen.

## Was diese Seite nicht kann

Die Leitplanken begrenzen Schaden, sie verhindern keine schlechten Aufträge. Der häufigste
echte Kostenfaktor ist nicht die Schleife, sondern ein **zu großer Auftrag**: Ein Auftrag, der
fünf Runden braucht, kostet fünfmal. Deshalb gilt für neue Aufträge:

- **ein Ziel** pro Issue,
- **eine Datei** wenn möglich,
- Abnahmekriterien, die man **messen** kann (Zahlen, nicht Adjektive),
- und bei Wiederholung: den Auftrag **kleiner** schneiden, nicht neu starten.
