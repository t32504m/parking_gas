'use strict';
// タイムゾーン補助（ホスト側）。Intl を使い、任意のIANAタイムゾーンで壁時計時刻 ⇔ UTC を変換する。
const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return dtfCache.get(tz);
}

function partsInTz(utcMs, tz) {
  const o = {};
  for (const p of dtf(tz).formatToParts(new Date(utcMs))) o[p.type] = p.value;
  return {
    y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second,
    ms: ((utcMs % 1000) + 1000) % 1000, wd: o.weekday,
  };
}

function offsetMs(tz, utcMs) {
  const p = partsInTz(utcMs, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - (utcMs - (((utcMs % 1000) + 1000) % 1000));
}

function zonedToUtc(tz, y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = offsetMs(tz, guess);
  let t = guess - off;
  const off2 = offsetMs(tz, t);
  if (off2 !== off) t = guess - off2;
  return t;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function formatYmd(utcMs, tz) {
  const p = partsInTz(utcMs, tz);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}

module.exports = { partsInTz, offsetMs, zonedToUtc, formatYmd, pad };
