# scan_immo - Microservice Playwright V1

Ce dépôt contient un microservice **Node.js + Express + Playwright** prêt à être branché à n8n.

## Structure

```text
.
├── docker-compose.snippet.yml
├── Dockerfile
├── package.json
├── README.md
├── README_DEPLOIEMENT_VPS.md
├── README_INSTALLATION.md
├── README_TEST.md
└── src
    ├── app.js
    ├── config.js
    ├── server.js
    ├── routes
    │   └── extract.js
    ├── services
    │   └── extractor.js
    └── utils
        ├── fieldHelpers.js
        └── validators.js
```

## Démarrage rapide (local)

```bash
npm install
npm run dev
```

Puis testez:

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "source": "n8n",
    "request_id": "demo-001",
    "debug": false
  }'
```

Guides détaillés:
- Installation débutant: `README_INSTALLATION.md`
- Déploiement VPS Hostinger: `README_DEPLOIEMENT_VPS.md`
- Tests: `README_TEST.md`
