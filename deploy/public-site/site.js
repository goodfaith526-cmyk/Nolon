(function () {
  var site = document.getElementById('site');
  var T = {
    ar: {
      hello: 'أهلاً بيك في نولون 👋\nالمحادثة المباشرة مع وكيل نولون حتفتح هنا قريباً: حساب السعر، الحجز، ومتابعة شحنتك.\nلحدي داك راسلنا على info@nolon.dev',
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
      hello: 'Welcome to Nolon 👋\nLive chat with the Nolon assistant opens here soon: prices, bookings and shipment updates.\nUntil then, email us at info@nolon.dev',
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
  var chips = document.getElementById('chips');
  var input = document.getElementById('chat-input');
  var started = false;

  function add(text, who) {
    var d = document.createElement('div');
    d.className = 'm ' + who;
    d.textContent = text;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function renderChips() {
    chips.innerHTML = '';
    [].forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = c[1];
      b.addEventListener('click', function () { ask(c[0]); });
      chips.appendChild(b);
    });
    input.placeholder = T[L()].ph;
  }
  function ask(key) {
    add(T[L()].q[key], 'me');
    setTimeout(function () { add(T[L()].a[key], 'bot'); }, 450);
  }
  function openChat(topic) {
    chat.hidden = false;
    if (!started) { started = true; add(T[L()].hello, 'bot'); }
    if (topic) ask(topic);
    input.focus({ preventScroll: true });
  }
  document.querySelectorAll('[data-open-chat]').forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.id === 'fab' && !chat.hidden) { chat.hidden = true; return; }
      openChat(b.getAttribute('data-ask'));
    });
  });
  document.getElementById('chat-close').addEventListener('click', function () { chat.hidden = true; });
  document.getElementById('chat-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = input.value.trim();
    if (!v) return;
    add(v, 'me'); input.value = '';
    setTimeout(function () { add(T[L()].fallback, 'bot'); }, 450);
  });

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
})();
