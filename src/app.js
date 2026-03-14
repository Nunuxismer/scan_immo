const express = require('express');
const extractRouter = require('./routes/extract');

const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/', extractRouter);

app.use((err, _req, res, _next) => {
  res.status(500).json({
    status: 'error',
    errors: [{ code: 'SERVER_ERROR', message: err.message }]
  });
});

module.exports = app;
