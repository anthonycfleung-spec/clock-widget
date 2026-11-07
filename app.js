/* MindLock — mentalism lock-screen prop. All state is local to this device. */
(() => {
  'use strict';

  const LS_LOG = 'mindlock.log';
  const LS_CFG = 'mindlock.cfg';
  const LS_LOCKSHOT = 'mindlock.lockshot';   // data URL of a real lock-screen screenshot
  const LS_HOMESHOT = 'mindlock.homeshot';   // data URL of a real home-screen screenshot
  const CAP_MAX = 50;

  const DEFAULT_CFG = {
    unlockAttempt: 3,        // after this many tries -> reveal (home screenshot) or lock screen
    master: '0000',          // typed on keypad -> opens the calorie app (blank = disabled)
    badgeSrc: 'latest',      // 'latest' | 'first' — which captured code the badge shows
    dateOrder: 'MMDD',       // 'MMDD' | 'DDMM'
    eventTitle: 'Do duo lingo',
    wallpaper: '',           // data URL, optional (rendered lock fallback)
    badgeX: 78,              // reveal badge position, % of width  (over the folder)
    badgeY: 20               // reveal badge position, % of height
  };

  const ZODIAC = [
    ['Capricorn', '♑', 1, 19], ['Aquarius', '♒', 2, 18],
    ['Pisces', '♓', 3, 20], ['Aries', '♈', 4, 19],
    ['Taurus', '♉', 5, 20], ['Gemini', '♊', 6, 20],
    ['Cancer', '♋', 7, 22], ['Leo', '♌', 8, 22],
    ['Virgo', '♍', 9, 22], ['Libra', '♎', 10, 22],
    ['Scorpio', '♏', 11, 21], ['Sagittarius', '♐', 12, 21],
    ['Capricorn', '♑', 12, 31]
  ];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // ---------- storage ----------
  const readJSON = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  let cfg = Object.assign({}, DEFAULT_CFG, readJSON(LS_CFG, {}));
  let log = readJSON(LS_LOG, []);
  let lockShot = '', homeShot = '';
  try { lockShot = localStorage.getItem(LS_LOCKSHOT) || ''; } catch {}
  try { homeShot = localStorage.getItem(LS_HOMESHOT) || ''; } catch {}
  const saveCfg = () => writeJSON(LS_CFG, cfg);
  const saveLog = () => writeJSON(LS_LOG, log);

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  function daysInMonth(m) { return [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]; }

  function decodeDate(code) {
    if (!/^\d{4}$/.test(code)) return null;
    let m, d;
    if (cfg.dateOrder === 'DDMM') { d = +code.slice(0, 2); m = +code.slice(2); }
    else { m = +code.slice(0, 2); d = +code.slice(2); }
    if (m < 1 || m > 12 || d < 1 || d > daysInMonth(m)) return null;
    return { m, d };
  }
  function zodiacFor(m, d) {
    for (const [name, sym, zm, zd] of ZODIAC) {
      if (m < zm || (m === zm && d <= zd)) return { name, sym };
    }
    return { name: 'Capricorn', sym: '♑' };
  }

  // Downscale an uploaded screenshot and re-encode as JPEG so it fits in storage.
  function fileToScaledDataURL(file, maxW, cb) {
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        try { cb(c.toDataURL('image/jpeg', 0.85)); } catch { cb(r.result); }
      };
      img.onerror = () => cb(r.result);
      img.src = r.result;
    };
    r.readAsDataURL(file);
  }
  function tryStore(key, val) {
    try { localStorage.setItem(key, val); return true; }
    catch { alert('That image is too large to save on this device. Try a smaller screenshot.'); return false; }
  }

  // ---------- real app-icon badge (Badging API, installed PWA on iOS 16.4+) ----------
  function revealCode() {
    if (!log.length) return null;
    return (cfg.badgeSrc === 'first' ? log[0] : log[log.length - 1]).code;
  }
  function syncBadge() {
    if (!('setAppBadge' in navigator)) return;
    const rc = revealCode();
    const n = rc != null ? parseInt(rc, 10) : 0;
    try {
      if (n > 0) navigator.setAppBadge(n).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    } catch {}
  }
  function clearBadge() {
    if ('clearAppBadge' in navigator) { try { navigator.clearAppBadge().catch(() => {}); } catch {} }
  }

  // ---------- screens ----------
  let placing = false;
  function show(name) {
    $$('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === name));
    if (name === 'lock') { attempts = 0; entry = ''; renderDots(); applyLockShot(); }
    if (name === 'reveal') renderReveal();
    if (name === 'cal') { closeSheet(); renderCal(); }
  }

  // ---------- clock ----------
  function tick() {
    const now = new Date();
    let t = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
      .replace(/\s?[AP]M$/i, '').trim();
    $('#lock-time').textContent = t;
    const d = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      .replace(/,/g, '');
    $('#lock-date').textContent = d;
    const cd = $('#cal-day');
    if (cd) cd.textContent = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  // ---------- wallpaper / event / screenshots ----------
  function applyCfgToUI() {
    if (cfg.wallpaper) {
      document.documentElement.style.setProperty('--wall', `url("${cfg.wallpaper}") center/cover no-repeat`);
    } else {
      document.documentElement.style.removeProperty('--wall');
    }
    $('#w-event-title').textContent = cfg.eventTitle || 'Do duo lingo';
  }
  function applyLockShot() {
    const el = $('#lock-shot');
    if (lockShot) { el.style.backgroundImage = `url("${lockShot}")`; el.hidden = false; }
    else { el.hidden = true; el.style.backgroundImage = ''; }
  }

  // ---------- passcode ----------
  let entry = '';
  let attempts = 0;
  const dots = $$('#pc-dots span');
  function renderDots() {
    dots.forEach((s, i) => s.classList.toggle('filled', i < entry.length));
    $('#pc-cancel').textContent = entry.length ? 'Delete' : 'Cancel';
  }
  function resetEntry() { entry = ''; renderDots(); }

  function pressDigit(d) {
    if (entry.length >= 4) return;
    entry += d;
    renderDots();
    if (entry.length === 4) {
      const code = entry;
      // Secret entry code -> calorie app, not logged, does not count as an attempt.
      if (cfg.master && code === cfg.master) {
        setTimeout(() => { resetEntry(); attempts = 0; show('cal'); }, 120);
        return;
      }
      capture(code);
      attempts++;
      const n = parseInt(cfg.unlockAttempt, 10) || 0;
      if (n > 0 && attempts >= n) {
        // Reveal: the home-screen screenshot with the badge over the folder.
        setTimeout(() => { resetEntry(); attempts = 0; show(homeShot ? 'reveal' : 'lock'); }, 240);
      } else {
        setTimeout(fail, 130);
      }
    }
  }
  function fail() {
    const box = $('#pc-dots');
    box.classList.add('shake');
    setTimeout(() => { box.classList.remove('shake'); resetEntry(); }, 400);
  }
  function capture(code) {
    log.push({ code, ts: Date.now() });
    if (log.length > CAP_MAX) log = log.slice(-CAP_MAX);
    saveLog();
    syncBadge();
  }

  // ---------- reveal (home screenshot + badge) ----------
  function positionBadge() {
    const b = $('#reveal-badge');
    b.style.left = cfg.badgeX + '%';
    b.style.top = cfg.badgeY + '%';
  }
  function renderReveal() {
    const img = $('#reveal-img');
    if (homeShot) { img.style.backgroundImage = `url("${homeShot}")`; img.hidden = false; }
    else { img.hidden = true; img.style.backgroundImage = ''; }
    const rc = revealCode();
    const b = $('#reveal-badge');
    b.textContent = rc || '0';
    b.hidden = !rc && !placing;
    positionBadge();
    b.classList.toggle('placing', placing);
    $('#place-bar').hidden = !placing;
  }

  // ---------- calorie app (reveal decode + settings) ----------
  function mealIcon(hr) {
    if (hr < 11) return '🥞';
    if (hr < 16) return '🥗';
    if (hr < 21) return '🍝';
    return '🍎';
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  function renderCal() {
    const list = $('#cal-list'); list.innerHTML = '';
    $('#cal-count').textContent = log.length + (log.length === 1 ? ' entry' : ' entries');

    const food = Math.min(2000, 320 + log.length * 80);
    const remain = 2000 - food;
    $('#cal-food').textContent = food.toLocaleString();
    $('#cal-remain').textContent = remain.toLocaleString();
    const circ = 2 * Math.PI * 52;
    $('#cal-ring-fg').style.strokeDashoffset = String(circ * (1 - food / 2000));

    if (!log.length) {
      const e = document.createElement('div');
      e.className = 'cal-empty'; e.textContent = 'No entries logged today.';
      list.appendChild(e);
      return;
    }
    [...log].reverse().forEach(item => {
      const dd = decodeDate(item.code);
      const hr = new Date(item.ts).getHours();
      const row = document.createElement('div');
      row.className = 'meal' + (dd ? '' : ' invalid');

      const ico = document.createElement('div');
      ico.className = 'meal-ico'; ico.textContent = mealIcon(hr);

      const main = document.createElement('div'); main.className = 'meal-main';
      const name = document.createElement('div'); name.className = 'meal-name';
      const sub = document.createElement('div'); sub.className = 'meal-sub';
      if (dd) {
        const z = zodiacFor(dd.m, dd.d);
        name.textContent = `${z.sym} ${z.name}`;
        sub.textContent = `${MONTHS[dd.m - 1]} ${dd.d} · ${item.code} · ${fmtTime(item.ts)}`;
      } else {
        name.textContent = 'Logged';
        sub.textContent = `${item.code} · not a date · ${fmtTime(item.ts)}`;
      }
      main.appendChild(name); main.appendChild(sub);

      const cal = document.createElement('div'); cal.className = 'meal-cal';
      const b = document.createElement('b'); b.textContent = String(parseInt(item.code, 10));
      const s = document.createElement('small'); s.textContent = 'cal';
      cal.appendChild(b); cal.appendChild(s);

      row.appendChild(ico); row.appendChild(main); row.appendChild(cal);
      list.appendChild(row);
    });
  }

  // ---------- settings sheet ----------
  function openSheet() {
    $('#set-attempts').value = (cfg.unlockAttempt ?? 3);
    $('#set-master').value = cfg.master || '';
    $('#set-badge-src').value = cfg.badgeSrc;
    $('#set-dateorder').value = cfg.dateOrder;
    $('#set-event').value = cfg.eventTitle || '';
    $('#set-lockshot-state').textContent = lockShot ? 'uploaded ✓' : 'none';
    $('#set-homeshot-state').textContent = homeShot ? 'uploaded ✓' : 'none';
    $('#menu-help').textContent =
      'Get in: long-press the "Enter Passcode" title, or type your secret code (' +
      (cfg.master || 'off') + '). Upload a real screenshot of your lock screen and home screen for a ' +
      'pixel-perfect prop. After ' + (cfg.unlockAttempt || '∞') + ' tries it shows your home screenshot ' +
      'with the entered number badged over your folder — set that spot with "Set badge position". This ' +
      'list decodes each code to a star sign + birthday.';
    $('#cal-sheet').hidden = false;
  }
  function closeSheet() { $('#cal-sheet').hidden = true; }

  // ---------- long-press / gesture helper ----------
  function onLongPress(el, ms, fn) {
    let timer = null, sx = 0, sy = 0;
    const start = e => {
      const p = e.touches ? e.touches[0] : e;
      sx = p.clientX; sy = p.clientY;
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    };
    const move = e => {
      if (!timer) return;
      const p = e.touches ? e.touches[0] : e;
      if (Math.abs(p.clientX - sx) > 10 || Math.abs(p.clientY - sy) > 10) cancel();
    };
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: true });
    el.addEventListener('touchend', cancel);
    el.addEventListener('mousedown', start);
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseup', cancel);
    el.addEventListener('mouseleave', cancel);
  }

  // swipe-up detector
  function onSwipeUp(el, fn) {
    let sy = null;
    el.addEventListener('touchstart', e => { sy = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', e => {
      if (sy == null) return;
      const ey = (e.changedTouches[0] || {}).clientY ?? sy;
      if (sy - ey > 60) fn();
      sy = null;
    });
  }

  // ---------- wiring ----------
  function init() {
    applyCfgToUI();
    applyLockShot();
    tick();
    setInterval(tick, 15000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    syncBadge();

    // Lock -> passcode
    const lock = $('#screen-lock');
    lock.addEventListener('click', () => show('passcode'));
    onSwipeUp(lock, () => show('passcode'));

    // Keypad
    $('#keypad').addEventListener('click', e => {
      const k = e.target.closest('.key[data-d]');
      if (k) pressDigit(k.dataset.d);
    });
    // Right foot button: Delete a digit, or Cancel back to lock when empty.
    $('#pc-cancel').addEventListener('click', () => {
      if (entry.length > 0) { entry = entry.slice(0, -1); renderDots(); }
      else { resetEntry(); show('lock'); }
    });
    $('#pc-emergency').addEventListener('click', e => e.preventDefault());

    // Secret entry: long-press passcode title -> calorie app
    onLongPress($('#pc-title'), 850, () => { resetEntry(); show('cal'); });

    // Reveal screen: tap to place the badge (placement mode); long-press -> calorie app
    $('#screen-reveal').addEventListener('click', e => {
      if (!placing || e.target.closest('#place-bar')) return;
      const r = $('#screen-reveal').getBoundingClientRect();
      cfg.badgeX = +(((e.clientX - r.left) / r.width) * 100).toFixed(1);
      cfg.badgeY = +(((e.clientY - r.top) / r.height) * 100).toFixed(1);
      positionBadge();
    });
    onLongPress($('#screen-reveal'), 850, () => { if (!placing) show('cal'); });
    $('#place-done').addEventListener('click', () => { placing = false; saveCfg(); show('cal'); });

    // Calorie app: gear -> settings sheet
    $('#cal-gear').addEventListener('click', openSheet);
    $('#cal-sheet-close').addEventListener('click', closeSheet);
    $('#cal-to-lock').addEventListener('click', () => { closeSheet(); show('lock'); });
    $('#cal-sheet').addEventListener('click', e => { if (e.target === $('#cal-sheet')) closeSheet(); });

    // Settings fields
    $('#set-attempts').addEventListener('change', e => {
      const v = parseInt(e.target.value.replace(/\D/g, ''), 10);
      cfg.unlockAttempt = isNaN(v) ? 0 : Math.min(v, 20);
      e.target.value = cfg.unlockAttempt; saveCfg();
    });
    $('#set-master').addEventListener('change', e => { cfg.master = e.target.value.replace(/\D/g, '').slice(0, 4); saveCfg(); });
    $('#set-badge-src').addEventListener('change', e => { cfg.badgeSrc = e.target.value; saveCfg(); syncBadge(); });
    $('#set-dateorder').addEventListener('change', e => { cfg.dateOrder = e.target.value; saveCfg(); renderCal(); });
    $('#set-event').addEventListener('change', e => { cfg.eventTitle = e.target.value; saveCfg(); applyCfgToUI(); });

    $('#set-lockshot').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      fileToScaledDataURL(f, 1100, url => {
        if (tryStore(LS_LOCKSHOT, url)) { lockShot = url; applyLockShot(); $('#set-lockshot-state').textContent = 'uploaded ✓'; }
      });
    });
    $('#set-homeshot').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      fileToScaledDataURL(f, 1100, url => {
        if (tryStore(LS_HOMESHOT, url)) { homeShot = url; $('#set-homeshot-state').textContent = 'uploaded ✓'; }
      });
    });
    $('#set-place-badge').addEventListener('click', e => {
      e.preventDefault();
      if (!homeShot) { alert('Upload a home-screen screenshot first.'); return; }
      placing = true; closeSheet(); show('reveal');
    });
    $('#set-lockshot-clear').addEventListener('click', e => {
      e.preventDefault(); lockShot = ''; try { localStorage.removeItem(LS_LOCKSHOT); } catch {}
      applyLockShot(); $('#set-lockshot-state').textContent = 'none';
    });
    $('#set-homeshot-clear').addEventListener('click', e => {
      e.preventDefault(); homeShot = ''; try { localStorage.removeItem(LS_HOMESHOT); } catch {}
      $('#set-homeshot-state').textContent = 'none';
    });

    $('#set-wallpaper').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0]; if (!f) return;
      fileToScaledDataURL(f, 1100, url => { cfg.wallpaper = url; saveCfg(); applyCfgToUI(); });
    });
    $('#set-wallpaper-clear').addEventListener('click', e => {
      e.preventDefault(); cfg.wallpaper = ''; saveCfg(); applyCfgToUI();
    });
    $('#set-badge-clear').addEventListener('click', e => { e.preventDefault(); clearBadge(); });
    $('#set-clear').addEventListener('click', e => {
      e.preventDefault();
      if (confirm('Clear all captured codes?')) { log = []; saveLog(); clearBadge(); renderCal(); }
    });

    // Block context menu / selection long-press everywhere except our handlers
    document.addEventListener('contextmenu', e => e.preventDefault());

    show('lock');
  }

  document.addEventListener('DOMContentLoaded', init);

  // Service worker (offline)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
