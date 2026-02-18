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

// フォームページのHTMLを取得してフィールドを解析
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en;q=0.9',
      },
      timeout: 15000,
    }, (res) => {
      // リダイレクト処理
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, finalUrl: url, status: res.statusCode }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('タイムアウト')); });
  });
}

// HTMLからフォームフィールドを解析
function analyzeForm(html, url) {
  const fields = [];
  
  // inputタグを解析
  const inputRegex = /<input([^>]*?)>/gi;
  let match;
  while ((match = inputRegex.exec(html)) !== null) {
    const attrs = match[1];
    const type = (attrs.match(/type=["']([^"']+)["']/i) || [])[1] || 'text';
    const name = (attrs.match(/name=["']([^"']+)["']/i) || [])[1] || '';
    const id = (attrs.match(/id=["']([^"']+)["']/i) || [])[1] || '';
    const placeholder = (attrs.match(/placeholder=["']([^"']+)["']/i) || [])[1] || '';
    
    if (!['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio'].includes(type) && (name || id)) {
      fields.push({ tag: 'input', type, name, id, placeholder });
    }
  }
  
  // textareaタグを解析
  const textareaRegex = /<textarea([^>]*?)>/gi;
  while ((match = textareaRegex.exec(html)) !== null) {
    const attrs = match[1];
    const name = (attrs.match(/name=["']([^"']+)["']/i) || [])[1] || '';
    const id =​​​​​​​​​​​​​​​​
