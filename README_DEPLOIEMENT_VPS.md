# README Déploiement VPS Hostinger (ultra pas à pas)

Objectif: ajouter le microservice sans casser votre stack n8n existante.

## A. Préparation

1. Connectez-vous au VPS:

```bash
ssh root@IP_DE_VOTRE_VPS
```

2. Vérifiez Docker:

```bash
docker --version
docker compose version
```

3. Sauvegarde du compose existant n8n (très important):

```bash
cd /opt
cp -r n8n n8n_backup_$(date +%Y%m%d_%H%M%S)
```

## B. Création des fichiers

1. Créez le dossier du microservice:

```bash
mkdir -p /opt/scan_immo_service/src/routes
mkdir -p /opt/scan_immo_service/src/services
mkdir -p /opt/scan_immo_service/src/utils
cd /opt/scan_immo_service
```

2. Copiez les fichiers de ce dépôt dans `/opt/scan_immo_service`.

3. Vérifiez la présence des fichiers:

```bash
find /opt/scan_immo_service -maxdepth 3 -type f
```

## C. Construction Docker

```bash
cd /opt/scan_immo_service
docker build -t scan-immo-service:1.0.0 .
```

Vérifiez l'image:

```bash
docker images | grep scan-immo-service
```

## D. Démarrage du conteneur

### Option recommandée: l'ajouter au docker-compose existant

1. Ouvrez votre `docker-compose.yml` actuel (celui de n8n).
2. Copiez le service depuis `docker-compose.snippet.yml` dans la section `services:`.
3. Si votre stack n8n a un network nommé, ajoutez le même network au service.
4. Lancez seulement ce service:

```bash
cd /opt/n8n
docker compose up -d scan-immo-service
```

5. Vérifiez son état:

```bash
docker compose ps
```

## E. Test HTTP

Depuis le VPS:

```bash
curl -X POST http://localhost:3010/extract \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "source": "n8n",
    "request_id": "vps-test-001",
    "debug": false
  }'
```

## F. Vérification des logs

```bash
docker compose logs -f scan-immo-service
```

Si erreur:
1. Vérifiez les variables d'environnement,
2. Vérifiez le port `3010` libre,
3. Vérifiez le contenu JSON envoyé,
4. Redémarrez le service:

```bash
docker compose restart scan-immo-service
```

## G. Intégration future dans n8n

1. Dans le workflow n8n, ajoutez un node **HTTP Request**.
2. Si n8n et le service sont sur le même Docker network:
   - URL: `http://scan-immo-service:3000/extract`
3. Sinon (appel via host):
   - URL: `http://VOTRE_IP_VPS:3010/extract`
4. Activez `Send Body` en JSON et envoyez:

```json
{
  "url": "{{$json.url}}",
  "source": "n8n",
  "request_id": "{{$execution.id}}",
  "debug": false
}
```

5. Vérifiez la sortie JSON dans n8n, puis mappez les champs vers vos étapes suivantes.
