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
    // Header logo trip, once per browser session: the truck drives in, stops in the header's
    // open space, loads two barrels and a parcel, drives to its place and delivers them.
    var brand = document.querySelector('.top .brand');
    var top = document.querySelector('.top');
    var drove = false;
    try {
      drove = sessionStorage.getItem('nolon-drive') === '1';
      sessionStorage.setItem('nolon-drive', '1');
    } catch (err) {}
    if (brand && top && !drove && brand.animate) {
      var CARGO = [
        '<svg class="cargo" viewBox="0 0 22 26" aria-hidden="true"><rect x="2" y="1" width="18" height="24" rx="4" fill="#f39531"/><rect x="2" y="7" width="18" height="2.6" fill="#c46a10"/><rect x="2" y="16.4" width="18" height="2.6" fill="#c46a10"/><rect x="5" y="3" width="3" height="20" rx="1.5" fill="#fff" fill-opacity=".35"/></svg>',
        '<svg class="cargo" viewBox="0 0 22 26" aria-hidden="true"><rect x="2" y="1" width="18" height="24" rx="4" fill="#0a55a1"/><rect x="2" y="7" width="18" height="2.6" fill="#063a70"/><rect x="2" y="16.4" width="18" height="2.6" fill="#063a70"/><rect x="5" y="3" width="3" height="20" rx="1.5" fill="#fff" fill-opacity=".3"/></svg>',
        '<svg class="cargo" viewBox="0 0 26 22" aria-hidden="true"><rect x="1" y="3" width="24" height="18" rx="2" fill="#c9965f"/><rect x="1" y="3" width="24" height="5" rx="2" fill="#b58049"/><rect x="11" y="3" width="4" height="18" fill="#ecd3ad"/></svg>',
      ];
      var tripImg = brand.querySelector(site.lang === 'en' ? 'img.en' : 'img.ar');
      var trip = function () {
        var r = brand.getBoundingClientRect();
        var ri = tripImg.getBoundingClientRect();
        var t = top.getBoundingClientRect();
        if (!r.width || !ri.width) return;
        // The widest open stretch of the header bar, between the logo, the menu and the buttons.
        var edges = [];
        Array.prototype.forEach.call(top.querySelector('.wrap').children, function (el) {
          var b = el.getBoundingClientRect();
          if (b.width) edges.push([b.left, b.right]);
        });
        edges.sort(function (p, q) {
          return p[0] - q[0];
        });
        var gap = [0, 0];
        for (var i = 1; i < edges.length; i++) {
          if (edges[i][0] - edges[i - 1][1] > gap[1] - gap[0]) gap = [edges[i - 1][1], edges[i][0]];
        }
        var layer = document.createElement('div');
        layer.className = 'drive-cargo';
        layer.innerHTML = CARGO.join('');
        top.appendChild(layer);
        var items = Array.prototype.slice.call(layer.children);
        var sizes = items.map(function (el) {
          return el.getBoundingClientRect();
        });
        var load = sizes.reduce(function (s, b) {
          return s + b.width + 4;
        }, 0);
        // Truck position at the stop, as an offset from its place; cargo waits in front of it.
        var stop = (gap[0] + gap[1]) / 2 - (r.width + 10 + load) / 2 - r.left;
        var from = -(r.right + 24);
        var ground = ri.top + ri.height * (site.lang === 'en' ? 0.66 : 0.6) - t.top;
        var bedX = ri.left + ri.width * 0.47 - t.left;
        var bedY = ri.top + ri.height * 0.28 - t.top;
        var out = r.left + r.width / 2 < window.innerWidth / 2 ? 1 : -1;
        var ms = 7800;
        function at(x) {
          return x / ms;
        }
        function tx(x) {
          return 'translateX(' + x.toFixed(1) + 'px)';
        }
        var back = stop > 0 ? -1 : 1;
        // 3D: darker copies of the logo stacked behind it give the truck a body; the truck turns
        // three-quarters while it drives and faces front when it stops.
        top.classList.add('driving');
        brand.classList.add('drive');
        var depth = [];
        for (var d = 1; d <= 12; d++) {
          var c = tripImg.cloneNode();
          c.alt = '';
          c.setAttribute('aria-hidden', 'true');
          c.classList.add('depth');
          c.style.left = tripImg.offsetLeft + 'px';
          c.style.top = tripImg.offsetTop + 'px';
          c.style.transform = 'translateZ(' + -d * 1.6 + 'px)';
          brand.insertBefore(c, tripImg);
          depth.push(c);
        }
        var shade = document.createElement('span');
        shade.className = 'truck-shadow';
        shade.style.left = tripImg.offsetLeft + tripImg.offsetWidth * 0.12 + 'px';
        shade.style.width = tripImg.offsetWidth * 0.76 + 'px';
        shade.style.top = tripImg.offsetTop + ri.height * (site.lang === 'en' ? 0.64 : 0.58) + 'px';
        brand.insertBefore(shade, brand.firstChild);
        var layers = depth.concat([tripImg]);
        function pose(x, turn, lean) {
          return (
            'perspective(900px) translateX(' +
            x.toFixed(1) +
            'px) rotateY(' +
            turn +
            'deg) skewX(' +
            lean +
            'deg)'
          );
        }
        brand.animate(
          [
            { offset: 0, transform: pose(from, -28, -4), easing: 'cubic-bezier(.25,.6,.4,1)' },
            { offset: at(1700), transform: pose(stop + 7, -14, -4), easing: 'ease-out' },
            { offset: at(1950), transform: pose(stop - 2, -4, 3), easing: 'ease-in-out' },
            { offset: at(2150), transform: pose(stop, 0, 0) },
            { offset: at(4100), transform: pose(stop, 0, 0), easing: 'ease-in-out' },
            {
              offset: at(4500),
              transform: pose(stop - back * 10, back * 26, 0),
              easing: 'ease-in-out',
            },
            {
              offset: at(5500),
              transform: pose(back * 6, back * 12, back * -3),
              easing: 'ease-out',
            },
            { offset: at(5750), transform: pose(back * -2, 0, back * 2) },
            { offset: at(5950), transform: pose(0, 0, 0) },
            { offset: 1, transform: pose(0, 0, 0) },
          ],
          { duration: ms },
        );
        var bob = [{ transform: 'translateY(0)' }, { transform: 'translateY(-2px)' }];
        function all(frames, opts) {
          opts.composite = 'add';
          layers.forEach(function (el) {
            el.animate(frames, opts);
          });
        }
        all(bob, { duration: 190, iterations: 8, direction: 'alternate' });
        all(bob, { duration: 190, iterations: 7, direction: 'alternate', delay: 4100 });
        function squat(delay, dy) {
          all(
            [
              { transform: 'translateY(0)' },
              { transform: 'translateY(' + dy + 'px)' },
              { transform: 'translateY(0)' },
            ],
            { duration: 260, delay: delay, easing: 'ease-out' },
          );
        }
        function pt(x, y, s, o) {
          return {
            transform: 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) scale(' + s + ')',
            opacity: o,
          };
        }
        var x0 = r.right + stop + 10 - t.left;
        items.forEach(function (el, n) {
          var w = sizes[n].width,
            h = sizes[n].height;
          var gx = x0,
            gy = ground - h;
          x0 += w + 4;
          var ax = bedX + stop - w / 2,
            ay = bedY - h / 2;
          // Waits at the stop, hops into the truck, rides along hidden, then is delivered.
          var up = 2250 + n * 520,
            land = up + 560;
          var dx = bedX - w / 2,
            outX = dx + out * (46 + n * 30);
          var drop = t.height + 30;
          var unload = 6050 + n * 380;
          el.animate(
            [
              Object.assign({ offset: 0 }, pt(gx, gy, 0, 0)),
              Object.assign({ offset: at(1500 + n * 120), easing: 'ease-out' }, pt(gx, gy, 0, 0)),
              Object.assign({ offset: at(1800 + n * 120) }, pt(gx, gy - 6, 1.1, 1)),
              Object.assign({ offset: at(1950 + n * 120) }, pt(gx, gy, 1, 1)),
              Object.assign({ offset: at(up), easing: 'ease-out' }, pt(gx, gy, 1, 1)),
              Object.assign(
                { offset: at(up + 300), easing: 'ease-in' },
                pt((gx + ax) / 2, Math.max(2, Math.min(gy, ay) - 34), 1, 1),
              ),
              Object.assign({ offset: at(land) }, pt(ax, ay, 0.45, 0)),
              Object.assign({ offset: at(unload) }, pt(dx, ay, 0.45, 0)),
              Object.assign(
                { offset: at(unload + 200), easing: 'ease-out' },
                pt(dx, Math.max(2, ay - 8), 1, 1),
              ),
              Object.assign(
                { offset: at(unload + 480), easing: 'ease-in' },
                pt((dx + outX) / 2, Math.max(2, ay - 30), 1, 1),
              ),
              Object.assign({ offset: at(unload + 900) }, pt(outX, drop, 1, 0)),
              Object.assign({ offset: 1 }, pt(outX, drop, 1, 0)),
            ],
            { duration: ms },
          );
          squat(land - 80, 3);
          squat(unload, -2);
        });
        setTimeout(function () {
          layer.remove();
          shade.remove();
          depth.forEach(function (el) {
            el.remove();
          });
          brand.classList.remove('drive');
          top.classList.remove('driving');
        }, ms + 50);
      };
      if (tripImg && !tripImg.complete) tripImg.addEventListener('load', trip, { once: true });
      else if (tripImg) trip();
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
