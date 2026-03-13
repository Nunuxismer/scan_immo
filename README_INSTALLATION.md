# README Installation (débutant)

Ce guide est fait pour une personne non développeuse.

## A. Préparation

1. Ouvrir un terminal sur votre machine locale (ou sur le VPS).
2. Vérifier Node.js et npm:

```bash
node -v
npm -v
```

3. Si Node.js n'est pas installé, installez Node 20 LTS puis relancez les commandes ci-dessus.
4. Créez un dossier de travail:

```bash
mkdir -p ~/scan_immo_service
cd ~/scan_immo_service
```

## B. Création des fichiers

Créez les dossiers:

```bash
mkdir -p src/routes src/services src/utils
```

Créez ensuite les fichiers avec leurs noms exacts:

- `package.json`
- `Dockerfile`
- `docker-compose.snippet.yml`
- `src/config.js`
- `src/server.js`
- `src/app.js`
- `src/routes/extract.js`
- `src/services/extractor.js`
- `src/utils/validators.js`
- `src/utils/fieldHelpers.js`

> Conseil débutant: ouvrez chaque fichier avec `nano NOM_DU_FICHIER`, collez le contenu depuis ce dépôt, sauvegardez avec `CTRL+O`, puis quittez avec `CTRL+X`.

## C. Construction Docker (optionnel en local)

```bash
docker build -t scan-immo-service:local .
```

Si la commande échoue:
- vérifiez que Docker est démarré,
- vérifiez que vous êtes bien dans le bon dossier (`pwd`),
- relancez.

## D. Démarrage du conteneur

```bash
docker run --rm -p 3000:3000 --name scan-immo-local scan-immo-service:local
```

Le service répond alors sur `http://localhost:3000`.

## E. Test HTTP

Dans un 2e terminal:

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "source": "n8n",
    "request_id": "local-test-001",
    "debug": false
  }'
```

Résultat attendu:
- un JSON,
- avec `status` = `success` ou `partial`.

## F. Vérification des logs

Si vous lancez en `docker run`, les logs s'affichent directement dans la fenêtre.

Avec Docker Compose:

```bash
docker compose logs -f scan-immo-service
```

## G. Intégration future dans n8n

Dans n8n, ajoutez un node HTTP Request:
- Method: `POST`
- URL: `http://scan-immo-service:3000/extract` (même réseau Docker)
- Body Content Type: JSON
- Body:

```json
{
  "url": "{{$json.url}}",
  "source": "n8n",
  "request_id": "{{$json.id}}",
  "debug": false
}
```
