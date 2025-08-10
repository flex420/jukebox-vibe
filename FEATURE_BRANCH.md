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
# Feature Version starten (ersetzt Stable Version)
docker-compose -f docker-compose.feature.yml up -d

# Beide Versionen verwenden Port 8199
# Nightly Version zeigt "Nightly" Badge im Header
```

### 4. In Portainer
- **Stable Version:** `flex420/discordsoundbot-vib:latest` (Port 8199)
- **Nightly Version:** `flex420/discordsoundbot-vib:feature-nightly` (Port 8199)

### 5. Mergen wenn bereit
```bash
git checkout main
git merge feature/mein-experiment
git push origin main
# Feature Branch löschen
git branch -d feature/mein-experiment
```

## Versionierung & Changelog
- Versionen werden in `README.md` (Badge) gepflegt
- Änderungen dokumentieren wir in `CHANGELOG.md`
- Nightly-Entwicklung: Features zuerst im Branch `feature/nightly`, Merge nach `main` für Release

## Docker Images
- `:latest` - Hauptversion (main branch)
- `:feature-nightly` - Feature Version
- `:main` - Explizit main branch
- `:sha-abc123` - Spezifischer Commit

## Portainer Setup
1. **Stable Container:** Port 8199, Image `:latest`
2. **Nightly Container:** Port 8199, Image `:feature-nightly`
3. **Testing:** Nightly Version zeigt "Nightly" Badge im Header
4. **Deployment:** Wenn gut, Feature in main mergen
