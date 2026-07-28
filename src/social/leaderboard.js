/**
 * Boot-shell leaderboard — verified X login (OAuth 1.0a) to post.
 */

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = (s / 60) | 0;
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

function fmtScore(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  return v.toLocaleString('en-US');
}

function labelFor(row) {
  const handle = (row?.handle || '').replace(/^@/, '').trim();
  const name = (row?.name || '').trim();
  if (name && handle && name.toLowerCase() !== handle.toLowerCase()) {
    return { primary: name, secondary: `@${handle}` };
  }
  if (handle) return { primary: `@${handle}`, secondary: '' };
  if (name) return { primary: name, secondary: '' };
  return { primary: 'unknown', secondary: '' };
}

/** Avatar URL for a board row — prefer stored image, else free handle-based art. */
function avatarUrlFor(row) {
  const stored = (row?.image || '').trim();
  if (stored) return stored;
  const handle = (row?.handle || '').replace(/^@/, '').trim();
  if (!handle) return '';
  // ui-avatars always works; unavatar is flaky for X now.
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(handle)}&background=1d9bf0&color=fff&size=64&bold=true`;
}

function personSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 16');
  svg.setAttribute('class', 'boot-lb-ico boot-lb-ico-ally');
  svg.setAttribute('aria-hidden', 'true');
  const head = document.createElementNS(ns, 'circle');
  head.setAttribute('cx', '6');
  head.setAttribute('cy', '3.2');
  head.setAttribute('r', '2.4');
  const body = document.createElementNS(ns, 'path');
  body.setAttribute(
    'd',
    'M2.2 14.8 V9.2 C2.2 7.1 3.9 5.8 6 5.8 S9.8 7.1 9.8 9.2 V14.8',
  );
  svg.append(head, body);
  return svg;
}

function tombSvg() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 16');
  svg.setAttribute('class', 'boot-lb-ico boot-lb-ico-tomb');
  svg.setAttribute('aria-hidden', 'true');
  const stone = document.createElementNS(ns, 'path');
  stone.setAttribute(
    'd',
    'M3.2 14.5 V6.2 C3.2 4.1 4.5 2.8 6 2.8 S8.8 4.1 8.8 6.2 V14.5',
  );
  const base = document.createElementNS(ns, 'rect');
  base.setAttribute('x', '2');
  base.setAttribute('y', '13.2');
  base.setAttribute('width', '8');
  base.setAttribute('height', '1.8');
  const crossV = document.createElementNS(ns, 'rect');
  crossV.setAttribute('x', '5.55');
  crossV.setAttribute('y', '5.2');
  crossV.setAttribute('width', '0.9');
  crossV.setAttribute('height', '4.2');
  const crossH = document.createElementNS(ns, 'rect');
  crossH.setAttribute('x', '4.2');
  crossH.setAttribute('y', '6.4');
  crossH.setAttribute('width', '3.6');
  crossH.setAttribute('height', '0.9');
  svg.append(stone, base, crossV, crossH);
  return svg;
}

function alliesIcons(alive) {
  const wrap = document.createElement('span');
  wrap.className = 'boot-lb-allies';
  const n = Math.max(0, Math.min(3, Math.floor(alive ?? 0)));
  wrap.title =
    n === 0
      ? 'Squad wiped · 1× multiplier'
      : `${n}/3 allies up · ${n}× multiplier`;
  for (let i = 0; i < 3; i++) {
    wrap.appendChild(i < n ? personSvg() : tombSvg());
  }
  return wrap;
}

/**
 * @param {import('./auth.js').SocialAuth | null} social
 * @param {ParentNode} [root=document]
 */
export function bindLeaderboard(social, root = document) {
  const col = root.querySelector('#boot-leaderboard');
  if (!col) return { dispose() {} };

  const listEl = col.querySelector('#boot-lb-list');
  const statusEl = col.querySelector('#boot-lb-status');
  const authEl = col.querySelector('#boot-lb-auth');
  const loginBtn = col.querySelector('#boot-lb-login');
  const logoutBtn = col.querySelector('#boot-lb-logout');
  const whoEl = col.querySelector('#boot-lb-who');
  const ctaEl = authEl?.querySelector('.boot-lb-cta') ?? null;

  let profileEl = authEl?.querySelector('.boot-lb-profile') ?? null;
  if (authEl && !profileEl) {
    profileEl = document.createElement('div');
    profileEl.className = 'boot-lb-profile';
    profileEl.hidden = true;
    profileEl.innerHTML = `
      <img class="boot-lb-avatar" alt="" width="36" height="36" decoding="async" />
      <div class="boot-lb-profile-text">
        <span class="boot-lb-profile-name"></span>
        <span class="boot-lb-profile-handle"></span>
      </div>
    `;
    if (ctaEl) authEl.insertBefore(profileEl, ctaEl);
    else authEl.prepend(profileEl);
  }
  const avatarEl = profileEl?.querySelector('.boot-lb-avatar') ?? null;
  const nameEl = profileEl?.querySelector('.boot-lb-profile-name') ?? null;
  const handleEl = profileEl?.querySelector('.boot-lb-profile-handle') ?? null;

  let unsub = null;

  if (!social) {
    if (statusEl) statusEl.textContent = 'Leaderboard offline';
    return { dispose() {} };
  }

  const renderBoard = (state) => {
    if (!listEl) return;
    const board = state.board;
    listEl.replaceChildren();

    if (!state.boardLoaded) {
      if (statusEl) statusEl.textContent = 'Loading…';
      return;
    }
    if (state.error && !board?.length) {
      if (statusEl) statusEl.textContent = `Board error: ${state.error}`;
      return;
    }
    if (!board?.length) {
      if (statusEl) statusEl.textContent = 'No scores yet — be the first.';
      return;
    }

    if (statusEl) statusEl.textContent = '';
    for (const row of board) {
      const li = document.createElement('li');
      li.className = 'boot-lb-row' + (row.isYou ? ' is-you' : '');

      const rank = document.createElement('span');
      rank.className = 'boot-lb-rank';
      rank.textContent = String(row.rank);

      const nameWrap = document.createElement('span');
      nameWrap.className = 'boot-lb-name';
      const { primary, secondary } = labelFor(row);

      const avSrc = avatarUrlFor(row);
      if (avSrc) {
        const av = document.createElement('img');
        av.className =
          'boot-lb-row-avatar' + (row?.image ? '' : ' is-fallback');
        av.src = avSrc;
        av.alt = '';
        av.width = 22;
        av.height = 22;
        av.decoding = 'async';
        av.referrerPolicy = 'no-referrer';
        av.onerror = () => {
          const h = (row?.handle || primary || '?').replace(/^@/, '');
          av.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(h.slice(0, 2))}&background=1d9bf0&color=fff&size=64&bold=true`;
          av.onerror = null;
        };
        nameWrap.appendChild(av);
      }

      const textCol = document.createElement('span');
      textCol.className = 'boot-lb-name-text';
      const primaryEl = document.createElement('span');
      primaryEl.className = 'boot-lb-primary';
      primaryEl.textContent = primary;
      textCol.appendChild(primaryEl);
      if (secondary) {
        const sec = document.createElement('span');
        sec.className = 'boot-lb-secondary';
        sec.textContent = secondary;
        textCol.appendChild(sec);
      }
      nameWrap.appendChild(textCol);

      const time = document.createElement('span');
      time.className = 'boot-lb-time';
      time.textContent = mmss(row.timeSurvived);

      const allies = alliesIcons(row.alliesAlive ?? 0);

      const score = document.createElement('span');
      score.className = 'boot-lb-score';
      const pts = row.combatPoints ?? 0;
      const mult = Math.max(1, Math.min(3, row.alliesAlive ?? 0));
      score.textContent = fmtScore(row.score);
      score.title = `(${Math.floor(row.timeSurvived)}s + ${pts} pts) × ${mult}`;

      li.append(rank, nameWrap, time, allies, score);
      listEl.appendChild(li);
    }
  };

  const renderAuth = (state) => {
    if (!authEl) return;
    const { me, isAuthenticated } = state;

    if (isAuthenticated) {
      if (loginBtn) loginBtn.hidden = true;
      if (logoutBtn) logoutBtn.hidden = false;
      if (whoEl) whoEl.hidden = true;

      if (profileEl) {
        profileEl.hidden = false;
        const handle = (me?.handle || '').replace(/^@/, '');
        const display = (me?.name || '').trim();
        // Prefer X display name (e.g. "Sid Riff"), @handle underneath.
        if (nameEl) {
          nameEl.textContent =
            display && display.toLowerCase() !== handle.toLowerCase()
              ? display
              : handle
                ? `@${handle}`
                : 'Operator';
        }
        if (handleEl) {
          if (
            display &&
            handle &&
            display.toLowerCase() !== handle.toLowerCase()
          ) {
            handleEl.textContent = `@${handle}`;
            handleEl.hidden = false;
          } else {
            handleEl.textContent = '';
            handleEl.hidden = true;
          }
        }
        if (avatarEl) {
          const label =
            display && display.toLowerCase() !== handle.toLowerCase()
              ? display
              : handle
                ? `@${handle}`
                : 'Operator';
          const src =
            me?.image ||
            (handle
              ? `https://ui-avatars.com/api/?name=${encodeURIComponent(handle)}&background=1d9bf0&color=fff&size=128&bold=true`
              : '');
          if (src) {
            avatarEl.src = src;
            avatarEl.hidden = false;
            avatarEl.alt = label;
            avatarEl.referrerPolicy = 'no-referrer';
            avatarEl.onerror = () => {
              if (handle) {
                avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(handle.slice(0, 2))}&background=1d9bf0&color=fff&size=128&bold=true`;
                avatarEl.onerror = null;
              } else {
                avatarEl.hidden = true;
              }
            };
          } else {
            avatarEl.removeAttribute('src');
            avatarEl.hidden = true;
          }
        }
      }

      if (ctaEl) {
        ctaEl.textContent =
          me?.bestTimeSurvived != null
            ? `Best ${mmss(me.bestTimeSurvived)} · scores auto-post`
            : 'Play a match — your score posts on the board';
      }
    } else {
      if (loginBtn) loginBtn.hidden = false;
      if (logoutBtn) logoutBtn.hidden = true;
      if (profileEl) profileEl.hidden = true;
      if (ctaEl) {
        ctaEl.textContent = 'Log in with X to post scores (verified @handle)';
      }
    }
  };

  loginBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (statusEl) statusEl.textContent = 'Opening X login…';
    void social
      .signInWithX()
      .then(() => {
        if (statusEl && !social.isAuthenticated) statusEl.textContent = '';
      })
      .catch((err) => {
        const msg = String(err?.message ?? err);
        if (statusEl) statusEl.textContent = msg.slice(0, 140);
        console.error(err);
      });
  });

  logoutBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    void social.signOut();
  });

  unsub = social.subscribe((state) => {
    renderBoard(state);
    renderAuth(state);
    if (state.error && statusEl && !state.isAuthenticated) {
      statusEl.textContent = state.error.slice(0, 140);
    }
  });

  return {
    dispose() {
      unsub?.();
    },
  };
}
