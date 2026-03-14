const FIELD_KEYS = [
  'type_bien',
  'nombre_lots',
  'montant_travaux',
  'mesures_surfaces',
  'type_vitrage',
  'taxe_fonciere',
  'situation_geographique',
  'montant_loyers',
  'etat_facade',
  'etat_toiture',
  'dpe',
  'mode_chauffage',
  'prix_achat_negocie',
  'pno',
  'prix_affiche',
  'titre_annonce',
  'description',
  'agence_annonceur',
  'reference_annonce'
];

function createEmptyField() {
  return {
    value: null,
    normalized_value: null,
    status: 'missing',
    confidence: null,
    source_text: null,
    source_type: null,
    needs_review: true
  };
}

function createInitialFields() {
  return FIELD_KEYS.reduce((acc, key) => {
    acc[key] = createEmptyField();
    return acc;
  }, {});
}

function normalizeConfidence(confidence) {
  if (!Number.isFinite(confidence)) return null;
  if (confidence < 0) return 0;
  if (confidence > 1) return 1;
  return Math.round(confidence * 100) / 100;
}

function updateField(fields, key, value, sourceText, status = 'found', needsReview = true, options = {}) {
  if (!fields[key]) {
    return;
  }

  const hasValue = value !== undefined && value !== null && String(value).trim() !== '';

  if (!hasValue) {
    fields[key] = createEmptyField();
    return;
  }

  fields[key] = {
    value: String(value).trim(),
    normalized_value: options.normalizedValue ?? null,
    status,
    confidence: normalizeConfidence(options.confidence),
    source_text: sourceText ? String(sourceText).trim() : null,
    source_type: options.sourceType || null,
    needs_review: needsReview
  };
}

function findRegexValue(text, regex) {
  if (!text) {
    return null;
  }
  const match = text.match(regex);
  return match ? match[0].trim() : null;
}

function buildCompleteness(fields) {
  // NOTE: logique de complétude consolidée après résolution de conflits.
  const foundFields = [];
  const missingFields = [];
  const reviewFields = [];

  Object.entries(fields).forEach(([key, data]) => {
    const hasValue = data.value !== null && data.value !== undefined && String(data.value).trim() !== '';

    if (hasValue && ['found', 'inferred', 'ambiguous'].includes(data.status)) {
      foundFields.push(key);
    }

    if (!hasValue || data.status === 'missing' || data.status === 'manual_required') {
      missingFields.push(key);
    }

    if (data.status === 'ambiguous' || data.needs_review) {
      reviewFields.push(key);
    }
  });

  const completionScore = Math.round((foundFields.length / FIELD_KEYS.length) * 100);

  return {
    found_fields: foundFields,
    missing_fields: missingFields,
    review_fields: reviewFields,
    completion_score: completionScore
  };
}

module.exports = {
  FIELD_KEYS,
  createInitialFields,
  updateField,
  findRegexValue,
  buildCompleteness
};
