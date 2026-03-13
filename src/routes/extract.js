const express = require('express');
const { validateExtractPayload } = require('../utils/validators');
const { extractListing } = require('../services/extractor');

const router = express.Router();

router.post('/extract', async (req, res) => {
  const errors = validateExtractPayload(req.body);
  if (errors.length) {
    return res.status(400).json({
      request_id: req.body?.request_id || null,
      status: 'error',
      errors: errors.map((message) => ({ code: 'VALIDATION_ERROR', message }))
    });
  }

  try {
    const result = await extractListing(req.body);
    const statusCode = result.status === 'error' ? 500 : 200;
    return res.status(statusCode).json(result);
  } catch (error) {
    return res.status(500).json({
      request_id: req.body?.request_id || null,
      status: 'error',
      errors: [{ code: 'UNHANDLED_ERROR', message: error.message }]
    });
  }
});

module.exports = router;
