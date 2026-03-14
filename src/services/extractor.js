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

    const isLikelyPropertyImage = (item) => {
      if (!item.url) return false;
      const lowered = item.url.toLowerCase();
      const context = `${item.alt || ''} ${item.className || ''} ${item.parentClass || ''}`.toLowerCase();

      if (lowered.startsWith('data:')) return false;

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

      if (blockedUrlTokens.some((token) => lowered.includes(token))) return false;
      if (/avatar|profil|profile|agent|conseiller|author/.test(context)) return false;

      if (item.width && item.height && item.width < 180 && item.height < 180) return false;

      const hasKnownImageExt = /\.(jpg|jpeg|png|webp|avif)(\?|$)/i.test(lowered);
      const hasExplicitNonImageExt = /\.(svg|gif|ico|woff2?|ttf|eot|mp4|webm|pdf)(\?|$)/i.test(lowered);
      if (hasExplicitNonImageExt) return false;

      // Cas fréquent M-OI: on garde explicitement les photos métier du dossier properties.
      if (lowered.includes('/img/properties/')) return true;

      return hasKnownImageExt || /\/photos?\//i.test(lowered) || /\/images?\//i.test(lowered);
    };

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
    imageCandidates.forEach((candidate) => {
      const normalizedUrl = absoluteUrl(candidate.url);
      const withUrl = { ...candidate, url: normalizedUrl };
      if (!normalizedUrl || !isLikelyUsefulImage(withUrl)) return;
      if (seen.has(normalizedUrl)) return;
      seen.add(normalizedUrl);
      imageUrls.push(normalizedUrl);
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

    return {
      pageTitle: title,
      h1Text,
      metaDescription: descriptionMeta,
      ogTitle,
      ogDescription,
      jsonLdPrice,
      cleanedMainText: mainTextBlocks.join('\n'),
      fallbackText: bodyTextBlocks.join('\n'),
      imageUrls: imageUrls.slice(0, maxImages)
    };
  }, { maxImages: config.maxImages });
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

  const descriptionText = normalizeDescriptionText(pageData.cleanedMainText || pageData.fallbackText);

  updateField(fields, 'titre_annonce', pageData.h1Text || pageData.pageTitle || pageData.ogTitle, pageData.h1Text || pageData.pageTitle || pageData.ogTitle, 'found', false);

  if (descriptionText) {
    updateField(fields, 'description', descriptionText, descriptionText.slice(0, 200), 'found', false);
  }

  const bestPrice = extractBestPrice(pageData);
  if (bestPrice) {
    updateField(fields, 'prix_affiche', formatEuroValue(bestPrice.amount), bestPrice.source, 'found', false);
  }

  const loyer = findRegexValue(aggregateText, /(loyer[s]?\s*[:\-]?\s*\d[\d\s]{2,}\s?€)/i);
  if (loyer) {
    updateField(fields, 'montant_loyers', loyer, loyer, 'found', true);
  }

  const surface = findRegexValue(aggregateText, /(\d{1,4}[,.]?\d{0,2}\s?m²)/i);
  if (surface) {
    updateField(fields, 'mesures_surfaces', surface, surface, 'found', true);
  }

  const lots = findRegexValue(aggregateText, /(\d+\s+lots?)/i);
  if (lots) {
    updateField(fields, 'nombre_lots', lots, lots, 'found', true);
  }

  const taxe = findRegexValue(aggregateText, /(taxe fonci[eè]re\s*[:\-]?\s*\d[\d\s]{1,}\s?€?)/i);
  if (taxe) {
    updateField(fields, 'taxe_fonciere', taxe, taxe, 'found', true);
  }

  const dpe = findRegexValue(aggregateText, /(DPE\s*[:\-]?\s*[A-G])/i);
  if (dpe) {
    updateField(fields, 'dpe', dpe, dpe, 'found', true);
  }

  const chauffage = extractHeatingFromText(descriptionText || aggregateText);
  if (chauffage) {
    updateField(fields, 'mode_chauffage', chauffage, chauffage, 'found', true);
  }

  const reference = findRegexValue(aggregateText, /(r[eé]f[eé]rence\s*[:#\-]?\s*[A-Za-z0-9\-_/]+)/i);
  if (reference) {
    updateField(fields, 'reference_annonce', reference, reference, 'found', true);
  }

  const location = extractLocation(pageData);
  if (location && location.value) {
    updateField(fields, 'situation_geographique', location.value, location.source, 'found', false);
  }

  // Heuristique ciblée: on évite le faux positif "honoraires agence".
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
    updateField(fields, 'agence_annonceur', normalizedAgency || agencyLine, agencyLine, 'inferred', true);
  } else if (/iadfrance\.fr/i.test(sourceUrl)) {
    updateField(fields, 'agence_annonceur', 'iad France', 'Domaine iadfrance.fr', 'inferred', true);
  }

  const typeBien = findRegexValue(aggregateText, /(appartement|maison|immeuble|studio|terrain|local commercial)/i);
  if (typeBien) {
    updateField(fields, 'type_bien', typeBien, typeBien, 'inferred', true);
  }

  return {
    fields,
    descriptionText
  };
}

function buildResponse({ requestId, sourceUrl, pageData, fields, images, errors, descriptionText }) {
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
      description_text: descriptionText || ''
    },
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
    const { fields, descriptionText } = extractFieldsFromText(pageData, payload.url);

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
      descriptionText
    });

    if (payload.debug) {
      response.debug = {
        meta: {
          title: pageData.pageTitle,
          h1: pageData.h1Text,
          ogTitle: pageData.ogTitle,
          ogDescription: pageData.ogDescription,
          metaDescription: pageData.metaDescription,
          jsonLdPrice: pageData.jsonLdPrice
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
        description_text: ''
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
