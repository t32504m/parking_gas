/* google.script.run / google.script.url / google.script.host の模擬（ブラウザ側）。
 * 実GASと同じく非同期で、成功・失敗ハンドラを通じて結果を返す。
 * 呼べる関数名はサーバー側の公開関数（名前が _ で終わらない最上位関数）に限られる。 */
(function () {
  'use strict';
  var cfg = window.__HARNESS_GSR__ || {};
  var publicFns = cfg.publicFns || [];
  var seq = 0;

  function illegal(v, depth) {
    if (depth > 50) return true;
    if (v === null || v === undefined) return false;
    var t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return false;
    if (t === 'function') return true;
    if (v instanceof Date) return true;
    if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) if (illegal(v[i], depth + 1)) return true; return false; }
    if (typeof HTMLElement !== 'undefined' && v instanceof HTMLElement) return v.tagName !== 'FORM';
    if (t === 'object') { for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k) && illegal(v[k], depth + 1)) return true; }
    return false;
  }
  function formToObject(form) {
    var o = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled) return;
      if ((el.type === 'checkbox' || el.type === 'radio') && !el.checked) return;
      if (o[el.name] !== undefined) o[el.name] = [].concat(o[el.name], el.value); else o[el.name] = el.value;
    });
    return o;
  }

  function makeRunner(success, failure, userObject) {
    var target = {
      withSuccessHandler: function (fn) { return makeRunner(fn, failure, userObject); },
      withFailureHandler: function (fn) { return makeRunner(success, fn, userObject); },
      withUserObject: function (o) { return makeRunner(success, failure, o); },
    };
    return new Proxy(target, {
      get: function (t, name) {
        if (name in t) return t[name];
        if (typeof name !== 'string' || publicFns.indexOf(name) < 0) return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments).map(function (a) {
            return (typeof HTMLFormElement !== 'undefined' && a instanceof HTMLFormElement) ? formToObject(a) : a;
          });
          for (var i = 0; i < args.length; i++) {
            if (illegal(args[i], 0)) throw new Error('Failed due to illegal value in property: ' + i);
          }
          var id = ++seq;
          var t0 = performance.now();
          window.__harnessPending = (window.__harnessPending || 0) + 1;
          var settle = function () { window.__harnessPending--; };
          fetch('/__harness/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
            body: JSON.stringify({ fn: name, args: args, callId: id, page: location.pathname }),
          }).then(function (r) { if (r.status !== 200) throw new Error('dropped'); return r.json(); }).then(function (res) {
            window.__harnessCalls = window.__harnessCalls || [];
            window.__harnessCalls.push({ fn: name, ms: performance.now() - t0, ok: res.ok });
            // ハンドラ内の例外は失敗ハンドラに回さず、画面のエラーとして表に出す（実GASと同じ）
            setTimeout(function () {
              try {
                if (res.ok) { if (success) success(res.value === undefined ? undefined : res.value, userObject); return; }
                var e = new Error(res.error && res.error.message ? res.error.message : 'ScriptError');
                e.name = (res.error && res.error.name) || 'ScriptError';
                if (failure) failure(e, userObject); else console.error(e);
              } finally { settle(); }
            }, 0);
          }, function () {
            setTimeout(function () {
              try {
                var e = new Error('NetworkError: Connection failure due to HTTP 0');
                e.name = 'NetworkError';
                if (failure) failure(e, userObject); else console.error(e);
              } finally { settle(); }
            }, 0);
          });
        };
      },
    });
  }

  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(null, null, undefined),
    url: {
      getLocation: function (cb) {
        var p = cfg.params || {};
        var parameters = {}; Object.keys(p).forEach(function (k) { parameters[k] = [p[k]]; });
        setTimeout(function () { cb({ hash: (location.hash || '').replace(/^#/, ''), parameter: p, parameters: parameters }); }, 0);
      },
    },
    host: {
      close: function () {}, setHeight: function () {}, setWidth: function () {},
      origin: location.origin,
      editor: { focus: function () {} },
    },
    history: {
      push: function (state, params, hash) { history.pushState(state, '', hash ? '#' + hash : location.href); },
      replace: function (state, params, hash) { history.replaceState(state, '', hash ? '#' + hash : location.href); },
      setChangeHandler: function (fn) { window.addEventListener('popstate', function (e) { fn({ state: e.state, location: {} }); }); },
    },
  };
}());
