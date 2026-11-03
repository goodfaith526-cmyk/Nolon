(function () {
  var site = document.getElementById('site');
  var T = {
    ar: {
      hello:
        'أهلاً بيك في نولون 👋\nأنا وكيل نولون. قول لي داير تشحن شنو، ومن وين لوين، وأحسب ليك السعر وأجهز طلب الحجز.',
      ph: 'اكتب رسالتك…',
      typing: 'بيكتب…',
      need: 'اكتب رقم الحجز أو الشحنة أولاً.',
      e404: 'الخدمة مش متاحة الآن. جرّب بعد شوية أو كلّمنا في تليغرام.',
      e429: 'رسايل كتيرة في وقت قصير. انتظر شوية وأرسل تاني.',
      e403: 'في مشكلة في إعداد المحادثة. كلّمنا في تليغرام لحدي ما نصلحها.',
      e400: 'الرسالة فاضية أو أطول من 1000 حرف.',
      enet: 'ما قدرنا نوصل للوكيل. اتأكد من الإنترنت وأرسل تاني.',
      retry: 'اضغط على الرسالة عشان تعيد إرسالها.',
      file: 'افتح الملف',
      image: 'صورة',
    },
    en: {
      hello:
        "Welcome to Nolon 👋\nI'm the Nolon assistant. Tell me what you want to ship, from where to where, and I'll price it and prepare your booking request.",
      ph: 'Type a message…',
      typing: 'Typing…',
      need: 'Enter a booking or shipment number first.',
      e404: 'The service is not available right now. Try again later or talk to us on Telegram.',
      e429: 'Too many messages in a short time. Wait a little and send again.',
      e403: 'The chat is not set up correctly. Talk to us on Telegram until we fix it.',
      e400: 'The message is empty or longer than 1000 characters.',
      enet: 'We could not reach the assistant. Check your connection and send again.',
      retry: 'Tap the message to send it again.',
      file: 'Open the file',
      image: 'Image',
    },
  };
  function L() {
    return site.getAttribute('lang') === 'en' ? 'en' : 'ar';
  }

  /* Live chat with the Nolon bookings assistant (agent web channel, site "nolon"). */
  var BASE = 'https://2-31-19-14.sslip.io/api/v1/whatsapp/web/nolon';
  var TOKEN_KEY = 'nolon-chat-token';
  var chat = document.getElementById('chat');
  var msgs = document.getElementById('msgs');
  var form = document.getElementById('chat-form');
  var input = document.getElementById('chat-input');
  var status = document.getElementById('chat-status');
  var dot = document.getElementById('fab-dot');
  var seenIds = {};
  var lastAt = null;
  var loaded = false;
  var waiting = false;
  var timer = null;
  var typingEl = null;
  var helloEl = null;
  var memToken = null;

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || memToken;
    } catch (err) {
      return memToken;
    }
  }
  function setToken(t) {
    memToken = t;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (err) {}
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.prototype.map
      .call(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      })
      .join('');
  }
  function ApiError(status, retryAfter) {
    this.status = status;
    this.retryAfter = retryAfter;
  }
  // One session request at a time: messages sent before /sessions answers wait for the
  // same token, so a fresh visitor's first messages never split across two visitors.
  var pendingSession = null;
  function session() {
    if (pendingSession) return pendingSession;
    pendingSession = fetch(BASE + '/sessions', { method: 'POST' })
      .then(function (res) {
        if (!res.ok) throw new ApiError(res.status);
        return res.json();
      })
      .then(
        function (b) {
          setToken(b.token);
          pendingSession = null;
          return b.token;
        },
        function (e) {
          pendingSession = null;
          throw e;
        },
      );
    return pendingSession;
  }
  function call(path, init, second) {
    var t = getToken();
    var ready = t ? Promise.resolve(t) : session();
    var used = null;
    return ready
      .then(function (tok) {
        used = tok;
        var opts = init || {};
        var headers = { authorization: 'Bearer ' + tok };
        if (opts.json) headers['content-type'] = 'application/json';
        return fetch(BASE + path, {
          method: opts.method || 'GET',
          headers: headers,
          body: opts.json ? JSON.stringify(opts.json) : undefined,
        });
      })
      .then(function (res) {
        if (res.status === 401 && !second) {
          // Only drop the token this call used; if another call already replaced it,
          // retry with the new one instead of starting yet another session.
          if (getToken() === used) setToken(null);
          return call(path, init, true);
        }
        if (!res.ok) throw new ApiError(res.status, Number(res.headers.get('Retry-After')) || 0);
        return res;
      });
  }
  function errorText(e) {
    var t = T[L()];
    if (!(e instanceof ApiError)) return t.enet;
    if (e.status === 404) return t.e404;
    if (e.status === 429) return t.e429;
    if (e.status === 403) return t.e403;
    if (e.status === 400) return t.e400;
    return t.enet;
  }
  function showStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }
  function scrollDown() {
    msgs.scrollTop = msgs.scrollHeight;
  }
  function makeBubble(text, who) {
    var d = document.createElement('div');
    d.className = 'm ' + who;
    d.textContent = text;
    return d;
  }
  function showHello() {
    if (helloEl || msgs.querySelector('.m:not(.hello)')) return;
    helloEl = makeBubble(T[L()].hello, 'bot hello');
    msgs.insertBefore(helloEl, msgs.firstChild);
  }
  function attachDocument(el, lineId) {
    call('/files/' + encodeURIComponent(lineId))
      .then(function (res) {
        return res.blob();
      })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        if (/^image\//.test(blob.type)) {
          var img = document.createElement('img');
          img.className = 'doc';
          img.src = url;
          img.alt = T[L()].image;
          img.addEventListener('load', scrollDown);
          var a = document.createElement('a');
          a.href = url;
          a.target = '_blank';
          a.rel = 'noopener';
          a.appendChild(img);
          el.appendChild(a);
        } else {
          var link = document.createElement('a');
          link.className = 'doc-link';
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener';
          link.download = 'nolon-' + lineId + '.pdf';
          link.textContent = '📄 ' + T[L()].file;
          el.appendChild(link);
        }
        scrollDown();
      })
      .catch(function () {});
  }
  function addLine(line) {
    if (seenIds[line.id]) {
      var mine = msgs.querySelector('[data-id="' + line.id + '"]');
      if (mine) mine.classList.remove('pending', 'failed');
      return false;
    }
    seenIds[line.id] = true;
    var el = makeBubble(line.text || '', line.from === 'visitor' ? 'me' : 'bot');
    el.setAttribute('data-id', line.id);
    if (line.document) attachDocument(el, line.id);
    if (typingEl && typingEl.parentNode) msgs.insertBefore(el, typingEl);
    else msgs.appendChild(el);
    if (!lastAt || line.at > lastAt) lastAt = line.at;
    return line.from !== 'visitor';
  }
  function setTyping(on) {
    if (on && !typingEl) {
      typingEl = makeBubble(T[L()].typing, 'bot typing');
      msgs.appendChild(typingEl);
    }
    if (!on && typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }
  function schedule() {
    clearTimeout(timer);
    var open = !chat.hidden;
    if (!getToken() || document.hidden) return;
    timer = setTimeout(poll, waiting ? 2000 : open ? 15000 : 30000);
  }
  function poll() {
    if (!getToken()) return;
    call('/messages' + (lastAt ? '?after=' + encodeURIComponent(lastAt) : ''))
      .then(function (res) {
        return res.json();
      })
      .then(function (b) {
        var fresh = false;
        (b.messages || [])
          .slice()
          .sort(function (x, y) {
            return x.at < y.at ? -1 : x.at > y.at ? 1 : 0;
          })
          .forEach(function (l) {
            if (addLine(l)) fresh = true;
          });
        waiting = !!b.waiting;
        setTyping(waiting);
        if (fresh && chat.hidden && loaded) dot.hidden = false;
        loaded = true;
        if (!chat.hidden) {
          showStatus('');
          scrollDown();
        }
        showHello();
      })
      .catch(function (e) {
        if (!chat.hidden && e instanceof ApiError && e.status !== 429) showStatus(errorText(e));
      })
      .then(schedule);
  }
  function send(text, el, id) {
    el.classList.add('pending');
    el.classList.remove('failed');
    call('/messages', { method: 'POST', json: { id: id, text: text } })
      .then(function () {
        el.classList.remove('pending');
        waiting = true;
        setTyping(true);
        scrollDown();
        showStatus('');
        clearTimeout(timer);
        timer = setTimeout(poll, 1200);
      })
      .catch(function (e) {
        el.classList.remove('pending');
        el.classList.add('failed');
        el.title = T[L()].retry;
        showStatus(
          errorText(e) + (e instanceof ApiError && e.status === 400 ? '' : ' ' + T[L()].retry),
        );
        el.onclick = function () {
          el.onclick = null;
          send(text, el, id);
        };
      });
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    if (text.length > 1000) {
      showStatus(T[L()].e400);
      return;
    }
    var id = newId();
    seenIds[id] = true;
    var el = makeBubble(text, 'me');
    el.setAttribute('data-id', id);
    if (typingEl) msgs.insertBefore(el, typingEl);
    else msgs.appendChild(el);
    input.value = '';
    grow();
    scrollDown();
    send(text, el, id);
  });
  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit'));
    }
  });
  function openChat() {
    chat.hidden = false;
    dot.hidden = true;
    showHello();
    if (!loaded && getToken()) poll();
    else schedule();
    scrollDown();
    input.focus({ preventScroll: true });
  }
  function renderStatic() {
    input.placeholder = T[L()].ph;
    if (helloEl) helloEl.textContent = T[L()].hello;
    if (typingEl) typingEl.textContent = T[L()].typing;
  }
  document.querySelectorAll('[data-open-chat]').forEach(function (b) {
    b.addEventListener('click', function () {
      hideBubble();
      if (b.id === 'fab' && !chat.hidden) {
        chat.hidden = true;
        schedule();
        return;
      }
      openChat();
    });
  });
  document.getElementById('chat-close').addEventListener('click', function () {
    chat.hidden = true;
    schedule();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) {
      clearTimeout(timer);
      if (getToken()) poll();
    }
  });
  renderStatic();
  if (getToken()) poll();

  document.getElementById('track-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var r = document.getElementById('ref').value.trim();
    var msg = document.getElementById('track-msg');
    if (!r) {
      msg.textContent = T[L()].need;
      return;
    }
    window.location.href = 'https://app.nolon.dev/' + L() + '/track';
  });

  document.getElementById('lang-btn').addEventListener('click', function () {
    var en = L() === 'ar';
    site.setAttribute('lang', en ? 'en' : 'ar');
    site.setAttribute('dir', en ? 'ltr' : 'rtl');
    document.documentElement.lang = en ? 'en' : 'ar';
    renderStatic();
    try {
      localStorage.setItem('nolon-lang', en ? 'en' : 'ar');
    } catch (err) {}
  });
  try {
    if (localStorage.getItem('nolon-lang') === 'en') {
      site.setAttribute('lang', 'en');
      site.setAttribute('dir', 'ltr');
    }
  } catch (err) {}

  /* Mascot: greeting bubble once per visit, eyes that follow the pointer. */
  var bubble = document.getElementById('fab-bubble');
  function hideBubble() {
    if (bubble) bubble.hidden = true;
  }
  document.getElementById('fab-bubble-x').addEventListener('click', hideBubble);
  var seen = false;
  try {
    seen = sessionStorage.getItem('nolon-hi') === '1';
  } catch (err) {}
  if (!seen) {
    setTimeout(function () {
      if (!chat.hidden) return;
      bubble.hidden = false;
      try {
        sessionStorage.setItem('nolon-hi', '1');
      } catch (err) {}
    }, 3500);
  }
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still) {
    // Header logo drives in from the far left once per browser session.
    var brand = document.querySelector('.top .brand');
    var top = document.querySelector('.top');
    var drove = false;
    try {
      drove = sessionStorage.getItem('nolon-drive') === '1';
      sessionStorage.setItem('nolon-drive', '1');
    } catch (err) {}
    if (brand && top && !drove) {
      var startDrive = function () {
        var r = brand.getBoundingClientRect();
        if (!r.width) return;
        brand.style.setProperty('--drive-from', -Math.ceil(r.right + 24) + 'px');
        top.classList.add('driving');
        brand.classList.add('drive');
      };
      brand.addEventListener('animationend', function (e) {
        if (e.target !== brand) return;
        brand.classList.remove('drive');
        top.classList.remove('driving');
      });
      var logoImg = brand.querySelector(site.lang === 'en' ? 'img.en' : 'img.ar');
      if (logoImg && !logoImg.complete)
        logoImg.addEventListener('load', startDrive, { once: true });
      else startDrive();
    }
    var eyes = Array.prototype.slice.call(document.querySelectorAll('.bot .pupil'));
    var px = 0,
      py = 0,
      queued = false;
    function look() {
      queued = false;
      eyes.forEach(function (g) {
        var r = g.ownerSVGElement.getBoundingClientRect();
        if (!r.width) return;
        var dx = px - (r.left + r.width / 2),
          dy = py - (r.top + r.height / 2);
        var d = Math.sqrt(dx * dx + dy * dy) || 1,
          k = Math.min(1, d / 260);
        g.setAttribute(
          'transform',
          'translate(' +
            ((dx / d) * 2.6 * k).toFixed(2) +
            ' ' +
            ((dy / d) * 2.4 * k).toFixed(2) +
            ')',
        );
      });
    }
    window.addEventListener(
      'pointermove',
      function (e) {
        px = e.clientX;
        py = e.clientY;
        if (!queued) {
          queued = true;
          requestAnimationFrame(look);
        }
      },
      { passive: true },
    );
  }
})();
