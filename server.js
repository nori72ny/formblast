const express = require('express');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const jobs = {};

function normalizeUrl(url) {
  if (!url) return null;
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  try { new URL(url); return url; } catch(e) { return null; }
}

function resolveUrl(base, rel) {
  if (!rel) return base;
  try { return rel.startsWith('http') ? rel : new URL(rel, base).href; } catch(e) { return base; }
}

function fetchPage(url, method, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch(e) { return reject(new Error('無効なURL: ' + url)); }
    const cl = parsed.protocol === 'https:' ? https : http;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method || 'GET',
      headers: Object.assign({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'ja,en;q=0.9',
      }, extraHeaders || {}),
      timeout: 20000,
    };
    const req = cl.request(opts, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        return fetchPage(resolveUrl(url, res.headers.location)).then(resolve).catch(reject);
      }
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ html: d, status: res.statusCode, finalUrl: url }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('タイムアウト')); });
    if (body) req.write(body);
    req.end();
  });
}

function analyzeForm(html, baseUrl) {
  const fields = [];
  const re = /<(input|textarea)([^>]*?)(?:\/>|>)/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[2];
    const type = (a.match(/type=["']([^"']+)["']/i) || [])[1] || 'text';
    if (['hidden','submit','button','reset','image','file'].includes(type)) continue;
    const name  = (a.match(/name=["']([^"']+)["']/i)         || [])[1] || '';
    const id    = (a.match(/id=["']([^"']+)["']/i)           || [])[1] || '';
    const ph    = (a.match(/placeholder=["']([^"']+)["']/i)  || [])[1] || '';
    const label = (a.match(/aria-label=["']([^"']+)["']/i)   || [])[1] || '';
    if (name || id) fields.push({ tag: m[1], type, name, id, ph, label });
  }
  const hidden = [];
  const hre = /<input[^>]*type=["']hidden["'][^>]*>/gi;
  let hm;
  while ((hm = hre.exec(html)) !== null) {
    const hn = (hm[0].match(/name=["']([^"']+)["']/i) || [])[1];
    const hv = (hm[0].match(/value=["']([^"']*?)["']/i) || [])[1] || '';
    if (hn) hidden.push({ name: hn, value: hv });
  }
  const fm = html.match(/<form([^>]*?)>/i);
  const rawAction = fm ? ((fm[1].match(/action=["']([^"']+)["']/i) || [])[1] || '') : '';
  const method    = fm ? ((fm[1].match(/method=["']([^"']+)["']/i) || [])[1] || 'post') : 'post';
  const action    = rawAction ? resolveUrl(baseUrl, rawAction) : baseUrl;
  return { fields, hidden, action, method };
}

function mapFields(fields, info, msg) {
  const mapped = fields.map(f => {
    const k = [f.name, f.id, f.ph, f.label].join(' ').toLowerCase();
    let v = '';
    if      (/name|氏名|名前|お名前|ふりがな|フリガナ|担当/.test(k) && !/company|会社|企業/.test(k)) v = info.name;
    else if (/company|会社|企業|法人|組織|団体/.test(k)) v = info.company;
    else if (/email|mail|メール|e.mail/.test(k)) v = info.email;
    else if (/tel|phone|電話|携帯|fax/.test(k)) v = info.phone;
    else if (/message|content|body|問い合わせ|内容|要望|質問|備考|ご用件|用件|件名|subject|詳細|コメント|comment|text/.test(k)) v = msg;
    return v ? { ...f, value: v } : null;
  }).filter(Boolean);

  // 本文がどのフィールドにもマッピングされなかった場合
  // → textareaがあれば最初のtextareaに本文を入れる
  const msgMapped = mapped.some(f => f.tag === 'textarea' || /message|content|body|問い合わせ|内容|要望|質問|備考|ご用件|用件|件名|subject|詳細/.test([f.name,f.id,f.ph,f.label].join(' ').toLowerCase()));
  if (!msgMapped) {
    const firstTextarea = fields.find(f => f.tag === 'textarea');
    if (firstTextarea && !mapped.find(m => m.name === firstTextarea.name && m.id === firstTextarea.id)) {
      mapped.push({ ...firstTextarea, value: msg, autoFallback: true });
    }
  }
  return mapped;
}

app.post('/api/preview', async (req, res) => {
  const { companies, senderInfo, messageTemplate } = req.body;
  if (!companies?.length) return res.status(400).json({ error: '企業情報がありません' });
  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', previews: [], errors: [] };
  (async () => {
    for (const company of companies) {
      const url = normalizeUrl(company.url);
      if (!url) { jobs[jobId].errors.push({ company: company.name||company.url, error: '無効なURL。https://から始まるURLを入力してください。', needsManual: true, url: company.url }); continue; }
      try {
        const { html, finalUrl } = await fetchPage(url);
        const { fields, action, method } = analyzeForm(html, finalUrl||url);
        const msg = company.msgContent || messageTemplate.content;
        const mapped = mapFields(fields, senderInfo, msg);
        const needsManual = mapped.length === 0 || fields.length === 0;
        jobs[jobId].previews.push({
          companyId: company.id, companyName: company.name || company.url || url, url,
          formAction: action, totalFields: fields.length, mappedFields: mapped,
          fillResults: {
            filled:   mapped.map(f => ({ field: f.name||f.id, value: f.value.substring(0,30)+(f.value.length>30?'…':'') })),
            notFound: fields.filter(f => !mapped.find(m => m.name===f.name&&m.id===f.id)).map(f => f.name||f.id).filter(Boolean),
          },
          status: 'ready', needsManual,
        });
      } catch(err) {
        jobs[jobId].errors.push({ company: company.name||url, error: err.message, url, needsManual: true });
      }
    }
    jobs[jobId].status = 'done';
  })();
  res.json({ jobId });
});

app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(job);
});

app.post('/api/submit', async (req, res) => {
  const { companies, senderInfo, messageTemplate, selectedCompanyIds } = req.body;
  const targets = companies.filter(c => selectedCompanyIds.includes(c.id));
  const results = [];
  for (const company of targets) {
    const url = normalizeUrl(company.url);
    if (!url) { results.push({ companyId: company.id, companyName: company.name, status: 'error', error: '無効なURL', url: company.url }); continue; }
    try {
      const { html, finalUrl } = await fetchPage(url);
      const { fields, hidden, action } = analyzeForm(html, finalUrl||url);
      const msg = company.msgContent || messageTemplate.content;
      const mapped = mapFields(fields, senderInfo, msg);
      if (mapped.length === 0) {
        results.push({ companyId: company.id, companyName: company.name, status: 'manual_required', url, message: '自動入力できるフィールドが見つかりませんでした。手動送信ボタンからブラウザで開いて送信してください。' });
        continue;
      }
      const formData = {};
      hidden.forEach(h => { formData[h.name] = h.value; });
      mapped.forEach(f => { if (f.name) formData[f.name] = f.value; });
      const body = Object.entries(formData).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
      const submitUrl = normalizeUrl(action) || url;
      const origin = (() => { try { return new URL(url).origin; } catch(e) { return ''; } })();
      await fetchPage(submitUrl, 'POST', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body).toString(),
        'Referer': url, 'Origin': origin,
      });
      results.push({ companyId: company.id, companyName: company.name, status: 'submitted' });
    } catch(err) {
      results.push({ companyId: company.id, companyName: company.name, status: 'error', error: err.message, url });
    }
  }
  res.json({ results });
});

// ── 業態自動判定API ──────────────────────────
app.post('/api/detect-pattern', async (req, res) => {
  const { url } = req.body;
  const normalized = normalizeUrl(url);
  if (!normalized) return res.json({ patternId: null });
  try {
    const { html } = await fetchPage(normalized);
    // HTMLのテキストから業態キーワードを判定
    const text = html.replace(/<[^>]+>/g, ' ').toLowerCase();
    const title = (html.match(/<title[^>]*>(.*?)<\/title>/i) || [])[1] || '';
    const meta  = (html.match(/<meta[^>]*description[^>]*content=["']([^"']+)["']/i) || [])[1] || '';
    const combined = (title + ' ' + meta + ' ' + text + ' ' + normalized).toLowerCase();

    let patternId = null;
    // 判定優先順位：チェーン本部 > 居酒屋・宴会 > 高単価 > カフェ
    if (/チェーン|本部|holdings|hd\.jp|group|グループ会社|多店舗|フランチャイズ|franchise/.test(combined)) patternId = 3;
    else if (/居酒屋|izakaya|焼肉|焼き鳥|串焼|炉端|宴会|飲み放題|食べ放題|個室居酒屋/.test(combined)) patternId = 2;
    else if (/フレンチ|イタリアン|スパニッシュ|鉄板焼|割烹|懐石|会席|高級|fine.dining|premium|ソムリエ|シェフ/.test(combined)) patternId = 1;
    else if (/カフェ|cafe|珈琲|コーヒー|coffee|ベーカリー|bakery|パン|スイーツ|ケーキ|パティスリー|ティー|紅茶/.test(combined)) patternId = 0;
    else if (/ラーメン|そば|うどん|寿司|鮨|天ぷら|とんかつ|牛丼|定食|ファミレス|ファミリーレストラン/.test(combined)) patternId = 2; // 一般飲食は居酒屋寄り
    else if (/restaurant|レストラン|dining|ダイニング|bistro|ビストロ/.test(combined)) patternId = 1; // レストラン系は高単価寄り

    res.json({ patternId, detected: patternId !== null });
  } catch(e) {
    res.json({ patternId: null, error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', version: '3.1' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('FormBlast v3 on port ' + PORT));
