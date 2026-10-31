(function () {
  function BridgeWS(url) {
    var self = this;
    this.url = String(url);
    this.readyState = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    var m = /[?&]token=([^&]+)/.exec(this.url);
    var token = m ? decodeURIComponent(m[1]) : '';
    if (!token) { try { token = localStorage.getItem('pi-web-ui:token') || ''; } catch (e) {} }
    this._token = token;
    this.sid = 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this._stop = false;
    this._loop();
    setTimeout(function () {
      if (self._stop) return;
      self.readyState = 1;
      if (self.onopen) { try { self.onopen({}); } catch (e) {} }
    }, 40);
  }
  BridgeWS.prototype._loop = function () {
    var self = this;
    if (this._stop) return;
    var url = '/bridge/poll?sid=' + encodeURIComponent(this.sid) + '&token=' + encodeURIComponent(this._token);
    fetch(url, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 502) { self._dead(); return null; }
        return r.ok ? r.text() : '';
      })
      .then(function (txt) {
        if (self._stop || txt === null) return;
        if (txt) {
          var lines = txt.split('\n');
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (!line) continue;
            self.readyState = 1;
            if (self.onmessage) { try { self.onmessage({ data: line, type: 'message', target: self }); } catch (e) {} }
          }
        }
        setTimeout(function () { self._loop(); }, 80);
      })
      .catch(function () { setTimeout(function () { self._loop(); }, 1500); });
  };
  BridgeWS.prototype._dead = function () {
    var self = this;
    this.readyState = 3;
    this._stop = true;
    try { this._es && this._es.close(); } catch (e) {}
    fetch('/bridge/close?sid=' + encodeURIComponent(this.sid) + '&token=' + encodeURIComponent(this._token), { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    if (this.onclose) { try { this.onclose({ code: 1006, reason: 'backend gone' }); } catch (e) {} }
  };
  BridgeWS.prototype.send = function (data) {
    var self = this;
    fetch('/bridge/send?sid=' + encodeURIComponent(this.sid) + '&token=' + encodeURIComponent(this._token), {
      method: 'POST', body: data, headers: { 'content-type': 'text/plain;charset=utf-8' }, credentials: 'same-origin', keepalive: true
    }).catch(function () { if (self.onerror) { try { self.onerror({}); } catch (e) {} } });
  };
  BridgeWS.prototype.close = function () {
    this.readyState = 3;
    this._stop = true;
    fetch('/bridge/close?sid=' + encodeURIComponent(this.sid) + '&token=' + encodeURIComponent(this._token), { method: 'POST', credentials: 'same-origin' }).catch(function () {});
    if (this.onclose) { try { this.onclose({ code: 1000, reason: '' }); } catch (e) {} }
  };
  BridgeWS.CONNECTING = 0; BridgeWS.OPEN = 1; BridgeWS.CLOSING = 2; BridgeWS.CLOSED = 3;
  window.WebSocket = BridgeWS;
  window.__PI_BRIDGE__ = true;
})();
