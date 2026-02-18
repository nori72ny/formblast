const express = require(‘express’);
const https = require(‘https’);
const http = require(‘http’);
const { v4: uuidv4 } = require(‘uuid’);
const path = require(‘path’);

const app = express();
const PORT = process.env.PORT || 3001;
app.use(express.json());
app.use(express.static(path.join(__dirname, ‘public’)));

const jobs = {};

function fetchPage(url) {
return new Promise((resolve, reject) => {
const client = url.startsWith(‘https’) ? https : http;
client.get(url, {
headers: { ‘User-Agent’: ‘Mozilla/5.0 Chrome/120.0.0.0’ },
timeout: 15000,
}, (res) => {
if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
return fetchPage(res.headers.location).then(resolve).catch(reject);
}
let data = ‘’;
res.on(‘data’, (c) => { data += c; });
res.on(‘end’, () => resolve({ html: data, status: res.statusCode }));
}).on(‘error’, reject).on(‘timeout’, () => reject(new Error(‘timeout’)));
});
}

function analyzeForm(html) {
const fields = [];
const re = /<(input|textarea)([^>]*?)>/gi;
let m;
while ((m = re.exec(html)) !== null) {
const a = m[2];
const type = (a.match(/type=[”’]([^"']+)[”’]/i) || [])[1] || ‘text’;
if ([‘hidden’,‘submit’,‘button’,‘reset’,‘image’,‘checkbox’,‘radio’].includes(type)) continue;
const name = (a.match(/name=[”’]([^"']+)[”’]/i) || [])[1] || ‘’;
const id = (a.match(/id=[”’]([^"']+)[”’]/i) || [])[1] || ‘’;
const ph = (a.match(/placeholder=[”’]([^"']+)[”’]/i) || [])[1] || ‘’;
if (name || id) fields.push({ tag: m[1], type, name, id, ph });
}
const fm = html.match(/<form([^>]*?)>/i);
const action = fm ? ((fm[1].match(/action=[”’]([^"']+)[”’]/i) || [])[1] || ‘’) : ‘’;
const method = fm ? ((fm[1].match(/method=[”’]([^"']+)[”’]/i) || [])[1] || ‘post’) : ‘post’;
return { fields, action, method };
}

function mapFields(fields, info, msg) {
return fields.map((f) => {
const k = (f.name + ’ ’ + f.id + ’ ’ + f.ph).toLowerCase();
let value = ‘’;
if (/name|氏名|名前|お名前/.test(k) && !/company|会社|企業/.test(k)) value = info.name;
else if (/company|会社|企業|法人/.test(k)) value = info.company;
else if (/email|mail|メール/.test(k)) value = info.email;
else if (/tel|phone|電話/.test(k)) value = info.phone;
else if (/message|content|body|問い合わせ|内容|要望/.test(k)) value = msg;
return value ? { …f, value } : null;
}).filter(Boolean);
}

app.post(’/api/preview’, async (req, res) => {
const { companies, senderInfo, messageTemplate } = req.body;
if (!companies || !companies.length) return res.status(400).json({ error: ‘企業情報がありません’ });
const jobId = uuidv4();
jobs[jobId] = { status: ‘processing’, previews: [], errors: [] };
(async () => {
for (const company of companies) {
if (!company.url || !company.url.startsWith(‘http’)) {
jobs[jobId].errors.push({ company: company.name, error: ‘無効なURL’ });
continue;
}
try {
const { html } = await fetchPage(company.url);
const { fields, action, method } = analyzeForm(html);
const mapped = mapFields(fields, senderInfo, messageTemplate.content);
jobs[jobId].previews.push({
companyId: company.id,
companyName: company.name,
url: company.url,
formAction: action,
formMethod: method,
mappedFields: mapped,
fillResults: {
filled: mapped.map((f) => ({ field: f.name || f.id, value: f.value })),
notFound: fields.filter((f) => !mapped.find((m) => m.name === f.name)).map((f) => f.name || f.id),
},
status: ‘ready’,
});
} catch (err) {
jobs[jobId].errors.push({ company: company.name, error: err.message });
}
}
jobs[jobId].status = ‘done’;
})();
res.json({ jobId });
});

app.get(’/api/job/:id’, (req, res) => {
const job = jobs[req.params.id];
if (!job) return res.status(404).json({ error: ‘not found’ });
res.json(job);
});

app.post(’/api/submit’, async (req, res) => {
const { companies, senderInfo, messageTemplate, selectedCompanyIds } = req.body;
const targets = companies.filter((c) => selectedCompanyIds.includes(c.id));
const results = [];
for (const company of targets) {
try {
const { html } = await fetchPage(company.url);
const { fields, action } = analyzeForm(html);
const mapped = mapFields(fields, senderInfo, messageTemplate.content);
if (!mapped.length) {
results.push({ companyId: company.id, companyName: company.name, status: ‘no_fields’, message: ‘フィールド未検出’ });
continue;
}
const formData = {};
mapped.forEach((f) => { if (f.name) formData[f.name] = f.value; });
const hiddenRe = /<input[^>]*type=[”’]hidden[”’][^>]*>/gi;
let hm;
while ((hm = hiddenRe.exec(html)) !== null) {
const hn = (hm[0].match(/name=[”’]([^"']+)[”’]/i) || [])[1];
const hv = (hm[0].match(/value=[”’]([^"']*?)[”’]/i) || [])[1] || ‘’;
if (hn) formData[hn] = hv;
}
const body = Object.entries(formData).map(([k, v]) => encodeURIComponent(k) + ‘=’ + encodeURIComponent(v)).join(’&’);
let submitUrl = action || company.url;
if (submitUrl.startsWith(’/’)) {
const base = new URL(company.url);
submitUrl = base.protocol + ‘//’ + base.host + submitUrl;
}
const parsed = new URL(submitUrl);
const client = parsed.protocol === ‘https:’ ? https : http;
await new Promise((resolve, reject) => {
const r = client.request({
hostname: parsed.hostname,
port: parsed.port,
path: parsed.pathname + parsed.search,
method: ‘POST’,
headers: {
‘Content-Type’: ‘application/x-www-form-urlencoded’,
‘Content-Length’: Buffer.byteLength(body),
‘User-Agent’: ‘Mozilla/5.0 Chrome/120.0.0.0’,
‘Referer’: company.url,
},
}, (r2) => { r2.resume(); resolve(r2.statusCode); });
r.on(‘error’, reject);
r.write(body);
r.end();
});
results.push({ companyId: company.id, companyName: company.name, status: ‘submitted’ });
} catch (err) {
results.push({ companyId: company.id, companyName: company.name, status: ‘error’, error: err.message });
}
}
res.json({ results });
});

app.get(’/api/health’, (*, res) => res.json({ status: ‘ok’ }));
app.get(’*’, (*, res) => res.sendFile(path.join(__dirname, ‘public’, ‘index.html’)));
app.listen(PORT, () => console.log(’FormBlast started on port ’ + PORT));
