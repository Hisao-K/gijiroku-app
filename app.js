// gijiroku-appアプリ（PWA）。
// 画面だけを受け持ち、データの出し入れはすべて各社のGAS（AppApi）に任せる。
// 議事録のデータはこの端末にもこのサイトにも保存しない（端末に覚えるのはGASのURLとログイン中のトークンだけ）。
(function () {
  'use strict';

  var CONFIG = window.GIJIROKU_CONFIG || {};
  var API_URL_STORE = 'gijiroku.api';
  var TOKEN_KEY = 'gijiroku.idt';
  var GAS_URL_RE = /^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[A-Za-z0-9_-]+\/exec$/;
  var IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  var POLL_MS = 20000;
  var CHUNK_TRIES = 5;

  var state = {
    apiUrl: '',
    idToken: '',
    tab: 'upload',
    file: null,          // 選んだ音声ファイル
    durationSec: 0,      // 音声から読んだ長さ（読めなければ 0）
    uploading: false,
    lastMeetingId: '',
    meeting: null,       // 詳細で開いている会議
    todos: [],
    pollTimer: 0,
    tokenWaiters: [],
    inboxUrl: '',
    session: 0,          // ログインのたびに増やす。終えたログインの応答は画面に出さない
  };

  // =========================
  //  小物
  // =========================
  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') node.textContent = attrs[k];
      else if (k === 'class') node.className = attrs[k];
      else if (k === 'onclick') node.addEventListener('click', attrs[k]);
      else node.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function storageGet(key) { try { return localStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function storageSet(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* 保存できなくても動かす */ } }
  function sessionGet(key) { try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; } }
  function sessionSet(key, v) { try { v ? sessionStorage.setItem(key, v) : sessionStorage.removeItem(key); } catch (e) { /* 同上 */ } }

  function msg(id, text, kind) {
    var p = $(id);
    p.textContent = text || '';
    p.className = 'msg' + (kind ? ' ' + kind : '');
  }

  function busy(text) {
    $('busy-text').textContent = text || '処理しています…';
    $('busy').hidden = false;
  }
  function idle() { $('busy').hidden = true; }

  function show(view) {
    ['setup', 'login', 'main', 'detail'].forEach(function (v) { $('view-' + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1] || ''); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function ymd(d) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + 'MB'; }

  function minutesText(sec) {
    if (!sec) return '';
    var m = Math.round(sec / 60);
    return m >= 60 ? Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '') : m + '分';
  }

  /** GAS が返すリンクのうち、Google ドライブ・ドキュメントのものだけを使う */
  function safeLink(url) {
    return /^https:\/\/(docs|drive)\.google\.com\//.test(String(url || '')) ? url : '';
  }

  // =========================
  //  設定（この会社のGASのURL）
  // =========================
  function validApiUrl(u) {
    if (IS_LOCAL && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(u)) return true;
    return GAS_URL_RE.test(u);
  }

  /** 接続先の URL の見分けやすい部分（/s/ の後ろの末尾8文字） */
  function apiLabel(u) {
    var m = String(u || '').match(/\/s\/([A-Za-z0-9_-]+)\//);
    return m ? '…' + m[1].slice(-8) : u;
  }

  /**
   * 接続先（この会社の GAS）を決める。リンクの ?api= は、確認して OK のときだけ使う
   * （まだ設定がないときも、すでに別の接続先が設定されているときも）。
   * （知らない人から届いたリンクで接続先を書き換えられ、ログインの情報をその人の GAS に送ってしまうのを防ぐ。名刺管理君と同じ）
   */
  function loadApiUrl() {
    var params = new URLSearchParams(location.search);
    var fromLink = params.get('api');
    var saved = storageGet(API_URL_STORE);
    if (fromLink && validApiUrl(fromLink) && fromLink !== saved) {
      var question = validApiUrl(saved)
        ? '接続先（会社のgijiroku-app）を切り替えますか？\n\n今の接続先: ' + apiLabel(saved) + '\n新しい接続先: ' + apiLabel(fromLink)
        : 'このリンクの接続先（会社のgijiroku-app）を使いますか？\n\n接続先: ' + apiLabel(fromLink);
      if (IS_LOCAL || confirm(question + '\n\n会社の導入担当から受け取ったリンクのときだけ「OK」を押してください。心当たりがなければ「キャンセル」を押してください。')) {
        storageSet(API_URL_STORE, fromLink);
        sessionSet(TOKEN_KEY, '');
        saved = fromLink;
      }
    }
    // 読み終えた ?api= はアドレスから消す（再読み込みで何度も確認が出ないように）
    if (fromLink) {
      params.delete('api');
      try { history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); } catch (e) { /* 消せなくても動かす */ }
    }
    state.apiUrl = validApiUrl(saved) ? saved : '';
  }

  $('setup-save').addEventListener('click', function () {
    var u = $('setup-url').value.trim();
    if (!validApiUrl(u)) {
      msg('setup-msg', '設定コードの形が違います。https://script.google.com/macros/s/…/exec の形のURLを貼り付けてください。', 'err');
      return;
    }
    if (u !== storageGet(API_URL_STORE)) sessionSet(TOKEN_KEY, '');
    storageSet(API_URL_STORE, u);
    state.apiUrl = u;
    start();
  });

  // =========================
  //  ログイン（Google）
  // =========================
  function decodeJwt(token) {
    try {
      var part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(atob(part).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join(''));
      return JSON.parse(json);
    } catch (e) { return null; }
  }

  /** 接続先の URL の ID（/s/ と /exec の間）。手元の模擬環境は 'local' */
  function apiId(u) {
    var m = String(u || '').match(/\/s\/([A-Za-z0-9_-]+)\//);
    return m ? m[1] : (IS_LOCAL ? 'local' : '');
  }

  /**
   * ログインのトークンに入れる nonce。先頭を今の接続先の ID にする（GAS の Auth.verify が確かめる）。
   * 偽の接続先に送らされたトークンは、本物のgijiroku-appでは通らない
   */
  function loginNonce() {
    var bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return apiId(state.apiUrl) + '.' + Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  /** 期限まで1分以上あり、今の接続先あてのトークンか */
  function tokenValid(token) {
    var p = token && decodeJwt(token);
    return !!(p && p.exp * 1000 - Date.now() > 60 * 1000 &&
              String(p.nonce || '').split('.')[0] === apiId(state.apiUrl));
  }

  function setToken(token) {
    state.idToken = token || '';
    sessionSet(TOKEN_KEY, state.idToken);
    var p = token && decodeJwt(token);
    $('who').textContent = p ? p.email : (IS_LOCAL && CONFIG.devIdToken ? '（模擬環境）' : '');
    $('logout').hidden = !state.idToken;
  }

  function onCredential(res) {
    // 前の接続先で初期化したときのログインが遅れて届いたら使わない（今の接続先あてのトークンだけ使う）
    if (!(IS_LOCAL && CONFIG.devIdToken) && !tokenValid(res.credential)) {
      msg('login-msg', 'ログインをやり直してください（接続先が変わったため）。', 'err');
      return;
    }
    setToken(res.credential);
    var waiters = state.tokenWaiters.splice(0);
    waiters.forEach(function (w) { w(state.idToken); });
    if (!$('view-login').hidden) enterMain();
  }

  function initGoogle() {
    if (IS_LOCAL && CONFIG.devIdToken) return true;   // 手元の模擬環境だけ
    if (!CONFIG.googleClientId) {
      msg('login-msg', 'アプリの設定が終わっていません（GoogleのクライアントIDが未設定）。\n導入担当にお知らせください。', 'err');
      return false;
    }
    if (!(window.google && google.accounts && google.accounts.id)) return false;
    google.accounts.id.initialize({
      client_id: CONFIG.googleClientId,
      nonce: loginNonce(),
      callback: onCredential,
      auto_select: true,
      itp_support: true,
      use_fedcm_for_prompt: true,
    });
    google.accounts.id.renderButton($('gsi-button'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'ja' });
    return true;
  }

  /** 有効なトークンを返す。切れていれば自動でのログインを試し、だめならログイン画面を出す */
  function freshToken() {
    if (IS_LOCAL && CONFIG.devIdToken) return Promise.resolve(CONFIG.devIdToken);
    if (tokenValid(state.idToken)) return Promise.resolve(state.idToken);
    return new Promise(function (resolve, reject) {
      var done = false;
      state.tokenWaiters.push(function (t) { done = true; resolve(t); });
      try { google.accounts.id.prompt(); } catch (e) { /* 下のタイマーでログイン画面へ */ }
      setTimeout(function () {
        if (done) return;
        state.tokenWaiters.splice(0);
        endSession('ログインの有効期限が切れました。もう一度ログインしてください。', 'err');
        reject(new Error('ログインが必要です'));
      }, 6000);
    });
  }

  /**
   * 「閉じる」＝ログアウト。ホーム画面のアプリは自分では閉じられないため、
   * ログインを解除し、画面に出ている議事録・入力中の文字も消してログイン画面に戻す。
   */
  function logout() {
    if (!state.idToken) return;
    if (state.uploading) { alert('音声を送っている途中です。送り終わってから閉じてください。'); return; }
    if (!confirm('ログアウトして閉じますか？\n次に開いたときは、ログインからになります。')) return;
    try { google.accounts.id.disableAutoSelect(); } catch (e) { /* 未読み込みでも続ける */ }
    endSession('ログアウトしました。アプリを閉じるときは、スマホの操作で閉じてください。', 'ok');
  }

  /**
   * ログインを終える（ログアウト・ログイン切れの両方）。トークンを消し、画面に出ている議事録・入力中の文字・選んだ音声を消す。
   * session を増やすので、終える前に送った要求の応答は画面に出ない（送っている途中の音声もそこで止まる）。
   */
  function endSession(text, kind) {
    state.session++;
    setToken('');
    try { google.accounts.id.cancel(); } catch (e) { /* ログインの案内が出ていなければ何もしない */ }
    idle();
    stopPoll();
    state.uploading = false;
    keepAwake(false);
    setProgress(null);
    clearFile();
    state.meeting = null;
    state.todos = [];
    ['f-title', 'f-attendees', 'f-glossary', 'h-q', 't-q'].forEach(function (id) { $(id).value = ''; });
    ['h-list', 't-list', 'detail-head', 'detail-status', 'detail-body', 'detail-links'].forEach(function (id) { $(id).replaceChildren(); });
    ['upload-msg', 'h-msg', 't-msg', 'detail-msg'].forEach(function (id) { msg(id, ''); });
    $('detail-transcript').hidden = true;
    $('detail-transcript').textContent = '';
    $('upload-open').hidden = true;
    selectTab('upload');
    show('login');
    msg('login-msg', text, kind);
  }

  $('who').addEventListener('click', logout);
  $('logout').addEventListener('click', logout);

  // =========================
  //  GAS とのやり取り
  // =========================
  /**
   * @returns {Promise<Object>} GAS の応答（ok:false でも返す。呼び出し元が message を出す）
   */
  function api(action, params) {
    var session = state.session;
    var never = function () { return new Promise(function () {}); };   // 終えたログインの応答は捨てる
    return freshToken().then(function (idToken) {
      if (session !== state.session) return never();
      var body = Object.assign({ action: action, idToken: idToken }, params || {});
      return fetch(state.apiUrl, {
        method: 'POST',
        // text/plain にすると事前確認（プリフライト）が出ず、GAS がそのまま受け取れる
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'follow',
      }).catch(function (e) {
        throw new Error('通信できませんでした。電波のよい場所でもう一度お試しください。\n[原因] ' + e.message);
      }).then(function (res) {
        return res.json().catch(function () {
          throw new Error('応答を読めませんでした。\n[原因] HTTP ' + res.status);
        });
      }).then(function (json) {
        if (session !== state.session) return never();
        if (!json.ok && json.code === 'AUTH') {
          endSession(json.message, 'err');
          return never();
        }
        return json;
      }, function (e) {
        if (session !== state.session) return never();   // 通信の失敗も、終えたログインの分は画面に出さない
        throw e;
      });
    }, function (e) {
      if (session !== state.session) return never();   // ログイン切れで終えた。ログイン画面に案内済み
      throw e;
    });
  }

  /** 失敗時の表示文（GAS の message、または通信エラー） */
  function errText(x) { return (x && (x.message || String(x))) || '失敗しました。'; }

  // =========================
  //  タブ
  // =========================
  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    ['upload', 'history', 'todo'].forEach(function (t) { $('tab-' + t).hidden = t !== tab; });
    stopPoll();
    if (tab === 'history') loadHistory();
    if (tab === 'todo') loadTodos();
  }

  document.querySelectorAll('.tabs button').forEach(function (b) {
    b.addEventListener('click', function () { selectTab(b.dataset.tab); });
  });

  // =========================
  //  登録（音声を送る）
  // =========================
  $('pick').addEventListener('click', function () {
    if (state.uploading) return;
    $('file-audio').value = '';
    $('file-audio').click();
  });

  /** 音声の長さを読む。読めない形式なら 0（そのときは GAS 側で数える） */
  function audioDuration(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var a = document.createElement('audio');
      var settled = false;
      function done(v) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(v);
      }
      a.preload = 'metadata';
      a.onloadedmetadata = function () { done(isFinite(a.duration) && a.duration > 0 ? a.duration : 0); };
      a.onerror = function () { done(0); };
      setTimeout(function () { done(0); }, 8000);
      a.src = url;
    });
  }

  $('file-audio').addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    state.file = file;
    state.durationSec = 0;
    $('upload-open').hidden = true;
    msg('upload-msg', '');
    if (!$('f-title').value.trim()) $('f-title').value = file.name.replace(/\.[^.]+$/, '').slice(0, 100);
    $('f-date').value = ymd(new Date(file.lastModified || Date.now()));
    renderFileInfo();
    audioDuration(file).then(function (sec) {
      if (state.file !== file) return;
      state.durationSec = Math.round(sec);
      renderFileInfo();
    });
    refreshUpload();
  });

  function renderFileInfo() {
    var f = state.file;
    $('file-info').hidden = !f;
    if (!f) return;
    $('file-info').textContent = '🎧 ' + f.name + '（' + mb(f.size) + (state.durationSec ? '・' + minutesText(state.durationSec) : '') + '）';
  }

  function clearFile() {
    state.file = null;
    state.durationSec = 0;
    $('file-audio').value = '';
    renderFileInfo();
    refreshUpload();
  }

  function refreshUpload() {
    $('do-upload').disabled = state.uploading || !state.file || !$('f-title').value.trim() || !$('f-date').value;
    $('pick').disabled = state.uploading;
  }
  ['f-title', 'f-date'].forEach(function (id) { $(id).addEventListener('input', refreshUpload); });

  function setProgress(ratio, text) {
    $('progress').hidden = ratio === null;
    if (ratio === null) return;
    $('meter-fill').style.width = Math.round(ratio * 100) + '%';
    $('progress-text').textContent = text;
  }

  /** 送っている間は画面が消えないようにする（対応している端末だけ） */
  var wakeLock = null;
  function keepAwake(on) {
    try {
      if (on && navigator.wakeLock) navigator.wakeLock.request('screen').then(function (l) { wakeLock = l; }).catch(function () {});
      if (!on && wakeLock) { wakeLock.release(); wakeLock = null; }
    } catch (e) { /* 対応していない端末はそのまま */ }
  }

  window.addEventListener('beforeunload', function (e) {
    if (!state.uploading) return;
    e.preventDefault();
    e.returnValue = '';
  });

  /**
   * 1つ分を送る。通信が切れたら、GAS 経由でドライブがどこまで受け取ったかを聞いて、そこから続ける。
   * @returns {Promise<Object>} { done, next, meetingId }
   */
  async function sendChunk(uploadId, file, offset, chunkSize) {
    var lastErr = null;
    for (var i = 0; i < CHUNK_TRIES; i++) {
      try {
        if (i > 0) {
          await sleep(2000 * i);
          var st = await api('uploadStatus', { uploadId: uploadId });
          if (!st.ok) throw new Error(errText(st));
          if (st.done || st.next !== offset) return st;   // すでに受け取り済み → 次の位置から
        }
        var data = await blobToBase64(file.slice(offset, Math.min(offset + chunkSize, file.size)));
        var res = await api('uploadChunk', { uploadId: uploadId, offset: offset, data: data });
        if (!res.ok) {
          if (res.code === 'AUTH' || res.code === 'E004' || res.code === 'BAD_REQUEST') throw Object.assign(new Error(errText(res)), { fatal: true });
          throw new Error(errText(res));
        }
        return res;
      } catch (e) {
        if (e.fatal || /ログインが必要/.test(e.message)) throw e;
        lastErr = e;
      }
    }
    throw lastErr;
  }

  $('do-upload').addEventListener('click', async function () {
    var file = state.file;
    if (!file || state.uploading) return;
    state.uploading = true;
    refreshUpload();
    keepAwake(true);
    $('upload-open').hidden = true;
    msg('upload-msg', '送り終わるまで、この画面を開いたままにしてください。', '');
    setProgress(0, '準備しています…');
    try {
      var start = await api('uploadStart', {
        title: $('f-title').value.trim(), date: $('f-date').value,
        attendees: $('f-attendees').value.trim(), glossary: $('f-glossary').value.trim(),
        fileName: file.name, mimeType: file.type || '', size: file.size, durationSec: state.durationSec,
      });
      if (!start.ok) throw new Error(errText(start));
      state.lastMeetingId = start.meetingId;
      var offset = 0;
      for (;;) {
        var res = await sendChunk(start.uploadId, file, offset, start.chunkSize);
        if (res.done) break;
        offset = res.next;
        setProgress(offset / file.size, '送っています ' + Math.floor(100 * offset / file.size) + '%（' + mb(offset) + ' / ' + mb(file.size) + '）');
      }
      setProgress(1, '送りました（' + mb(file.size) + '）');
      msg('upload-msg', '受け付けました。文字起こし・議事メモ・TODO を作っています。\nアプリを閉じても処理は続きます。できあがると履歴の状態が「完了」になります。', 'ok');
      $('upload-open').hidden = false;
      clearFile();
      ['f-title', 'f-attendees', 'f-glossary'].forEach(function (id) { $(id).value = ''; });
    } catch (e) {
      setProgress(null);
      msg('upload-msg', '音声を送れませんでした。もう一度「送って議事録を作る」を押してください。\n' + errText(e), 'err');
    } finally {
      state.uploading = false;
      keepAwake(false);
      refreshUpload();
    }
  });

  $('upload-open').addEventListener('click', function () {
    if (state.lastMeetingId) openMeeting(state.lastMeetingId);
  });

  // =========================
  //  履歴
  // =========================
  var STATUS_CLASS = { '完了': 'st-done', 'エラー': 'st-err', '処理中': 'st-run', '待機中': 'st-wait', 'アップロード中': 'st-wait' };

  function statusBadge(status) {
    return el('span', { class: 'badge ' + (STATUS_CLASS[status] || 'st-wait'), text: status || '不明' });
  }

  function isWorking(status) { return status !== '完了' && status !== 'エラー'; }

  function loadHistory(quiet) {
    if (!quiet) msg('h-msg', '読み込んでいます…');
    return api('list', { q: $('h-q').value.trim() }).then(function (res) {
      if (!res.ok) { msg('h-msg', errText(res), 'err'); return; }
      msg('h-msg', res.total ? '' : ($('h-q').value.trim() ? '見つかりませんでした。' : 'まだ会議はありません。「登録」から音声を送ってください。'));
      renderHistory(res.items);
      if (res.items.some(function (m) { return isWorking(m.status); })) schedulePoll(function () { loadHistory(true); });
    }).catch(function (e) { msg('h-msg', errText(e), 'err'); });
  }

  function renderHistory(items) {
    $('h-list').replaceChildren.apply($('h-list'), items.map(function (m) {
      var sub = [m.date, minutesText(m.minutes * 60), m.attendees].filter(String).join('・');
      var note = m.status === '完了' ? m.summary : (m.progress || '');
      return el('li', {}, [el('button', { onclick: function () { openMeeting(m.id); } }, [
        el('span', { class: 'head' }, [statusBadge(m.status), el('span', { class: 'name', text: m.title })]),
        el('span', { class: 'sub', text: sub }),
        note ? el('span', { class: 'note', text: note }) : null,
      ])]);
    }));
  }

  $('h-reload').addEventListener('click', function () { loadHistory(); });
  $('h-q').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadHistory(); });
  $('h-q').addEventListener('search', function () { loadHistory(); });

  function schedulePoll(fn) {
    stopPoll();
    state.pollTimer = setTimeout(function () {
      state.pollTimer = 0;
      if (document.visibilityState === 'visible') fn(); else schedulePoll(fn);
    }, POLL_MS);
  }
  function stopPoll() { if (state.pollTimer) clearTimeout(state.pollTimer); state.pollTimer = 0; }

  // =========================
  //  TODO
  // =========================
  function todoFilter() { return document.querySelector('input[name="tfilter"]:checked').value; }

  function loadTodos() {
    msg('t-msg', '読み込んでいます…');
    return api('todos', { filter: todoFilter() }).then(function (res) {
      if (!res.ok) { msg('t-msg', errText(res), 'err'); return; }
      state.todos = res.items;
      renderTodos();
    }).catch(function (e) { msg('t-msg', errText(e), 'err'); });
  }

  function renderTodos() {
    var q = $('t-q').value.trim().toLowerCase();
    var items = state.todos.filter(function (t) {
      return !q || (t.task + ' ' + t.owner + ' ' + t.meetingTitle).toLowerCase().indexOf(q) !== -1;
    });
    msg('t-msg', items.length ? items.length + '件' : 'TODO はありません。');
    $('t-list').replaceChildren.apply($('t-list'), items.map(function (t) { return todoItem(t, true); }));
  }

  /** TODO の1行。チェックで完了の印を付け外しする */
  function todoItem(t, withMeeting) {
    var today = ymd(new Date());
    var check = el('input', { type: 'checkbox', 'aria-label': '完了' });
    check.checked = t.done;
    check.addEventListener('change', function () {
      check.disabled = true;
      api('setTodo', { id: t.id, done: check.checked }).then(function (res) {
        check.disabled = false;
        if (!res.ok) { check.checked = !check.checked; alert(errText(res)); return; }
        t.done = res.todo.done;
        t.doneDate = res.todo.doneDate;
        li.className = t.done ? 'done' : '';
      }).catch(function (e) { check.disabled = false; check.checked = !check.checked; alert(errText(e)); });
    });
    var overdue = !t.done && t.due && t.due < today;
    var meta = [
      el('span', { text: '担当：' + (t.owner || '未定') }),
      el('span', { class: overdue ? 'overdue' : '', text: '期限：' + (t.due || '未定') + (overdue ? '（過ぎています）' : '') }),
    ];
    if (withMeeting) {
      meta.push(el('button', { class: 'link small', text: t.meetingDate + ' ' + t.meetingTitle, onclick: function () { openMeeting(t.meetingId); } }));
    }
    var li = el('li', { class: t.done ? 'done' : '' }, [
      el('label', { class: 'check' }, [check, el('span', { class: 'task', text: t.task })]),
      el('div', { class: 'meta' }, meta),
    ]);
    return li;
  }

  document.querySelectorAll('input[name="tfilter"]').forEach(function (r) { r.addEventListener('change', loadTodos); });
  $('t-q').addEventListener('input', renderTodos);

  // =========================
  //  会議の詳細
  // =========================
  function openMeeting(id) {
    stopPoll();
    show('detail');
    ['detail-head', 'detail-status', 'detail-body', 'detail-links'].forEach(function (x) { $(x).replaceChildren(); });
    $('detail-actions').hidden = true;
    $('detail-transcript').hidden = true;
    $('detail-transcript').textContent = '';
    msg('detail-msg', '読み込んでいます…');
    loadMeeting(id);
  }

  function loadMeeting(id, quiet) {
    return api('detail', { id: id }).then(function (res) {
      if ($('view-detail').hidden) return;
      if (!res.ok) { msg('detail-msg', errText(res), 'err'); return; }
      if (!quiet) msg('detail-msg', '');
      state.meeting = res.meeting;
      renderMeeting(res.meeting);
      if (isWorking(res.meeting.status)) schedulePoll(function () { loadMeeting(id, true); });
    }).catch(function (e) { msg('detail-msg', errText(e), 'err'); });
  }

  function section(title, children) {
    return el('section', { class: 'sec' }, [el('h3', { text: title })].concat(children));
  }

  function bullets(items) {
    if (!items || !items.length) return el('p', { class: 'none', text: 'なし' });
    return el('ul', {}, items.map(function (s) { return el('li', { text: s }); }));
  }

  function renderMeeting(m) {
    $('detail-head').replaceChildren(
      el('h2', { text: m.title }),
      el('p', { class: 'sub', text: [m.date, minutesText(m.minutes * 60), m.attendees ? '参加者：' + m.attendees : ''].filter(String).join('・') }),
      el('p', { class: 'sub', text: '登録：' + m.registrant })
    );

    var st = [];
    if (m.status !== '完了') {
      st.push(el('p', { class: 'statusline' }, [statusBadge(m.status), el('span', { text: ' ' + (m.progress || '') })]));
      if (m.status === 'エラー') {
        st.push(el('p', { class: 'msg err', text: m.error || '失敗しました。' }));
        st.push(el('button', { class: 'primary', text: '止まったところからやり直す', onclick: function () { retry(m.id); } }));
      } else {
        st.push(el('p', { class: 'hint', text: 'できあがると、ここに議事メモと TODO が出ます。この画面は自動で更新します。アプリを閉じても処理は続きます。' }));
        if (m.error) st.push(el('p', { class: 'hint', text: m.error }));
      }
    }
    $('detail-status').replaceChildren.apply($('detail-status'), st);

    var j = m.minutesJson;
    if (j) {
      $('detail-body').replaceChildren(
        section('概要', [el('p', { text: j.summary || 'なし' })]),
        section('決定事項', [bullets(j.decisions)]),
        section('TODO', [m.todos.length
          ? el('ul', { class: 'todos' }, m.todos.map(function (t) { return todoItem(t, false); }))
          : el('p', { class: 'none', text: 'なし' })]),
        section('議題ごとの要点', j.topics.length ? j.topics.map(function (t) {
          return el('div', { class: 'topic' }, [el('h4', { text: t.title }), bullets(t.points)]);
        }) : [el('p', { class: 'none', text: 'なし' })]),
        section('保留・持ち越し', [bullets(j.openIssues)]),
        section('次回', [el('p', { text: j.nextMeeting || '話に出なかった' })]),
        el('p', { class: 'hint', text: 'AI が録音から作った内容です。使う前に確認してください。手直しは下の「議事メモ（Google ドキュメント）」で行えます（この画面には最初に作った内容が出ます）。' })
      );
    } else {
      $('detail-body').replaceChildren();
    }
    $('detail-actions').hidden = !j;
    $('act-transcript').hidden = !(m.links.transcript || m.status === '処理中');

    var links = [
      ['議事メモ（Google ドキュメント）', m.links.minutes],
      ['文字起こし（Google ドキュメント）', m.links.transcript],
      ['録音（Google ドライブ）', m.links.audio],
      ['この会議のフォルダ', m.links.folder],
    ].filter(function (x) { return safeLink(x[1]); });
    $('detail-links').replaceChildren.apply($('detail-links'), links.map(function (x) {
      return el('li', {}, [el('a', { href: safeLink(x[1]), target: '_blank', rel: 'noopener', text: x[0] + ' ↗' })]);
    }));
  }

  function retry(id) {
    busy('やり直しを受け付けています…');
    api('retry', { id: id }).then(function (res) {
      idle();
      if (!res.ok) { msg('detail-msg', errText(res), 'err'); return; }
      msg('detail-msg', 'やり直しを受け付けました。', 'ok');
      loadMeeting(id, true);
    }).catch(function (e) { idle(); msg('detail-msg', errText(e), 'err'); });
  }

  $('act-transcript').addEventListener('click', function () {
    var m = state.meeting;
    if (!m) return;
    busy('文字起こしを読み込んでいます…');
    api('transcript', { id: m.id }).then(function (res) {
      idle();
      if (!res.ok) { msg('detail-msg', errText(res), 'err'); return; }
      $('detail-transcript').textContent = (res.partial ? '（作っている途中です。ここまでの分）\n\n' : '') + (res.text || 'まだありません。');
      $('detail-transcript').hidden = false;
      $('detail-transcript').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { idle(); msg('detail-msg', errText(e), 'err'); });
  });

  /** 議事メモを文字にする（LINE・メールに貼る用） */
  function minutesPlain(m) {
    var j = m.minutesJson;
    var lines = ['議事メモ　' + m.title, '開催日：' + m.date + (m.attendees ? '　参加者：' + m.attendees : ''), ''];
    function list(title, items) {
      lines.push('■' + title);
      (items.length ? items : ['なし']).forEach(function (s) { lines.push('・' + s); });
      lines.push('');
    }
    lines.push('■概要', j.summary || 'なし', '');
    list('決定事項', j.decisions);
    list('TODO', m.todos.map(function (t) {
      return t.task + '（担当：' + (t.owner || '未定') + '／期限：' + (t.due || '未定') + '）' + (t.done ? '［完了］' : '');
    }));
    lines.push('■議題ごとの要点');
    if (!j.topics.length) lines.push('なし');
    j.topics.forEach(function (t) {
      lines.push('【' + t.title + '】');
      t.points.forEach(function (p) { lines.push('・' + p); });
    });
    lines.push('');
    list('保留・持ち越し', j.openIssues);
    lines.push('■次回', j.nextMeeting || '話に出なかった');
    return lines.join('\n');
  }

  $('act-copy').addEventListener('click', function () {
    var m = state.meeting;
    if (!m || !m.minutesJson) return;
    var text = minutesPlain(m);
    var copied = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('この端末ではコピーできません'));
    copied.then(function () { msg('detail-msg', '議事メモをコピーしました。', 'ok'); })
      .catch(function (e) { msg('detail-msg', 'コピーできませんでした。\n[原因] ' + e.message, 'err'); });
  });

  $('detail-back').addEventListener('click', function () {
    stopPoll();
    state.meeting = null;
    show('main');
    selectTab(state.tab === 'upload' ? 'history' : state.tab);
  });

  // =========================
  //  起動
  // =========================
  function enterMain() {
    show('main');
    selectTab(state.tab);
    api('whoami').then(function (res) {
      if (!res.ok) return;
      state.inboxUrl = safeLink(res.inboxUrl);
      $('inbox-link').hidden = !state.inboxUrl;
      if (state.inboxUrl) $('inbox-link').firstElementChild.href = state.inboxUrl;
    }).catch(function () { /* 受付フォルダのリンクが出ないだけ */ });
  }

  function start() {
    loadApiUrl();
    if (!state.apiUrl) { show('setup'); return; }
    if (IS_LOCAL && CONFIG.devIdToken) { setToken(''); enterMain(); return; }
    var saved = sessionGet(TOKEN_KEY);
    if (tokenValid(saved)) setToken(saved);
    if (!initGoogle()) {
      // Google のログイン部品の読み込みを待つ
      var tries = 0;
      var t = setInterval(function () {
        if (initGoogle() || ++tries > 50) { clearInterval(t); if (tries > 50) msg('login-msg', 'Google のログイン部品を読み込めませんでした。電波のよい場所で開き直してください。', 'err'); }
      }, 200);
    }
    if (state.idToken) enterMain(); else show('login');
  }

  $('f-date').value = ymd(new Date());
  refreshUpload();
  start();

  if ('serviceWorker' in navigator && !IS_LOCAL) {
    navigator.serviceWorker.register('sw.js').catch(function () { /* なくても動く */ });
  }
})();
