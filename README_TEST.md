# README Test

## 1) Test local sans Docker

```bash
npm install
npm start
```

Puis:

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "source": "n8n",
    "request_id": "test-local-01",
    "debug": false
  }'
```

## 2) Test via Docker

```bash
docker build -t scan-immo-service:test .
docker run --rm -p 3000:3000 scan-immo-service:test
```

Puis relancez le même `curl`.

## 3) Vérifications rapides

Healthcheck:

```bash
curl http://localhost:3000/health
```

Test d'erreur de validation:

```bash
curl -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"source":"n8n"}'
```

## 4) Exemple de réponse JSON (format cible)

```json
{
  "request_id": "test-local-01",
  "status": "partial",
  "source": {
    "url": "https://example.com",
    "domain": "example.com",
    "page_title": "Example Domain"
  },
  "timestamps": {
    "extracted_at": "2026-01-01T10:00:00.000Z"
  },
  "images": {
    "count": 0,
    "items": []
  },
  "fields": {
    "type_bien": {
      "value": null,
      "status": "missing",
      "source_text": null,
      "needs_review": true
    }
  },
  "completeness": {
    "found_fields": [],
    "missing_fields": ["type_bien"],
    "review_fields": ["type_bien"],
    "completion_score": 0
  },
  "raw": {
    "description_text": "Example Domain"
  },
  "errors": []
}
```
