/**
 * scorebook.js
 * Scaffold only — wires up the persistent header controls (mode toggle,
 * team toggle, section nav) and loads gameData.json so we have something
 * real to render against. The actual grid-building, modal input logic,
 * and Watch & Learn playback engine come next, once the structure below
 * is confirmed.
 */

(async function init() {
  const data = await window.MLBScorebook.loadGameData();
  console.log('Loaded gameData.json:', data);

  const INNINGS_SHOWN = 11; // wireframe shows 11 columns; extra innings appear blank until needed
  const HALF_FOR_TEAM = { away: 'top', home: 'bottom' };

  const state = { team: 'away', mode: 'watch-learn', userEdits: {}, revealedIndex: data.meta.startEventIndex, isPlaying: false, lineupOverrides: { away: null, home: null } };

  // The lineup currently in effect for a team — either the original simulated
  // lineup, or whatever's been substituted/auto-populated in via the UI.
  // Batting-order *numbers* never change, so this never breaks the grid's
  // match against playByPlay (which is keyed by battingOrder, not name).
  function currentLineup(team) {
    return state.lineupOverrides[team] || data.lineups[team];
  }

  // ---- Mode toggle: Watch & Learn vs True Fan -------------------------
  const modeButtons = document.querySelectorAll('[data-mode]');
  const saveBtn = document.getElementById('btn-save');
  const playbackControls = document.getElementById('playback-controls');

  function setMode(mode) {
    state.mode = mode;
    modeButtons.forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active);
    });

    const isTrueFan = mode === 'true-fan';
    playbackControls.classList.toggle('hidden', isTrueFan);

    // Save button only active in True Fan mode (spec)
    saveBtn.disabled = !isTrueFan;
    saveBtn.classList.toggle('bg-gray-300', !isTrueFan);
    saveBtn.classList.toggle('text-gray-500', !isTrueFan);
    saveBtn.classList.toggle('cursor-not-allowed', !isTrueFan);
    saveBtn.classList.toggle('bg-[var(--mlb-yellow)]', isTrueFan);
    saveBtn.classList.toggle('text-[var(--mlb-navy)]', isTrueFan);
  }

  modeButtons.forEach(btn => btn.addEventListener('click', () => {
    setMode(btn.dataset.mode);
    if (state.mode === 'true-fan') pausePlayback();
    renderOffenseDefense();
  }));

  saveBtn.addEventListener('click', () => {
    if (saveBtn.disabled) return;
    console.log('Saving True Fan edits:', state.userEdits);
    // TODO: persist to a backend; for the prototype we confirm visually.
    const original = saveBtn.textContent;
    saveBtn.textContent = 'Saved \u2713';
    setTimeout(() => { saveBtn.textContent = original; }, 1200);
  });

  // ---- Team hotlinks ----------------------------------------------------
  document.querySelectorAll('[data-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-team]').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.team = btn.dataset.team;
      renderLineup();
      renderPitching();
      renderOffenseDefense();
      scrollToLiveCell();
    });
  });

  // ---- Section hotlinks (Line Up / Pitching / Offence-Defense) ---------
  document.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-section]').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');

      document.querySelectorAll('[data-panel]').forEach(panel => panel.classList.add('hidden'));
      document.getElementById(`panel-${btn.dataset.section}`).classList.remove('hidden');
    });
  });

  // ---- Line Up panel ------------------------------------------------------
  const lineupList = document.getElementById('lineup-list');
  function renderLineup() {
    lineupList.innerHTML = '';
    const original = data.lineups[state.team];
    currentLineup(state.team).forEach((player, i) => {
      const isSub = player.name !== original[i].name;
      const row = document.createElement('div');
      row.dataset.battingOrder = player.battingOrder;
      row.className = 'flex items-center justify-between px-3 py-2.5 text-sm cursor-pointer hover:bg-amber-50 transition-colors';
      row.innerHTML = `
        <span class="text-gray-400 w-5">${player.battingOrder}</span>
        <span class="flex-1 font-medium text-[var(--mlb-ink)]">
          ${player.name}
          ${isSub ? `<span class="ml-1 text-[10px] font-bold text-white bg-[var(--mlb-navy)] px-1.5 py-0.5 rounded">SUB</span>` : ''}
        </span>
        <span class="text-gray-500 text-xs">${player.positionAbbr}</span>
      `;
      row.addEventListener('click', () => openSubstitutionModal(player, i));
      lineupList.appendChild(row);
    });
  }

  document.getElementById('btn-insert-lineup').addEventListener('click', () => {
    // Auto-populate action, per spec — pulls in the demo lineup defined in
    // gameData.json (sourced directly from the wireframe annotation).
    const original = data.lineups[state.team];
    state.lineupOverrides[state.team] = data.demoLineup.battingOrder.map((p, i) => ({
      battingOrder: original[i].battingOrder, // keep real batting-order numbers stable
      name: p.name,
      positionAbbr: p.positionAbbr,
      position: original[i].position,
      bats: original[i].bats,
    }));
    renderLineup();
    renderOffenseDefense();
  });

  // ---- Pitching panel -------------------------------------------------------
  const pitchingBody = document.getElementById('pitching-body');
  function renderPitching() {
    pitchingBody.innerHTML = '';
    data.pitchers[state.team].forEach(p => {
      const row = document.createElement('tr');
      row.className = 'border-t border-gray-100';
      row.innerHTML = `
        <td class="text-left pl-3 py-2 font-medium">${p.name}</td>
        <td>${p.throws}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
      `;
      pitchingBody.appendChild(row);
    });
  }

  // ---- Offence / Defense panel — the core scorebook grid -------------------
  const playerCol = document.getElementById('player-col');
  const atbatGrid = document.getElementById('atbat-grid');

  function eventsByBatterInning(team) {
    const half = HALF_FOR_TEAM[team];
    const map = {};
    data.playByPlay.forEach((ev, idx) => {
      if (ev.half !== half) return;
      const key = `${ev.battingOrder}-${ev.inning}`;
      if (!map[key]) map[key] = [];
      map[key].push({ ...ev, globalIndex: idx });
    });
    return map;
  }

  function renderOffenseDefense() {
    const team = state.team;
    const lineup = currentLineup(team);
    const byBatterInning = eventsByBatterInning(team);

    // Frozen left column: batting order, name, position — row height must
    // match the grid rows exactly so vertical scroll stays in sync.
    playerCol.innerHTML = '';
    lineup.forEach(player => {
      const row = document.createElement('div');
      row.className = 'h-[72px] flex flex-col justify-center px-2 border-b border-gray-100 text-[11px] leading-tight';
      row.innerHTML = `
        <span class="font-semibold text-[var(--mlb-ink)] truncate">${player.battingOrder}. ${player.name}</span>
        <span class="text-gray-400">${player.positionAbbr}</span>
      `;
      playerCol.appendChild(row);
    });

    // Grid: sticky inning header row + one row per batter, one cell per inning.
    const headerCells = Array.from({ length: INNINGS_SHOWN }, (_, i) =>
      `<div class="w-[68px] shrink-0 h-10 flex items-center justify-center text-[11px] font-bold text-gray-500 border-b border-l border-gray-200 bg-gray-50">${i + 1}</div>`
    ).join('');

    const bodyRows = lineup.map(player => {
      const cells = Array.from({ length: INNINGS_SHOWN }, (_, i) => {
        const inning = i + 1;
        const events = byBatterInning[`${player.battingOrder}-${inning}`] || [];
        return renderCell(player, inning, events);
      }).join('');
      return `<div class="flex">${cells}</div>`;
    }).join('');

    atbatGrid.innerHTML = `
      <div class="flex sticky top-0 z-10">${headerCells}</div>
      ${bodyRows}
    `;

    atbatGrid.querySelectorAll('[data-cell]').forEach(cell => {
      cell.addEventListener('click', () => {
        const { battingOrder, inning } = cell.dataset;
        const events = byBatterInning[`${battingOrder}-${inning}`] || [];
        const player = lineup.find(p => String(p.battingOrder) === battingOrder);
        openAtBatModal(player, Number(inning), events);
      });
    });
  }

  // Maps a result code to how many bases the batter reached on that specific
  // play, and whether they scored. This drives the visual base path on the
  // diamond — not full traditional scorekeeping (which also tracks a runner
  // across *later* at-bats), but enough that the immediate result of THIS
  // at-bat is visible at a glance instead of requiring the code to be decoded.
  function classifyResult(result) {
    if (!result) return { bases: 0, scored: false, isOut: false };
    if (['1B', '2B', '3B', 'HR'].includes(result)) {
      const bases = { '1B': 1, '2B': 2, '3B': 3, 'HR': 4 }[result];
      return { bases, scored: bases === 4, isOut: false };
    }
    if (result === 'BB' || result === 'HBP') return { bases: 1, scored: false, isOut: false };
    if (/^E\d/.test(result)) return { bases: 1, scored: false, isOut: false }; // reached on an error
    if (result === 'FC') return { bases: 1, scored: false, isOut: false }; // batter safe, runner out elsewhere
    if (result === 'K' || result === '\u02d3' || /^F\d/.test(result) || /^P\d/.test(result) || /^\d/.test(result)) {
      return { bases: 0, scored: false, isOut: true };
    }
    return { bases: 0, scored: false, isOut: false }; // SAC, SB, WP, PB — not the batter's own base path
  }

  // Diamond corners per scorekeeping convention: home at bottom, 1st at
  // right, 2nd at top, 3rd at left. Draws the path the batter actually took.
  function diamondSVG({ bases, scored, isOut, dim }) {
    const home = [20, 38], first = [38, 20], second = [20, 2], third = [2, 20];
    const segments = [[home, first], [first, second], [second, third], [third, home]];
    const reached = scored ? 4 : bases;
    const outlineColor = dim ? '#d8dadf' : '#9ca3af';
    const pathColor = dim ? '#9ca3af' : 'var(--mlb-navy)';

    const outline = `<polygon points="${[home, first, second, third].map(p => p.join(',')).join(' ')}"
        fill="${scored && !dim ? 'rgba(4,30,66,0.12)' : 'none'}" stroke="${outlineColor}" stroke-width="1.5" />`;

    const pathLines = segments.map(([a, b], i) => {
      const isWalked = i < reached;
      return isWalked
        ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${pathColor}" stroke-width="2.5" stroke-linecap="round" />`
        : '';
    }).join('');

    return `<svg viewBox="0 0 40 40" class="w-7 h-7">${outline}${pathLines}</svg>`;
  }

  function renderCell(player, inning, events) {
    const editKey = `${state.team}-${player.battingOrder}-${inning}`;
    const edit = state.userEdits[editKey];
    const hasEvent = events.length > 0 || !!edit;
    const isFuture = !edit && hasEvent && events[0].globalIndex >= state.revealedIndex;
    const label = edit ? edit.result : (hasEvent ? events.map(e => e.result).join(' / ') : '');
    const isLiveCell = !edit && hasEvent && events[0].globalIndex === state.revealedIndex - 1;
    const classification = hasEvent ? classifyResult(label.split(' / ')[0]) : { bases: 0, scored: false, isOut: false };

    return `
      <div data-cell data-batting-order="${player.battingOrder}" data-inning="${inning}" ${isLiveCell ? 'data-live="1"' : ''}
           class="w-[68px] shrink-0 h-[72px] border-b border-l border-gray-200 flex flex-col items-center justify-center gap-0.5
                  cursor-pointer hover:bg-amber-50 transition-colors relative ${isLiveCell ? 'ring-2 ring-inset ring-[var(--mlb-red)]' : ''}">
        ${hasEvent
          ? diamondSVG({ ...classification, dim: isFuture })
          : `<div class="diamond opacity-20"></div>`}
        ${hasEvent ? `<span class="text-[9px] font-bold leading-none ${isFuture ? 'text-gray-400' : 'text-[var(--mlb-ink)]'}">${label}</span>` : ''}
        ${edit ? '<span class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--mlb-navy)]"></span>' : ''}
      </div>
    `;
  }

  // Brings the most recent at-bat for the currently-selected team into view —
  // used after each playback tick and after switching teams mid-playback,
  // so the person always sees where the "live" action is without manual scrolling.
  function scrollToLiveCell() {
    const liveCell = atbatGrid.querySelector('[data-live="1"]');
    if (liveCell) {
      liveCell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      return;
    }
    // Selected team's half hasn't had the most recent event — fall back to
    // their own last-revealed at-bat so the view still tracks forward progress.
    const half = HALF_FOR_TEAM[state.team];
    for (let i = state.revealedIndex - 1; i >= 0; i--) {
      const ev = data.playByPlay[i];
      if (ev.half === half) {
        const cell = atbatGrid.querySelector(`[data-batting-order="${ev.battingOrder}"][data-inning="${ev.inning}"]`);
        if (cell) cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        return;
      }
    }
  }

  // ---- At-bat modal ---------------------------------------------------------
  // Watch & Learn mode: read-only detail of the recorded event.
  // True Fan mode: tactile, tap-only input (no typing) per spec —
  // category -> sub-result/position picker -> ball-strike count -> confirm.
  const modal = document.getElementById('atbat-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  const POSITIONS = [
    { n: 1, label: 'P' }, { n: 2, label: 'C' }, { n: 3, label: '1B' },
    { n: 4, label: '2B' }, { n: 5, label: '3B' }, { n: 6, label: 'SS' },
    { n: 7, label: 'LF' }, { n: 8, label: 'CF' }, { n: 9, label: 'RF' },
  ];

  let modalCtx = null; // { player, inning, editKey, result, count: {b,s} }

  function chip(label, extraClasses = '') {
    return `class="col-span-1 ${extraClasses} bg-gray-100 hover:bg-[var(--mlb-yellow)] hover:text-[var(--mlb-navy)] rounded-lg py-3 text-center transition-colors"`;
  }

  function modalNav(title, onBack) {
    return `
      <div class="col-span-3 flex items-center gap-2 mb-1 -mt-1">
        ${onBack ? `<button data-back class="text-xs text-gray-400">&larr; Back</button>` : ''}
        <span class="text-xs font-semibold text-gray-500 ml-auto">${title}</span>
      </div>`;
  }

  function openAtBatModal(player, inning, events) {
    const editKey = `${state.team}-${player.battingOrder}-${inning}`;
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    if (state.mode !== 'true-fan') {
      const edit = state.userEdits[editKey];
      const items = edit ? [edit] : events;
      modalBody.innerHTML = items.length
        ? items.map(e => `
            <div class="col-span-3 bg-gray-50 rounded p-2 text-xs text-gray-700 mb-1">
              <strong>${e.result}</strong> &middot; count ${e.count || `${e.count?.b ?? 0}-${e.count?.s ?? 0}`} &middot; outs ${e.outsBefore ?? '-'}&rarr;${e.outsAfter ?? '-'}
            </div>`).join('')
        : `<p class="col-span-3 text-xs text-gray-500">Not reached yet in Watch &amp; Learn playback.</p>`;
      return;
    }

    modalCtx = { player, inning, editKey, result: null, count: { b: 0, s: 0 } };
    const existing = state.userEdits[editKey];
    if (existing) modalCtx = { ...modalCtx, ...existing };
    renderCategoryScreen();
  }

  function closeModal() {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalCtx = null;
  }

  // Screen 1: top-level category
  function renderCategoryScreen() {
    modalBody.innerHTML = `
      ${modalNav('Select result type')}
      <button data-go="hit" ${chip('Hit')}>Hit</button>
      <button data-go="out" ${chip('Out')}>Out</button>
      <button data-go="walk" ${chip('Walk / HBP')}>Walk / HBP</button>
      <button data-go="error" ${chip('Error')}>Error</button>
      <button data-go="other" ${chip('Other', 'col-span-3')}>Other (FC, SAC, SB, WP, PB)</button>
    `;
    wireNav();
    modalBody.querySelectorAll('[data-go]').forEach(btn =>
      btn.addEventListener('click', () => SCREENS[btn.dataset.go]()));
  }

  function renderHitScreen() {
    modalBody.innerHTML = `
      ${modalNav('Hit type', true)}
      ${['1B', '2B', '3B', 'HR'].map(code => `<button data-result="${code}" ${chip(code)}>${code}</button>`).join('')}
    `;
    wireBackAndResults();
  }

  function renderWalkScreen() {
    modalBody.innerHTML = `
      ${modalNav('Walk type', true)}
      <button data-result="BB" ${chip('BB', 'col-span-1')}>BB</button>
      <button data-result="HBP" ${chip('HBP', 'col-span-2')}>HBP</button>
    `;
    wireBackAndResults();
  }

  function renderOutScreen() {
    modalBody.innerHTML = `
      ${modalNav('Out type', true)}
      <button data-go="strikeout" ${chip('Strikeout', 'col-span-3')}>Strikeout</button>
      <button data-go="flyout" ${chip('Fly Out', 'col-span-1')}>Fly Out</button>
      <button data-go="groundout" ${chip('Ground Out', 'col-span-2')}>Ground Out (sequence)</button>
    `;
    wireNav();
    modalBody.querySelectorAll('[data-go]').forEach(btn =>
      btn.addEventListener('click', () => SCREENS[btn.dataset.go]()));
  }

  function renderStrikeoutScreen() {
    modalBody.innerHTML = `
      ${modalNav('Strikeout type', true)}
      <button data-result="K" ${chip('Swinging (K)', 'col-span-1')}>Swinging<br><span class="text-xs">K</span></button>
      <button data-result="\u02d3" ${chip('Looking', 'col-span-2')}>Looking<br><span class="text-xs">\u02d3</span></button>
    `;
    wireBackAndResults();
  }

  function renderFlyoutScreen() {
    modalBody.innerHTML = `
      ${modalNav('Tap fielder who caught it', true)}
      ${POSITIONS.map(p => `<button data-result="F${p.n}" ${chip('')}>${p.label}<br><span class="text-[10px] text-gray-400">F${p.n}</span></button>`).join('')}
    `;
    wireBackAndResults();
  }

  function renderGroundoutScreen() {
    const seq = [];
    function draw() {
      modalBody.innerHTML = `
        ${modalNav('Tap fielders in order', true)}
        <div class="col-span-3 text-center font-bold text-lg mb-1">${seq.length ? seq.join('-') : '\u2014'}</div>
        ${POSITIONS.map(p => `<button data-pos="${p.n}" ${chip('')}>${p.label}<br><span class="text-[10px] text-gray-400">${p.n}</span></button>`).join('')}
        <button data-undo ${chip('Undo', 'col-span-1')}>Undo</button>
        <button data-confirm-seq ${chip('Out (confirm)', 'col-span-2 !bg-[var(--mlb-navy)] !text-white')} ${seq.length ? '' : 'disabled'}>Out (confirm)</button>
      `;
      modalBody.querySelector('[data-back]').addEventListener('click', renderOutScreen);
      modalBody.querySelectorAll('[data-pos]').forEach(btn =>
        btn.addEventListener('click', () => { seq.push(btn.dataset.pos); draw(); }));
      modalBody.querySelector('[data-undo]').addEventListener('click', () => { seq.pop(); draw(); });
      const confirmBtn = modalBody.querySelector('[data-confirm-seq]');
      if (seq.length) {
        confirmBtn.addEventListener('click', () => selectResult(seq.join('-')));
      }
    }
    draw();
  }

  function renderErrorScreen() {
    modalBody.innerHTML = `
      ${modalNav('Tap fielder who erred', true)}
      ${POSITIONS.map(p => `<button data-result="E${p.n}" ${chip('')}>${p.label}<br><span class="text-[10px] text-gray-400">E${p.n}</span></button>`).join('')}
    `;
    wireBackAndResults();
  }

  function renderOtherScreen() {
    modalBody.innerHTML = `
      ${modalNav('Other result', true)}
      <button data-result="FC" ${chip('FC')}>FC</button>
      <button data-result="SAC" ${chip('SAC')}>SAC</button>
      <button data-result="SB" ${chip('SB')}>SB</button>
      <button data-result="WP" ${chip('WP')}>WP</button>
      <button data-result="PB" ${chip('PB')}>PB</button>
    `;
    wireBackAndResults();
  }

  // Screen 2: ball-strike count (tap steppers, no typing) + final confirm
  function renderCountScreen() {
    modalBody.innerHTML = `
      ${modalNav(`Result: ${modalCtx.result}`, true)}
      <div class="col-span-3 grid grid-cols-2 gap-3 mb-2">
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-1">Balls</p>
          <div class="flex items-center justify-center gap-2">
            <button data-count="b-" class="w-8 h-8 rounded-full bg-gray-100">&minus;</button>
            <span class="w-5 text-center" id="count-b">${modalCtx.count.b}</span>
            <button data-count="b+" class="w-8 h-8 rounded-full bg-gray-100">+</button>
          </div>
        </div>
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-1">Strikes</p>
          <div class="flex items-center justify-center gap-2">
            <button data-count="s-" class="w-8 h-8 rounded-full bg-gray-100">&minus;</button>
            <span class="w-5 text-center" id="count-s">${modalCtx.count.s}</span>
            <button data-count="s+" class="w-8 h-8 rounded-full bg-gray-100">+</button>
          </div>
        </div>
      </div>
      <button data-confirm-final ${chip('Confirm At-Bat', 'col-span-3 !bg-[var(--mlb-yellow)] !text-[var(--mlb-navy)] font-bold')}>Confirm At-Bat</button>
    `;
    modalBody.querySelector('[data-back]').addEventListener('click', renderCategoryScreen);
    modalBody.querySelectorAll('[data-count]').forEach(btn => btn.addEventListener('click', () => {
      const [field, dir] = [btn.dataset.count[0], btn.dataset.count[1]];
      const max = field === 'b' ? 3 : 2;
      const delta = dir === '+' ? 1 : -1;
      modalCtx.count[field] = Math.min(max, Math.max(0, modalCtx.count[field] + delta));
      document.getElementById(`count-${field}`).textContent = modalCtx.count[field];
    }));
    modalBody.querySelector('[data-confirm-final]').addEventListener('click', confirmAtBat);
  }

  const SCREENS = {
    hit: renderHitScreen, out: renderOutScreen, walk: renderWalkScreen,
    error: renderErrorScreen, other: renderOtherScreen,
    strikeout: renderStrikeoutScreen, flyout: renderFlyoutScreen, groundout: renderGroundoutScreen,
  };

  function wireNav() {
    const back = modalBody.querySelector('[data-back]');
    if (back) back.addEventListener('click', renderCategoryScreen);
  }
  function wireBackAndResults() {
    wireNav();
    modalBody.querySelectorAll('[data-result]').forEach(btn =>
      btn.addEventListener('click', () => selectResult(btn.dataset.result)));
  }
  function selectResult(result) {
    modalCtx.result = result;
    renderCountScreen();
  }

  function confirmAtBat() {
    state.userEdits[modalCtx.editKey] = {
      result: modalCtx.result,
      count: { ...modalCtx.count },
      battingOrder: modalCtx.player.battingOrder,
      inning: modalCtx.inning,
      team: state.team,
    };
    closeModal();
    renderOffenseDefense();
  }

  document.getElementById('modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // ---- Substitution modal (tactile — tap a bench player, no typing) --------
  function openSubstitutionModal(player, slotIndex) {
    modalTitle.textContent = `Substitute — ${player.positionAbbr}, Slot ${player.battingOrder}`;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    if (state.mode !== 'true-fan') {
      modalBody.innerHTML = `
        <p class="col-span-3 text-xs text-gray-500">
          Currently batting: <strong>${player.name}</strong> (${player.positionAbbr}).
          Switch to True Fan mode to make a substitution.
        </p>`;
      return;
    }

    const bench = data.bench[state.team] || [];
    modalBody.innerHTML = `
      <div class="col-span-3 text-xs text-gray-500 mb-1">Currently: <strong class="text-[var(--mlb-ink)]">${player.name}</strong> (${player.positionAbbr})</div>
      ${bench.map(b => `
        <button data-bench-name="${b.name}" data-bench-pos="${b.eligiblePositions[0]}"
                class="col-span-3 bg-gray-100 hover:bg-[var(--mlb-yellow)] hover:text-[var(--mlb-navy)] rounded-lg py-3 px-3 text-left transition-colors">
          <span class="font-semibold">${b.name}</span>
          <span class="text-xs text-gray-500 ml-2">${b.eligiblePositions.join(' / ')} &middot; Bats ${b.bats}</span>
        </button>`).join('')}
      <button data-revert class="col-span-3 text-xs text-gray-400 mt-1">Revert to original starter</button>
    `;

    modalBody.querySelectorAll('[data-bench-name]').forEach(btn => {
      btn.addEventListener('click', () => {
        applySubstitution(slotIndex, { name: btn.dataset.benchName, positionAbbr: btn.dataset.benchPos });
        closeModal();
      });
    });
    modalBody.querySelector('[data-revert]').addEventListener('click', () => {
      revertSubstitution(slotIndex);
      closeModal();
    });
  }

  function applySubstitution(slotIndex, { name, positionAbbr }) {
    const team = state.team;
    const base = (state.lineupOverrides[team] || data.lineups[team]).map(p => ({ ...p }));
    base[slotIndex] = { ...base[slotIndex], name, positionAbbr };
    state.lineupOverrides[team] = base;
    renderLineup();
    renderOffenseDefense();
  }

  function revertSubstitution(slotIndex) {
    const team = state.team;
    if (!state.lineupOverrides[team]) return;
    const base = state.lineupOverrides[team].map(p => ({ ...p }));
    base[slotIndex] = { ...data.lineups[team][slotIndex] };
    state.lineupOverrides[team] = base;
    renderLineup();
    renderOffenseDefense();
  }

  // ---- Linescore strip (live — recomputed from state.revealedIndex) --------
  const linescoreBody = document.getElementById('linescore-body');

  function computeLiveLinescore() {
    const innings = {
      away: Array(INNINGS_SHOWN).fill(0),
      home: Array(INNINGS_SHOWN).fill(0),
    };
    const totals = {
      away: { R: 0, H: 0, E: 0, LOB: data.linescore.totals.away.LOB },
      home: { R: 0, H: 0, E: 0, LOB: data.linescore.totals.home.LOB },
    };
    data.playByPlay.slice(0, state.revealedIndex).forEach(ev => {
      const side = ev.half === 'top' ? 'away' : 'home';
      innings[side][ev.inning - 1] += ev.runsScoredOnPlay || 0;
      totals[side].R += ev.runsScoredOnPlay || 0;
      if (ev.category === 'hit') totals[side].H += 1;
      if (ev.category === 'error') totals[side].E += 1;
    });
    return { innings, totals };
  }

  function linescoreRow(teamName, logoSrc, innings, totals) {
    const tr = document.createElement('tr');
    const cells = innings.map(r => `<td>${r || ''}</td>`).join('');
    tr.innerHTML = `
      <td class="text-left pl-2 flex items-center gap-1 py-1"><img src="${logoSrc}" alt="" class="w-4 h-4 rounded-full">${teamName}</td>
      ${cells}
      <td class="pl-2">${totals.R}</td><td>${totals.H}</td><td>${totals.E}</td><td>${totals.LOB}</td>
    `;
    return tr;
  }

  function renderLinescore() {
    const { innings, totals } = computeLiveLinescore();
    linescoreBody.innerHTML = '';
    linescoreBody.appendChild(linescoreRow('TBS', `../${data.teams.away.logo}`, innings.away, totals.away));
    linescoreBody.appendChild(linescoreRow('TIG', `../${data.teams.home.logo}`, innings.home, totals.home));
  }

  // ---- Live game-state status (inning / half / outs) -----------------------
  function computeCurrentState() {
    const total = data.playByPlay.length;
    if (state.revealedIndex >= total) return { final: true };
    if (state.revealedIndex === 0) return { inning: 1, half: 'top', outs: 0 };

    const last = data.playByPlay[state.revealedIndex - 1];
    if (last.outsAfter < 3) return { inning: last.inning, half: last.half, outs: last.outsAfter };

    const next = data.playByPlay[state.revealedIndex];
    return { inning: next.inning, half: next.half, outs: 0 };
  }

  function renderStatus() {
    const s = computeCurrentState();
    const statusEl = document.getElementById('playback-status');
    statusEl.textContent = s.final
      ? 'Final'
      : `${s.half === 'top' ? 'Top' : 'Bottom'} ${s.inning} \u00b7 ${s.outs} Out${s.outs === 1 ? '' : 's'}`;
  }

  // ---- Watch & Learn playback engine ----------------------------------------
  const BASE_INTERVAL_MS = 1500;
  const playToggleBtn = document.getElementById('playback-toggle');
  const speedSelect = document.getElementById('playback-speed');
  let playbackTimer = null;

  function intervalForSpeed() {
    return BASE_INTERVAL_MS / parseFloat(speedSelect.value || '1');
  }

  function tick() {
    if (state.revealedIndex >= data.playByPlay.length) {
      pausePlayback();
      return;
    }
    state.revealedIndex += 1;
    renderOffenseDefense();
    renderLinescore();
    renderStatus();
    scrollToLiveCell();
  }

  function startPlayback() {
    if (state.mode === 'true-fan' || state.revealedIndex >= data.playByPlay.length) return;
    state.isPlaying = true;
    playToggleBtn.textContent = '\u275a\u275a'; // pause glyph
    playToggleBtn.setAttribute('aria-label', 'Pause');
    playbackTimer = setInterval(tick, intervalForSpeed());
  }

  function pausePlayback() {
    state.isPlaying = false;
    playToggleBtn.textContent = '\u25b6'; // play glyph
    playToggleBtn.setAttribute('aria-label', 'Play');
    clearInterval(playbackTimer);
    playbackTimer = null;
  }

  playToggleBtn.addEventListener('click', () => {
    if (state.isPlaying) pausePlayback(); else startPlayback();
  });

  speedSelect.addEventListener('change', () => {
    if (state.isPlaying) { pausePlayback(); startPlayback(); } // restart interval at new speed
  });

  // ---- Initial render ----------------------------------------------------
  renderLineup();
  renderPitching();
  renderOffenseDefense();
  renderLinescore();
  renderStatus();

  // Keep the frozen player column in sync with the grid's vertical scroll
  const gridScrollContainer = atbatGrid.parentElement;
  gridScrollContainer.addEventListener('scroll', () => {
    playerCol.scrollTop = gridScrollContainer.scrollTop;
  });

  // NOTE: the at-bat input modal currently just displays recorded events.
  // Hit/Out/BB/E tactile input buttons are the next build pass.
})();
