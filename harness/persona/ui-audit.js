#!/usr/bin/env node
'use strict';
// 画面の自動監査（評価役AIを使わない機械的な検査）。verify から毎回実行される。
// スマホ幅で利用者画面・管理者画面の初期表示を開き、要件8（スマホ対応・表示）に関わる項目を測る。
const fs = require('fs');
const path = require('path');
const { loadPlaywright } = require('../web/pw');
const { startApp } = require('../web/app');
const { collect } = require('./collect');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'reports', 'raw', 'ui-audit.json');
const SHOTS = path.join(ROOT, 'reports', 'screens');

async function contrastIssues(frame) {
  return frame.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] === undefined ? 1 : p[3] }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const bgOf = (el) => { let e = el; while (e && e.nodeType === 1) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.5) return c; e = e.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const out = [];
    const seen = new Set();
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const t = n.textContent.trim(); const p = n.parentElement;
      if (!t || !p || seen.has(p)) continue;
      seen.add(p);
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const fg = parse(cs.color); if (!fg) continue;
      const bg = bgOf(p);
      const L1 = lum(fg); const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const large = parseFloat(cs.fontSize) >= 24 || (parseFloat(cs.fontSize) >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) out.push({ text: t.slice(0, 30), ratio: Math.round(ratio * 100) / 100 });
    }
    return out;
  });
}

async function audit() {
  const pw = loadPlaywright();
  const scenario = JSON.parse(fs.readFileSync(path.join(ROOT, 'personas', 'scenario.json'), 'utf8'));
  const app = await startApp({ scenario, now: scenario.now });
  const browser = await pw.chromium.launch();
  const pages = [
    { id: 'user', url: app.userUrl, user: '' },
    { id: 'admin', url: app.adminUrl, user: app.actors.admin.email },
  ];
  const devices = ['iPhone SE', 'Pixel 7', 'Desktop Chrome'];
  const results = [];
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const pg of pages) {
    for (const dn of devices) {
      const ctx = await browser.newContext({ ...pw.devices[dn], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
      await ctx.addCookies([{ name: 'harness_user', value: pg.user, url: app.web.url }]);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const r = { page: pg.id, device: dn, problems: [], warnings: [] };
      try {
        const resp = await page.goto(pg.url);
        r.status = resp.status();
        await page.waitForTimeout(400);
        const frame = page.frame({ name: 'userHtmlFrame' });
        const viewport = await page.evaluate(() => { const m = document.querySelector('meta[name=viewport]'); return m ? m.content : null; });
        if (!viewport) r.problems.push('外側のページに viewport の meta が無い（doGet で addMetaTag("viewport", ...) が必要）。スマホで縮小表示になる');
        if (r.status !== 200 || !frame) { r.problems.push(`画面が開けない（HTTP ${r.status}）`); }
        else {
          for (let i = 0; i < 30; i++) { if (!(await frame.evaluate(() => window.__harnessPending || 0))) break; await page.waitForTimeout(100); }
          const o = await frame.evaluate(collect);
          r.elements = o.elements.length;
          if (o.scrollWidth > o.clientWidth + 1) r.problems.push(`横スクロールが発生（内容幅 ${o.scrollWidth}px > 画面幅 ${o.clientWidth}px）`);
          const tiny = o.texts.filter((t) => t.px < 12);
          if (tiny.length) r.problems.push(`12px 未満の文字: ${tiny.slice(0, 5).map((t) => `「${t.t.slice(0, 15)}」${t.px}px`).join(' ')}`);
          const small16 = o.texts.filter((t) => t.px >= 12 && t.px < 16);
          if (small16.length) r.warnings.push(`16px 未満の文字（高齢の利用者には読みにくい）: ${small16.length} 箇所`);
          const smallTargets = o.elements.filter((e) => !e.disabled && e.tag !== 'a' && (e.w < 44 || e.h < 44));
          if (smallTargets.length) r.problems.push(`44px 未満の押しにくい部品: ${smallTargets.slice(0, 6).map((e) => `「${e.name || e.tag}」${e.w}x${e.h}`).join(' ')}`);
          const unnamed = o.elements.filter((e) => !e.name);
          if (unnamed.length) r.problems.push(`名前（ラベル）の無い操作部品: ${unnamed.length} 個（読み上げや説明で特定できない）`);
          const low = await contrastIssues(frame);
          if (low.length) r.problems.push(`文字と背景のコントラスト不足: ${low.slice(0, 4).map((x) => `「${x.text}」${x.ratio}`).join(' ')}`);
        }
        if (errors.length) r.problems.push(`JavaScriptエラー: ${errors.slice(0, 2).join(' / ')}`);
        const shot = path.join(SHOTS, `${pg.id}__${dn.replace(/\s+/g, '-')}.png`);
        await page.screenshot({ path: shot, fullPage: false });
        r.screenshot = path.relative(ROOT, shot);
      } catch (e) {
        r.problems.push(`監査中のエラー: ${e.message.split('\n')[0]}`);
      }
      r.pass = r.problems.length === 0;
      results.push(r);
      await ctx.close();
    }
  }
  await browser.close();
  await app.close();
  const out = { at: new Date().toISOString(), pass: results.every((r) => r.pass), results };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  audit().then((r) => {
    for (const x of r.results) {
      console.log(`${x.pass ? 'OK  ' : 'FAIL'} ${x.page} @ ${x.device}  ${x.screenshot || ''}`);
      for (const p of x.problems) console.log(`     - ${p}`);
      for (const w of x.warnings) console.log(`     (注意) ${w}`);
    }
    process.exit(r.pass ? 0 : 1);
  }).catch((e) => { console.error(`ui-audit: 実行できなかった: ${e.message}`); fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ pass: false, error: e.message, results: [] }, null, 2)); process.exit(1); });
}

module.exports = { audit };
