(function () {
  var site = document.getElementById('site');
  var T = {
    ar: {
      hello: 'أهلاً بيك في نولون 👋\nأنا وكيل نولون. أحسب لك سعر شحنتك، أجهز لك طلب الحجز، وأتابع لك شحنتك لحدي ما توصل.\nالمحادثة هنا في الموقع حتفتح قريباً، وهسة تقدر تكلمني في تليغرام 👇',
      chips: [['price', 'سعر شحنة'], ['track', 'تتبّع شحنة'], ['outlet', 'أقرب منفذ'], ['partner', 'أبقى شريك']],
      q: { price: 'عايز أشحن برميلين من جدة للخرطوم', track: 'وين وصلت شحنتي BK00142؟', outlet: 'وين أقرب منفذ في جدة؟', partner: 'عندي مكتب سفريات وعايز أبقى شريك' },
      a: {
        price: 'تمام. البرميل من جدة إلى الخرطوم بسعر ثابت، وحأرسل لك هنا عرض السعر كامل.\nعشان أجهز طلب الحجز محتاج: اسم المستلم ورقم هاتفه في الخرطوم.\nبعدها موظف نولون يراجع الطلب ويأكده ليك.',
        track: 'شحنتك BK00142 وصلت بورتسودان يوم 8 نوفمبر، وهي الآن في التخليص.\nالمحطة الجاية: النقل البري إلى الخرطوم.',
        outlet: 'منفذ جدة يستلم الكراتين والبراميل والباليتات. أرسل لك العنوان ورقم الهاتف هنا، وتقدر تجيب شحنتك في أوقات الدوام.',
        partner: 'ممتاز! منافذ نولون الشريكة تستلم الشحنات بأسعارنا الثابتة وتأخذ عمولة على كل شحنة.\nاكتب لي اسم المكتب والمدينة ورقم التواصل، وفريق نولون يتواصل معاك.'
      },
      fallback: 'شكراً على رسالتك. المحادثة المباشرة لسه ما اشتغلت، راسلنا على info@nolon.dev ونرد عليك.',
      ph: 'اكتب رسالتك…',
      track: 'في الموقع الحقيقي، الزر ده يفتح صفحة التتبع في نظام نولون برقم {r}.',
      need: 'اكتب رقم الحجز أو الشحنة أولاً.'
    },
    en: {
      hello: 'Welcome to Nolon 👋\nI\'m the Nolon assistant. I price your cargo, prepare your booking and follow your shipment until it arrives.\nChat here on the website opens soon; right now you can talk to me on Telegram 👇',
      chips: [['price', 'Get a price'], ['track', 'Track a shipment'], ['outlet', 'Nearest outlet'], ['partner', 'Become a partner']],
      q: { price: 'I want to ship two barrels from Jeddah to Khartoum', track: 'Where is my shipment BK00142?', outlet: 'Where is the nearest outlet in Jeddah?', partner: 'I run a travel office and want to become a partner' },
      a: {
        price: 'Sure. Barrels from Jeddah to Khartoum have a fixed price, and I will send you the full quote right here.\nTo prepare the booking request I need the receiver\'s name and phone number in Khartoum.\nA Nolon employee then checks the request and confirms it.',
        track: 'Your shipment BK00142 arrived in Port Sudan on 8 November and is in customs now.\nNext stage: road transport to Khartoum.',
        outlet: 'The Jeddah outlet takes cartons, barrels and pallets. I will send you its address and phone number here; drop your cargo during working hours.',
        partner: 'Great! Nolon partner outlets take shipments at our fixed prices and earn a commission on each one.\nSend me your office name, city and phone, and the Nolon team will contact you.'
      },
      fallback: 'Thanks for your message. Live chat is not open yet; email info@nolon.dev and we will reply.',
      ph: 'Type a message…',
      track: 'On the live site, this opens the tracking page in the Nolon system for {r}.',
      need: 'Enter a booking or shipment number first.'
    }
  };
  function L() { return site.getAttribute('lang') === 'en' ? 'en' : 'ar'; }

  var chat = document.getElementById('chat');
  var msgs = document.getElementById('msgs');
  var started = false;

  function add(text, who) {
    var d = document.createElement('div');
    d.className = 'm ' + who;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function renderChips() {}
  function ask(key) {
    add(T[L()].q[key], 'me');
    setTimeout(function () { add(T[L()].a[key], 'bot'); }, 450);
  }
  function openChat(topic) {
    chat.hidden = false;
    if (!started) { started = true; add(T[L()].hello, 'bot'); }
    if (topic) ask(topic);
    var cta = chat.querySelector('.tg'); if (cta) cta.focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-open-chat]').forEach(function (b) {
    b.addEventListener('click', function () {
      hideBubble();
      if (b.id === 'fab' && !chat.hidden) { chat.hidden = true; return; }
      openChat(b.getAttribute('data-ask'));
    });
  });
  document.getElementById('chat-close').addEventListener('click', function () { chat.hidden = true; });

  document.getElementById('track-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var r = document.getElementById('ref').value.trim();
    var msg = document.getElementById('track-msg');
    if (!r) { msg.textContent = T[L()].need; return; }
    window.location.href = 'https://app.nolon.dev/' + L() + '/track';
  });

  document.getElementById('lang-btn').addEventListener('click', function () {
    var en = L() === 'ar';
    site.setAttribute('lang', en ? 'en' : 'ar');
    site.setAttribute('dir', en ? 'ltr' : 'rtl');
    document.documentElement.lang = en ? 'en' : 'ar';
    renderChips();
    try { localStorage.setItem('nolon-lang', en ? 'en' : 'ar'); } catch (err) {}
  });
  try {
    if (localStorage.getItem('nolon-lang') === 'en') { site.setAttribute('lang', 'en'); site.setAttribute('dir', 'ltr'); }
  } catch (err) {}
  renderChips();

  /* Mascot: greeting bubble once per visit, eyes that follow the pointer. */
  var bubble = document.getElementById('fab-bubble');
  function hideBubble() { if (bubble) bubble.hidden = true; }
  document.getElementById('fab-bubble-x').addEventListener('click', hideBubble);
  var seen = false;
  try { seen = sessionStorage.getItem('nolon-hi') === '1'; } catch (err) {}
  if (!seen) {
    setTimeout(function () {
      if (!chat.hidden) return;
      bubble.hidden = false;
      try { sessionStorage.setItem('nolon-hi', '1'); } catch (err) {}
    }, 3500);
  }
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!still) {
    var eyes = Array.prototype.slice.call(document.querySelectorAll('.bot .pupil'));
    var px = 0, py = 0, queued = false;
    function look() {
      queued = false;
      eyes.forEach(function (g) {
        var r = g.ownerSVGElement.getBoundingClientRect();
        if (!r.width) return;
        var flip = site.getAttribute('dir') === 'rtl' ? -1 : 1;
        var dx = (px - (r.left + r.width / 2)) * flip, dy = py - (r.top + r.height / 2);
        var d = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.min(1, d / 260);
        g.setAttribute('transform', 'translate(' + (dx / d * 2.8 * k).toFixed(2) + ' ' + (dy / d * 3.4 * k).toFixed(2) + ')');
      });
    }
    window.addEventListener('pointermove', function (e) {
      px = e.clientX; py = e.clientY;
      if (!queued) { queued = true; requestAnimationFrame(look); }
    }, { passive: true });
  }
})();
