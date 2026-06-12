const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const reports = new Map();

function normalizeUrl(input) {
  if (!input) return null;
  let value = String(input).trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    return url.href;
  } catch (_) {
    return null;
  }
}

function absoluteUrl(base, href) {
  try {
    return new URL(href, base).href;
  } catch (_) {
    return href;
  }
}

function stripTags(html) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function fetchText(url, options = {}) {
  const limit = options.limit || 900000;
  const timeout = options.timeout || 18000;
  const redirectsLeft = options.redirectsLeft ?? 4;
  const method = options.method || 'GET';
  const headers = Object.assign({
    'User-Agent': 'Mozilla/5.0 (compatible; AIOAuditBot/1.0; +https://example.com/aio-audit)',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'Accept-Language': 'ja,en;q=0.8',
  }, options.headers || {});

  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return reject(new Error('URL形式が正しくありません。')); }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers,
      timeout,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        fetchText(absoluteUrl(url, res.headers.location), { ...options, redirectsLeft: redirectsLeft - 1 })
          .then(resolve)
          .catch(reject);
        return;
      }

      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= limit) chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ body, status: res.statusCode, finalUrl: url, headers: res.headers });
      });
    });
    req.on('timeout', () => req.destroy(new Error('サイト取得がタイムアウトしました。')));
    req.on('error', reject);
    req.end();
  });
}

function findMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return '';
}

function extractJsonLd(html) {
  const items = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const raw = match[1].trim();
    try {
      const parsed = JSON.parse(raw);
      items.push(parsed);
    } catch (_) {
      items.push({ parseError: true, preview: raw.slice(0, 180) });
    }
  }
  return items;
}

function flattenSchemaTypes(items) {
  const types = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (node['@type']) {
      const type = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
      type.forEach((t) => types.add(String(t)));
    }
    if (node['@graph']) visit(node['@graph']);
    ['address', 'geo', 'openingHoursSpecification', 'aggregateRating', 'review', 'sameAs'].forEach((key) => visit(node[key]));
  };
  items.forEach(visit);
  return [...types];
}

function includesAny(text, words) {
  return words.some((word) => text.includes(word.toLowerCase()));
}

function extractBusinessFacts(html, url) {
  const title = decodeHtml((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const description = findMeta(html, 'description');
  const ogTitle = findMeta(html, 'og:title');
  const ogDescription = findMeta(html, 'og:description');
  const canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i) || [])[1] || '';
  const text = stripTags(html).slice(0, 90000);
  const lowerText = text.toLowerCase();
  const jsonLd = extractJsonLd(html);
  const schemaTypes = flattenSchemaTypes(jsonLd);
  const h1 = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])).filter(Boolean).slice(0, 5);
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => stripTags(m[1])).filter(Boolean).slice(0, 16);
  const links = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ href: absoluteUrl(url, decodeHtml(m[1])), text: stripTags(m[2]).slice(0, 80) }))
    .filter((link) => link.text || /^https?:/i.test(link.href))
    .slice(0, 120);
  const sameAsSignals = links.filter((link) => /google|instagram|facebook|x\.com|twitter|tabelog|hotpepper|gnavi|retty|tripadvisor|youtube|line\.me/i.test(link.href));
  const phone = (text.match(/0\d{1,4}[-ー−]?\d{1,4}[-ー−]?\d{3,4}/) || [])[0] || '';
  const address = (text.match(/(?:〒\s?\d{3}[-ー−]?\d{4}\s*)?(?:東京都|北海道|大阪府|京都府|.{2,3}県)[^\s、。]{4,60}/) || [])[0] || '';

  const serviceWords = ['サービス', 'メニュー', '料金', '価格', '費用', 'プラン', 'コース', '実績', '事例', '口コミ', 'レビュー', 'FAQ', 'よくある質問', 'アクセス', '営業時間', '予約', 'お問い合わせ'];
  const localWords = ['営業時間', '定休日', '住所', 'アクセス', '駐車場', '最寄り', '駅', '予約', '電話'];
  const credibilityWords = ['実績', '受賞', '認定', '資格', '導入', 'お客様の声', '口コミ', 'レビュー', 'メディア', '創業', '運営会社'];

  return {
    url,
    title,
    description,
    ogTitle,
    ogDescription,
    canonical: canonical ? absoluteUrl(url, canonical) : '',
    h1,
    headings,
    schemaTypes,
    jsonLdCount: jsonLd.length,
    hasBrokenJsonLd: jsonLd.some((item) => item.parseError),
    textLength: text.length,
    phone,
    address,
    sameAsSignals,
    hasFaq: /FAQ|よくある質問|Q\s*[&Ａ]?[AＡ]/i.test(text) || schemaTypes.includes('FAQPage'),
    hasReview: includesAny(lowerText, ['口コミ', 'レビュー', 'お客様の声', '評判']) || schemaTypes.some((t) => /Review|AggregateRating/i.test(t)),
    hasPrice: includesAny(lowerText, ['料金', '価格', '費用', '税込', '円', 'プラン', 'コース']),
    hasAccess: includesAny(lowerText, localWords.map((w) => w.toLowerCase())) || Boolean(address),
    hasCredibility: includesAny(lowerText, credibilityWords.map((w) => w.toLowerCase())),
    serviceCoverage: serviceWords.filter((word) => lowerText.includes(word.toLowerCase())),
    snippets: text.slice(0, 1400),
  };
}

function inferKeywords(name, facts, extraKeywords) {
  const source = `${name} ${facts.title} ${facts.description} ${facts.h1.join(' ')} ${facts.headings.join(' ')}`;
  const categories = [
    '飲食店', 'レストラン', 'カフェ', '美容室', '整体', '歯科', 'クリニック', '税理士', '弁護士', '工務店', '不動産', 'ホテル', 'ジム', '塾', '行政書士', 'Web制作', 'マーケティング', '焼肉', '居酒屋', 'ラーメン', 'エステ', 'ネイル', '修理', 'リフォーム'
  ];
  const detected = categories.filter((word) => source.includes(word));
  const area = facts.address ? facts.address.slice(0, 12).replace(/〒?\d{3}[-ー−]?\d{4}/, '').trim() : '';
  const seeds = [];
  if (name) seeds.push(`${name}`);
  if (detected[0] && area) seeds.push(`${area} ${detected[0]} おすすめ`);
  if (detected[0]) seeds.push(`${detected[0]} 選び方`);
  if (detected[0] && area) seeds.push(`${area} ${detected[0]} 料金`);
  seeds.push(...String(extraKeywords || '').split(/[\n,、]/).map((v) => v.trim()).filter(Boolean));
  return [...new Set(seeds)].slice(0, 8);
}

function scoreFacts(facts, searchSignals, keywords) {
  const checks = [
    { key: 'basic', label: '基本情報の明確さ', weight: 16, ok: Boolean(facts.title && facts.description && facts.h1.length), detail: 'title・description・H1で事業内容を説明できているか' },
    { key: 'entity', label: 'エンティティ情報', weight: 18, ok: Boolean(facts.phone && facts.address && facts.hasAccess), detail: '住所・電話・アクセス・営業時間など、AIが同一事業者として認識しやすい情報があるか' },
    { key: 'schema', label: '構造化データ', weight: 18, ok: facts.jsonLdCount > 0 && !facts.hasBrokenJsonLd && facts.schemaTypes.length > 0, detail: 'LocalBusiness / Organization / FAQPage 等のJSON-LDがあるか' },
    { key: 'service', label: 'サービス説明の網羅性', weight: 14, ok: facts.serviceCoverage.length >= 5 && facts.textLength >= 2500, detail: 'メニュー・料金・実績・FAQなど、AI回答の根拠になる情報量があるか' },
    { key: 'trust', label: '信頼情報', weight: 12, ok: facts.hasReview && facts.hasCredibility, detail: '口コミ・レビュー・実績・運営者情報があるか' },
    { key: 'offsite', label: '外部言及・GBP導線', weight: 12, ok: searchSignals.estimatedMentions >= 3 || facts.sameAsSignals.length >= 2, detail: 'GoogleビジネスプロフィールやSNS、ポータル等への言及が確認できるか' },
    { key: 'keyword', label: 'AI検索キーワード適合', weight: 10, ok: keywords.length >= 3 && searchSignals.keywordCoverage >= 0.45, detail: '想定される比較・推薦系キーワードで情報が拾われやすいか' },
  ];
  const score = checks.reduce((sum, check) => sum + (check.ok ? check.weight : Math.round(check.weight * 0.25)), 0);
  return { score: Math.min(100, score), checks };
}

function toolScores(totalScore, facts, searchSignals) {
  const chatgpt = Math.max(0, Math.min(100, totalScore + (facts.textLength > 5000 ? 5 : -4) + (facts.hasFaq ? 4 : -2)));
  const gemini = Math.max(0, Math.min(100, totalScore + (searchSignals.estimatedMentions >= 4 ? 7 : -5) + (facts.sameAsSignals.length ? 3 : 0)));
  const aio = Math.max(0, Math.min(100, totalScore + (facts.schemaTypes.length ? 6 : -6) + (facts.hasReview ? 3 : -3)));
  return {
    chatgpt: { score: chatgpt, status: statusFromScore(chatgpt), reason: '公式サイト本文・FAQ・事業説明から回答根拠を作れる度合い' },
    gemini: { score: gemini, status: statusFromScore(gemini), reason: 'Web上の外部言及、SNS/ポータル、Google系情報との整合性を拾える度合い' },
    aio: { score: aio, status: statusFromScore(aio), reason: 'Google検索のAI Overviewで引用されやすい構造化データ・口コミ・網羅性の度合い' },
  };
}

function statusFromScore(score) {
  if (score >= 80) return '表示可能性が高い';
  if (score >= 60) return '条件付きで表示可能';
  if (score >= 40) return '表示が不安定';
  return '表示されにくい';
}

function missingKeywords(name, facts, keywords) {
  const base = keywords.filter((keyword) => keyword !== name).slice(0, 3);
  const fallback = [
    `${facts.address ? facts.address.slice(0, 8) : '地域名'} ${facts.h1[0] || '業種'} おすすめ`,
    `${facts.h1[0] || 'サービス'} 料金 比較`,
    `${facts.h1[0] || '店舗名'} 口コミ 評判`,
  ];
  return [...new Set([...base, ...fallback])].slice(0, 3);
}

function buildRecommendations(facts, scoreResult, keywords) {
  const recommendations = [];
  if (!facts.address || !facts.phone) recommendations.push('住所・電話番号・営業時間・アクセスを公式サイト内で明確にし、Googleビジネスプロフィールと表記を統一してください。');
  if (!facts.schemaTypes.length) recommendations.push('LocalBusiness / Organization / WebSite / FAQPage のJSON-LD構造化データを追加してください。');
  if (!facts.hasFaq) recommendations.push('「よくある質問」を追加し、料金・予約・キャンセル・対応エリア・選ばれる理由を質問形式で回答してください。');
  if (!facts.hasReview) recommendations.push('口コミ・お客様の声・導入事例を追加し、第三者評価をAIが引用しやすい形にしてください。');
  if (facts.serviceCoverage.length < 5) recommendations.push('メニュー・料金・実績・比較ポイント・利用シーンを各ページで具体的に説明してください。');
  if (facts.sameAsSignals.length < 2) recommendations.push('Googleビジネスプロフィール、Instagram、業界ポータル等へのリンクや表記統一で外部エンティティを強化してください。');
  recommendations.push(`重点キーワードは「${keywords.slice(0, 3).join('」「')}」から着手し、各キーワードに対応する根拠ページを作成してください。`);
  return recommendations.slice(0, 7);
}

async function searchWeb(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const { body, status } = await fetchText(url, { timeout: 12000, limit: 250000, headers: { 'Accept': 'text/html,*/*' } });
    if (status >= 400) return { query, results: [], error: `検索結果取得エラー HTTP ${status}` };
    const results = [];
    const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(body)) !== null && results.length < 5) {
      results.push({ title: stripTags(match[2]), url: decodeHtml(match[1]), snippet: stripTags(match[3]) });
    }
    if (!results.length) {
      const simple = [...body.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 5);
      simple.forEach((m) => results.push({ title: stripTags(m[2]), url: decodeHtml(m[1]), snippet: '' }));
    }
    return { query, results };
  } catch (error) {
    return { query, results: [], error: error.message };
  }
}

app.post('/api/aio-audit', async (req, res) => {
  const name = String(req.body.name || '').trim();
  const normalizedUrl = normalizeUrl(req.body.url);
  const extraKeywords = req.body.keywords || '';
  if (!name && !normalizedUrl) return res.status(400).json({ error: '店舗・会社名またはサイトURLを入力してください。' });

  try {
    let siteHtml = '';
    let finalUrl = normalizedUrl;
    let fetchStatus = null;
    let fetchError = '';
    if (normalizedUrl) {
      try {
        const fetched = await fetchText(normalizedUrl);
        siteHtml = fetched.body;
        finalUrl = fetched.finalUrl;
        fetchStatus = fetched.status;
      } catch (error) {
        fetchError = error.message;
      }
    }

    const facts = siteHtml ? extractBusinessFacts(siteHtml, finalUrl) : {
      url: normalizedUrl || '', title: '', description: '', ogTitle: '', ogDescription: '', canonical: '', h1: [], headings: [], schemaTypes: [], jsonLdCount: 0, hasBrokenJsonLd: false, textLength: 0, phone: '', address: '', sameAsSignals: [], hasFaq: false, hasReview: false, hasPrice: false, hasAccess: false, hasCredibility: false, serviceCoverage: [], snippets: '',
    };

    const displayName = name || facts.title || normalizedUrl;
    const keywords = inferKeywords(displayName, facts, extraKeywords);
    const searchQueries = [
      displayName,
      `${displayName} Google ビジネスプロフィール`,
      ...keywords.filter((keyword) => keyword !== displayName).slice(0, 3),
    ].slice(0, 5);
    const searchResults = await Promise.all(searchQueries.map(searchWeb));
    const flatResults = searchResults.flatMap((item) => item.results || []);
    const host = (() => { try { return new URL(finalUrl || normalizedUrl).hostname.replace(/^www\./, ''); } catch (_) { return ''; } })();
    const estimatedMentions = flatResults.filter((result) => {
      const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
      return (displayName && haystack.includes(displayName.toLowerCase())) || (host && haystack.includes(host));
    }).length;
    const keywordCoverage = keywords.length ? keywords.filter((keyword) => {
      const k = keyword.toLowerCase();
      return flatResults.some((result) => `${result.title} ${result.snippet}`.toLowerCase().includes(k.split(/\s+/)[0]));
    }).length / keywords.length : 0;
    const searchSignals = { estimatedMentions, keywordCoverage, resultCount: flatResults.length };
    const scoreResult = scoreFacts(facts, searchSignals, keywords);
    const tools = toolScores(scoreResult.score, facts, searchSignals);
    const weakKeywords = missingKeywords(displayName, facts, keywords);
    const recommendations = buildRecommendations(facts, scoreResult, keywords);

    const report = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      input: { name: displayName, url: normalizedUrl, keywords: extraKeywords },
      fetch: { status: fetchStatus, error: fetchError, finalUrl },
      score: scoreResult.score,
      status: statusFromScore(scoreResult.score),
      tools,
      facts,
      checks: scoreResult.checks,
      keywords,
      weakKeywords,
      recommendations,
      searchResults,
      notes: [
        '本レポートは公式サイト取得結果と公開検索結果のシグナルを元にしたAIO表示可能性の事前診断です。',
        'ChatGPT/Gemini/AI Overviewの実際の表示は、ユーザー所在地・検索履歴・時期・各AI側のインデックス状況で変動します。',
      ],
    };
    reports.set(report.id, report);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/report/:id', (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'レポートが見つかりません。ブラウザ保存履歴をご確認ください。' });
  res.json(report);
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', version: '4.0-aio-audit' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`AIO Audit app listening on port ${PORT}`));
