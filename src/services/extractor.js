const { chromium } = require('playwright');
const config = require('../config');
const {
  createInitialFields,
  updateField,
  findRegexValue,
  buildCompleteness
} = require('../utils/fieldHelpers');

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 500;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 250);
    });
  });
}

async function tryCarouselInteractions(page) {
  const selectors = [
    'button[aria-label*="suivant" i]',
    'button[aria-label*="next" i]',
    '.swiper-button-next',
    '.carousel-control-next',
    '[data-testid*="next" i]'
  ];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.count()) {
      for (let i = 0; i < 5; i += 1) {
        try {
          await button.click({ timeout: 1500 });
          await page.waitForTimeout(250);
        } catch (_error) {
          break;
        }
      }
    }
  }
}

function normalizePriceNumber(rawPrice) {
  if (!rawPrice) return null;
  const digits = String(rawPrice).replace(/[^\d]/g, '');
  if (!digits) return null;
  return Number(digits);
}

function formatEuroValue(amount) {
  if (!Number.isFinite(amount)) return null;
  return `${amount.toLocaleString('fr-FR')} €`;
}

function extractBestPrice(pageData) {
  // NOTE: ce bloc est la version consolidée retenue lors de la résolution de conflits.
  // Heuristique ciblée: privilégier le prix lié au bien (pas loyer/charges/honoraires)
  // 1) JSON-LD price, 2) lignes contenant "prix", 3) fallback max montant raisonnable.
  const candidates = [];

  if (pageData.jsonLdPrice) {
    const amount = normalizePriceNumber(pageData.jsonLdPrice);
    if (amount) {
      candidates.push({
        amount,
        text: String(pageData.jsonLdPrice),
        confidence: 100,
        source: 'jsonld'
      });
    }
  }

  const lines = pageData.cleanedMainText.split('\n').map((line) => line.trim()).filter(Boolean);
  const moneyRegex = /(\d[\d\s]{2,})\s?€/g;
  const negativeContextRegex = /(loyer|charges|charge|honoraires|mois|mensuel|mensuelle|frais|d[ée]p[oô]t)/i;

  lines.forEach((line) => {
    const matches = [...line.matchAll(moneyRegex)];
    if (!matches.length) return;

    matches.forEach((m) => {
      const amount = normalizePriceNumber(m[1]);
      if (!amount) return;

      let confidence = 20;
      if (/\bprix\b/i.test(line)) confidence += 40;
      if (/\bvente\b|\bacheter\b|\bachat\b/i.test(line)) confidence += 10;
      if (negativeContextRegex.test(line)) confidence -= 40;
      if (amount < 10000) confidence -= 20;

      candidates.push({ amount, text: m[0], confidence, source: line });
    });
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.amount - a.amount;
  });

  return candidates[0];
}

function normalizeDescriptionText(rawText) {
  if (!rawText) return '';
  return rawText
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line && line.length > 30)
    .filter((line) => !/(cookies|confidentialit|mentions l[ée]gales|navigation|recherche|estimer|connexion|inscription)/i.test(line))
    .slice(0, 120)
    .join('\n');
}

function extractHeatingFromText(text) {
  if (!text) return null;

  const patterns = [
    /(radiateurs?\s+[a-zàâçéèêëîïôûùüÿñæœ\-\s]{3,80})/i,
    /(chauffage\s*[:\-]?\s*[a-zàâçéèêëîïôûùüÿñæœ\-\s]{3,100})/i,
    /(pompe\s+[a-zàâçéèêëîïôûùüÿñæœ\-\s]{2,80})/i
  ];

  for (const regex of patterns) {
    const match = text.match(regex);
    if (match && match[0]) {
      return match[0].replace(/\s+/g, ' ').trim();
    }
  }

  return null;
}

function extractLocation(pageData) {
  // NOTE: extraction géographique consolidée (titre/H1/main content).
  const locationRegex = /(?:\b[a-zàâçéèêëîïôûùüÿñæœ]+(?:[-\s][a-zàâçéèêëîïôûùüÿñæœ]+){0,4}\b)\s*\((\d{5})\)/i;
  const texts = [pageData.h1Text, pageData.pageTitle, pageData.cleanedMainText, pageData.ogTitle].filter(Boolean);

  for (const text of texts) {
    const match = text.match(locationRegex);
    if (match) {
      return {
        value: text.match(/([A-Za-zÀ-ÿ\-\s']+)\s*\(\d{5}\)/)?.[1]?.trim() || null,
        source: match[0]
      };
    }
  }

  const fromTitle = texts.find((t) => /saint-l[ée]onard-de-noblat/i.test(t));
  if (fromTitle) {
    return { value: 'Saint-Léonard-de-Noblat', source: fromTitle };
  }

  return null;
}

async function collectPageData(page) {
  return page.evaluate(({ maxImages }) => {
    const absoluteUrl = (candidate) => {
      if (!candidate || typeof candidate !== 'string') {
        return null;
      }
      try {
        return new URL(candidate, window.location.href).toString();
      } catch (_error) {
        return null;
      }
    };

    const normalizeImageUrl = (rawUrl) => {
      const absolute = absoluteUrl(rawUrl);
      if (!absolute) return null;
      try {
        const parsed = new URL(absolute);
        parsed.hash = '';
        return parsed.toString();
      } catch (_error) {
        return absolute;
      }
    };

    const getImageRejectionReason = (item) => {
      if (!item.url) return 'missing_url';
      const lowered = item.url.toLowerCase();
      const context = `${item.alt || ''} ${item.className || ''} ${item.parentClass || ''}`.toLowerCase();

      if (lowered.startsWith('data:')) return 'data_url';

      const blockedUrlTokens = [
        'maps.googleapis.com/maps/vt',
        'googleapis.com/maps',
        'google.com/maps',
        'whatsapp',
        'logo',
        'icon',
        'avatar',
        'profile',
        'bed-test',
        'plan-test',
        'leaf-test',
        'marker',
        'pin',
        'sprite',
        'thumbnail-default',
        'favicon',
        'placeholder'
      ];

      if (blockedUrlTokens.some((token) => lowered.includes(token))) return 'blocked_token';
      if (/avatar|profil|profile|agent|conseiller|author/.test(context)) return 'blocked_context';

      if (item.width && item.height && item.width < 180 && item.height < 180) return 'tiny_image';

      const hasKnownImageExt = /\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(lowered);
      const hasExplicitNonImageExt = /\.(svg|gif|ico|woff2?|ttf|eot|mp4|webm|pdf)(\?|$)/i.test(lowered);
      if (hasExplicitNonImageExt) return 'non_image_extension';

      // Cas fréquent M-OI: on garde explicitement les photos métier du dossier properties.
      if (lowered.includes('/img/properties/')) return null;

      // Garde plus souple: certains sites (M-OI) servent des photos via /uploads/ sans extension explicite.
      let sameDomainPath = '';
      try {
        const parsed = new URL(item.url);
        const currentHost = window.location.hostname.replace(/^www\./, '');
        const itemHost = parsed.hostname.replace(/^www\./, '');
        if (itemHost === currentHost) {
          sameDomainPath = parsed.pathname.toLowerCase();
        }
      } catch (_error) {
        return 'invalid_url';
      }

      if (sameDomainPath && /\/(uploads|upload|media|photos?|images?)\//i.test(sameDomainPath)) {
        return null;
      }

      if (hasKnownImageExt || /\/photos?\//i.test(lowered) || /\/images?\//i.test(lowered)) {
        return null;
      }

      return 'not_photo_like';
    };

    const isLikelyPropertyImage = (item) => getImageRejectionReason(item) === null;

    const imageCandidates = [];

    document.querySelectorAll('img').forEach((img) => {
      const srcset = img.getAttribute('srcset') || '';
      const srcsetFirst = srcset.split(',')[0]?.trim().split(' ')[0] || null;
      [img.currentSrc, img.src, srcsetFirst].forEach((src) => {
        if (!src) return;
        imageCandidates.push({
          url: src,
          alt: img.getAttribute('alt') || '',
          className: img.className || '',
          parentClass: img.parentElement?.className || '',
          width: img.naturalWidth || img.width || 0,
          height: img.naturalHeight || img.height || 0
        });
      });
    });

    document.querySelectorAll('[style*="background-image"]').forEach((element) => {
      const style = element.getAttribute('style') || '';
      const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
      if (match && match[1]) {
        imageCandidates.push({
          url: match[1],
          alt: '',
          className: element.className || '',
          parentClass: element.parentElement?.className || '',
          width: element.clientWidth || 0,
          height: element.clientHeight || 0
        });
      }
    });

    const imageUrls = [];
    const seen = new Set();
    const imageFilterDebug = {
      total_candidates: imageCandidates.length,
      kept_count: 0,
      rejected_count: 0,
      rejected_reasons: {},
      kept_samples: [],
      rejected_samples: []
    };

    imageCandidates.forEach((candidate) => {
      const normalizedUrl = normalizeImageUrl(candidate.url);
      const withUrl = { ...candidate, url: normalizedUrl };
      const rejectionReason = getImageRejectionReason(withUrl);

      if (!normalizedUrl || rejectionReason !== null) {
        imageFilterDebug.rejected_count += 1;
        const reasonKey = rejectionReason || 'invalid_url';
        imageFilterDebug.rejected_reasons[reasonKey] = (imageFilterDebug.rejected_reasons[reasonKey] || 0) + 1;
        if (normalizedUrl && imageFilterDebug.rejected_samples.length < 20) {
          imageFilterDebug.rejected_samples.push({ url: normalizedUrl, reason: reasonKey });
        }
        return;
      }

      if (seen.has(normalizedUrl)) {
        imageFilterDebug.rejected_count += 1;
        imageFilterDebug.rejected_reasons.duplicate = (imageFilterDebug.rejected_reasons.duplicate || 0) + 1;
        return;
      }

      seen.add(normalizedUrl);
      imageUrls.push(normalizedUrl);
      imageFilterDebug.kept_count += 1;
      if (imageFilterDebug.kept_samples.length < 20) {
        imageFilterDebug.kept_samples.push(normalizedUrl);
      }
    });

    const title = document.title || '';
    const h1Text = document.querySelector('h1')?.innerText?.trim() || '';
    const descriptionMeta = document.querySelector('meta[name="description"]')?.content || '';
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
    const ogDescription = document.querySelector('meta[property="og:description"]')?.content || '';

    const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    let jsonLdPrice = null;
    for (const script of jsonLdScripts) {
      try {
        const parsed = JSON.parse(script.textContent || '{}');
        const asArray = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of asArray) {
          if (item?.offers?.price) {
            jsonLdPrice = item.offers.price;
            break;
          }
          if (item?.price) {
            jsonLdPrice = item.price;
            break;
          }
        }
      } catch (_error) {
        // ignore malformed JSON-LD
      }
      if (jsonLdPrice) break;
    }

    // Heuristique bruit réduit: on priorise la zone principale d'annonce.
    const mainContainer =
      document.querySelector('main') ||
      document.querySelector('article') ||
      document.querySelector('[data-testid*="listing" i]') ||
      document.querySelector('[class*="listing" i]') ||
      document.body;

    const collectText = (root) => Array.from(root.querySelectorAll('h1, h2, h3, p, li'))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean);

    const mainTextBlocks = collectText(mainContainer).slice(0, 700);
    const bodyTextBlocks = collectText(document.body).slice(0, 1000);

    const breadcrumbSelectors = [
      'nav[aria-label*=\"breadcrumb\" i]',
      '[role=\"navigation\"][aria-label*=\"fil\" i]',
      '[class*=\"breadcrumb\" i]',
      '[data-testid*=\"breadcrumb\" i]'
    ];

    let breadcrumbText = '';
    for (const selector of breadcrumbSelectors) {
      const node = document.querySelector(selector);
      if (node) {
        const nodeText = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (nodeText) {
          breadcrumbText = nodeText;
          break;
        }
      }
    }

    return {
      pageTitle: title,
      h1Text,
      metaDescription: descriptionMeta,
      ogTitle,
      ogDescription,
      jsonLdPrice,
      cleanedMainText: mainTextBlocks.join('\n'),
      fallbackText: bodyTextBlocks.join('\n'),
      breadcrumbText,
      imageUrls: imageUrls.slice(0, maxImages),
      imageFilterDebug
    };
  }, { maxImages: config.maxImages });
}

function inferSourceType(sourceText, sourceHint = '') {
  const normalized = `${sourceHint || ''} ${sourceText || ''}`.toLowerCase();
  if (normalized.includes('jsonld')) return 'json_ld';
  if (normalized.includes('meta') || normalized.includes('og:')) return 'meta_tag';
  if (normalized.includes('url') || normalized.includes('domaine') || normalized.includes('domain')) return 'url';
  if (normalized.includes('h1') || normalized.includes('title')) return 'title';
  return 'body_text';
}

function extractReferenceFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const slugTokens = `${parsed.pathname} ${parsed.search}`.match(/[A-Za-z]{1,5}[-_]?[0-9]{4,}|[0-9]{5,}/g) || [];
    return slugTokens.length ? slugTokens[0] : null;
  } catch (_error) {
    return null;
  }
}

function buildRegexCandidates(text, regex, field, sourceType, confidence = 0.6) {
  if (!text) return [];
  const matches = [...text.matchAll(regex)];
  return matches.slice(0, 8).map((match) => ({
    field,
    value: (match[1] || match[0] || '').trim(),
    source_text: (match[0] || '').trim(),
    source_type: sourceType,
    confidence
  })).filter((item) => item.value);
}


function extractUrlTokens(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    const seen = new Set();

    return decodeURIComponent(parsed.pathname || '')
      .toLowerCase()
      .split(/[\s\/_-]+/g)
      .map((token) => token.trim())
      .filter((token) => token && !seen.has(token) && (seen.add(token) || true));
  } catch (_error) {
    return [];
  }
}

function buildCandidateItem(match, contextText, sourceType, options = {}) {
  const valueRaw = (match?.[0] || '').trim();
  if (!valueRaw) return null;

  const normalizedValue = options.normalizer ? options.normalizer(valueRaw, match) : null;

  return {
    value_raw: valueRaw,
    normalized_value: normalizedValue,
    unit: options.unit || null,
    context: (contextText || '').slice(0, 220),
    source_type: sourceType
  };
}

function buildGenericCandidates(sourceEntries, regex, options = {}) {
  const output = [];

  sourceEntries.forEach(({ text, sourceType }) => {
    if (!text) return;
    const lines = String(text).split('\n').map((line) => line.trim()).filter(Boolean);

    lines.forEach((line) => {
      const matches = [...line.matchAll(regex)];
      matches.forEach((match) => {
        const item = buildCandidateItem(match, line, sourceType, options);
        if (item) {
          output.push(item);
        }
      });
    });
  });

  const seen = new Set();
  return output.filter((item) => {
    const key = `${item.value_raw}|${item.context}|${item.source_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 40);
}

function buildEvidenceCandidates(pageData, aggregateText, sourceUrl) {
  const sources = [
    { text: pageData.h1Text, sourceType: 'title' },
    { text: pageData.pageTitle, sourceType: 'title' },
    { text: pageData.metaDescription, sourceType: 'meta_tag' },
    { text: pageData.ogTitle, sourceType: 'meta_tag' },
    { text: pageData.ogDescription, sourceType: 'meta_tag' },
    { text: pageData.breadcrumbText || '', sourceType: 'breadcrumb' },
    { text: extractUrlTokens(sourceUrl).join(' '), sourceType: 'url' },
    { text: aggregateText, sourceType: 'body_text' },
    { text: pageData.jsonLdPrice ? `price ${pageData.jsonLdPrice} eur` : '', sourceType: 'json_ld' }
  ];

  return {
    prices: [
      ...buildGenericCandidates(sources, /\b\d[\d\s.,]{2,}\s?(?:€|eur)\b/gi, {
      unit: 'eur',
      normalizer: (valueRaw) => normalizePriceNumber(valueRaw)
      }),
      ...(pageData.jsonLdPrice ? [{
        value_raw: String(pageData.jsonLdPrice),
        normalized_value: normalizePriceNumber(pageData.jsonLdPrice),
        unit: 'eur',
        context: `price ${pageData.jsonLdPrice}`,
        source_type: 'json_ld'
      }] : [])
    ],
    surfaces: buildGenericCandidates(sources, /\b\d{1,4}(?:[.,]\d{1,2})?\s?m(?:²|2)\b/gi, {
      unit: 'm2',
      normalizer: (valueRaw) => Number(
        String(valueRaw)
          .replace(/m(?:²|2)/gi, '')
          .replace(',', '.')
          .replace(/[^\d.]/g, '')
      ) || null
    }),
    rent_mentions: buildGenericCandidates(sources, /\b(loyer[s]?|revenus? locatifs?)\b[^\n]{0,120}/gi),
    lot_mentions: buildGenericCandidates(sources, /\b(?:\d+\s+lots?|lot\s*\d+|immeuble de rapport)\b[^\n]{0,120}/gi),
    occupancy_mentions: buildGenericCandidates(sources, /\b(lou[ée]s?|libre|vacant|occup[ée]|disponible|actuellement lou[ée]|d[ée]j[àa] lou[ée])\b[^\n]{0,120}/gi),
    tax_mentions: buildGenericCandidates(sources, /\b(taxe\s+fonci[èe]re|fonci[èe]re|TF)\b[^\n]{0,120}/gi),
    glazing_mentions: buildGenericCandidates(sources, /\b(simple vitrage|double vitrage|triple vitrage)\b[^\n]{0,120}/gi),
    dpe_mentions: buildGenericCandidates(sources, /\b(DPE|classe\s+[ée]nergie|GES|classe\s+climat|[A-G]\s*\/\s*[A-G])\b[^\n]{0,120}/gi),
    heating_mentions: buildGenericCandidates(sources, /\b(chauffage|radiateur|[ée]lectrique|gaz|collectif|individuel|pompe\s+[àa]\s+chaleur|chaudi[èe]re|inertie)\b[^\n]{0,120}/gi)
  };
}

function extractFieldsFromText(pageData, sourceUrl) {
  const fields = createInitialFields();
  const aggregateText = [
    pageData.h1Text,
    pageData.pageTitle,
    pageData.ogTitle,
    pageData.metaDescription,
    pageData.ogDescription,
    pageData.cleanedMainText,
    pageData.fallbackText
  ].join('\n');

  const extractionMeta = {
    contract_version: '2.0-min',
    strategy: 'heuristic_plus_evidence',
    text_lengths: {
      cleaned_main: (pageData.cleanedMainText || '').length,
      fallback: (pageData.fallbackText || '').length
    }
  };

  const candidates = {
    dpe: buildRegexCandidates(aggregateText, /(dpe\s*[:\-]?\s*[a-g])/gi, 'dpe', 'body_text', 0.72),
    reference_annonce: buildRegexCandidates(aggregateText, /(r[ée]f[ée]rence\s*[:#\-]?\s*[a-z0-9\-_/]+)/gi, 'reference_annonce', 'body_text', 0.78),
    montant_loyers: buildRegexCandidates(aggregateText, /(loyer[s]?\s*[:\-]?\s*\d[\d\s]{2,}\s?€)/gi, 'montant_loyers', 'body_text', 0.7),
    mode_chauffage: buildRegexCandidates(aggregateText, /(chauffage\s*[:\-]?\s*[a-zàâçéèêëîïôûùüÿñæœ\-\s]{3,100})/gi, 'mode_chauffage', 'body_text', 0.65),
    ...buildEvidenceCandidates(pageData, aggregateText, sourceUrl)
  };

  const descriptionText = normalizeDescriptionText(pageData.cleanedMainText || pageData.fallbackText);

  updateField(
    fields,
    'titre_annonce',
    pageData.h1Text || pageData.pageTitle || pageData.ogTitle,
    pageData.h1Text || pageData.pageTitle || pageData.ogTitle,
    'found',
    false,
    { confidence: 0.95, sourceType: pageData.h1Text ? 'title' : 'meta_tag' }
  );

  if (descriptionText) {
    updateField(fields, 'description', descriptionText, descriptionText.slice(0, 200), 'found', false, {
      confidence: 0.86,
      sourceType: 'body_text'
    });
  }

  const bestPrice = extractBestPrice(pageData);
  if (bestPrice) {
    updateField(fields, 'prix_affiche', formatEuroValue(bestPrice.amount), bestPrice.source, 'found', false, {
      normalizedValue: bestPrice.amount,
      confidence: Math.min(Math.max(bestPrice.confidence / 100, 0.4), 0.99),
      sourceType: inferSourceType(bestPrice.source, bestPrice.source)
    });
  }

  const loyer = findRegexValue(aggregateText, /(loyer[s]?\s*[:\-]?\s*\d[\d\s]{2,}\s?€)/i);
  if (loyer) {
    const normalized = normalizePriceNumber(loyer);
    updateField(fields, 'montant_loyers', loyer, loyer, 'found', true, {
      normalizedValue: normalized,
      confidence: 0.7,
      sourceType: 'body_text'
    });
  }

  const surface = findRegexValue(aggregateText, /(\d{1,4}[,.]?\d{0,2}\s?m²)/i);
  if (surface) {
    const normalized = Number(String(surface).replace(',', '.').replace(/[^\d.]/g, '')) || null;
    updateField(fields, 'mesures_surfaces', surface, surface, 'found', true, {
      normalizedValue: normalized,
      confidence: 0.72,
      sourceType: 'body_text'
    });
  }

  const lots = findRegexValue(aggregateText, /(\d+\s+lots?)/i);
  if (lots) {
    const normalized = Number((lots.match(/\d+/) || [])[0]) || null;
    updateField(fields, 'nombre_lots', lots, lots, 'found', true, {
      normalizedValue: normalized,
      confidence: 0.68,
      sourceType: 'body_text'
    });
  }

  const taxe = findRegexValue(aggregateText, /(taxe fonci[eè]re\s*[:\-]?\s*\d[\d\s]{1,}\s?€?)/i);
  if (taxe) {
    updateField(fields, 'taxe_fonciere', taxe, taxe, 'found', true, {
      normalizedValue: normalizePriceNumber(taxe),
      confidence: 0.71,
      sourceType: 'body_text'
    });
  }

  const dpe = findRegexValue(aggregateText, /(DPE\s*[:\-]?\s*[A-G])/i);
  if (dpe) {
    updateField(fields, 'dpe', dpe, dpe, 'found', true, {
      normalizedValue: (dpe.match(/[A-G]/i) || [null])[0],
      confidence: 0.75,
      sourceType: 'body_text'
    });
  }

  const chauffage = extractHeatingFromText(descriptionText || aggregateText);
  if (chauffage) {
    updateField(fields, 'mode_chauffage', chauffage, chauffage, 'found', true, {
      confidence: 0.66,
      sourceType: 'body_text'
    });
  }

  const referenceFromUrl = extractReferenceFromUrl(sourceUrl);
  const reference = findRegexValue(aggregateText, /(r[ée]f[ée]rence\s*[:#\-]?\s*[A-Za-z0-9\-_/]+)/i) || referenceFromUrl;
  if (reference) {
    const sourceType = reference === referenceFromUrl ? 'url' : 'body_text';
    updateField(fields, 'reference_annonce', reference, reference, 'found', true, {
      confidence: sourceType === 'url' ? 0.62 : 0.8,
      sourceType
    });
    if (sourceType === 'url') {
      candidates.reference_annonce.push({
        field: 'reference_annonce',
        value: reference,
        source_text: sourceUrl,
        source_type: 'url',
        confidence: 0.62
      });
    }
  }

  const location = extractLocation(pageData);
  if (location && location.value) {
    updateField(fields, 'situation_geographique', location.value, location.source, 'found', false, {
      confidence: 0.83,
      sourceType: 'body_text'
    });
  }

  const agencySignals = [
    /iad\s*france/i,
    /century\s*21/i,
    /orpi/i,
    /lafor[eê]t/i,
    /guy\s*hoquet/i,
    /safti/i
  ];
  const agencyLine = (aggregateText.split('\n').find((line) => agencySignals.some((regex) => regex.test(line))) || '').trim();
  if (agencyLine) {
    const agencyName = agencySignals.find((regex) => regex.test(agencyLine));
    const normalizedAgency = agencyName ? agencyLine.match(agencyName)?.[0] : null;
    updateField(fields, 'agence_annonceur', normalizedAgency || agencyLine, agencyLine, 'inferred', true, {
      confidence: 0.74,
      sourceType: 'body_text'
    });
  } else if (/iadfrance\.fr/i.test(sourceUrl)) {
    updateField(fields, 'agence_annonceur', 'iad France', 'Domaine iadfrance.fr', 'inferred', true, {
      confidence: 0.69,
      sourceType: 'url'
    });
  }

  const typeBien = findRegexValue(aggregateText, /(appartement|maison|immeuble|studio|terrain|local commercial)/i);
  if (typeBien) {
    updateField(fields, 'type_bien', typeBien, typeBien, 'inferred', true, {
      confidence: 0.82,
      sourceType: 'body_text'
    });
  }

  return {
    fields,
    descriptionText,
    candidates,
    extractionMeta,
    rawSignals: {
      page_title: pageData.pageTitle || '',
      h1: pageData.h1Text || '',
      meta_description: pageData.metaDescription || '',
      og_title: pageData.ogTitle || '',
      og_description: pageData.ogDescription || '',
      json_ld_price: pageData.jsonLdPrice || null,
      cleaned_main_text: pageData.cleanedMainText || '',
      fallback_text: pageData.fallbackText || '',
      url_tokens: extractUrlTokens(sourceUrl),
      breadcrumb_text: pageData.breadcrumbText || ''
    }
  };
}

function buildResponse({ requestId, sourceUrl, pageData, fields, images, errors, descriptionText, candidates, extractionMeta, rawSignals }) {
  const completeness = buildCompleteness(fields);
  const hasFatalErrors = errors.some((e) => e.code === 'EXTRACTION_FAILED' || e.code === 'NAVIGATION_FAILED');
  const hasMissing = completeness.missing_fields.length > 0;

  return {
    request_id: requestId || null,
    status: hasFatalErrors ? 'error' : hasMissing ? 'partial' : 'success',
    source: {
      url: sourceUrl,
      domain: new URL(sourceUrl).hostname,
      page_title: pageData.pageTitle || ''
    },
    timestamps: {
      extracted_at: new Date().toISOString()
    },
    images: {
      count: images.length,
      items: images.map((url, index) => ({
        url,
        status: 'found',
        order: index + 1
      }))
    },
    fields,
    completeness,
    raw: {
      description_text: descriptionText || '',
      ...rawSignals
    },
    candidates,
    extraction_metadata: extractionMeta,
    errors
  };
}

async function extractListing(payload) {
  const errors = [];
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 2200 },
      userAgent: 'scan-immo-bot/1.0 (+playwright)'
    });

    const page = await context.newPage();
    page.setDefaultTimeout(config.browserTimeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);

    await page.goto(payload.url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: config.navigationTimeoutMs }).catch(() => {});

    await autoScroll(page);
    await tryCarouselInteractions(page);

    const pageData = await collectPageData(page);
    const { fields, descriptionText, candidates, extractionMeta, rawSignals } = extractFieldsFromText(pageData, payload.url);

    if (!pageData.pageTitle) {
      errors.push({
        code: 'PAGE_TITLE_MISSING',
        message: 'Le titre de la page est vide ou inaccessible.'
      });
    }

    const response = buildResponse({
      requestId: payload.request_id,
      sourceUrl: payload.url,
      pageData,
      fields,
      images: pageData.imageUrls,
      errors,
      descriptionText,
      candidates,
      extractionMeta,
      rawSignals
    });

    if (payload.debug) {
      response.debug = {
        meta: {
          title: pageData.pageTitle,
          h1: pageData.h1Text,
          ogTitle: pageData.ogTitle,
          ogDescription: pageData.ogDescription,
          metaDescription: pageData.metaDescription,
          jsonLdPrice: pageData.jsonLdPrice,
          imageFilterDebug: pageData.imageFilterDebug
        }
      };
    }

    return response;
  } catch (error) {
    return {
      request_id: payload.request_id || null,
      status: 'error',
      source: {
        url: payload.url,
        domain: (() => {
          try {
            return new URL(payload.url).hostname;
          } catch (_error) {
            return 'unknown';
          }
        })(),
        page_title: ''
      },
      timestamps: {
        extracted_at: new Date().toISOString()
      },
      images: {
        count: 0,
        items: []
      },
      fields: createInitialFields(),
      completeness: {
        found_fields: [],
        missing_fields: [],
        review_fields: [],
        completion_score: 0
      },
      raw: {
        description_text: '',
        page_title: '',
        h1: '',
        meta_description: '',
        og_title: '',
        og_description: '',
        json_ld_price: null,
        cleaned_main_text: '',
        fallback_text: '',
        url_tokens: [],
        breadcrumb_text: ''
      },
      candidates: {
        dpe: [],
        reference_annonce: [],
        montant_loyers: [],
        mode_chauffage: [],
        prices: [],
        surfaces: [],
        rent_mentions: [],
        lot_mentions: [],
        occupancy_mentions: [],
        tax_mentions: [],
        glazing_mentions: [],
        dpe_mentions: [],
        heating_mentions: []
      },
      extraction_metadata: {
        contract_version: '2.0-min',
        strategy: 'heuristic_plus_evidence',
        text_lengths: {
          cleaned_main: 0,
          fallback: 0
        }
      },
      errors: [
        {
          code: 'EXTRACTION_FAILED',
          message: error.message
        }
      ]
    };
  } finally {
    await browser.close();
  }
}

module.exports = {
  extractListing
};
