'use strict';
// 画面（iframe の中）から、操作できる要素と読める文字を取り出す。frame.evaluate で実行される。
// 返す値は「人がその画面で知覚できるもの」の近似。ペルソナの制約（文字の大きさ等）は drive 側で適用する。
function collect() {
  /* eslint-disable no-undef */
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    let e = el;
    while (e && e.nodeType === 1) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
      e = e.parentElement;
    }
    return r;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const nameOf = (el) => {
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return clean(lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent).join(' '));
    if (el.labels && el.labels.length) return clean([...el.labels].map((l) => l.textContent).join(' '));
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.name || '');
    return clean(el.innerText || el.value || el.getAttribute('title') || (el.querySelector('img') && el.querySelector('img').alt) || '');
  };
  document.querySelectorAll('[data-hx]').forEach((e) => e.removeAttribute('data-hx'));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=option],[role=menuitem],[onclick],[tabindex]:not([tabindex="-1"])';
  const els = [];
  let i = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = vis(el);
    if (!r) continue;
    if (el.tagName === 'LABEL') continue;
    const idx = ++i;
    el.setAttribute('data-hx', String(idx));
    const cs = getComputedStyle(el);
    els.push({
      idx, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', name: nameOf(el),
      value: el.tagName === 'SELECT' ? clean(el.selectedOptions[0] ? el.selectedOptions[0].textContent : '') : ['INPUT', 'TEXTAREA'].includes(el.tagName) && el.type !== 'password' ? clean(el.value) : (el.type === 'password' && el.value ? '●'.repeat(Math.min(el.value.length, 8)) : undefined),
      checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked : undefined,
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => clean(o.textContent)) : undefined,
      w: Math.round(r.width), h: Math.round(r.height), fontPx: parseFloat(cs.fontSize),
      inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
      top: Math.round(r.top + scrollY),
    });
  }
  // 読める文字（テキストノード単位。親要素の文字サイズで判定）
  const texts = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = clean(n.textContent);
    if (!t) continue;
    const p = n.parentElement;
    if (!p || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'OPTION'].includes(p.tagName)) continue;
    const r = vis(p);
    if (!r) continue;
    const range = document.createRange(); range.selectNodeContents(n);
    const rr = range.getBoundingClientRect();
    const cs = getComputedStyle(p);
    texts.push({ t, px: parseFloat(cs.fontSize), inView: rr.bottom > 0 && rr.top < innerHeight, top: Math.round(rr.top + scrollY), color: cs.color });
  }
  const de = document.scrollingElement || document.documentElement;
  return {
    title: document.title, elements: els, texts,
    scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, scrollY: Math.round(scrollY), scrollHeight: de.scrollHeight, innerHeight,
    pending: window.__harnessPending || 0,
    alerts: (window.__harnessAlerts || []).slice(),
  };
}

module.exports = { collect };
