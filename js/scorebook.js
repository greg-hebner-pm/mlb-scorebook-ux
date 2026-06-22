/**
 * scorebook.js — MLB Digital Scorebook Prototype
 * Watch & Learn: auto-playback of simulated game at realistic pacing.
 * True Fan: fully tactile entry, no typing.
 *
 * Playback speed research:
 *   Average 2025 MLB 9-inning game = 2h 38min ≈ 9,480s
 *   ~75 plate appearances per game → ~126s/at-bat real pace.
 *   Demo base interval = 8s at 1x (compressed for portfolio demo).
 *   Speed options: 1x (8s), 2/3x (12s), 1/2x (16s), 1/3x (24s).
 */

(async function init() {
  const data = await window.MLBScorebook.loadGameData();

  const INNINGS_SHOWN = 11;
  const HALF_FOR_TEAM = { away: 'top', home: 'bottom' };
  // 8 seconds per at-bat at 1x — compressed demo pace
  // (real pace ~126s; this lets someone see a full game in ~10min at 1x)
  const BASE_INTERVAL_MS = 8000;

  const state = {
    team: null,           // null until user picks one
    section: null,        // null until user picks one
    mode: 'watch-learn',
    userEdits: {},
    lineupOverrides: { away: null, home: null },
    revealedIndex: data.meta.startEventIndex,
    isPlaying: false,
  };

  function currentLineup(team) {
    return state.lineupOverrides[team] || data.lineups[team];
  }

  // ---- Mode toggle -------------------------------------------------------
  const modeButtons = document.querySelectorAll('[data-mode]');
  const saveBar     = document.getElementById('save-bar');
  const saveBtn     = document.getElementById('btn-save');
  const playbackBar = document.getElementById('playback-bar');
  const pitchingReadonlyBadge = document.getElementById('pitching-readonly-badge');

  function setMode(mode) {
    state.mode = mode;
    modeButtons.forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active);
    });

    const isTrueFan = mode === 'true-fan';

    // Playback bar only in Watch & Learn
    playbackBar.classList.toggle('hidden', isTrueFan);
    saveBar.classList.toggle('hidden', !isTrueFan);

    // Save button active in True Fan
    saveBtn.disabled = !isTrueFan;
    saveBtn.classList.toggle('bg-gray-200', !isTrueFan);
    saveBtn.classList.toggle('text-gray-400', !isTrueFan);
    saveBtn.classList.toggle('cursor-not-allowed', !isTrueFan);
    saveBtn.classList.toggle('bg-[var(--mlb-yellow)]', isTrueFan);
    saveBtn.classList.toggle('text-[var(--mlb-navy)]', isTrueFan);

    // Pitching read-only badge
    if (pitchingReadonlyBadge) {
      pitchingReadonlyBadge.classList.toggle('hidden', !isTrueFan);
    }

    if (isTrueFan) {
      pausePlayback();
    } else {
      // Toggling back to WNL: resume from current state, discarding user edits
      // for future cells (per spec: "restart wherever the game is at making
      // corrections to errors the user made").
      renderOffenseDefense();
      renderLinescore();
      renderStatus();
    }
  }

  modeButtons.forEach(btn => btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  saveBtn.addEventListener('click', () => {
    if (saveBtn.disabled) return;
    const orig = saveBtn.textContent;
    saveBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveBtn.textContent = orig; }, 1200);
  });

  // ---- Team hotlinks -------------------------------------------------------
  document.querySelectorAll('[data-team]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-team]').forEach(b => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.team = btn.dataset.team;
      // If no section chosen yet, default to lineup
      if (!state.section) selectSection('lineup');
      else renderCurrentPanel();
    });
  });

  // ---- Section hotlinks ---------------------------------------------------
  function selectSection(section) {
    state.section = section;
    document.querySelectorAll('[data-section]').forEach(b => {
      b.classList.toggle('is-active', b.dataset.section === section);
    });
    renderCurrentPanel();
  }

  document.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.team) return; // require team selection first
      selectSection(btn.dataset.section);
    });
  });

  function renderCurrentPanel() {
    // Hide empty state and all panels
    document.getElementById('panel-empty').classList.add('hidden');
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));

    if (!state.team || !state.section) {
      document.getElementById('panel-empty').classList.remove('hidden');
      return;
    }

    const panelId = `panel-${state.section}`;
    const panel = document.getElementById(panelId);
    if (panel) panel.classList.remove('hidden');

    if (state.section === 'lineup') renderLineup();
    if (state.section === 'pitching') renderPitching();
    if (state.section === 'offense-defense') renderOffenseDefense();
  }

  // ---- Line Up panel -------------------------------------------------------
  const lineupList = document.getElementById('lineup-list');

  function renderLineup() {
    lineupList.innerHTML = '';
    const original = data.lineups[state.team];
    currentLineup(state.team).forEach((player, i) => {
      const isSub = player.name !== original[i].name;
      const row = document.createElement('div');
      row.className = 'flex items-center justify-between px-3 py-2.5 text-sm';
      row.innerHTML = `
        <span class="text-gray-400 w-5">${player.battingOrder}</span>
        <span class="flex-1 font-medium text-[var(--mlb-ink)]">
          ${player.name}
          ${isSub ? '<span class="ml-1 text-[10px] font-bold text-white bg-[var(--mlb-navy)] px-1.5 py-0.5 rounded">SUB</span>' : ''}
        </span>
        <span class="text-gray-500 text-xs">${player.positionAbbr}</span>
      `;
      // Lineup rows are read-only — substitutions happen in Off/Def tab per spec
      lineupList.appendChild(row);
    });
  }

  document.getElementById('btn-insert-lineup').addEventListener('click', () => {
    const original = data.lineups[state.team];
    const demo = data.demoLineup.battingOrder;
    state.lineupOverrides[state.team] = demo.map((p, i) => ({
      battingOrder: original[i].battingOrder,
      name: p.name,
      positionAbbr: p.positionAbbr,
      position: original[i].position,
      bats: original[i].bats,
    }));
    renderLineup();
  });

  // ---- Pitching panel -------------------------------------------------------
  const pitchingBody = document.getElementById('pitching-body');

  function renderPitching() {
    pitchingBody.innerHTML = '';
    // Pitching is always read-only (True Fan cannot edit, per spec)
    data.pitchers[state.team].forEach(p => {
      const tr = document.createElement('tr');
      tr.className = 'border-t border-gray-100';
      tr.innerHTML = `
        <td class="text-left pl-3 py-2 font-medium">${p.name}</td>
        <td>${p.throws}</td>
        <td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>
      `;
      pitchingBody.appendChild(tr);
    });
  }

  // ---- Offence / Defense grid ----------------------------------------------
  const playerCol    = document.getElementById('player-col');
  const atbatGrid    = document.getElementById('atbat-grid');
  const gridScroll   = document.getElementById('grid-scroll');

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

  function classifyResult(result) {
    if (!result) return { bases: 0, scored: false, isOut: false };
    const r = result.split(' ')[0]; // strip DP / SF annotations
    if (['1B','2B','3B','HR'].includes(r)) {
      const b = {'1B':1,'2B':2,'3B':3,'HR':4}[r];
      return { bases: b, scored: b === 4, isOut: false };
    }
    if (['BB','HBP','FC','E'].some(x => r.startsWith(x))) return { bases:1, scored:false, isOut:false };
    return { bases:0, scored:false, isOut:true };
  }

  function diamondSVG({ bases, scored, dim }) {
    const home=[20,38], first=[38,20], second=[20,2], third=[2,20];
    const segs = [[home,first],[first,second],[second,third],[third,home]];
    const reached = scored ? 4 : bases;
    const outlineColor = dim ? '#e5e7eb' : '#d1d5db';
    const pathColor    = dim ? '#9ca3af' : 'var(--mlb-navy)';
    const fillColor    = scored && !dim ? 'rgba(4,30,66,0.12)' : 'none';
    const outline = `<polygon points="${[home,first,second,third].map(p=>p.join(',')).join(' ')}" fill="${fillColor}" stroke="${outlineColor}" stroke-width="1.5"/>`;
    const lines = segs.map(([a,b],i) => i < reached
      ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${pathColor}" stroke-width="2.5" stroke-linecap="round"/>`
      : '').join('');
    return `<svg viewBox="0 0 40 40" class="w-6 h-6">${outline}${lines}</svg>`;
  }

  function renderCell(player, inning, events) {
    const editKey  = `${state.team}-${player.battingOrder}-${inning}`;
    const edit     = state.userEdits[editKey];
    const hasEvent = events.length > 0 || !!edit;
    const isFuture = !edit && hasEvent && events[0].globalIndex >= state.revealedIndex;
    const label    = edit ? edit.result : (hasEvent ? events.map(e => e.result).join('/') : '');
    const cls      = classifyResult(label);

    return `
      <div data-cell data-batting-order="${player.battingOrder}" data-inning="${inning}"
           class="w-[64px] shrink-0 h-[68px] border-b border-l border-gray-200 flex flex-col items-center
                  justify-center gap-0.5 cursor-pointer hover:bg-amber-50 transition-colors relative bg-white">
        ${hasEvent ? diamondSVG({...cls, dim: isFuture}) : '<div class="w-6 h-6 opacity-10 border border-gray-400 rotate-45"></div>'}
        ${hasEvent ? `<span class="text-[8px] font-bold leading-none ${isFuture ? 'text-gray-400' : 'text-[var(--mlb-ink)]'} max-w-[58px] text-center truncate">${label}</span>` : ''}
        ${edit ? '<span class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--mlb-navy)]"></span>' : ''}
      </div>
    `;
  }

  function renderOffenseDefense() {
    if (!state.team) return;
    const lineup         = currentLineup(state.team);
    const byBatterInning = eventsByBatterInning(state.team);

    // Player column
    playerCol.innerHTML = '';
    lineup.forEach(player => {
      const row = document.createElement('div');
      row.className = 'h-[68px] flex flex-col justify-center px-2 border-b border-gray-100 text-[10px] leading-tight bg-white';
      row.innerHTML = `
        <span class="font-semibold text-[var(--mlb-ink)] truncate">${player.battingOrder}. ${player.name}</span>
        <span class="text-gray-400">${player.positionAbbr}</span>
      `;
      playerCol.appendChild(row);
    });

    // Grid header + rows
    const headerCells = Array.from({length: INNINGS_SHOWN}, (_,i) =>
      `<div class="w-[64px] shrink-0 h-10 flex items-center justify-center text-[11px] font-bold
                   text-gray-500 border-b border-l border-gray-200 bg-gray-50">${i+1}</div>`
    ).join('');

    const bodyRows = lineup.map(player => {
      const cells = Array.from({length: INNINGS_SHOWN}, (_,i) => {
        const events = byBatterInning[`${player.battingOrder}-${i+1}`] || [];
        return renderCell(player, i+1, events);
      }).join('');
      return `<div class="flex">${cells}</div>`;
    }).join('');

    atbatGrid.innerHTML = `<div class="flex">${headerCells}</div>${bodyRows}`;

    // Wire cell clicks
    atbatGrid.querySelectorAll('[data-cell]').forEach(cell => {
      cell.addEventListener('click', () => {
        const bo  = Number(cell.dataset.battingOrder);
        const inn = Number(cell.dataset.inning);
        const evs = byBatterInning[`${bo}-${inn}`] || [];
        const pl  = lineup.find(p => p.battingOrder === bo);
        openAtBatModal(pl, inn, evs);
      });
    });

    scrollToRevealedCell();
  }

  function scrollToRevealedCell() {
    if (!state.team) return;
    const half = HALF_FOR_TEAM[state.team];
    for (let i = state.revealedIndex - 1; i >= 0; i--) {
      const ev = data.playByPlay[i];
      if (ev && ev.half === half) {
        const cell = atbatGrid.querySelector(`[data-batting-order="${ev.battingOrder}"][data-inning="${ev.inning}"]`);
        if (cell) { cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); }
        return;
      }
    }
  }

  // Scroll sync between frozen col and grid
  gridScroll.addEventListener('scroll', () => { playerCol.scrollTop = gridScroll.scrollTop; });

  // ---- At-bat modal --------------------------------------------------------
  const modal      = document.getElementById('atbat-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalBody  = document.getElementById('modal-body');
  let modalCtx     = null;

  const POSITIONS = [
    {n:1,label:'P'},{n:2,label:'C'},{n:3,label:'1B'},{n:4,label:'2B'},{n:5,label:'3B'},
    {n:6,label:'SS'},{n:7,label:'LF'},{n:8,label:'CF'},{n:9,label:'RF'},
  ];

  function chip(extra='') {
    return `class="col-span-1 ${extra} bg-gray-100 hover:bg-[var(--mlb-yellow)] hover:text-[var(--mlb-navy)] rounded-lg py-3 text-center transition-colors cursor-pointer"`;
  }
  function navBar(title, onBack) {
    return `<div class="col-span-3 flex items-center gap-2 mb-1 -mt-1">
      ${onBack ? '<button data-back class="text-xs text-gray-400">← Back</button>' : ''}
      <span class="text-xs font-semibold text-gray-500 ml-auto">${title}</span>
    </div>`;
  }

  function openAtBatModal(player, inning, events) {
    const editKey = `${state.team}-${player.battingOrder}-${inning}`;
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    if (state.mode !== 'true-fan') {
      const edit  = state.userEdits[editKey];
      const items = edit ? [edit] : events;
      modalBody.innerHTML = items.length
        ? items.map(e => `<div class="col-span-3 bg-gray-50 rounded p-2 text-xs text-gray-700">
            <strong>${e.result}</strong> · count ${e.count || '-'} · outs ${e.outsBefore ?? '-'}→${e.outsAfter ?? '-'}
          </div>`).join('')
        : `<p class="col-span-3 text-xs text-gray-500">Not yet revealed in Watch & Learn.</p>`;
      return;
    }

    // Substitution option in Offence/Defense tab
    const bench = data.bench[state.team] || [];

    modalCtx = { player, inning, editKey, result: null, count: { b:0, s:0 } };
    renderCategoryScreen();

    // Add sub option at bottom
    modalBody.insertAdjacentHTML('beforeend', `
      <div class="col-span-3 mt-2 pt-2 border-t border-gray-100">
        <button data-open-sub class="w-full text-left text-xs text-[var(--mlb-navy)] font-semibold py-1">
          ↔ Make substitution for this batter…
        </button>
      </div>
    `);
    modalBody.querySelector('[data-open-sub]')?.addEventListener('click', () =>
      renderSubScreen(player, inning, bench)
    );
  }

  function closeModal() {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modalCtx = null;
  }

  const SCREENS = {};

  function renderCategoryScreen() {
    modalBody.innerHTML = `
      ${navBar('Select result')}
      <button data-go="hit" ${chip()}>Hit</button>
      <button data-go="out" ${chip()}>Out</button>
      <button data-go="walk" ${chip()}>Walk / HBP</button>
      <button data-go="error" ${chip()}>Error</button>
      <button data-go="other" ${chip('col-span-3')}>Other (FC · SAC · SB · WP · PB)</button>
    `;
    wireNav();
    modalBody.querySelectorAll('[data-go]').forEach(btn =>
      btn.addEventListener('click', () => SCREENS[btn.dataset.go]?.()));
  }
  SCREENS.hit = () => {
    modalBody.innerHTML = `${navBar('Hit type', true)}
      ${['1B','2B','3B','HR'].map(c=>`<button data-result="${c}" ${chip()}>${c}</button>`).join('')}`;
    wireBackAndResults();
  };
  SCREENS.walk = () => {
    modalBody.innerHTML = `${navBar('Walk / HBP', true)}
      <button data-result="BB" ${chip()}>BB</button>
      <button data-result="HBP" ${chip('col-span-2')}>HBP</button>`;
    wireBackAndResults();
  };
  SCREENS.out = () => {
    modalBody.innerHTML = `${navBar('Out type', true)}
      <button data-go="strikeout" ${chip('col-span-3')}>Strikeout</button>
      <button data-go="flyout" ${chip()}>Fly Out</button>
      <button data-go="groundout" ${chip('col-span-2')}>Ground Out</button>`;
    wireNav();
    modalBody.querySelectorAll('[data-go]').forEach(btn =>
      btn.addEventListener('click', () => SCREENS[btn.dataset.go]?.()));
  };
  SCREENS.strikeout = () => {
    modalBody.innerHTML = `${navBar('Strikeout', true)}
      <button data-result="K" ${chip('col-span-1')}>Swinging<br><span class="text-xs">K</span></button>
      <button data-result="˓" ${chip('col-span-2')}>Looking<br><span class="text-xs">˓</span></button>`;
    wireBackAndResults();
  };
  SCREENS.flyout = () => {
    modalBody.innerHTML = `${navBar('Tap fielder', true)}
      ${POSITIONS.map(p=>`<button data-result="F${p.n}" ${chip()}>${p.label}<br><span class="text-[10px] text-gray-400">F${p.n}</span></button>`).join('')}`;
    wireBackAndResults();
  };
  SCREENS.groundout = () => {
    const seq = [];
    function draw() {
      modalBody.innerHTML = `${navBar('Tap fielders in order', true)}
        <div class="col-span-3 text-center font-bold text-lg mb-1">${seq.length ? seq.join('-') : '—'}</div>
        ${POSITIONS.map(p=>`<button data-pos="${p.n}" ${chip()}>${p.label}<br><span class="text-[10px] text-gray-400">${p.n}</span></button>`).join('')}
        <button data-undo ${chip()}>Undo</button>
        <button data-confirm-seq ${chip('col-span-2 !bg-[var(--mlb-navy)] !text-white')} ${!seq.length?'disabled':''}>Confirm Out</button>`;
      modalBody.querySelector('[data-back]').addEventListener('click', SCREENS.out);
      modalBody.querySelectorAll('[data-pos]').forEach(b => b.addEventListener('click', ()=>{seq.push(b.dataset.pos);draw();}));
      modalBody.querySelector('[data-undo]').addEventListener('click', ()=>{seq.pop();draw();});
      if (seq.length) modalBody.querySelector('[data-confirm-seq]').addEventListener('click', ()=>selectResult(seq.join('-')));
    }
    draw();
  };
  SCREENS.error = () => {
    modalBody.innerHTML = `${navBar('Tap fielder who erred', true)}
      ${POSITIONS.map(p=>`<button data-result="E${p.n}" ${chip()}>${p.label}<br><span class="text-[10px] text-gray-400">E${p.n}</span></button>`).join('')}`;
    wireBackAndResults();
  };
  SCREENS.other = () => {
    modalBody.innerHTML = `${navBar('Other', true)}
      ${['FC','SAC','SB','WP','PB'].map(c=>`<button data-result="${c}" ${chip()}>${c}</button>`).join('')}`;
    wireBackAndResults();
  };

  function renderSubScreen(player, inning, bench) {
    const lineup = currentLineup(state.team);
    const slotIndex = lineup.findIndex(p => p.battingOrder === player.battingOrder);
    modalBody.innerHTML = `
      ${navBar('Substitution', true)}
      <div class="col-span-3 text-xs text-gray-500 mb-1">Replacing: <strong>${player.name}</strong> (${player.positionAbbr})</div>
      ${bench.map(b=>`
        <button data-bench-name="${b.name}" data-bench-pos="${b.eligiblePositions[0]}"
                class="col-span-3 bg-gray-100 hover:bg-[var(--mlb-yellow)] hover:text-[var(--mlb-navy)]
                       rounded-lg py-2.5 px-3 text-left transition-colors cursor-pointer">
          <span class="font-semibold">${b.name}</span>
          <span class="text-xs text-gray-500 ml-2">${b.eligiblePositions.join('/')} · Bats ${b.bats}</span>
        </button>`).join('')}
      <button data-revert class="col-span-3 text-xs text-gray-400 mt-1 py-1">↩ Revert to original</button>
    `;
    modalBody.querySelector('[data-back]').addEventListener('click', () => openAtBatModal(player, inning, []));
    modalBody.querySelectorAll('[data-bench-name]').forEach(btn =>
      btn.addEventListener('click', () => {
        applySubstitution(slotIndex, {name: btn.dataset.benchName, positionAbbr: btn.dataset.benchPos});
        closeModal();
      })
    );
    modalBody.querySelector('[data-revert]')?.addEventListener('click', () => {
      revertSubstitution(slotIndex);
      closeModal();
    });
  }

  function applySubstitution(slotIndex, {name, positionAbbr}) {
    const team = state.team;
    const base = (state.lineupOverrides[team] || data.lineups[team]).map(p=>({...p}));
    base[slotIndex] = {...base[slotIndex], name, positionAbbr};
    state.lineupOverrides[team] = base;
    renderOffenseDefense();
  }
  function revertSubstitution(slotIndex) {
    const team = state.team;
    if (!state.lineupOverrides[team]) return;
    const base = state.lineupOverrides[team].map(p=>({...p}));
    base[slotIndex] = {...data.lineups[team][slotIndex]};
    state.lineupOverrides[team] = base;
    renderOffenseDefense();
  }

  function renderCountScreen() {
    modalBody.innerHTML = `
      ${navBar(`Result: ${modalCtx.result}`, true)}
      <div class="col-span-3 grid grid-cols-2 gap-4 mb-3">
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-2">Balls</p>
          <div class="flex items-center justify-center gap-3">
            <button data-count="b-" class="w-8 h-8 rounded-full bg-gray-100 font-bold">−</button>
            <span class="w-5 text-center font-bold" id="count-b">${modalCtx.count.b}</span>
            <button data-count="b+" class="w-8 h-8 rounded-full bg-gray-100 font-bold">+</button>
          </div>
        </div>
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-2">Strikes</p>
          <div class="flex items-center justify-center gap-3">
            <button data-count="s-" class="w-8 h-8 rounded-full bg-gray-100 font-bold">−</button>
            <span class="w-5 text-center font-bold" id="count-s">${modalCtx.count.s}</span>
            <button data-count="s+" class="w-8 h-8 rounded-full bg-gray-100 font-bold">+</button>
          </div>
        </div>
      </div>
      <button data-confirm-final ${chip('col-span-3 !bg-[var(--mlb-yellow)] !text-[var(--mlb-navy)] font-bold')}>
        Confirm At-Bat
      </button>
    `;
    modalBody.querySelector('[data-back]').addEventListener('click', renderCategoryScreen);
    modalBody.querySelectorAll('[data-count]').forEach(btn => btn.addEventListener('click', () => {
      const [f,d] = [btn.dataset.count[0], btn.dataset.count[1]];
      modalCtx.count[f] = Math.min(f==='b'?3:2, Math.max(0, modalCtx.count[f] + (d==='+'?1:-1)));
      document.getElementById(`count-${f}`).textContent = modalCtx.count[f];
    }));
    modalBody.querySelector('[data-confirm-final]').addEventListener('click', confirmAtBat);
  }

  function wireNav() {
    const back = modalBody.querySelector('[data-back]');
    if (back) back.addEventListener('click', renderCategoryScreen);
  }
  function wireBackAndResults() {
    wireNav();
    modalBody.querySelectorAll('[data-result]').forEach(btn =>
      btn.addEventListener('click', () => selectResult(btn.dataset.result)));
  }
  function selectResult(result) { modalCtx.result = result; renderCountScreen(); }
  function confirmAtBat() {
    state.userEdits[modalCtx.editKey] = {
      result: modalCtx.result, count: {...modalCtx.count},
      battingOrder: modalCtx.player.battingOrder,
      inning: modalCtx.inning, team: state.team,
    };
    closeModal();
    renderOffenseDefense();
  }

  document.getElementById('modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // ---- Linescore -----------------------------------------------------------
  const linescoreBody = document.getElementById('linescore-body');

  function computeLiveLinescore() {
    const innings  = { away: Array(INNINGS_SHOWN).fill(0), home: Array(INNINGS_SHOWN).fill(0) };
    const totals   = {
      away: { R:0, H:0, E:0 },
      home: { R:0, H:0, E:0 },
    };
    data.playByPlay.slice(0, state.revealedIndex).forEach(ev => {
      const side = ev.half === 'top' ? 'away' : 'home';
      innings[side][ev.inning - 1] += ev.runsScoredOnPlay || 0;
      totals[side].R += ev.runsScoredOnPlay || 0;
      if (ev.category === 'hit')   totals[side].H++;
      if (ev.category === 'error') totals[side].E++;
    });
    return { innings, totals };
  }

  function renderLinescore() {
    const { innings, totals } = computeLiveLinescore();
    linescoreBody.innerHTML = '';
    [['TBS', 'away', '../assets/logos/tubesocks.svg'],
     ['TIG', 'home', '../assets/logos/tiggers.svg']].forEach(([abbr, side, logo]) => {
      const tr = document.createElement('tr');
      const cells = innings[side].map(r => `<td>${r || ''}</td>`).join('');
      tr.innerHTML = `
        <td class="text-left pl-2 py-1">
          <div class="flex items-center gap-1">
            <img src="${logo}" alt="" class="w-3.5 h-3.5 rounded-full">${abbr}
          </div>
        </td>
        ${cells}
        <td class="pl-2">${totals[side].R}</td>
        <td>${totals[side].H}</td>
        <td>${totals[side].E}</td>
      `;
      linescoreBody.appendChild(tr);
    });
  }

  // ---- Status label --------------------------------------------------------
  function computeCurrentState() {
    const total = data.playByPlay.length;
    if (state.revealedIndex >= total) return { final: true };
    if (state.revealedIndex === 0)    return { inning:1, half:'top', outs:0 };
    const last = data.playByPlay[state.revealedIndex - 1];
    if (last.outsAfter < 3)           return { inning: last.inning, half: last.half, outs: last.outsAfter };
    const next = data.playByPlay[state.revealedIndex];
    return { inning: next.inning, half: next.half, outs: 0 };
  }

  function renderStatus() {
    const s = computeCurrentState();
    document.getElementById('playback-status').textContent = s.final
      ? 'Final'
      : `${s.half === 'top' ? 'Top' : 'Bot'} ${s.inning} · ${s.outs} Out${s.outs===1?'':'s'}`;
  }

  // ---- Playback engine -----------------------------------------------------
  const playToggleBtn = document.getElementById('playback-toggle');
  const speedSelect   = document.getElementById('playback-speed');
  let playbackTimer   = null;

  function intervalForSpeed() {
    return BASE_INTERVAL_MS / parseFloat(speedSelect.value || '1');
  }

  function tick() {
    if (state.revealedIndex >= data.playByPlay.length) { pausePlayback(); return; }
    state.revealedIndex++;
    if (state.section === 'offense-defense') renderOffenseDefense();
    renderLinescore();
    renderStatus();
  }

  function startPlayback() {
    if (state.mode === 'true-fan' || state.revealedIndex >= data.playByPlay.length) return;
    state.isPlaying = true;
    playToggleBtn.innerHTML = '&#9646;&#9646;';
    playToggleBtn.setAttribute('aria-label', 'Pause');
    playbackTimer = setInterval(tick, intervalForSpeed());
  }

  function pausePlayback() {
    state.isPlaying = false;
    playToggleBtn.innerHTML = '&#9658;';
    playToggleBtn.setAttribute('aria-label', 'Play');
    clearInterval(playbackTimer);
    playbackTimer = null;
  }

  playToggleBtn.addEventListener('click', () => {
    if (state.isPlaying) pausePlayback(); else startPlayback();
  });
  speedSelect.addEventListener('change', () => {
    if (state.isPlaying) { pausePlayback(); startPlayback(); }
  });

  // ---- Initial render (linescore + status only; panels start hidden) -------
  renderLinescore();
  renderStatus();

})();
