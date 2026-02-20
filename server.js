const express = require('express');
const { chromium } = require('playwright-core');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

const screenshotDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

const jobs = {};

// Render環境でのChromiumパス取得
function getChromiumPath() {
  // Render / Linux 環境
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // playwright-core のバンドル版にフォールバック
  return undefined;
}

async function launchBrowser() {
  const executablePath = getChromiumPath();
  return chromium.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
}

// ── フォーム自動入力 ──────────────────────────
async function detectAndFillForm(page, formData) {
  const { name, company, email, phone, message } = formData;

  const fieldPatterns = {
    name: [
      'input[name*="name" i]', 'input[name*="氏名"]', 'input[name*="名前"]',
      'input[placeholder*="名前"]', 'input[placeholder*="氏名"]',
      'input[placeholder*="name" i]', 'input[id*="name" i]',
      '#name', '#contact_name',
    ],
    company: [
      'input[name*="company" i]', 'input[name*="会社"]', 'input[name*="企業"]',
      'input[placeholder*="会社"]', 'input[placeholder*="company" i]',
      'input[id*="company" i]', '#company', '#organization',
    ],
    email: [
      'input[type="email"]', 'input[name*="email" i]', 'input[name*="mail" i]',
      'input[placeholder*="メール"]', 'input[placeholder*="email" i]',
      'input[id*="email" i]', '#email',
    ],
    phone: [
      'input[type="tel"]', 'input[name*="tel" i]', 'input[name*="phone" i]',
      'input[name*="電話"]', 'input[placeholder*="電話"]',
      'input[id*="tel" i]', 'input[id*="phone" i]',
    ],
    message: [
      'textarea[name*="message" i]', 'textarea[name*="content" i]',
      'textarea[name*="お問い合わせ"]', 'textarea[name*="内容"]',
      'textarea[placeholder*="お問い合わせ"]', 'textarea[placeholder*="内容"]',
      'textarea[id*="message" i]', 'textarea',
    ],
  };

  const results = { filled: [], notFound: [] };

  async function tryFill(fieldName, value, selectors) {
    if (!value) return;
    for (const sel of selectors) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          await el.click();
          await el.fill(value);
          results.filled.push({ field: fieldName, selector: sel });
          return;
        }
      } catch (_) {}
    }
    results.notFound.push(fieldName);
  }

  await tryFill('お名前',       name,    fieldPatterns.name);
  await tryFill('会社名',       company, fieldPatterns.company);
  await tryFill('メールアドレス', email,   fieldPatterns.email);
  await tryFill('電話番号',     phone,   fieldPatterns.phone);
  await tryFill('お問い合わせ内容', message, fieldPatterns.message);

  return results;
}

// ── API: プレビュー取得 ───────────────────────
app.post('/api/preview', async (req, res) => {
  const { companies, senderInfo, messageTemplate } = req.body;
  if (!companies?.length) return res.status(400).json({ error: '企業情報がありません' });

  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', previews: [], errors: [] };

  ;(async () => {
    const browser = await launchBrowser();

    for (const company of companies) {
      if (!company.url?.startsWith('http')) {
        jobs[jobId].errors.push({ company: company.name, error: '無効なURLです' });
        continue;
      }
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      try {
        await page.goto(company.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);

        const fillResults = await detectAndFillForm(page, {
          name:    senderInfo.name,
          company: senderInfo.company,
          email:   senderInfo.email,
          phone:   senderInfo.phone,
          message: messageTemplate.content,
        });

        const screenshotPath = path.join(screenshotDir, `${jobId}_${company.id}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        jobs[jobId].previews.push({
          companyId:     company.id,
          companyName:   company.name,
          url:           company.url,
          screenshotUrl: `/screenshots/${jobId}_${company.id}.png`,
          fillResults,
          status: 'ready',
        });
      } catch (err) {
        jobs[jobId].errors.push({ company: company.name, error: err.message });
      } finally {
        await context.close();
      }
    }

    await browser.close();
    jobs[jobId].status = 'done';
  })().catch(err => {
    jobs[jobId].status = 'error';
    jobs[jobId].fatalError = err.message;
  });

  res.json({ jobId });
});

// ── API: ジョブ確認 ───────────────────────────
app.get('/api/job/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
  res.json(job);
});

// ── API: 送信実行 ─────────────────────────────
app.post('/api/submit', async (req, res) => {
  const { companies, senderInfo, messageTemplate, selectedCompanyIds } = req.body;
  const targets = companies.filter(c => selectedCompanyIds.includes(c.id));
  const results = [];

  const browser = await launchBrowser();

  for (const company of targets) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    try {
      await page.goto(company.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);

      await detectAndFillForm(page, {
        name:    senderInfo.name,
        company: senderInfo.company,
        email:   senderInfo.email,
        phone:   senderInfo.phone,
        message: messageTemplate.content,
      });

      const submitSelectors = [
        'button[type="submit"]', 'input[type="submit"]',
        'button:has-text("送信")', 'button:has-text("確認")',
        'input[value*="送信"]', 'input[value*="確認"]',
        '.submit-btn', '#submit',
      ];

      let submitted = false;
      for (const sel of submitSelectors) {
        try {
          const btn = await page.$(sel);
          if (btn && await btn.isVisible()) {
            await btn.click();
            await page.waitForTimeout(3000);
            submitted = true;
            const sp = path.join(screenshotDir, `submit_${company.id}_${Date.now()}.png`);
            await page.screenshot({ path: sp });
            results.push({
              companyId:    company.id,
              companyName:  company.name,
              status:       'submitted',
              screenshotUrl: `/screenshots/${path.basename(sp)}`,
            });
            break;
          }
        } catch (_) {}
      }

      if (!submitted) {
        results.push({
          companyId:   company.id,
          companyName: company.name,
          status:      'no_submit_button',
          message:     '送信ボタンが見つかりませんでした。手動で送信してください。',
        });
      }
    } catch (err) {
      results.push({ companyId: company.id, companyName: company.name, status: 'error', error: err.message });
    } finally {
      await context.close();
    }
  }

  await browser.close();
  res.json({ results });
});

// ── ヘルスチェック ────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok' }));

// ── SPA フォールバック ─────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`🚀 FormBlast起動: http://localhost:${PORT}`));
