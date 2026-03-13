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

async function collectPageData(page, pageUrl) {
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

    const isLikelyUsefulImage = (url) => {
      if (!url) return false;
      const lowered = url.toLowerCase();
      if (lowered.startsWith('data:')) return false;
      const blockedKeywords = ['logo', 'icon', 'avatar', 'sprite', 'favicon', 'placeholder'];
      return !blockedKeywords.some((keyword) => lowered.includes(keyword));
    };

    const imageCandidates = [];

    document.querySelectorAll('img').forEach((img) => {
      const srcset = img.getAttribute('srcset') || '';
      const srcsetFirst = srcset.split(',')[0]?.trim().split(' ')[0] || null;
      imageCandidates.push(img.currentSrc, img.src, srcsetFirst);
    });

    document.querySelectorAll('[style*="background-image"]').forEach((element) => {
      const style = element.getAttribute('style') || '';
      const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
      if (match && match[1]) {
        imageCandidates.push(match[1]);
      }
    });

    const imageUrls = [];
    const seen = new Set();
    imageCandidates.forEach((candidate) => {
      const normalized = absoluteUrl(candidate);
      if (!normalized || !isLikelyUsefulImage(normalized)) return;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      imageUrls.push(normalized);
    });

    const title = document.title || '';
    const descriptionMeta = document.querySelector('meta[name="description"]')?.content || '';
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
    const ogDescription = document.querySelector('meta[property="og:description"]')?.content || '';

    const textBlocks = Array.from(document.querySelectorAll('h1, h2, h3, p, li, span'))
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
      .slice(0, 1200);

    return {
      pageTitle: title,
      metaDescription: descriptionMeta,
      ogTitle,
      ogDescription,
      textContent: textBlocks.join('\n'),
      imageUrls: imageUrls.slice(0, maxImages)
    };
  }, { maxImages: config.maxImages, pageUrl });
}

function extractFieldsFromText(pageData) {
  const fields = createInitialFields();
  const aggregateText = [
    pageData.pageTitle,
    pageData.ogTitle,
    pageData.metaDescription,
    pageData.ogDescription,
    pageData.textContent
  ].join('\n');

  updateField(fields, 'titre_annonce', pageData.pageTitle || pageData.ogTitle, pageData.pageTitle || pageData.ogTitle, 'found', false);
  updateField(fields, 'description', pageData.metaDescription || pageData.ogDescription, pageData.metaDescription || pageData.ogDescription, pageData.metaDescription ? 'found' : 'inferred', true);

  const prixAffiche = findRegexValue(aggregateText, /(\d[\d\s]{2,}\s?€)/i);
  if (prixAffiche) {
    updateField(fields, 'prix_affiche', prixAffiche, prixAffiche, 'found', true);
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

  const chauffage = findRegexValue(aggregateText, /(chauffage\s*[:\-]?\s*[^\n,.]{3,40})/i);
  if (chauffage) {
    updateField(fields, 'mode_chauffage', chauffage, chauffage, 'ambiguous', true);
  }

  const reference = findRegexValue(aggregateText, /(r[eé]f[eé]rence\s*[:#\-]?\s*[A-Za-z0-9\-_/]+)/i);
  if (reference) {
    updateField(fields, 'reference_annonce', reference, reference, 'found', true);
  }

  const agence = findRegexValue(aggregateText, /(agence\s*[:\-]?\s*[^\n,.]{2,80})/i);
  if (agence) {
    updateField(fields, 'agence_annonceur', agence, agence, 'ambiguous', true);
  }

  const typeBien = findRegexValue(aggregateText, /(appartement|maison|immeuble|studio|terrain|local commercial)/i);
  if (typeBien) {
    updateField(fields, 'type_bien', typeBien, typeBien, 'inferred', true);
  }

  return fields;
}

function buildResponse({ requestId, sourceUrl, pageData, fields, images, errors }) {
  const completeness = buildCompleteness(fields);
  const hasErrors = errors.length > 0;
  const hasMissing = completeness.missing_fields.length > 0;

  return {
    request_id: requestId || null,
    status: hasErrors ? 'error' : hasMissing ? 'partial' : 'success',
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
      description_text: pageData.textContent || ''
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

    const pageData = await collectPageData(page, payload.url);
    const fields = extractFieldsFromText(pageData);

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
      errors
    });

    if (payload.debug) {
      response.debug = {
        meta: {
          title: pageData.pageTitle,
          ogTitle: pageData.ogTitle,
          ogDescription: pageData.ogDescription,
          metaDescription: pageData.metaDescription
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
