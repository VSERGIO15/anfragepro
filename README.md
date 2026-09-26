# AnfragePro

AnfragePro verbindet Kunden mit Dienstleistern: Anfrage erstellen → passende Dienstleister finden → Anfrage übernehmen → Angebot → Chat → Abschluss → Bewertung.

## Lokale Entwicklung

Voraussetzungen: Node.js 18+ und npm.

```bash
npm install
npm start
```

Danach: `http://localhost:3000`

Ohne `DATABASE_URL` verwendet die App die lokale JSON-Datei. Für Production ist PostgreSQL vorgesehen.

## Production

Die vollständige Liste der Konfigurationswerte steht in [`.env.example`](.env.example).

Mindestens erforderlich:

- `NODE_ENV=production`
- `SESSION_SECRET` — langer zufälliger Secret-Wert
- `DATABASE_URL` — PostgreSQL
- `APP_URL` — öffentliche HTTPS-Adresse
- `RESEND_API_KEY`
- `RESEND_FROM`

Für den öffentlichen Start müssen außerdem die echten Anbieterangaben in den Seiten **Impressum** und **Datenschutz** eingetragen werden. Die aktuelle Version enthält dort ausdrücklich Demo-/Platzhaltertexte und ist deshalb noch keine fertige öffentliche Rechtstextfassung.

## E-Mail

AnfragePro verwendet die Resend HTTP API für transaktionale E-Mails. Ohne `RESEND_API_KEY` und `RESEND_FROM` werden E-Mails nicht versendet; die Anwendung protokolliert den Versandfehler serverseitig.

Vor dem Launch testen:

1. Dienstleister registrieren.
2. Bestätigungs-E-Mail empfangen und Link öffnen.
3. Anfrage mit passendem Ort + Leistung erstellen.
4. Verifizierter Dienstleister erhält die Matching-Mail.
5. Dienstleister übernimmt die Anfrage.
6. Kunde erhält die Übernahme-Mail.
7. Angebot senden.
8. Kunde erhält die Angebots-Mail.
9. Angebot annehmen.
10. Auftrag abschließen und Bewertung abgeben.

## Sicherheitscheck vor Launch

- [ ] `SESSION_SECRET` ist gesetzt und zufällig.
- [ ] PostgreSQL ist aktiv; keine Production-Nutzung der JSON-Datei.
- [ ] `APP_URL` zeigt auf die echte HTTPS-Domain.
- [ ] Resend-Absenderdomain ist eingerichtet und `RESEND_FROM` ist gültig.
- [ ] E-Mail-Verifizierung für Dienstleister wurde getestet.
- [ ] Impressum und Datenschutzerklärung enthalten echte, geprüfte Angaben.
- [ ] E2E-Provisionierungssecret ist separat und lang zufällig; E2E-Workflow bleibt nur für Tests.
- [ ] Nach Deployment: `Live E2E` grün ausführen.

## Live E2E

Der Live-Test wird über GitHub Actions gestartet:

**Actions → Live E2E → Run workflow**

Er prüft unter anderem zwei Kunden, zwei Dienstleister, paralleles Übernehmen, Angebot, Chat, Abschluss, Bewertung und unzulässige Zugriffe.

## Wichtiger Hinweis

Das Repository enthält technische Produktlogik und Demo-Rechtstexte. Vor einem echten öffentlichen Betrieb müssen insbesondere Verantwortlicher, Kontaktangaben, Hosting-/E-Mail-Verarbeitung, Speicherfristen, Datenschutzprozesse und sonstige rechtliche Anforderungen mit den tatsächlich eingesetzten Diensten und einer geeigneten fachlichen Prüfung abgeglichen werden.
