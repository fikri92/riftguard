// The HUD is DOM, drawn over the canvas, and every number on it is read from the simulation: health,
// armour, the magazine and its reserve, the round clock, the score, the money, and the live round
// banner. Nothing on this layer invents a value the simulation does not hold.
const HUD_HTML = `
<div id="vignette"></div>
<div id="hurt"></div>
<div id="crosshair"><i></i><i></i><i></i><i></i></div>
<div id="hitmarker"><i></i><i></i><i></i><i></i></div>
<div id="topbar">
  <div class="team a"><span class="label">RIFT</span><b id="score-a">0</b></div>
  <div class="clock"><b id="timer">1:55</b><span id="phase">BUY</span></div>
  <div class="team b"><b id="score-b">0</b><span class="label">WARDEN</span></div>
</div>
<div id="roundbanner" hidden><span id="banner-title"></span><span id="banner-sub"></span></div>
<div id="killfeed"></div>
<div id="vitals">
  <div class="bar"><span class="cap">HP</span><b id="health">100</b><i id="health-bar"></i></div>
  <div class="bar small"><span class="cap">AP</span><b id="armor">0</b></div>
</div>
<div id="ammo"><b id="mag">12</b><span id="reserve">/ 48</span><em id="wname">K-9</em></div>
<div id="money"><b id="money-value">800</b><span>CR</span></div>
<div id="obj"><i id="obj-dot"></i><span id="obj-text">No bomb</span></div>
<div id="buymenu" hidden>
  <h2>ARMORY <span id="buy-timer">18</span></h2>
  <ul id="buy-list"></ul>
  <p class="hint">1-4 buy · B close</p>
</div>
<div id="endscreen" hidden>
  <p id="end-kicker">ROUND OVER</p>
  <h1 id="end-title">ROUND</h1>
  <div id="end-score"><b class="a" id="end-a">0</b><span class="dash">—</span><b class="b" id="end-b">0</b></div>
  <div id="end-again">Press Enter to play again</div>
  <p id="end-sub"></p>
  <div id="end-stats">
    <div><b id="end-kills">0</b><span>Your kills</span></div>
    <div><b id="end-acc">0%</b><span>Accuracy</span></div>
    <div><b id="end-money">800</b><span>Credits</span></div>
  </div>
  <div id="end-keys"><kbd>ENTER</kbd> next round · <kbd>ESC</kbd> menu</div>
</div>
`;

export function createHud(root, buyItems) {
  root.innerHTML = HUD_HTML;
  const $ = (id) => root.querySelector(`#${id}`);
  const els = {
    health: $('health'), healthBar: $('health-bar'), armor: $('armor'),
    mag: $('mag'), reserve: $('reserve'), wname: $('wname'),
    timer: $('timer'), phase: $('phase'), scoreA: $('score-a'), scoreB: $('score-b'),
    money: $('money-value'), objText: $('obj-text'), objDot: $('obj-dot'),
    hitmarker: $('hitmarker'), hurt: $('hurt'),
    banner: $('roundbanner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
    buyMenu: $('buymenu'), buyList: $('buy-list'), buyTimer: $('buy-timer'),
    end: $('endscreen'), endTitle: $('end-title'), endSub: $('end-sub'), endAgain: $('end-again'),
    endKicker: $('end-kicker'), endA: $('end-a'), endB: $('end-b'),
    endKills: $('end-kills'), endAcc: $('end-acc'), endMoney: $('end-money'),
    killfeed: $('killfeed'),
  };

  // Build the buy list once; the prices come from weapon.js and never change at runtime.
  els.buyList.innerHTML = buyItems
    .map((item, i) => `<li data-id="${item.id}"><kbd>${i + 1}</kbd><b>${item.name ?? item.id}</b>
      <span class="price">${item.price}</span><em>${item.note}</em></li>`)
    .join('');

  let lastHealth = -1;
  let hurtTimer = 0;

  function pad(n) {
    return n < 10 ? `0${n}` : `${n}`;
  }

  return {
    els,
    setVitals(health, armor) {
      if (health !== lastHealth) {
        if (health < lastHealth && lastHealth > 0) {
          els.hurt.style.opacity = '0.55';
          hurtTimer = 0.28;
        }
        lastHealth = health;
      }
      els.health.textContent = String(Math.max(0, Math.round(health)));
      els.healthBar.style.width = `${Math.max(0, Math.min(100, health))}%`;
      els.healthBar.style.background = health > 60 ? 'var(--team)' : health > 28 ? 'var(--accent)' : 'var(--hostile)';
      els.armor.textContent = String(Math.max(0, Math.round(armor)));
    },
    setAmmo(mag, reserve, name) {
      els.mag.textContent = String(mag);
      els.reserve.textContent = `/ ${reserve}`;
      els.wname.textContent = name;
      els.mag.style.color = mag === 0 ? 'var(--hostile)' : mag <= 5 ? 'var(--accent)' : 'var(--ink)';
    },
    setClock(seconds, phaseLabel) {
      const s = Math.max(0, Math.ceil(seconds));
      els.timer.textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
      els.phase.textContent = phaseLabel;
      els.timer.style.color = s <= 10 ? 'var(--hostile)' : 'var(--ink)';
    },
    setScore(a, b) {
      els.scoreA.textContent = String(a);
      els.scoreB.textContent = String(b);
    },
    setMoney(value) {
      els.money.textContent = String(Math.round(value));
    },
    setObjective(text, live) {
      els.objText.textContent = text;
      els.objDot.style.background = live ? 'var(--hostile)' : 'var(--muted)';
      els.objDot.style.opacity = live && Math.floor(performance.now() / 320) % 2 === 0 ? '0.35' : '1';
    },
    hitMarker(headshot) {
      els.hitmarker.classList.add('on');
      els.hitmarker.style.filter = headshot ? 'brightness(1.9) saturate(0.4)' : 'none';
      setTimeout(() => els.hitmarker.classList.remove('on'), 110);
    },
    banner(title, sub, holdMs = 1500) {
      els.bannerTitle.textContent = title;
      els.bannerSub.textContent = sub;
      els.banner.hidden = false;
      clearTimeout(els.banner._t);
      els.banner._t = setTimeout(() => { els.banner.hidden = true; }, holdMs);
    },
    showBuy(open, secondsLeft) {
      els.buyMenu.hidden = !open;
      if (open && secondsLeft !== undefined) els.buyTimer.textContent = String(Math.ceil(secondsLeft));
    },
    highlightBuy(ids) {
      for (const li of els.buyList.children) {
        const id = li.dataset.id;
        li.classList.toggle('owned', ids.includes(id));
      }
    },
    showEnd(title, sub, stats) {
      els.endTitle.textContent = title;
      els.endSub.textContent = sub;
      if (stats !== undefined) {
        els.endA.textContent = String(stats.a);
        els.endB.textContent = String(stats.b);
        els.endKills.textContent = String(stats.kills);
        els.endAcc.textContent = `${stats.accuracy}%`;
        els.endMoney.textContent = String(stats.money);
        els.endKicker.textContent = stats.kicker ?? 'ROUND OVER';
      }
      els.endAgain.textContent = stats !== undefined && stats.mode === 'match'
        ? 'Press Enter to play again'
        : 'Press Enter for the next round';
      els.end.hidden = false;
    },
    hideEnd() {
      els.end.hidden = true;
    },
    killFeed(killer, victim, weaponName, headshot) {
      const row = document.createElement('div');
      row.className = 'feed-row';
      row.innerHTML = `<b>${killer}</b><span>${weaponName}${headshot ? ' ✦' : ''}</span><i>${victim}</i>`;
      els.killfeed.appendChild(row);
      setTimeout(() => row.remove(), 4200);
      while (els.killfeed.children.length > 5) els.killfeed.firstChild.remove();
    },
    step(dt) {
      if (hurtTimer > 0) {
        hurtTimer -= dt;
        if (hurtTimer <= 0) els.hurt.style.opacity = '0';
      }
    },
  };
}
