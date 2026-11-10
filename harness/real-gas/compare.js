#!/usr/bin/env node
'use strict';
// 実環境プローブの結果と、同じプローブをエミュレータで動かした結果を突き合わせる。
//   node harness/real-gas/compare.js results/editor.json [results/web-a-other.json ...]
// 一致しない項目は、エミュレータ（harness/emulator）か ASSUMPTIONS.md を直す必要がある。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GasHost } = require('../emulator/host');

async function emulate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
  fs.copyFileSync(path.join(__dirname, 'FaithfulnessProbe.gs'), path.join(dir, 'Probe.gs'));
  fs.copyFileSync(path.join(__dirname, 'ProbePage.html'), path.join(dir, 'ProbePage.html'));
  fs.writeFileSync(path.join(dir, 'appsscript.json'), JSON.stringify({ timeZone: 'Asia/Tokyo', runtimeVersion: 'V8' }));
  const out = {};
  const h = new GasHost({ projectDir: dir, now: new Date().toISOString() });
  const r = await h.run('probe_runAll', [], { kind: 'editor' });
  out.editor = r.ok ? r.value : { error: r.error };
  for (const [name, dep, user] of [['web-a-owner', { executeAs: 'USER_DEPLOYING', access: 'ANYONE' }, 'owner@example.com'], ['web-a-other', { executeAs: 'USER_DEPLOYING', access: 'ANYONE' }, 'other@gmail.com'], ['web-b-other', { executeAs: 'USER_ACCESSING', access: 'ANYONE' }, 'other@gmail.com']]) {
    const hw = new GasHost({ projectDir: dir, deployment: dep });
    const who = await hw.run('probe_whoami', [], { kind: 'client', user });
    const rd = await hw.run('probe_returnDate', [], { kind: 'client', user });
    out[name] = { whoami: who.value, returnDate: rd.value };
    await hw.close();
  }
  await h.close();
  return out;
}

const norm = (v) => JSON.stringify(v);
(async () => {
  const files = process.argv.slice(2);
  const emu = await emulate();
  if (!files.length) { console.log('エミュレータでのプローブ結果（実環境の結果と比べる対象）:'); console.log(JSON.stringify(emu, null, 2)); return; }
  let bad = 0;
  for (const f of files) {
    const real = JSON.parse(fs.readFileSync(f, 'utf8'));
    const base = path.basename(f, '.json');
    console.log(`\n== ${base} (${real.kind})`);
    if (real.kind === 'editor') {
      for (const [k, v] of Object.entries(real.results)) {
        const e = emu.editor.results ? emu.editor.results[k] : undefined;
        if (k === 'mailQuota' || k === 'newDateYmd') { console.log(`  参考 ${k}: 実環境=${norm(v)}`); continue; }
        const same = norm(v) === norm(e);
        if (!same) bad++;
        console.log(`  ${same ? '一致' : '★不一致'} ${k}\n      実環境:     ${norm(v)}\n      エミュレータ: ${norm(e)}`);
      }
      console.log('  所要時間（ms・中央値）→ harness/emulator/cost-model.json に反映する:');
      for (const [k, v] of Object.entries(real.timings || {})) console.log(`      ${k}: ${v}`);
    } else if (real.kind === 'web') {
      const e = emu[base];
      if (!e) { console.log(`  比較対象なし（ファイル名を web-a-owner / web-a-other / web-b-other にする）`); continue; }
      const pairs = [['whoami.active', real.results.whoami && real.results.whoami.active, e.whoami && e.whoami.active], ['returnDate', real.results.returnDate, e.returnDate], ['privateVisible', real.results.privateVisible, 'undefined']];
      for (const [k, rv, ev] of pairs) { const same = norm(rv) === norm(ev); if (!same) bad++; console.log(`  ${same ? '一致' : '★不一致'} ${k}: 実環境=${norm(rv)} エミュレータ=${norm(ev)}`); }
      console.log(`  参考: 画面幅 ${real.innerWidth}px（addMetaTag ${real.withMeta ? 'あり' : 'なし'}）、google.script.run 往復の中央値 ${real.results.roundTripMedianMs}ms → cost-model.json の clientCallOverheadMs に反映`);
    } else if (real.kind === 'trigger') {
      console.log(`  トリガーから末尾 _ の関数を実行できた: ${real.privateHandlerRan}（エミュレータは できる と仮定）`);
      if (!real.privateHandlerRan) bad++;
      console.log(`  トリガー内の activeUser: ${real.detail && real.detail.activeUser}（エミュレータは所有者のメールと仮定）`);
      console.log(`  実行後に残ったトリガー: ${norm(real.remainingTriggers)}（エミュレータは after トリガーは実行後に消えると仮定）`);
    }
  }
  console.log(`\n不一致 ${bad} 件。不一致があれば ASSUMPTIONS.md とエミュレータを直し、harness:seal し直すこと（人の確認のうえで）。`);
})();
