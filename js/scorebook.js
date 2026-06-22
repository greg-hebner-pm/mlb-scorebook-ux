/**
 * scorebook.js — MLB Digital Scorebook v2
 *
 * Playback speed basis (MLB 2025 data):
 *   Avg 9-inning game: 2h 38min ≈ 9480s, ~75 plate appearances → ~126s/AB real pace.
 *   Demo base: 8s at 1x ≈ 10 min for a full game (compressed but followable).
 *   Options: 1x (8s), 2/3x (12s), 1/2x (16s), 1/3x (24s) per at-bat.
 */
(async function init() {
  const data = await window.MLBScorebook.loadGameData();

  // ── Constants ──────────────────────────────────────────────────────────────
  const START_IDX  = data.meta.startEventIndex; // top 4th, after 1st out
  const BASE_MS    = 8000;
  const INNINGS    = 11;
  const HALF       = { away:'top', home:'bottom' };
  const LOGO       = { away:'../assets/logos/tubesocks.svg', home:'../assets/logos/tiggers.svg' };
  const ABBR       = { away:'TBS', home:'TIG' };
  const POS_LIST   = ['C','1B','2B','3B','SS','LF','CF','RF'];
  const FIELD_POS  = [
    {n:1,lbl:'P'},{n:2,lbl:'C'},{n:3,lbl:'1B'},{n:4,lbl:'2B'},{n:5,lbl:'3B'},
    {n:6,lbl:'SS'},{n:7,lbl:'LF'},{n:8,lbl:'CF'},{n:9,lbl:'RF'},
  ];

  // ── State ──────────────────────────────────────────────────────────────────
  const state = {
    mode:    null,   // null | 'watch-learn' | 'true-fan'
    team:    null,
    section: null,
    revealedIndex: START_IDX,
    isPlaying: false,

    // TF: per-team lineup entries [{name,positionAbbr}|null] × 8 (no pitcher)
    tfLineup: { away: Array(8).fill(null), home: Array(8).fill(null) },
    lineupLocked: { away: false, home: false },

    // Substitution history per team, per battingOrder
    // positionHistory[team][bo] = [{name,positionAbbr,active}]
    positionHistory: { away: buildPosHistory('away'), home: buildPosHistory('home') },

    // TF at-bat edits: key = `${team}-${bo}-${inning}`
    userEdits: {},

    // TF pitchers: null=untouched, []=blank, [...]=filled
    tfPitchers: { away: null, home: null },

    // TF catch-up done?
    tfCaughtUp: { away: false, home: false },
  };

  function buildPosHistory(team) {
    const h = {};
    data.lineups[team].forEach(p => {
      h[p.battingOrder] = [{ name:p.name, positionAbbr:p.positionAbbr, active:true }];
    });
    return h;
  }
  function currentSlot(team, bo) {
    const hist = state.positionHistory[team][bo];
    return hist[hist.length - 1];
  }

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const teamBar    = document.getElementById('team-bar');
  const sectionBar = document.getElementById('section-bar');
  const clockBar   = document.getElementById('clock-bar');
  const saveBar    = document.getElementById('save-bar');
  const modal      = document.getElementById('atbat-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalBody  = document.getElementById('modal-body');
  const clockStatus = document.getElementById('clock-status');
  const speedSelect = document.getElementById('playback-speed');

  // ── Header: Mode toggle ────────────────────────────────────────────────────
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('[data-mode]').forEach(btn => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle('tab-active', on);
      btn.classList.toggle('text-gray-400', !on);
      btn.setAttribute('aria-selected', on);
    });

    // Show team bar
    teamBar.classList.remove('hidden');

    // Clock / save bar
    const isWNL = mode === 'watch-learn';
    clockBar.classList.toggle('hidden', !isWNL);
    saveBar.classList.toggle('hidden', isWNL);

    // WNL: auto-populate history to start point immediately then roll
    if (isWNL) {
      state.revealedIndex = START_IDX;
      renderLinescore();
      renderStatus(true); // initial label
      startPlayback();
    } else {
      // TF: ask about catch-up (deferred until team/section selected)
      stopPlayback();
      renderLinescore();
    }

    if (state.team) renderCurrentPanel();
    else {
      showEmpty('Select a team above.');
      sectionBar.classList.add('hidden');
    }
  }

  // ── Header: Team toggle ────────────────────────────────────────────────────
  document.querySelectorAll('[data-team]').forEach(btn => {
    btn.addEventListener('click', () => setTeam(btn.dataset.team));
  });

  function setTeam(team) {
    state.team = team;
    document.querySelectorAll('[data-team]').forEach(btn => {
      const on = btn.dataset.team === team;
      btn.classList.toggle('tab-active', on);
      btn.classList.toggle('text-gray-400', !on);
    });
    sectionBar.classList.remove('hidden');
    if (!state.section) selectSection('lineup');
    else renderCurrentPanel();
  }

  // ── Header: Section toggle ─────────────────────────────────────────────────
  document.querySelectorAll('[data-section]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!state.team) return;
      selectSection(btn.dataset.section);
    });
  });

  function selectSection(section) {
    state.section = section;
    document.querySelectorAll('[data-section]').forEach(btn => {
      const on = btn.dataset.section === section;
      btn.classList.toggle('tab-active', on);
      btn.classList.toggle('text-gray-400', !on);
    });
    renderCurrentPanel();
  }

  // ── Panel routing ──────────────────────────────────────────────────────────
  function showEmpty(msg) {
    document.getElementById('panel-empty').classList.remove('hidden');
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
    document.getElementById('empty-message').textContent = msg || 'Select a mode above to begin.';
  }

  function renderCurrentPanel() {
    document.getElementById('panel-empty').classList.add('hidden');
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
    if (!state.mode || !state.team || !state.section) return;
    const panel = document.getElementById(`panel-${state.section}`);
    if (panel) panel.classList.remove('hidden');
    if (state.section === 'lineup')           renderLineupPanel();
    if (state.section === 'pitching')         renderPitchingPanel();
    if (state.section === 'offense-defense')  renderOffDefPanel();
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LINEUP PANEL
  // ════════════════════════════════════════════════════════════════════════════
  function renderLineupPanel() {
    const panel = document.getElementById('panel-lineup');
    if (state.mode === 'watch-learn') renderLineupWNL(panel);
    else                              renderLineupTF(panel);
  }

  function renderLineupWNL(panel) {
    // Read-only list, no pitcher, no buttons, no subs
    const players = data.lineups[state.team].filter(p => p.positionAbbr !== 'P');
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Starting Lineup</h2>
      </div>
      <div class="divide-y divide-gray-100">
        ${players.map(p => `
          <div class="flex items-center justify-between px-4 py-3 text-sm">
            <span class="text-gray-400 w-6">${p.battingOrder}</span>
            <span class="flex-1 font-medium text-gray-900">${p.name}</span>
            <span class="text-gray-400 text-xs">${p.positionAbbr}</span>
          </div>`).join('')}
      </div>
      <p class="text-[10px] text-gray-400 text-center py-3 border-t border-gray-100 mt-2">
        Pitcher details are in the Pitching tab.
      </p>
    `;
  }

  function renderLineupTF(panel) {
    const team = state.team;
    if (state.lineupLocked[team]) {
      // Locked: show read-only list (same as WNL but with editable note)
      const players = data.lineups[team].filter(p => p.positionAbbr !== 'P');
      const overrides = state.tfLineup[team];
      panel.innerHTML = `
        <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
          <h2 class="font-bold text-gray-900">Starting Lineup</h2>
          <span class="text-[10px] text-gray-400 italic">Locked ✓</span>
        </div>
        <div class="divide-y divide-gray-100">
          ${players.map((p, i) => {
            const entry = overrides[i] || { name: p.name, positionAbbr: p.positionAbbr };
            return `<div class="flex items-center justify-between px-4 py-3 text-sm">
              <span class="text-gray-400 w-6">${p.battingOrder}</span>
              <span class="flex-1 font-medium text-gray-900">${entry.name}</span>
              <span class="text-gray-400 text-xs">${entry.positionAbbr}</span>
            </div>`;
          }).join('')}
        </div>
        <p class="text-[10px] text-gray-400 text-center py-3 border-t border-gray-100 mt-2">
          Substitutions are managed in the Offence/Defense tab.
        </p>
      `;
      return;
    }

    // Blank editable form
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Starting Lineup</h2>
        <button id="btn-insert-lineup" class="text-xs bg-gray-900 text-white font-bold px-3 py-1.5 rounded-lg">
          Insert Lineup
        </button>
      </div>
      <div id="lineup-form" class="divide-y divide-gray-100">
        ${[1,2,3,4,5,6,7,8].map(bo => {
          const cur = state.tfLineup[team][bo-1];
          return `<div class="flex items-center gap-2 px-4 py-2.5">
            <span class="text-gray-400 text-sm w-5">${bo}</span>
            <input type="text" placeholder="Player name…" value="${cur?.name||''}"
              data-slot="${bo-1}"
              class="flex-1 text-sm border-b border-gray-200 focus:border-gray-900 outline-none py-0.5 bg-transparent">
            <select data-pos-slot="${bo-1}"
              class="text-xs border border-gray-200 rounded px-1.5 py-1 outline-none bg-white text-gray-600 shrink-0">
              <option value="">Pos</option>
              ${POS_LIST.map(pos => `<option value="${pos}" ${cur?.positionAbbr===pos?'selected':''}>${pos}</option>`).join('')}
            </select>
          </div>`;
        }).join('')}
      </div>
      <div class="px-4 py-3 border-t border-gray-100">
        <button id="btn-confirm-lineup" class="w-full bg-gray-900 text-white text-sm font-bold py-2.5 rounded-xl hover:bg-gray-700 transition-colors">
          Confirm Lineup
        </button>
        <p class="text-[10px] text-gray-400 text-center mt-2">
          Substitutions are managed in the Offence/Defense tab.
        </p>
      </div>
    `;

    document.getElementById('btn-insert-lineup').addEventListener('click', () => {
      const players = data.lineups[team].filter(p => p.positionAbbr !== 'P');
      state.tfLineup[team] = players.map(p => ({ name:p.name, positionAbbr:p.positionAbbr }));
      state.lineupLocked[team] = true;
      renderLineupPanel();
    });

    document.getElementById('btn-confirm-lineup').addEventListener('click', () => {
      const inputs  = panel.querySelectorAll('input[data-slot]');
      const selects = panel.querySelectorAll('select[data-pos-slot]');
      const entries = [];
      let allFilled = true;
      inputs.forEach((inp, i) => {
        const name = inp.value.trim();
        const pos  = selects[i].value;
        if (!name || !pos) { allFilled = false; }
        entries.push(name && pos ? { name, positionAbbr: pos } : null);
      });
      if (!allFilled) {
        alert('Please fill in all player names and positions before confirming.');
        return;
      }
      state.tfLineup[team] = entries;
      state.lineupLocked[team] = true;
      renderLineupPanel();
    });

    // Live-sync inputs to state
    panel.querySelectorAll('input[data-slot]').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = parseInt(inp.dataset.slot);
        if (!state.tfLineup[team][i]) state.tfLineup[team][i] = { name:'', positionAbbr:'' };
        state.tfLineup[team][i].name = inp.value.trim();
      });
    });
    panel.querySelectorAll('select[data-pos-slot]').forEach(sel => {
      sel.addEventListener('change', () => {
        const i = parseInt(sel.dataset.posSlot);
        if (!state.tfLineup[team][i]) state.tfLineup[team][i] = { name:'', positionAbbr:'' };
        state.tfLineup[team][i].positionAbbr = sel.value;
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PITCHING PANEL
  // ════════════════════════════════════════════════════════════════════════════
  function renderPitchingPanel() {
    const panel = document.getElementById('panel-pitching');
    if (state.mode === 'watch-learn') renderPitchingWNL(panel);
    else                              renderPitchingTF(panel);
  }

  function activePitchersWNL(team) {
    // Which pitchers have appeared for this team's pitching staff up to revealedIndex?
    // When team='away', away team PITCHES to home batters (half='bottom')... wait no:
    // Away team BATS in 'top', so home team PITCHES in 'top'.
    // We want pitchers of the OPPOSING team that pitch TO the selected team's batters.
    // But for display on "Tube Socks" pitching tab: Tube Socks pitchers pitch in home's
    // half (bottom). So for team='away' (Tube Socks): pitchers appear in half='bottom' events.
    const pitchingHalf = team === 'away' ? 'bottom' : 'top';
    const seen = new Set();
    const result = [];
    for (let i = 0; i < state.revealedIndex; i++) {
      const ev = data.playByPlay[i];
      if (ev.half === pitchingHalf && !seen.has(ev.pitcher)) {
        seen.add(ev.pitcher);
        const found = data.pitchers[team].find(p => p.name === ev.pitcher);
        result.push(found || { name: ev.pitcher, throws: '?' });
      }
    }
    // Always show at least the starting pitcher
    if (result.length === 0 && data.pitchers[team].length > 0) {
      result.push(data.pitchers[team][0]);
    }
    return result;
  }

  function pitchingTableHTML(pitchers) {
    return `
      <div class="overflow-x-auto">
        <table class="w-full text-xs text-center border-collapse">
          <thead class="bg-gray-50 text-gray-500">
            <tr>
              <th class="text-left pl-4 py-2 font-semibold">PITCHER</th>
              <th>R/L</th><th>IP</th><th>P</th><th>BF</th>
              <th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${pitchers.map(p => `
              <tr>
                <td class="text-left pl-4 py-2.5 font-medium text-gray-900">${p.name}</td>
                <td class="text-gray-500">${p.throws}</td>
                <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function renderPitchingWNL(panel) {
    const pitchers = activePitchersWNL(state.team);
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Pitching</h2>
        <p class="text-[10px] text-gray-400 mt-0.5">Updates as game progresses.</p>
      </div>
      ${pitchingTableHTML(pitchers)}
    `;
  }

  function renderPitchingTF(panel) {
    const team = state.team;
    const entries = state.tfPitchers[team];

    if (entries === null) {
      // Blank start — user hasn't done anything yet
      panel.innerHTML = `
        <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
          <h2 class="font-bold text-gray-900">Pitching</h2>
          <button id="btn-insert-pitchers" class="text-xs bg-gray-900 text-white font-bold px-3 py-1.5 rounded-lg">
            Insert Pitchers
          </button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs text-center border-collapse">
            <thead class="bg-gray-50 text-gray-500">
              <tr>
                <th class="text-left pl-4 py-2 font-semibold">PITCHER</th>
                <th>R/L</th><th>IP</th><th>P</th><th>BF</th>
                <th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th>
              </tr>
            </thead>
            <tbody id="pitching-tf-body" class="divide-y divide-gray-100">
              <tr>
                <td class="text-left pl-4 py-2.5">
                  <input type="text" placeholder="Starting pitcher…" data-tf-pitcher="0"
                    class="text-sm border-b border-gray-200 focus:border-gray-900 outline-none bg-transparent w-32">
                </td>
                <td><select data-tf-throws="0" class="text-xs border border-gray-200 rounded px-1 py-0.5 outline-none">
                  <option value="">—</option><option value="R">R</option><option value="L">L</option>
                </select></td>
                <td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td><td>—</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="text-[10px] text-gray-400 text-center px-4 py-3">
          Pitching substitutions are managed on this tab as the game progresses.
        </p>
      `;
      document.getElementById('btn-insert-pitchers').addEventListener('click', () => {
        state.tfPitchers[team] = [...data.pitchers[team]];
        renderPitchingTF(panel);
      });
    } else {
      // Filled (either inserted or user typed)
      panel.innerHTML = `
        <div class="px-4 pt-4 pb-2 border-b border-gray-100">
          <h2 class="font-bold text-gray-900">Pitching</h2>
          <p class="text-[10px] text-gray-400 mt-0.5">Read-only in True Fan mode.</p>
        </div>
        ${pitchingTableHTML(entries.length ? entries : data.pitchers[team].slice(0,1))}
      `;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  OFFENCE / DEFENSE PANEL
  // ════════════════════════════════════════════════════════════════════════════
  function renderOffDefPanel() {
    const panel = document.getElementById('panel-offense-defense');
    if (state.mode === 'watch-learn') renderOffDefWNL(panel);
    else                              renderOffDefTF(panel);
  }

  // Pre-build event lookup for this team
  function buildEventMap(team) {
    const half = HALF[team];
    const map = {};
    data.playByPlay.forEach((ev, idx) => {
      if (ev.half !== half) return;
      const key = `${ev.battingOrder}-${ev.inning}`;
      if (!map[key]) map[key] = [];
      map[key].push({ ...ev, globalIndex: idx });
    });
    return map;
  }

  // Does an at-bat exist for this team/bo/inning at all?
  function hasAnyAtBat(eventMap, bo, inning) {
    return !!(eventMap[`${bo}-${inning}`]?.length);
  }

  function classifyResult(result) {
    if (!result) return { bases:0, scored:false, isOut:false };
    const r = result.split(/[\s/]/)[0];
    if (['1B','2B','3B','HR'].includes(r)) {
      const b = {1:1,2:2,3:3,HR:4}[r[0]==='H'?'HR':r[0]] ?? ({1:1,2:2,3:3,4:4}[r.length]);
      const bases = {'1B':1,'2B':2,'3B':3,'HR':4}[r] ?? 1;
      return { bases, scored: bases===4, isOut:false };
    }
    if (['BB','HBP','FC'].some(x => r.startsWith(x)) || /^E/.test(r)) return { bases:1,scored:false,isOut:false };
    return { bases:0,scored:false,isOut:true };
  }

  function diamondSVG({ bases, scored, dim, isOut }) {
    const H=[20,38],F=[38,20],S=[20,2],T=[2,20];
    const segs=[[H,F],[F,S],[S,T],[T,H]];
    const n = scored ? 4 : bases;
    const stroke  = dim ? '#e5e7eb' : '#9ca3af';
    const pStroke = dim ? '#9ca3af' : '#041e42';
    const fill    = scored && !dim ? 'rgba(4,30,66,0.12)' : 'none';
    const outline = `<polygon points="${[H,F,S,T].map(p=>p.join(',')).join(' ')}"
      fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    const lines = segs.map(([a,b],i) => i<n
      ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"
           stroke="${pStroke}" stroke-width="2.5" stroke-linecap="round"/>`
      : '').join('');
    return `<svg viewBox="0 0 40 40" class="w-6 h-6">${outline}${lines}</svg>`;
  }

  // Player column cell (handles substitution stacking)
  function playerColCell(team, bo) {
    const hist = state.positionHistory[team][bo];
    const rows = hist.map((entry, i) => {
      const isFirst = i === 0;
      const isCurrent = i === hist.length - 1 && entry.active;
      return `
        ${i>0 ? '<div class="sub-divider"></div>' : ''}
        <span class="font-${isCurrent?'semibold':'normal'} text-${isCurrent?'gray-900':'gray-400'} truncate text-[11px] leading-tight">
          ${isFirst ? bo+'. ' : '↳ '}${entry.name}
        </span>
        <span class="text-gray-400 text-[9px] leading-none">${entry.positionAbbr}${!entry.active?' ✕':''}</span>
      `;
    }).join('');

    return `
      <div class="flex flex-col justify-center px-2 py-1.5 border-b border-gray-100 bg-white min-h-[68px]">
        ${rows}
      </div>
    `;
  }

  // At-bat grid cell
  function gridCell(team, bo, inning, eventMap, isTF) {
    const key   = `${team}-${bo}-${inning}`;
    const edit  = state.userEdits[key];
    const evts  = eventMap[`${bo}-${inning}`] || [];

    // In TF mode: only show user edits, NOT simulation events (page starts blank)
    const hasAB  = isTF ? !!edit : (evts.length > 0 || !!edit);
    const isRevealed = isTF ? !!edit : (!!edit || (evts.length>0 && evts[0].globalIndex < state.revealedIndex));
    const isFuture   = !isTF && !edit && evts.length>0 && !isRevealed;
    const isDead     = !isTF && !evts.length && !edit; // WNL only: no at-bat exists at all

    const label = edit ? edit.result : (evts.length>0 ? evts[0].result : '');
    const cls   = hasAB ? classifyResult(label) : { bases:0,scored:false,isOut:false };

    if (isDead) {
      return `<div class="w-16 shrink-0 border-b border-l border-gray-100 bg-gray-50 min-h-[68px] cell-dead"></div>`;
    }

    const clickable = isTF || hasAB; // TF: all cells; WNL: only cells with an at-bat
    return `
      <div data-cell data-bo="${bo}" data-inning="${inning}"
           class="w-16 shrink-0 border-b border-l border-gray-200 flex flex-col items-center
                  justify-center gap-0.5 relative bg-white min-h-[68px]
                  ${clickable ? 'cursor-pointer hover:bg-amber-50 transition-colors' : 'cell-dead'}">
        ${hasAB
          ? diamondSVG({...cls, dim:isFuture})
          : `<div class="w-5 h-5 border border-gray-200 rotate-45 opacity-40"></div>`}
        ${hasAB && label ? `
          <span class="text-[8px] font-bold leading-none max-w-[58px] text-center truncate
                       ${isFuture?'text-gray-300':'text-gray-800'}">${label}</span>` : ''}
        ${edit ? `<span class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500"></span>` : ''}
      </div>
    `;
  }

  function buildOffDefGrid(team, eventMap, isTF) {
    const lineup = data.lineups[team]; // all 9 including pitcher
    const headerCells = Array.from({length:INNINGS}, (_,i) =>
      `<div class="w-16 shrink-0 h-9 flex items-center justify-center text-[11px] font-bold
                   text-gray-500 border-b border-l border-gray-200 bg-gray-50 sticky top-0 z-10">${i+1}</div>`
    ).join('');

    const bodyRows = lineup.map(player => {
      const cells = Array.from({length:INNINGS}, (_,i) =>
        gridCell(team, player.battingOrder, i+1, eventMap, isTF)
      ).join('');
      return `<div class="flex">${cells}</div>`;
    }).join('');

    return `<div class="flex">${headerCells}</div>${bodyRows}`;
  }

  function renderOffDefWNL(panel) {
    const team     = state.team;
    const eventMap = buildEventMap(team);
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Offence / Defense</h2>
        <span class="text-[10px] text-gray-400">← scroll innings →</span>
      </div>
      <div class="flex">
        <div class="shrink-0 w-28 border-r border-gray-200 bg-white sticky left-0 z-10">
          <div class="h-9 flex items-center text-[10px] font-bold text-gray-500 px-2 border-b border-gray-200 bg-gray-50">
            PLAYER / POS
          </div>
          <div id="player-col">
            ${data.lineups[team].map(p => playerColCell(team, p.battingOrder)).join('')}
          </div>
        </div>
        <div class="overflow-x-auto flex-1" id="grid-scroll">
          <div id="atbat-grid" class="min-w-[704px]">
            ${buildOffDefGrid(team, eventMap, false)}
          </div>
        </div>
      </div>
    `;
    wireOffDefCellClicks(team, eventMap, false);
    syncPlayerColScroll();
  }

  function renderOffDefTF(panel) {
    const team     = state.team;
    const eventMap = buildEventMap(team);
    const caught   = state.tfCaughtUp[team];

    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Offence / Defense</h2>
        ${!caught ? `
          <button id="btn-catchup" class="text-xs bg-gray-900 text-white font-bold px-3 py-1.5 rounded-lg">
            Catch Up
          </button>` : `<span class="text-[10px] text-gray-400 italic">Caught up ✓</span>`}
      </div>
      <div class="flex">
        <div class="shrink-0 w-28 border-r border-gray-200 bg-white sticky left-0 z-10">
          <div class="h-9 flex items-center text-[10px] font-bold text-gray-500 px-2 border-b border-gray-200 bg-gray-50">
            PLAYER / POS
          </div>
          <div id="player-col">
            ${data.lineups[team].map(p => playerColCell(team, p.battingOrder)).join('')}
          </div>
        </div>
        <div class="overflow-x-auto flex-1" id="grid-scroll">
          <div id="atbat-grid" class="min-w-[704px]">
            ${buildOffDefGrid(team, eventMap, true)}
          </div>
        </div>
      </div>
    `;

    if (!caught) {
      document.getElementById('btn-catchup')?.addEventListener('click', () => {
        catchUpTF(team, eventMap);
      });
    }
    wireOffDefCellClicks(team, eventMap, true);
    syncPlayerColScroll();
  }

  function catchUpTF(team, eventMap) {
    const half = HALF[team];
    // Fill in all at-bats through START_IDX (the first out of the 4th)
    for (let i = 0; i < START_IDX; i++) {
      const ev = data.playByPlay[i];
      if (ev.half !== half) continue;
      const key = `${team}-${ev.battingOrder}-${ev.inning}`;
      if (!state.userEdits[key]) {
        state.userEdits[key] = {
          result: ev.result,
          count: typeof ev.count === 'string'
            ? { b: parseInt(ev.count[0])||0, s: parseInt(ev.count[2])||0 }
            : (ev.count || { b:0, s:0 }),
          battingOrder: ev.battingOrder,
          inning: ev.inning,
          team,
        };
      }
    }
    // Include the first out event itself
    const firstOut = data.playByPlay[START_IDX - 1];
    if (firstOut && firstOut.half === half) {
      const key = `${team}-${firstOut.battingOrder}-${firstOut.inning}`;
      if (!state.userEdits[key]) {
        state.userEdits[key] = { result:firstOut.result, count:firstOut.count||{b:0,s:0}, battingOrder:firstOut.battingOrder, inning:firstOut.inning, team };
      }
    }
    state.tfCaughtUp[team] = true;
    renderOffDefPanel();
  }

  function wireOffDefCellClicks(team, eventMap, isTF) {
    const grid = document.getElementById('atbat-grid');
    if (!grid) return;
    grid.querySelectorAll('[data-cell]').forEach(cell => {
      cell.addEventListener('click', () => {
        const bo  = parseInt(cell.dataset.bo);
        const inn = parseInt(cell.dataset.inning);
        const evts = eventMap[`${bo}-${inn}`] || [];
        const pl   = data.lineups[team].find(p => p.battingOrder === bo);
        if (isTF) {
          openAtBatInputModal(pl, inn, evts, team);
        } else {
          // WNL
          const key = `${team}-${bo}-${inn}`;
          const hasAB = evts.length > 0;
          if (!hasAB) return; // dead cell
          const isRevealed = evts[0].globalIndex < state.revealedIndex;
          if (isRevealed) openAtBatReadModal(pl, inn, evts);
          else            openNotYetModal(pl, inn);
        }
      });
    });
  }

  function syncPlayerColScroll() {
    const gs = document.getElementById('grid-scroll');
    const pc = document.getElementById('player-col');
    if (gs && pc) gs.addEventListener('scroll', () => { pc.scrollTop = gs.scrollTop; });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  MODAL SYSTEM
  // ════════════════════════════════════════════════════════════════════════════
  function openModal() {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
  function closeModal() {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  document.getElementById('modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // WNL: read-only at-bat detail
  function openAtBatReadModal(player, inning, evts) {
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    const ev = evts[0];
    const cnt = typeof ev.count === 'string' ? ev.count : `${ev.count?.b??0}-${ev.count?.s??0}`;
    modalBody.innerHTML = `
      <div class="col-span-3 bg-gray-50 rounded-xl p-4 text-center">
        <div class="text-2xl font-extrabold text-gray-900 mb-1">${ev.result}</div>
        <div class="text-xs text-gray-500">Count ${cnt} &nbsp;·&nbsp; ${ev.outsBefore}→${ev.outsAfter} outs</div>
      </div>
    `;
    openModal();
  }

  // WNL: not-yet-revealed cell
  function openNotYetModal(player, inning) {
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    modalBody.innerHTML = `
      <div class="col-span-3 text-center py-4">
        <div class="text-3xl mb-2">⏳</div>
        <p class="text-sm font-semibold text-gray-500">Not yet revealed in Watch &amp; Learn</p>
      </div>
    `;
    openModal();
  }

  // ── TF input flow ──────────────────────────────────────────────────────────
  let modalCtx = null;

  function chip(extra='') {
    return `class="col-span-1 ${extra} bg-gray-100 hover:bg-amber-100 hover:text-gray-900
                   rounded-xl py-3 text-center transition-colors cursor-pointer text-gray-700"`;
  }
  function navRow(title, onBack) {
    return `<div class="col-span-3 flex items-center gap-2 mb-2">
      ${onBack?`<button data-back class="text-xs text-gray-400 hover:text-gray-700">← Back</button>`:''}
      <span class="text-xs font-semibold text-gray-400 ml-auto">${title}</span>
    </div>`;
  }

  function openAtBatInputModal(player, inning, evts, team) {
    const key = `${team}-${player.battingOrder}-${inning}`;
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    modalCtx = { player, inning, team, editKey:key, result:null, count:{b:0,s:0} };
    const existing = state.userEdits[key];
    if (existing) modalCtx = { ...modalCtx, result:existing.result, count:{...(existing.count||{b:0,s:0})} };
    renderCategoryScreen();
    openModal();
  }

  const SCREENS = {};

  function renderCategoryScreen() {
    modalBody.innerHTML = `
      ${navRow('Select result')}
      <button data-go="hit" ${chip()}>Hit</button>
      <button data-go="out" ${chip()}>Out</button>
      <button data-go="walk" ${chip()}>Walk/HBP</button>
      <button data-go="error" ${chip()}>Error</button>
      <button data-go="other" ${chip('col-span-3')}>Other — FC · SAC · SB · WP · PB</button>
      <div class="col-span-3 border-t border-gray-100 mt-1 pt-2">
        <button data-open-sub class="w-full text-left text-xs text-blue-600 font-semibold py-1 hover:text-blue-800">
          ↔ Make substitution for this batter…
        </button>
      </div>
    `;
    wireBack(null);
    modalBody.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => SCREENS[b.dataset.go]?.()));
    modalBody.querySelector('[data-open-sub]')?.addEventListener('click', () => openSubstitutionScreen());
  }

  SCREENS.hit = () => {
    modalBody.innerHTML = `${navRow('Hit type', true)}
      ${['1B','2B','3B','HR'].map(c=>`<button data-result="${c}" ${chip()}>${c}</button>`).join('')}`;
    wireBack(renderCategoryScreen); wireResults();
  };
  SCREENS.walk = () => {
    modalBody.innerHTML = `${navRow('Walk / HBP', true)}
      <button data-result="BB" ${chip('col-span-1')}>BB</button>
      <button data-result="HBP" ${chip('col-span-2')}>HBP</button>`;
    wireBack(renderCategoryScreen); wireResults();
  };
  SCREENS.out = () => {
    modalBody.innerHTML = `${navRow('Out type', true)}
      <button data-go="strikeout" ${chip('col-span-3')}>Strikeout</button>
      <button data-go="flyout" ${chip()}>Fly Out</button>
      <button data-go="groundout" ${chip('col-span-2')}>Ground Out</button>`;
    wireBack(renderCategoryScreen);
    modalBody.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => SCREENS[b.dataset.go]?.()));
  };
  SCREENS.strikeout = () => {
    modalBody.innerHTML = `${navRow('Strikeout', true)}
      <button data-result="K" ${chip('col-span-1')}>Swinging<br><small>K</small></button>
      <button data-result="˓" ${chip('col-span-2')}>Looking<br><small>˓</small></button>`;
    wireBack(SCREENS.out); wireResults();
  };
  SCREENS.flyout = () => {
    modalBody.innerHTML = `${navRow('Fielder', true)}
      ${FIELD_POS.map(p=>`<button data-result="F${p.n}" ${chip()}>${p.lbl}<br><small class="text-gray-400">F${p.n}</small></button>`).join('')}`;
    wireBack(SCREENS.out); wireResults();
  };
  SCREENS.groundout = () => {
    const seq = [];
    function draw() {
      modalBody.innerHTML = `${navRow('Tap fielders in order', true)}
        <div class="col-span-3 text-center font-bold text-xl mb-1 text-gray-800">${seq.length?seq.join('-'):'—'}</div>
        ${FIELD_POS.map(p=>`<button data-pos="${p.n}" ${chip()}>${p.lbl}<br><small class="text-gray-400">${p.n}</small></button>`).join('')}
        <button data-undo ${chip()}>Undo</button>
        <button data-confirm-seq ${chip('col-span-2 !bg-gray-900 !text-white')} ${!seq.length?'disabled':''}>Confirm Out</button>`;
      wireBack(SCREENS.out);
      modalBody.querySelectorAll('[data-pos]').forEach(b=>b.addEventListener('click',()=>{seq.push(b.dataset.pos);draw();}));
      modalBody.querySelector('[data-undo]').addEventListener('click',()=>{seq.pop();draw();});
      if(seq.length) modalBody.querySelector('[data-confirm-seq]').addEventListener('click',()=>selectResult(seq.join('-')));
    }
    draw();
  };
  SCREENS.error = () => {
    modalBody.innerHTML = `${navRow('Fielder who erred', true)}
      ${FIELD_POS.map(p=>`<button data-result="E${p.n}" ${chip()}>${p.lbl}<br><small class="text-gray-400">E${p.n}</small></button>`).join('')}`;
    wireBack(renderCategoryScreen); wireResults();
  };
  SCREENS.other = () => {
    modalBody.innerHTML = `${navRow('Other', true)}
      ${['FC','SAC','SB','WP','PB'].map(c=>`<button data-result="${c}" ${chip()}>${c}</button>`).join('')}`;
    wireBack(renderCategoryScreen); wireResults();
  };

  function renderCountScreen() {
    modalBody.innerHTML = `
      ${navRow(`Result: ${modalCtx.result}`, true)}
      <div class="col-span-3 grid grid-cols-2 gap-4 mb-3">
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-2">Balls</p>
          <div class="flex items-center justify-center gap-3">
            <button data-c="b-" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">−</button>
            <span id="cnt-b" class="w-5 text-center font-bold text-gray-900">${modalCtx.count.b}</span>
            <button data-c="b+" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">+</button>
          </div>
        </div>
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-2">Strikes</p>
          <div class="flex items-center justify-center gap-3">
            <button data-c="s-" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">−</button>
            <span id="cnt-s" class="w-5 text-center font-bold text-gray-900">${modalCtx.count.s}</span>
            <button data-c="s+" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">+</button>
          </div>
        </div>
      </div>
      <button data-confirm-final ${chip('col-span-3 !bg-gray-900 !text-white font-bold')}>
        Confirm At-Bat
      </button>
    `;
    wireBack(renderCategoryScreen);
    modalBody.querySelectorAll('[data-c]').forEach(btn => btn.addEventListener('click', () => {
      const [f,d] = [btn.dataset.c[0], btn.dataset.c[1]];
      modalCtx.count[f] = Math.min(f==='b'?3:2, Math.max(0, modalCtx.count[f]+(d==='+'?1:-1)));
      document.getElementById(`cnt-${f}`).textContent = modalCtx.count[f];
    }));
    modalBody.querySelector('[data-confirm-final]').addEventListener('click', confirmAtBat);
  }

  function wireBack(backFn) {
    modalBody.querySelector('[data-back]')?.addEventListener('click', backFn || renderCategoryScreen);
  }
  function wireResults() {
    modalBody.querySelectorAll('[data-result]').forEach(b => b.addEventListener('click', ()=>selectResult(b.dataset.result)));
  }
  function selectResult(r) { modalCtx.result = r; renderCountScreen(); }

  function confirmAtBat() {
    state.userEdits[modalCtx.editKey] = {
      result: modalCtx.result, count:{...modalCtx.count},
      battingOrder: modalCtx.player.battingOrder, inning:modalCtx.inning, team:modalCtx.team,
    };
    closeModal();
    renderOffDefPanel();
  }

  // ── Substitution flow (TF off/def) ─────────────────────────────────────────
  function openSubstitutionScreen() {
    const team   = modalCtx.team;
    const bench  = data.bench[team] || [];
    modalTitle.textContent = `Substitute — ${modalCtx.player.name}`;
    modalBody.innerHTML = `
      ${navRow('Choose incoming player', true)}
      <div class="col-span-3 text-xs text-gray-500 mb-1">
        Current: <strong>${modalCtx.player.name}</strong> (${modalCtx.player.positionAbbr})
      </div>
      ${bench.map(b=>`
        <button data-bench="${b.name}" data-bench-pos="${b.eligiblePositions[0]}"
          class="col-span-3 bg-gray-100 hover:bg-amber-100 rounded-xl py-2.5 px-3 text-left transition-colors cursor-pointer">
          <span class="font-semibold text-gray-900 text-sm">${b.name}</span>
          <span class="text-xs text-gray-500 ml-2">${b.eligiblePositions.join('/')} · ${b.bats}</span>
        </button>`).join('')}
    `;
    wireBack(renderCategoryScreen);
    modalBody.querySelectorAll('[data-bench]').forEach(btn => {
      btn.addEventListener('click', () => {
        const incomingName = btn.dataset.bench;
        const incomingPos  = btn.dataset.benchPos;
        renderSubActionScreen(incomingName, incomingPos);
      });
    });
  }

  function renderSubActionScreen(incomingName, incomingPos) {
    const team    = modalCtx.team;
    const outBo   = modalCtx.player.battingOrder;
    const lineup  = data.lineups[team];

    modalTitle.textContent = `${incomingName} enters`;
    modalBody.innerHTML = `
      ${navRow('What happens to current player?', true)}
      <button data-sub-remove ${chip('col-span-3 !bg-red-50 !text-red-700 hover:!bg-red-100')}>
        Remove from game (${modalCtx.player.name} is done)
      </button>
      <div class="col-span-3 my-1 text-xs text-gray-400 text-center">— or —</div>
      <div class="col-span-3 text-xs font-semibold text-gray-500 mb-1">Move to another position (that player is then removed):</div>
      ${lineup.filter(p=>p.battingOrder !== outBo).map(p=>`
        <button data-sub-move="${p.battingOrder}" ${chip('col-span-3 text-left !px-3')}>
          ↔ ${p.name} (${p.positionAbbr}) slot ${p.battingOrder} — ${currentSlot(team,p.battingOrder).name} out permanently
        </button>`).join('')}
    `;
    wireBack(openSubstitutionScreen.bind(null));

    modalBody.querySelector('[data-sub-remove]')?.addEventListener('click', () => {
      applySubstitution(team, outBo, incomingName, incomingPos, null, null);
    });
    modalBody.querySelectorAll('[data-sub-move]').forEach(btn => {
      btn.addEventListener('click', () => {
        const targetBo = parseInt(btn.dataset.subMove);
        applySubstitution(team, outBo, incomingName, incomingPos, targetBo, null);
      });
    });
  }

  function applySubstitution(team, outgoingBo, incomingName, incomingPos, targetBo, _unused) {
    const hist = state.positionHistory[team];
    const outgoingSlot = hist[outgoingBo];
    const outgoingPlayer = outgoingSlot[outgoingSlot.length - 1];

    // Mark outgoing player as inactive
    outgoingPlayer.active = false;

    // Add incoming to outgoing slot
    outgoingSlot.push({ name:incomingName, positionAbbr:incomingPos, active:true });

    if (targetBo !== null) {
      // Outgoing player moves to target slot; player there is permanently removed
      const targetHist = hist[targetBo];
      targetHist[targetHist.length-1].active = false;
      targetHist.push({ name: outgoingPlayer.name, positionAbbr: outgoingPlayer.positionAbbr, active:true });
    }

    closeModal();
    renderOffDefPanel();
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  LINESCORE
  // ════════════════════════════════════════════════════════════════════════════
  const linescoreBody = document.getElementById('linescore-body');

  function computeLiveLinescore() {
    const inn  = { away:Array(INNINGS).fill(0), home:Array(INNINGS).fill(0) };
    const tot  = { away:{R:0,H:0,E:0}, home:{R:0,H:0,E:0} };
    data.playByPlay.slice(0, state.revealedIndex).forEach(ev => {
      const side = ev.half==='top' ? 'away' : 'home';
      inn[side][ev.inning-1] += ev.runsScoredOnPlay||0;
      tot[side].R += ev.runsScoredOnPlay||0;
      if (ev.category==='hit')   tot[side].H++;
      if (ev.category==='error') tot[side].E++;
    });
    return { inn, tot };
  }

  function renderLinescore() {
    const { inn, tot } = computeLiveLinescore();
    linescoreBody.innerHTML = '';
    ['away','home'].forEach(side => {
      const tr = document.createElement('tr');
      const cells = inn[side].map(r=>`<td class="py-1.5 text-center">${r||''}</td>`).join('');
      tr.innerHTML = `
        <td class="ls-team-col bg-gray-50 text-left pl-3 py-1.5">
          <div class="flex items-center gap-1">
            <img src="${LOGO[side]}" class="w-3.5 h-3.5 rounded-full" alt="">
            <span>${ABBR[side]}</span>
          </div>
        </td>
        ${cells}
        <td class="border-l border-gray-300 text-center font-bold">${tot[side].R}</td>
        <td class="text-center">${tot[side].H}</td>
        <td class="text-center">${tot[side].E}</td>
      `;
      linescoreBody.appendChild(tr);
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  GAME CLOCK — WNL only, no pause, auto-starts
  // ════════════════════════════════════════════════════════════════════════════
  let playTimer = null;

  function computeCurrentState() {
    const total = data.playByPlay.length;
    if (state.revealedIndex >= total) return { final:true };
    if (state.revealedIndex === 0)    return { inning:1, half:'top', outs:0 };
    const last = data.playByPlay[state.revealedIndex-1];
    if (last.outsAfter < 3) return { inning:last.inning, half:last.half, outs:last.outsAfter };
    const next = data.playByPlay[state.revealedIndex];
    return { inning:next.inning, half:next.half, outs:0 };
  }

  function renderStatus(initial=false) {
    if (initial || state.revealedIndex === START_IDX) {
      clockStatus.textContent = 'Demo starts at: Top 4th – 1st Out (Tube Socks)';
      return;
    }
    const s = computeCurrentState();
    clockStatus.textContent = s.final
      ? 'Final'
      : `${s.half==='top'?'Top':'Bottom'} ${s.inning} — ${s.outs} Out${s.outs===1?'':'s'}`;
  }

  function tick() {
    if (state.revealedIndex >= data.playByPlay.length) { stopPlayback(); return; }
    state.revealedIndex++;
    renderLinescore();
    renderStatus();
    // Update off/def grid if visible, and pitching tab
    if (state.section === 'offense-defense') renderOffDefPanel();
    if (state.section === 'pitching')         renderPitchingPanel();
  }

  function startPlayback() {
    if (state.mode !== 'watch-learn' || state.revealedIndex >= data.playByPlay.length) return;
    stopPlayback();
    state.isPlaying = true;
    playTimer = setInterval(tick, BASE_MS / parseFloat(speedSelect.value||'1'));
  }

  function stopPlayback() {
    state.isPlaying = false;
    clearInterval(playTimer);
    playTimer = null;
  }

  speedSelect.addEventListener('change', () => { if (state.isPlaying) { stopPlayback(); startPlayback(); } });

  document.getElementById('btn-reset').addEventListener('click', () => {
    stopPlayback();
    state.revealedIndex = START_IDX;
    renderLinescore();
    renderStatus(true);
    if (state.section) renderCurrentPanel();
    startPlayback();
  });

  document.getElementById('btn-save').addEventListener('click', () => {
    const btn = document.getElementById('btn-save');
    const orig = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(()=>{ btn.textContent = orig; }, 1400);
  });

  // ── Toggle TF → WNL: resume from current state ────────────────────────────
  // (handled in setMode: WNL path calls startPlayback(), which resumes from
  //  wherever state.revealedIndex is — including any progress made in TF mode)

  // ── Initial render ─────────────────────────────────────────────────────────
  renderLinescore();

})();
