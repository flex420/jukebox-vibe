# Feature Branch Development

## Workflow für Experimente

### 1. Feature Branch erstellen
```bash
git checkout -b feature/mein-experiment
git push -u origin feature/mein-experiment
```

### 2. Entwickeln und Testen
- Änderungen im Feature Branch machen
- Commits und Pushes wie gewohnt
- GitHub Actions baut automatisch das Feature Image

### 3. Feature Version testen
```bash
# Feature Version starten (Port 3001)
docker-compose -f docker-compose.feature.yml up -d

# Hauptversion läuft weiter auf Port 3000
# Feature Version läuft auf Port 3001
```

### 4. In Portainer
- **Hauptversion:** `flex420/discordsoundbot-vib:latest` (Port 3000)
- **Feature Version:** `flex420/discordsoundbot-vib:feature/nightly` (Port 3001)

### 5. Mergen wenn bereit
```bash
git checkout main
git merge feature/mein-experiment
git push origin main
# Feature Branch löschen
git branch -d feature/mein-experiment
```

## Docker Images
- `:latest` - Hauptversion (main branch)
- `:feature/nightly` - Feature Version
- `:main` - Explizit main branch
- `:sha-abc123` - Spezifischer Commit

## Portainer Setup
1. **Hauptcontainer:** Port 3000, Image `:latest`
2. **Feature Container:** Port 3001, Image `:feature/nightly`
3. **Testing:** Feature auf Port 3001 testen
4. **Deployment:** Wenn gut, Feature in main mergen
