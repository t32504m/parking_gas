'use strict';
// node:test の結果を JSON 行で書き出すレポーター。
// 使い方: node --test --test-reporter=./harness/report/json-reporter.js --test-reporter-destination=out.jsonl ...
module.exports = async function* jsonReporter(source) {
  for await (const ev of source) {
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue;
    const d = ev.data;
    if (d.details && d.details.type === 'suite') continue;
    if (d.nesting > 0) continue;
    const err = d.details && d.details.error;
    let message = null;
    if (err) {
      const c = err.cause || err;
      message = String((c && c.message) || err.message || err).split('\n').slice(0, 25).join('\n');
    }
    yield `${JSON.stringify({
      name: d.name, file: d.file, status: ev.type === 'test:pass' ? (d.skip ? 'skip' : (d.todo ? 'todo' : 'pass')) : 'fail',
      skipReason: typeof d.skip === 'string' ? d.skip : undefined, ms: d.details ? Math.round(d.details.duration_ms) : null, message,
    })}\n`;
  }
};
