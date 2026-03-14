function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

function validateExtractPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    errors.push('Le body JSON est requis.');
    return errors;
  }

  if (!body.url || typeof body.url !== 'string' || !isValidHttpUrl(body.url)) {
    errors.push('Le champ "url" est obligatoire et doit être une URL http/https valide.');
  }

  if (body.source !== undefined && typeof body.source !== 'string') {
    errors.push('Le champ "source" doit être une chaîne de caractères.');
  }

  if (body.request_id !== undefined && body.request_id !== null && typeof body.request_id !== 'string') {
    errors.push('Le champ "request_id" doit être une chaîne ou null.');
  }

  if (body.debug !== undefined && typeof body.debug !== 'boolean') {
    errors.push('Le champ "debug" doit être un booléen.');
  }

  return errors;
}

module.exports = {
  validateExtractPayload
};
