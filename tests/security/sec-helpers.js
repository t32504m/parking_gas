'use strict';
// 侵入試験（docs/PENTEST.md）の共通部品。tests/helpers.js（封印）を使い、変えない。
const H = require('../helpers');

const R = H.ACTORS.residents;
const ADMIN = H.ACTORS.admin;

/** google.script.run と同じ経路で呼ぶ（user が null なら未ログインの人） */
function call(env, fn, args, user = null) {
  return env.host.run(fn, args, { kind: 'client', user });
}
/** 値だけ（例外で落ちたときは { status: 'THROWN' }） */
async function v(env, fn, args, user = null) {
  const r = await call(env, fn, args, user);
  return r.ok ? r.value : { status: r.denied ? 'ACCESS_DENIED' : 'THROWN', error: r.error };
}
const adminAuth = (a = ADMIN) => ({ email: a.email, secret: a.secret });

/** 台帳・スクリプトプロパティ・トリガー・送ったメールの写し（変化したかを見る） */
function snapshot(host, except = []) {
  const out = [];
  for (const b of host.store.books.values()) {
    for (const s of b.sheets) if (!except.includes(s.name)) out.push(`${s.name}\n${host.store.toCsv(b.id, s.sheetId)}`);
  }
  return out.join('\n---\n') + JSON.stringify([...host.props.script]) + host.triggers.length + '|' + host.outbox.length;
}

/** 台帳の全てのセルのうち、数式になっているもの */
function formulaCells(host) {
  const hits = [];
  for (const b of host.store.books.values()) {
    for (const s of b.sheets) {
      s.rows.forEach((row, i) => (row || []).forEach((cell, j) => { if (cell && cell.f) hits.push(`${s.name}!R${i + 1}C${j + 1}=${cell.f}`); }));
    }
  }
  return hits;
}

/** 応答に出てはいけない内部の情報（スタック・ファイル名・ID・秘密） */
function internalLeaks(env, obj) {
  const s = JSON.stringify(obj ?? null);
  const needles = ['stack', '.gs:', 'at Object', 'Exception', 'TypeError', 'ReferenceError', 'SPREADSHEET_ID', 'ADMINS', env.spreadsheetId, 'salt', 'hash'];
  const props = JSON.parse(env.host.getScriptProperty('ADMINS') || '{}');
  for (const a of Object.values(props)) needles.push(a.salt, a.hash);
  return needles.filter((n) => n && s.includes(n));
}

/** 個人情報（住民12人・管理者2人） */
function allPii() {
  return H.piiOf(R).concat([ADMIN.email, ADMIN.secret, H.ACTORS.admin2.email, H.ACTORS.admin2.secret]);
}

/** 1回の実行で、ハッシュ（Utilities.computeDigest）を計算した回数 */
const digests = (r) => (r.metrics && r.metrics.ops && r.metrics.ops['util.digest']) || 0;

module.exports = { H, R, ADMIN, call, v, adminAuth, snapshot, formulaCells, internalLeaks, allPii, digests };
