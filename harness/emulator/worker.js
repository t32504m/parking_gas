'use strict';
// 1回の GAS 実行を担当するスレッド。
// 利用者のコードは vm コンテキスト（GAS と同様に setTimeout / require / process 等が無い世界）で動く。
const { workerData, parentPort } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const { sab, barrier, fn, kind, argsJson, sources, html, clockOffset, maxExecutionMs, env } = workerData;
const ctrl = new Int32Array(sab, 0, 4);
const buf = new Uint8Array(sab, 16);
const sleepArr = new Int32Array(new SharedArrayBuffer(4));
const decoder = new TextDecoder();

function hostCall(reqJson) {
  const req = JSON.parse(reqJson);
  Atomics.store(ctrl, 0, 0);
  parentPort.postMessage({ t: 'call', op: req.op, args: JSON.stringify(req.args === undefined ? null : req.args) });
  let out = '';
  for (;;) {
    Atomics.wait(ctrl, 0, 0);
    const n = Atomics.load(ctrl, 1);
    const more = Atomics.load(ctrl, 2);
    out += decoder.decode(buf.slice(0, n), { stream: more === 1 });
    Atomics.store(ctrl, 0, 0);
    if (!more) break;
    parentPort.postMessage({ t: 'more' });
  }
  return out;
}

const context = vm.createContext({
  __hostCall: hostCall,
  __log: (line) => parentPort.postMessage({ t: 'log', line: String(line) }),
  __warn: (w) => parentPort.postMessage({ t: 'warn', w: JSON.parse(w) }),
  __sleep: (ms) => { Atomics.wait(sleepArr, 0, 0, Math.max(0, Math.min(ms, 300000))); },
  __env: JSON.stringify({ ...env, clockOffset, html, fn, kind }),
}, { name: 'gas', codeGeneration: { strings: true, wasm: false } });

function runFile(file, code) {
  new vm.Script(code, { filename: file }).runInContext(context, { timeout: maxExecutionMs });
}

let loadError = null;
try {
  for (const f of ['prelude.js', 'services.js']) runFile(`[harness]/${f}`, fs.readFileSync(path.join(__dirname, 'context', f), 'utf8'));
  for (const s of sources) runFile(s.name, s.code);
} catch (e) {
  loadError = { name: e.name || 'Error', message: `(読み込み時) ${e.message}`, stack: String(e.stack || '').split('\n').slice(0, 6).join('\n') };
}

parentPort.postMessage({ t: 'ready' });
if (barrier) Atomics.wait(ctrl, 3, 0);

let res;
if (loadError) res = { ok: false, error: loadError };
else {
  try {
    context.__argsJson = argsJson;
    const out = new vm.Script('__invoke()', { filename: '[harness]/invoke' }).runInContext(context, { timeout: maxExecutionMs });
    res = JSON.parse(out);
  } catch (e) {
    const timeout = /Script execution timed out/.test(e.message);
    res = { ok: false, error: { name: timeout ? 'Timeout' : (e.name || 'Error'), message: timeout ? 'Exceeded maximum execution time' : e.message, stack: String(e.stack || '').split('\n').slice(0, 8).join('\n') } };
  }
}
parentPort.postMessage({ t: 'done', res });
