# Marko AI — dein privater KI-Workspace

Eine startbare Node.js-Web-App mit lila-schwarzem UI, serverseitigem Login, Admin-Panel, 10 Chat-Konten und 10 davon getrennten Konten für den Bildschirm-Modus.

## Was enthalten ist?

- **KI-Chat:** nutzt die OpenAI Responses API. Der API-Schlüssel bleibt auf dem Server.
- **20 Konten bei der Ersteinrichtung:** `marko-admin` + `marko01` bis `marko09` für den Chat; `screen01` bis `screen10` für den Bildschirm-Modus. Die Passwörter werden kryptografisch zufällig erzeugt und nur einmal angezeigt.
- **Admin-Panel:** Nutzerübersicht, Aktivieren/Sperren, Passwort zurücksetzen (neues Passwort wird einmal angezeigt) und ein kleines Aktivitätsprotokoll.
- **Separater Bildschirm-Modus:** eigener Login, Browser-Bildschirmfreigabe, Vorschau und Fragen mit Screenshot. Es gibt **keinen heimlichen Zugriff und keine automatische Dauerübertragung**: Der Browser fragt nach deiner Freigabe, und ein Screenshot wird erst beim Absenden einer Frage an die KI geschickt.
- **Sicherheit:** Passwort-Hashes (bcrypt), serverseitige Sessions, HTTP-only-Cookie, Login-/Chat-Limits, Same-Origin-Prüfung, sichere HTTP-Header und Eingabelimits.
- **Browser-Chatverlauf:** lokal im Browser des jeweiligen Geräts gespeichert. Er wird nicht zwischen Geräten synchronisiert.

## Voraussetzungen

- Node.js 20 oder neuer (empfohlen: aktuelle LTS-Version)
- Ein OpenAI-API-Schlüssel mit aktivierter API-Abrechnung, wenn du echte KI-Antworten möchtest (ChatGPT Plus/Pro ersetzt diesen API-Schlüssel nicht; API-Nutzung wird separat abgerechnet).
- Für öffentliche Bereitstellung: ein Node.js-Host wie Render. **GitHub speichert den Code, hostet aber den Express-Server nicht selbst.** GitHub Pages allein reicht für dieses Projekt nicht aus.

## Lokal starten (Windows, macOS oder Linux)

1. Installiere Node.js: <https://nodejs.org/>
2. Entpacke den Projektordner `Marko-AI`.
3. Öffne ein Terminal im Projektordner.
4. Kopiere `.env.example` zu `.env`.
   - Windows PowerShell: `Copy-Item .env.example .env`
   - macOS/Linux: `cp .env.example .env`
5. Öffne `.env` in einem Texteditor. Ändere `SESSION_SECRET` und `SETUP_TOKEN` zu langen, zufälligen Zeichenfolgen. Erstelle bei Bedarf einen API-Schlüssel unter <https://platform.openai.com/api-keys> und trage ihn bei `OPENAI_API_KEY=` ein. Standardmodell ist `gpt-5-mini`; du kannst `OPENAI_MODEL` ändern. Lass keine Anführungszeichen oder Leerzeichen um die Werte herum.
6. Installiere die Pakete und starte Marko:

   ```bash
   npm install
   npm start
   ```

7. Öffne <http://localhost:3000>. Bei der allerersten Anmeldung erscheint die Ersteinrichtung. Gib den Wert aus `SETUP_TOKEN` ein.
8. Marko erstellt 20 Konten und zeigt die Zugangsdaten **genau einmal**. Lade `MARKO-PRIVATE-ZUGANGSDATEN.txt` herunter und speichere sie in einem Passwortmanager oder an einem privaten Ort. Diese Datei niemals committen oder hochladen.
9. Melde dich mit `marko-admin` an. Mit Chat-Konten nutzt du den KI-Chat; mit `screen01` bis `screen10` nutzt du den separaten Bildschirm-Login.

Die Zugangsdaten werden nicht vorab in eine Datei eingebaut: Sie entstehen bei der ersten Einrichtung auf deinem eigenen Server, sind individuell und werden nicht im öffentlichen Repository gespeichert. Falls du das Fenster verlierst, kann der Admin im Panel einzelne Passwörter neu setzen.

## Auf GitHub hochladen

1. Erstelle auf GitHub ein **privates Repository** für Marko (du kannst es später öffentlich machen, sofern dort keine Geheimnisse liegen).
2. Lade die Dateien aus `Marko-AI` hoch. **Nicht hochladen:** `.env`, `data/`, eine eventuell heruntergeladene `MARKO-PRIVATE-ZUGANGSDATEN.txt` oder irgendeinen API-Schlüssel. Die `.gitignore` schützt Git-Commits, aber beim manuellen Hochladen musst du trotzdem prüfen, dass keine Geheimdatei ausgewählt ist.
3. Kontrolliere auf GitHub, dass `.env.example` sichtbar ist, aber `.env` nicht.

## Als Website bereitstellen (Render)

Die einfachste Route für dieses Node.js-Projekt ist Render Web Service. `render.yaml` enthält eine Blueprint-Konfiguration mit einer persistenten SQLite-Ablage unter `/var/data`.

1. Erstelle ein Konto bei <https://render.com/>.
2. Wähle **New → Blueprint** und verbinde dein GitHub-Repository.
3. Prüfe die vorgeschlagenen Einstellungen aus `render.yaml`. Dieser Entwurf nutzt einen kleinen persistenten Datenträger. Render weist darauf hin, dass persistente Datenträger nicht im kostenlosen Web-Service-Plan verfügbar sind; ohne persistenten Speicher könnten Konten und Sitzungen nach Neustarts oder Deployments verloren gehen. Prüfe daher den aktuellen Tarif, bevor du live gehst.
4. Setze im Render-Dashboard unter **Environment** mindestens:
   - `SETUP_TOKEN`: ein eigenes langes, zufälliges Geheimnis (mindestens 16 Zeichen)
   - `OPENAI_API_KEY`: dein persönlicher API-Schlüssel
   - `SESSION_SECRET` wird durch die Blueprint-Konfiguration generiert; ändere ihn nicht in einen kurzen Wert.
   - `DATA_DIR` soll `/var/data` bleiben, wenn du den Datenträger aus dem Blueprint nutzt.
5. Warte, bis der Build und Deploy erfolgreich sind. Öffne die Render-URL per HTTPS und erledige die Ersteinrichtung über den geheimen `SETUP_TOKEN`.
6. Lade die erzeugten Kontodaten lokal herunter. Teile den `SETUP_TOKEN` nicht mit normalen Nutzern. Nach erfolgreicher Erst-Einrichtung ist die Setup-Route automatisch gesperrt.

Render-Dokumentation: <https://render.com/docs/web-services>, <https://render.com/docs/configure-environment-variables>, <https://render.com/docs/disks>.

## API-Schlüssel und Kosten

Der Schlüssel wird ausschließlich von `server.js` gelesen. Niemals in `public/app.js`, HTML-Dateien oder eine öffentliche GitHub-Datei einfügen. API-Nutzung wird separat vom ChatGPT-Abo abgerechnet und kann kostenpflichtig sein. Preisdetails und verfügbare Modelle: <https://platform.openai.com/pricing> und <https://platform.openai.com/docs/models>. Lege beim Anbieter Limits fest und prüfe die Abrechnung regelmäßig.

Wenn das Admin-Panel die Meldung **„KI noch nicht verbunden“** zeigt, fehlt `OPENAI_API_KEY` oder der Server wurde nach dem Setzen nicht neu gestartet/deployed. Wenn der Anbieter einen Fehler meldet, prüfe auch den Wert von `OPENAI_MODEL`.

## Admin-Panel

Melde dich mit dem Chat-Admin `marko-admin` an und öffne **Admin Panel**. Dort kannst du Konten sperren/aktivieren oder ein neues Passwort erzeugen. Das neu erzeugte Passwort erscheint nur einmal. Der Admin kann sein eigenes Passwort über das Konto-Menü unten links ändern.

## Bildschirm-Modus

Melde dich im Screen-Login mit einem Konto `screen01` bis `screen10` an. Klicke auf **Bildschirm freigeben** und wähle im Browser selbst einen Bildschirm, ein Fenster oder einen Tab. Stelle danach eine Frage und lasse bei Bedarf **Screenshot mitsenden** aktiviert. Nur dann wird beim Absenden ein aktueller Frame an den Server geschickt. Klicke auf **Freigabe beenden**, wenn du fertig bist.

Der Browser benötigt für Screen Capture in der Regel HTTPS oder `localhost`. Die Anwendung kann deinen Computer nicht autonom fernsteuern oder eigenständig klicken. Sie analysiert den Screenshot, den du explizit sendest.

## Tests und Grenzen

- Syntaxprüfung: `npm run check`
- Health-Endpunkt: `/api/health`
- Die Chat-Historie liegt aktuell nur lokal im Browser. Ein Wechsel des Geräts oder das Leeren des Browser-Speichers entfernt sie.
- Marko ist eine solide Ausgangsbasis, aber kein unbegrenzter Alleskönner. Die Modellfähigkeiten richten sich nach dem konfigurierten API-Modell und dessen Zugriffsrechten.
- Für öffentliche Nutzung solltest du vor dem Teilen u. a. Datenschutztext/Impressum für deine Situation, Kostenlimits, Backups, Monitoring sowie eine Datenschutzprüfung ergänzen. Screenshots können private Inhalte enthalten.
