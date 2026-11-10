// GAS コンテキスト内で最初に動く準備処理。仮想時計と通信用の補助関数を用意する。
(function () {
  'use strict';
  const env = JSON.parse(__env);
  const RealDate = Date;
  const OFF = env.clockOffset || 0;
  function FakeDate(...a) {
    if (!new.target) return new RealDate(RealDate.now() + OFF).toString();
    return a.length ? new RealDate(...a) : new RealDate(RealDate.now() + OFF);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => RealDate.now() + OFF;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  Object.defineProperty(globalThis, 'Date', { value: FakeDate, writable: true, configurable: true });

  const enc = (v) => JSON.stringify(v, function (k, val) {
    const o = this[k];
    if (o instanceof RealDate) return { $d: o.getTime() };
    return val;
  });
  const dec = (s) => JSON.parse(s, (k, v) => (v && typeof v === 'object' && typeof v.$d === 'number' && Object.keys(v).length === 1 ? new RealDate(v.$d) : v));

  function host(op, args) {
    const r = dec(__hostCall(JSON.stringify({ op, args: JSON.parse(enc(args === undefined ? null : args)) })));
    if (!r.ok) { const e = new Error(r.e.message); e.name = r.e.name === 'Exception' ? 'Exception' : r.e.name; throw e; }
    return r.v;
  }
  function warn(code, message) { __warn(JSON.stringify({ code, message })); }

  Object.defineProperty(globalThis, '__H', { value: Object.freeze({ env, host, warn, enc, dec, RealDate }), enumerable: false });

  const fmtArgs = (args) => args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }).join(' ');
  globalThis.console = {
    log: (...a) => __log(fmtArgs(a)), info: (...a) => __log(`[info] ${fmtArgs(a)}`),
    warn: (...a) => __log(`[warn] ${fmtArgs(a)}`), error: (...a) => __log(`[error] ${fmtArgs(a)}`),
    time() {}, timeEnd() {},
  };
}());
