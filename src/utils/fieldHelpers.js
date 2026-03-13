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
    status: 'missing',
    source_text: null,
    needs_review: true
  };
}

function createInitialFields() {
  return FIELD_KEYS.reduce((acc, key) => {
    acc[key] = createEmptyField();
    return acc;
  }, {});
}

function updateField(fields, key, value, sourceText, status = 'found', needsReview = true) {
  if (!fields[key]) {
    return;
  }

  fields[key] = {
    value: value || null,
    status,
    source_text: sourceText || null,
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
  const foundFields = [];
  const missingFields = [];
  const reviewFields = [];

  Object.entries(fields).forEach(([key, data]) => {
    if (data.status === 'found' || data.status === 'inferred') {
      foundFields.push(key);
    }

    if (data.status === 'missing' || data.status === 'manual_required') {
      missingFields.push(key);
    }

    if (data.needs_review || data.status === 'ambiguous') {
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
