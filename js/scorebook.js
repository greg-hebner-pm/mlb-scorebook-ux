/**
 * scorebook.js — MLB Digital Scorebook v3
 *
 * Game clock research (MLB 2025):
 *   Avg 9-inning game 2h 38min, ~75 PA → ~126s/AB real pace.
 *   Demo 1x = 90s/AB, 15s between half-innings.
 *   2x = 45s/AB, 7.5s transition.  3x = 30s/AB, 5s transition.
 */
(async function init() {
  const data = await window.MLBScorebook.loadGameData();

  /* ── Constants ──────────────────────────────────────────────────────────── */
  const START_IDX     = data.meta.startEventIndex;
  const AB_MS_1X      = 60000;
  const TRANS_MS_1X   = 15000;
  const INNINGS       = 11;
  const HALF          = { away:'top', home:'bottom' };
  const LOGO          = { away:'../assets/logos/tubesocks.svg', home:'../assets/logos/tiggers.svg' };
  const ABBR          = { away:'TBS', home:'TIG' };
  const POS_LIST      = ['C','1B','2B','3B','SS','LF','CF','RF'];
  const FIELD_POS     = [
    {n:1,lbl:'P'},{n:2,lbl:'C'},{n:3,lbl:'1B'},{n:4,lbl:'2B'},{n:5,lbl:'3B'},
    {n:6,lbl:'SS'},{n:7,lbl:'LF'},{n:8,lbl:'CF'},{n:9,lbl:'RF'},
  ];

  /* ── State ──────────────────────────────────────────────────────────────── */
  const state = {
    mode:          null,
    team:          null,
    section:       null,
    revealedIndex: START_IDX,   // history already "happened"; clock ticks forward from here
    isPlaying:     false,
    lastAutoHalf:  null,         // tracks last half-inning we auto-bounced on

    tfLineup:     { away: Array(8).fill(null), home: Array(8).fill(null) },
    lineupLocked: { away: false, home: false },
    positionHistory: { away: buildPosHistory('away'), home: buildPosHistory('home') },
    userEdits:    {},            // key: `${team}-${bo}-${inning}`
    tfPitchers:   { away: null, home: null },
    tfCaughtUp:   { away: false, home: false },
  };

  function buildPosHistory(team) {
    const h = {};
    data.lineups[team].forEach(p => {
      h[p.battingOrder] = [{ name:p.name, positionAbbr:p.positionAbbr, active:true }];
    });
    return h;
  }
  function currentSlot(team, bo) {
    const h = state.positionHistory[team][bo];
    return h[h.length - 1];
  }

  /* ── DOM refs ───────────────────────────────────────────────────────────── */
  const teamBar     = document.getElementById('team-bar');
  const sectionBar  = document.getElementById('section-bar');
  const clockBar    = document.getElementById('clock-bar');
  const saveBar     = document.getElementById('save-bar');
  const modal       = document.getElementById('atbat-modal');
  const modalTitle  = document.getElementById('modal-title');
  const modalBody   = document.getElementById('modal-body');
  const clockStatus = document.getElementById('clock-status');
  const speedSelect = document.getElementById('playback-speed');

  /* ── Speed helpers ──────────────────────────────────────────────────────── */
  function speed()      { return parseFloat(speedSelect.value || '1'); }
  function abMS()       { return AB_MS_1X    / speed(); }
  function transMS()    { return TRANS_MS_1X / speed(); }

  /* ── Header: Mode toggle ────────────────────────────────────────────────── */
  document.querySelectorAll('[data-mode]').forEach(btn =>
    btn.addEventListener('click', () => setMode(btn.dataset.mode)));

  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll('[data-mode]').forEach(btn => {
      const on = btn.dataset.mode === mode;
      btn.classList.toggle('tab-active', on);
      btn.classList.toggle('text-gray-400', !on);
      btn.setAttribute('aria-selected', on);
    });
    const isWNL = mode === 'watch-learn';
    clockBar.classList.toggle('hidden', !isWNL);
    saveBar.classList.toggle('hidden',  isWNL);
    if (isWNL) {
      state.revealedIndex = START_IDX;
      state.lastAutoHalf = data.playByPlay[START_IDX]?.half || 'top';
      renderLinescore(); renderStatus(true);
      startPlayback();
    } else {
      stopPlayback();
      renderLinescore();
    }
    if (state.team && state.section) renderCurrentPanel();
    else showEmpty('Select a team and tab above.');
  }

  /* ── Header: Team ───────────────────────────────────────────────────────── */
  document.querySelectorAll('[data-team]').forEach(btn =>
    btn.addEventListener('click', () => setTeam(btn.dataset.team)));

  function setTeam(team, auto=false) {
    state.team = team;
    document.querySelectorAll('[data-team]').forEach(btn => {
      const on = btn.dataset.team === team;
      btn.classList.toggle('tab-active', on);
      btn.classList.toggle('text-gray-400', !on);
    });
    if (!state.section) selectSection('lineup');
    else renderCurrentPanel();
  }

  /* ── Header: Section ────────────────────────────────────────────────────── */
  document.querySelectorAll('[data-section]').forEach(btn =>
    btn.addEventListener('click', () => { if (state.team) selectSection(btn.dataset.section); }));

  function selectSection(section) {
    state.section = section;
    document.querySelectorAll('[data-section]').forEach(btn => {
      const on = btn.dataset.section === section;
      btn.classList.toggle('tab-active', on);
      btn.classList.toggle('text-gray-400', !on);
    });
    renderCurrentPanel();
  }

  /* ── Panel routing ──────────────────────────────────────────────────────── */
  function showEmpty(msg) {
    document.getElementById('panel-empty').classList.remove('hidden');
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
    document.getElementById('empty-message').textContent = msg;
  }

  function renderCurrentPanel() {
    document.getElementById('panel-empty').classList.add('hidden');
    document.querySelectorAll('[data-panel]').forEach(p => p.classList.add('hidden'));
    if (!state.mode || !state.team || !state.section) { showEmpty('Select a mode, team and tab above.'); return; }
    const panel = document.getElementById('panel-' + state.section);
    if (panel) panel.classList.remove('hidden');
    if (state.section === 'lineup')           renderLineupPanel();
    if (state.section === 'pitching')         renderPitchingPanel();
    if (state.section === 'offense-defense')  renderOffDefPanel();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     POSITIONAL MAP SVG (reference for off/def users)
  ══════════════════════════════════════════════════════════════════════════ */
  const FIELD_SVG = `
    <div class="mx-4 my-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
      <p class="text-[10px] font-semibold text-gray-500 mb-2 text-center">Position Reference</p>
      <svg viewBox="0 0 200 185" xmlns="http://www.w3.org/2000/svg" class="w-full max-w-[200px] mx-auto block">
        <!-- Outfield arc -->
        <path d="M 22 155 Q 100 5 178 155" fill="#dcfce7" stroke="#86efac" stroke-width="1.5" fill-opacity="0.6"/>
        <!-- Infield dirt -->
        <path d="M 100 172 L 158 114 L 100 56 L 42 114 Z" fill="#fef3c7" stroke="#d4a870" stroke-width="1" fill-opacity="0.7"/>
        <!-- Baselines -->
        <path d="M 100 172 L 158 114 L 100 56 L 42 114 Z" fill="none" stroke="#92400e" stroke-width="1.5"/>
        <!-- Pitcher circle -->
        <circle cx="100" cy="114" r="7" fill="#fde68a" stroke="#92400e" stroke-width="1"/>
        <!-- Position nodes -->
        <!-- 1 P -->
        <circle cx="100" cy="114" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="100" y="118" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">1</text>
        <!-- 2 C -->
        <circle cx="100" cy="172" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="100" y="176" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">2</text>
        <text x="100" y="186" text-anchor="middle" font-size="7" fill="#6b7280">C</text>
        <!-- 3 1B -->
        <circle cx="158" cy="114" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="158" y="118" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">3</text>
        <text x="175" y="118" text-anchor="middle" font-size="7" fill="#6b7280">1B</text>
        <!-- 4 2B -->
        <circle cx="100" cy="56" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="100" y="60" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">4</text>
        <text x="100" y="44" text-anchor="middle" font-size="7" fill="#6b7280">2B</text>
        <!-- 5 3B -->
        <circle cx="42" cy="114" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="42" y="118" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">5</text>
        <text x="24" y="118" text-anchor="middle" font-size="7" fill="#6b7280">3B</text>
        <!-- 6 SS -->
        <circle cx="64" cy="88" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="64" y="92" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">6</text>
        <text x="50" y="78" text-anchor="middle" font-size="7" fill="#6b7280">SS</text>
        <!-- 7 LF -->
        <circle cx="34" cy="45" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="34" y="49" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">7</text>
        <text x="18" y="38" text-anchor="middle" font-size="7" fill="#6b7280">LF</text>
        <!-- 8 CF -->
        <circle cx="100" cy="22" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="100" y="26" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">8</text>
        <text x="100" y="10" text-anchor="middle" font-size="7" fill="#6b7280">CF</text>
        <!-- 9 RF -->
        <circle cx="166" cy="45" r="10" fill="white" stroke="#374151" stroke-width="1.2"/>
        <text x="166" y="49" text-anchor="middle" font-size="10" font-weight="700" fill="#111827">9</text>
        <text x="182" y="38" text-anchor="middle" font-size="7" fill="#6b7280">RF</text>
      </svg>
    </div>`;

  /* ══════════════════════════════════════════════════════════════════════════
     LINEUP PANEL
  ══════════════════════════════════════════════════════════════════════════ */
  function renderLineupPanel() {
    const panel = document.getElementById('panel-lineup');
    if (state.mode === 'watch-learn') renderLineupWNL(panel);
    else                              renderLineupTF(panel);
  }

  function playerListHTML(players) {
    return players.map(p => `
      <div class="flex items-center justify-between px-4 py-3 text-sm">
        <span class="text-gray-400 w-6">${p.battingOrder}</span>
        <span class="flex-1 font-medium text-gray-900">${p.name}</span>
        <span class="text-gray-400 text-xs">${p.positionAbbr}</span>
      </div>`).join('');
  }

  function renderLineupWNL(panel) {
    const players = data.lineups[state.team].filter(p => p.positionAbbr !== 'P');
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Starting Lineup</h2>
      </div>
      <div class="divide-y divide-gray-100">${playerListHTML(players)}</div>
      <p class="text-[10px] text-gray-400 text-center py-3 border-t border-gray-100 mt-2">
        Pitcher details are in the Pitching tab.
      </p>
      ${FIELD_SVG}`;
  }

  function renderLineupTF(panel) {
    const team = state.team;
    if (state.lineupLocked[team]) {
      const overrides = state.tfLineup[team];
      const players   = data.lineups[team].filter(p => p.positionAbbr !== 'P');
      const rows = players.map((p, i) => {
        const e = overrides[i] || { name:p.name, positionAbbr:p.positionAbbr };
        return `<div class="flex items-center justify-between px-4 py-3 text-sm">
          <span class="text-gray-400 w-6">${p.battingOrder}</span>
          <span class="flex-1 font-medium text-gray-900">${e.name}</span>
          <span class="text-gray-400 text-xs">${e.positionAbbr}</span>
        </div>`;
      }).join('');
      panel.innerHTML = `
        <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
          <h2 class="font-bold text-gray-900">Starting Lineup</h2>
          <span class="text-[10px] text-gray-400 italic">Locked ✓</span>
        </div>
        <div class="divide-y divide-gray-100">${rows}</div>
        <p class="text-[10px] text-gray-400 text-center py-3 border-t border-gray-100 mt-2">
          Substitutions are managed in the Offense/Defense tab.
        </p>
        ${FIELD_SVG}`;
      return;
    }
    const cur = state.tfLineup[team];
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Starting Lineup</h2>
        <button id="btn-insert-lineup" class="text-xs bg-gray-900 text-white font-bold px-3 py-1.5 rounded-lg">Insert Lineup</button>
      </div>
      <div id="lineup-form" class="divide-y divide-gray-100">
        ${[1,2,3,4,5,6,7,8].map(bo => {
          const e = cur[bo-1];
          return `<div class="flex items-center gap-2 px-4 py-2.5">
            <span class="text-gray-400 text-sm w-5">${bo}</span>
            <input type="text" placeholder="Player name…" value="${e?.name||''}"
              data-slot="${bo-1}"
              class="flex-1 text-sm border-b border-gray-200 focus:border-gray-900 outline-none py-0.5 bg-transparent">
            <select data-pos-slot="${bo-1}"
              class="text-xs border border-gray-200 rounded px-1.5 py-1 outline-none bg-white text-gray-600 shrink-0">
              <option value="">Pos</option>
              ${POS_LIST.map(pos=>`<option value="${pos}" ${e?.positionAbbr===pos?'selected':''}>${pos}</option>`).join('')}
            </select>
          </div>`;
        }).join('')}
      </div>
      <div class="px-4 py-3 border-t border-gray-100">
        <button id="btn-confirm-lineup"
          class="w-full bg-gray-900 text-white text-sm font-bold py-2.5 rounded-xl">Confirm Lineup</button>
        <p class="text-[10px] text-gray-400 text-center mt-2">Substitutions are managed in the Offense/Defense tab.</p>
      </div>
      ${FIELD_SVG}`;

    panel.querySelectorAll('input[data-slot]').forEach(inp => {
      inp.addEventListener('input', () => {
        const i = +inp.dataset.slot;
        if (!state.tfLineup[team][i]) state.tfLineup[team][i] = { name:'', positionAbbr:'' };
        state.tfLineup[team][i].name = inp.value.trim();
      });
    });
    panel.querySelectorAll('select[data-pos-slot]').forEach(sel => {
      sel.addEventListener('change', () => {
        const i = +sel.dataset.posSlot;
        if (!state.tfLineup[team][i]) state.tfLineup[team][i] = { name:'', positionAbbr:'' };
        state.tfLineup[team][i].positionAbbr = sel.value;
      });
    });
    document.getElementById('btn-insert-lineup').addEventListener('click', () => {
      const players = data.lineups[team].filter(p=>p.positionAbbr!=='P');
      state.tfLineup[team] = players.map(p=>({ name:p.name, positionAbbr:p.positionAbbr }));
      state.lineupLocked[team] = true;
      renderLineupPanel();
    });
    document.getElementById('btn-confirm-lineup').addEventListener('click', () => {
      const inputs  = panel.querySelectorAll('input[data-slot]');
      const selects = panel.querySelectorAll('select[data-pos-slot]');
      const entries = [];
      let ok = true;
      inputs.forEach((inp,i) => {
        const name=inp.value.trim(), pos=selects[i].value;
        if (!name||!pos) ok=false;
        entries.push(name&&pos ? {name,positionAbbr:pos} : null);
      });
      if (!ok) { alert('Fill in all names and positions first.'); return; }
      state.tfLineup[team] = entries;
      state.lineupLocked[team] = true;
      renderLineupPanel();
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     PITCHING PANEL
  ══════════════════════════════════════════════════════════════════════════ */
  function renderPitchingPanel() {
    const panel = document.getElementById('panel-pitching');
    if (state.mode === 'watch-learn') renderPitchingWNL(panel);
    else                              renderPitchingTF(panel);
  }

  // Which half does this team's pitching staff appear in?
  // Away team pitches when home bats (bottom). Home pitches when away bats (top).
  function pitchingHalf(team) { return team === 'away' ? 'bottom' : 'top'; }

  function computePitcherStats(team, upTo) {
    const half = pitchingHalf(team);
    const order = []; const stats = {};
    for (let i = 0; i < upTo; i++) {
      const ev = data.playByPlay[i];
      if (ev.half !== half) continue;
      const nm = ev.pitcher;
      if (!stats[nm]) {
        stats[nm] = { bf:0, h:0, r:0, er:0, bb:0, k:0, outs:0, p:0 };
        order.push(nm);
      }
      const s = stats[nm];
      s.bf++;
      s.p += ev.pitchCount || 4;
      if (ev.category==='hit')  s.h++;
      if (ev.category==='walk') s.bb++;
      if (ev.result==='K' || ev.result==='˓') s.k++;
      s.r  += ev.runsScoredOnPlay||0;
      if (ev.category!=='error') s.er += ev.runsScoredOnPlay||0;
      s.outs += Math.max(0, (ev.outsAfter||0) - (ev.outsBefore||0));
    }
    return order.map(nm => {
      const s = stats[nm];
      const pitcher = data.pitchers[team].find(p=>p.name===nm);
      const full = Math.floor(s.outs/3), rem = s.outs%3;
      return { name:nm, throws:pitcher?.throws||'?', ip:`${full}.${rem}`,
               p:s.p, bf:s.bf, h:s.h, r:s.r, er:s.er, bb:s.bb, k:s.k };
    });
  }

  function pitchingTableHTML(pitchers, editable=false) {
    const headers = ['PITCHER','R/L','IP','P','BF','H','R','ER','BB','K'];
    const cols    = ['name','throws','ip','p','bf','h','r','er','bb','k'];
    const statCols = ['ip','p','bf','h','r','er','bb','k'];
    if (!pitchers.length) {
      return `<p class="text-xs text-gray-400 text-center py-6">No pitchers yet.</p>`;
    }
    return `
      <div class="overflow-x-auto">
        <table class="w-full text-xs text-center border-collapse min-w-[340px]">
          <thead class="bg-gray-50 text-gray-500">
            <tr>${headers.map(h=>`<th class="py-2 px-1 font-semibold ${h==='PITCHER'?'text-left pl-4':''}">${h}</th>`).join('')}</tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            ${pitchers.map((p,ri) => `
              <tr>
                ${editable ? `
                  <td class="text-left pl-3 py-1">
                    <input type="text" value="${p.name||''}" data-pi="${ri}" data-fi="name"
                      placeholder="Pitcher name…"
                      class="w-full text-xs border-b border-gray-200 focus:border-gray-900 outline-none bg-transparent"/>
                  </td>
                  <td class="px-1">
                    <select data-pi="${ri}" data-fi="throws"
                      class="text-xs border border-gray-200 rounded px-1 outline-none bg-white">
                      <option value="">—</option>
                      <option value="R" ${p.throws==='R'?'selected':''}>R</option>
                      <option value="L" ${p.throws==='L'?'selected':''}>L</option>
                    </select>
                  </td>
                  ${statCols.map(f=>`
                    <td class="px-0.5 py-1">
                      <input type="text" value="${p[f]||'—'}" data-pi="${ri}" data-fi="${f}"
                        class="w-9 text-center text-xs border-b border-gray-100 focus:border-gray-900 outline-none bg-transparent"/>
                    </td>`).join('')}
                ` : `
                  <td class="text-left pl-4 py-2 font-medium text-gray-900">${p.name}</td>
                  <td class="text-gray-500">${p.throws}</td>
                  ${statCols.map(f=>`<td>${p[f]??'—'}</td>`).join('')}
                `}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function renderPitchingWNL(panel) {
    const pitchers = computePitcherStats(state.team, state.revealedIndex);
    // Ensure at least the starting pitcher is shown even before any events
    if (!pitchers.length) {
      const sp = data.pitchers[state.team][0];
      if (sp) pitchers.push({ name:sp.name, throws:sp.throws, ip:'0.0', p:0, bf:0, h:0, r:0, er:0, bb:0, k:0 });
    }
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Pitching</h2>
        <p class="text-[10px] text-gray-400 mt-0.5">Updates as game progresses.</p>
      </div>
      ${pitchingTableHTML(pitchers, false)}`;
  }

  function renderPitchingTF(panel) {
    const team = state.team;
    let entries = state.tfPitchers[team];

    // Build editable table
    const buildEditable = (pitcherList) => {
      panel.innerHTML = `
        <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
          <h2 class="font-bold text-gray-900">Pitching</h2>
          <button id="btn-insert-p" class="text-xs bg-gray-900 text-white font-bold px-3 py-1.5 rounded-lg">Catch Up</button>
        </div>
        <div id="pitching-tf-wrap">${pitchingTableHTML(pitcherList, true)}</div>
        <div class="px-4 py-3 border-t border-gray-100">
          <button id="btn-add-reliever"
            class="w-full border border-dashed border-gray-300 text-xs text-gray-500 font-semibold py-2 rounded-xl hover:bg-gray-50">
            + Add Reliever
          </button>
        </div>`;

      // Wire editable inputs to state
      function syncInputs() {
        panel.querySelectorAll('[data-pi]').forEach(el => {
          el.addEventListener('change', () => {
            const i  = +el.dataset.pi;
            const fi = el.dataset.fi;
            if (!state.tfPitchers[team]) state.tfPitchers[team] = [...pitcherList];
            state.tfPitchers[team][i] = state.tfPitchers[team][i] || {};
            state.tfPitchers[team][i][fi] = el.value;
          });
        });
      }
      syncInputs();

      document.getElementById('btn-insert-p').addEventListener('click', () => {
        // Catch-up: only pitchers who have appeared up to START_IDX
        const caught = computePitcherStats(team, START_IDX);
        if (!caught.length) {
          const sp = data.pitchers[team][0];
          if (sp) caught.push({ name:sp.name, throws:sp.throws, ip:'0.0', p:0, bf:0, h:0, r:0, er:0, bb:0, k:0 });
        }
        state.tfPitchers[team] = caught;
        renderPitchingTF(panel);
      });

      document.getElementById('btn-add-reliever').addEventListener('click', () => {
        if (!state.tfPitchers[team]) state.tfPitchers[team] = [...pitcherList];
        state.tfPitchers[team].push({ name:'', throws:'', ip:'—', p:'—', bf:'—', h:'—', r:'—', er:'—', bb:'—', k:'—' });
        renderPitchingTF(panel);
      });
    };

    buildEditable(entries || [{ name:'', throws:'', ip:'—', p:'—', bf:'—', h:'—', r:'—', er:'—', bb:'—', k:'—' }]);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     OFFENCE / DEFENSE PANEL
  ══════════════════════════════════════════════════════════════════════════ */
  function renderOffDefPanel() {
    const panel = document.getElementById('panel-offense-defense');
    if (state.mode === 'watch-learn') renderOffDefWNL(panel);
    else                              renderOffDefTF(panel);
  }

  function buildEventMap(team) {
    const half = HALF[team]; const map = {};
    data.playByPlay.forEach((ev,idx) => {
      if (ev.half !== half) return;
      const key = `${ev.battingOrder}-${ev.inning}`;
      if (!map[key]) map[key] = [];
      map[key].push({ ...ev, globalIndex:idx });
    });
    return map;
  }

  function classifyResult(result) {
    if (!result) return { bases:0, scored:false };
    const r = result.split(/[\s/]/)[0];
    if (['1B','2B','3B','HR'].includes(r)) {
      const b = {'1B':1,'2B':2,'3B':3,'HR':4}[r];
      return { bases:b, scored:b===4 };
    }
    if (['BB','HBP','FC'].some(x=>r.startsWith(x)) || /^E/.test(r)) return { bases:1, scored:false };
    return { bases:0, scored:false };
  }

  function diamondSVG({ bases, scored, dim }) {
    const H=[20,38],F=[38,20],S=[20,2],T=[2,20];
    const segs=[[H,F],[F,S],[S,T],[T,H]];
    const n = scored ? 4 : bases;
    const stroke  = dim ? '#e5e7eb' : '#d1d5db';
    const pStroke = dim ? '#9ca3af' : '#041e42';
    const fill    = scored && !dim ? 'rgba(4,30,66,0.12)' : 'none';
    const outline = `<polygon points="${[H,F,S,T].map(p=>p.join(',')).join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    const lines   = segs.map(([a,b],i) => i<n
      ? `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${pStroke}" stroke-width="2.5" stroke-linecap="round"/>`
      : '').join('');
    return `<svg viewBox="0 0 40 40" class="w-7 h-7">${outline}${lines}</svg>`;
  }

  function gridCell(team, bo, inning, eventMap, isTF) {
    const key  = `${team}-${bo}-${inning}`;
    const edit = state.userEdits[key];
    const evts = eventMap[`${bo}-${inning}`] || [];

    // TF: only user edits are shown (blank until filled in)
    if (isTF) {
      const hasEdit = !!edit;
      const label   = edit?.result || '';
      const cls     = hasEdit ? classifyResult(label) : { bases:0, scored:false };
      return `
        <div data-cell data-bo="${bo}" data-inning="${inning}"
             class="w-[74px] shrink-0 border-b border-l border-gray-200 flex flex-col items-center
                    justify-center gap-0.5 relative bg-white min-h-[76px] cursor-pointer hover:bg-amber-50 transition-colors">
          ${hasEdit ? diamondSVG({...cls, dim:false}) : '<div class="w-5 h-5 border border-gray-200 rotate-45 opacity-30"></div>'}
          ${hasEdit && label ? `<span class="text-[8px] font-bold text-gray-800 max-w-[58px] text-center truncate">${label}</span>` : ''}
          ${edit ? '<span class="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-blue-500"></span>' : ''}
        </div>`;
    }

    // WNL: three visual states
    const hasAB      = evts.length > 0;
    const happened   = hasAB && evts[0].globalIndex < state.revealedIndex;
    const isCurrent  = hasAB && evts[0].globalIndex === state.revealedIndex - 1;
    const isFuture   = hasAB && !happened;
    const isDead     = !hasAB;
    const label      = happened ? evts[0].result : '';
    const cls        = happened ? classifyResult(label) : { bases:0, scored:false };

    if (isDead) {
      return `<div class="w-[74px] shrink-0 border-b border-l border-gray-100 bg-gray-50/50 min-h-[76px] cell-dead"></div>`;
    }
    if (isFuture) {
      // Faint outline only — no result peeking through
      return `
        <div class="w-[74px] shrink-0 border-b border-l border-gray-200 flex items-center justify-center
                    bg-white min-h-[76px] cursor-pointer hover:bg-gray-50 transition-colors"
             data-cell data-bo="${bo}" data-inning="${inning}">
          <div class="w-5 h-5 border border-gray-200 rotate-45 opacity-40"></div>
        </div>`;
    }
    return `
      <div data-cell data-bo="${bo}" data-inning="${inning}"
           class="w-[74px] shrink-0 border-b border-l border-gray-200 flex flex-col items-center
                  justify-center gap-0.5 relative bg-white min-h-[76px]
                  cursor-pointer hover:bg-amber-50 transition-colors ${isCurrent ? 'cell-current' : ''}">
        ${diamondSVG({...cls, dim:false})}
        ${label ? `<span class="text-[8px] font-bold text-gray-800 max-w-[58px] text-center truncate">${label}</span>` : ''}
      </div>`;
  }

  function playerColCell(team, bo) {
    const hist = state.positionHistory[team][bo];
    const inner = hist.map((entry,i) => `
      ${i>0 ? '<div style="border-top:1px dashed #e5e7eb;margin-top:3px;padding-top:3px;"></div>' : ''}
      <span class="block font-${i===hist.length-1&&entry.active?'semibold':'normal'}
                   text-${i===hist.length-1&&entry.active?'gray-900':'gray-400'}
                   truncate text-[11px] leading-tight">
        ${i===0 ? bo+'. ' : '↳ '}${entry.name}
      </span>
      <span class="block text-gray-400 text-[9px] leading-none">${entry.positionAbbr}${!entry.active?' ✕':''}</span>
    `).join('');
    return `<div class="flex flex-col justify-center px-2 py-1.5 border-b border-gray-100 bg-white min-h-[76px]">${inner}</div>`;
  }

  function buildGrid(team, eventMap, isTF) {
    const lineup = data.lineups[team];
    const hdr = Array.from({length:INNINGS},(_,i)=>
      `<div class="w-[74px] shrink-0 h-9 flex items-center justify-center text-[11px] font-bold
                   text-gray-500 border-b border-l border-gray-200 bg-gray-50">${i+1}</div>`
    ).join('');
    const rows = lineup.map(p=>{
      const cells = Array.from({length:INNINGS},(_,i)=>gridCell(team,p.battingOrder,i+1,eventMap,isTF)).join('');
      return `<div class="flex">${cells}</div>`;
    }).join('');
    return `<div class="flex">${hdr}</div>${rows}`;
  }

  function renderOffDefCore(panel, team, isTF, extraHeader='') {
    const eventMap = buildEventMap(team);
    panel.innerHTML = `
      <div class="px-4 pt-4 pb-2 flex items-center justify-between border-b border-gray-100">
        <h2 class="font-bold text-gray-900">Offense / Defense</h2>
        ${extraHeader}
      </div>
      <div class="flex">
        <div class="shrink-0 w-28 border-r border-gray-200 bg-white">
          <div class="h-9 flex items-center text-[10px] font-bold text-gray-500 px-2 border-b border-gray-200 bg-gray-50">PLAYER / POS</div>
          <div id="player-col">${data.lineups[team].map(p=>playerColCell(team,p.battingOrder)).join('')}</div>
        </div>
        <div class="overflow-x-auto flex-1" id="grid-scroll">
          <div id="atbat-grid" class="min-w-[814px]">${buildGrid(team,eventMap,isTF)}</div>
        </div>
      </div>`;
    wireOffDefClicks(team, eventMap, isTF);
    const gs=document.getElementById('grid-scroll'), pc=document.getElementById('player-col');
    if (gs&&pc) gs.addEventListener('scroll', ()=>{ pc.scrollTop=gs.scrollTop; });
    // Auto-scroll to current cell
    requestAnimationFrame(() => {
      const cur = panel.querySelector('.cell-current');
      if (cur) cur.scrollIntoView({ behavior:'smooth', block:'nearest', inline:'center' });
    });
  }

  function renderOffDefWNL(panel) {
    renderOffDefCore(panel, state.team, false, `<span class="text-[10px] text-gray-400">← scroll innings →</span>`);
  }

  function renderOffDefTF(panel) {
    const team   = state.team;
    const caught = state.tfCaughtUp[team];
    const extraHeader = caught
      ? `<span class="text-[10px] text-gray-400 italic">Caught up ✓</span>`
      : `<button id="btn-catchup" class="text-xs bg-gray-900 text-white font-bold px-3 py-1.5 rounded-lg">Catch Up</button>`;
    renderOffDefCore(panel, team, true, extraHeader);
    if (!caught) {
      document.getElementById('btn-catchup')?.addEventListener('click', () => {
        const half = HALF[team];
        for (let i=0; i<START_IDX; i++) {
          const ev=data.playByPlay[i];
          if (ev.half!==half) continue;
          const key=`${team}-${ev.battingOrder}-${ev.inning}`;
          if (!state.userEdits[key]) {
            const cnt = ev.count||'0-0';
            state.userEdits[key] = {
              result:ev.result, count:typeof cnt==='string'
                ? {b:parseInt(cnt[0])||0, s:parseInt(cnt[2])||0}
                : cnt,
              battingOrder:ev.battingOrder, inning:ev.inning, team,
              runsScored: ev.runsScoredOnPlay||0,
            };
          }
        }
        state.tfCaughtUp[team]=true;
        renderOffDefPanel();
      });
    }
  }

  function wireOffDefClicks(team, eventMap, isTF) {
    document.querySelectorAll('[data-cell]').forEach(cell => {
      cell.addEventListener('click', () => {
        const bo=+cell.dataset.bo, inn=+cell.dataset.inning;
        const evts = eventMap[`${bo}-${inn}`]||[];
        const pl   = data.lineups[team].find(p=>p.battingOrder===bo);
        if (isTF) {
          openAtBatInputModal(pl, inn, evts, team);
        } else {
          if (!evts.length) return;
          const happened = evts[0].globalIndex < state.revealedIndex;
          if (happened) openAtBatReadModal(pl, inn, evts[0]);
          else          openNotYetModal(pl, inn);
        }
      });
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     MODAL SYSTEM
  ══════════════════════════════════════════════════════════════════════════ */
  function openModal() { modal.classList.remove('hidden'); modal.classList.add('flex'); }
  function closeModal() { modal.classList.add('hidden'); modal.classList.remove('flex'); }
  document.getElementById('modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', e=>{ if(e.target===modal) closeModal(); });

  function openAtBatReadModal(player, inning, ev) {
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    const cnt = typeof ev.count==='string' ? ev.count : `${ev.count?.b??0}-${ev.count?.s??0}`;
    modalBody.innerHTML = `
      <div class="col-span-3 bg-gray-50 rounded-xl p-4 text-center">
        <div class="text-2xl font-extrabold text-gray-900 mb-1">${ev.result}</div>
        <div class="text-xs text-gray-500">Count ${cnt} &nbsp;·&nbsp; ${ev.outsBefore}→${ev.outsAfter} outs</div>
        ${ev.runsScoredOnPlay ? `<div class="text-xs text-green-600 font-semibold mt-1">${ev.runsScoredOnPlay} run${ev.runsScoredOnPlay>1?'s':''} scored</div>` : ''}
      </div>`;
    openModal();
  }

  function openNotYetModal(player, inning) {
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    modalBody.innerHTML = `
      <div class="col-span-3 text-center py-4">
        <div class="text-3xl mb-2">⏳</div>
        <p class="text-sm font-semibold text-gray-500">Not yet revealed in Watch &amp; Learn</p>
      </div>`;
    openModal();
  }

  /* ── TF input flow ────────────────────────────────────────────────────── */
  let mctx = null; // modal context

  function chip(extra='') {
    return `class="col-span-1 ${extra} bg-gray-100 hover:bg-amber-100 hover:text-gray-900 rounded-xl py-3 text-center transition-colors cursor-pointer text-gray-700"`;
  }
  function navRow(title, onBack) {
    return `<div class="col-span-3 flex items-center gap-2 mb-2">
      ${onBack ? `<button data-back class="text-xs text-gray-400 hover:text-gray-700">← Back</button>` : ''}
      <span class="text-xs font-semibold text-gray-400 ml-auto">${title}</span>
    </div>`;
  }

  function openAtBatInputModal(player, inning, evts, team) {
    const key = `${team}-${player.battingOrder}-${inning}`;
    modalTitle.textContent = `${player.name} — Inning ${inning}`;
    const ex = state.userEdits[key];
    mctx = { player, inning, team, key, result:null, count:{b:0,s:0},
              runners:{}, outsOnPlay:1, runsScored:0 };
    if (ex) mctx = { ...mctx, result:ex.result, count:{...(ex.count||{b:0,s:0})},
                     runners:{...(ex.runners||{})}, outsOnPlay:ex.outsOnPlay||1,
                     runsScored:ex.runsScored||0 };
    renderCategoryScreen();
    openModal();
  }

  const S = {}; // screens

  function renderCategoryScreen() {
    modalBody.innerHTML = `
      ${navRow('Select result')}
      <button data-go="hit"   ${chip()}>Hit</button>
      <button data-go="out"   ${chip()}>Out</button>
      <button data-go="walk"  ${chip()}>Walk/HBP</button>
      <button data-go="error" ${chip()}>Error</button>
      <button data-go="other" ${chip('col-span-3')}>Other — FC · SAC · SB · WP · PB</button>
      <div class="col-span-3 border-t border-gray-100 pt-2 mt-1">
        <button data-open-sub class="w-full text-left text-xs text-blue-600 font-semibold py-1 hover:text-blue-800">
          ↔ Make substitution for this batter…
        </button>
      </div>`;
    wireBack(null);
    modalBody.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>S[b.dataset.go]?.()));
    modalBody.querySelector('[data-open-sub]')?.addEventListener('click', openSubstitutionScreen);
  }

  S.hit = ()=>{ modalBody.innerHTML=`${navRow('Hit type',true)}${['1B','2B','3B','HR'].map(c=>`<button data-result="${c}" ${chip()}>${c}</button>`).join('')}`; wireBack(renderCategoryScreen); wireResults(); };
  S.walk= ()=>{ modalBody.innerHTML=`${navRow('Walk/HBP',true)}<button data-result="BB" ${chip()}>BB</button><button data-result="HBP" ${chip('col-span-2')}>HBP</button>`; wireBack(renderCategoryScreen); wireResults(); };
  S.out = ()=>{ modalBody.innerHTML=`${navRow('Out type',true)}<button data-go="strikeout" ${chip('col-span-3')}>Strikeout</button><button data-go="flyout" ${chip()}>Fly Out</button><button data-go="groundout" ${chip('col-span-2')}>Ground Out</button>`; wireBack(renderCategoryScreen); modalBody.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>S[b.dataset.go]?.())); };
  S.strikeout=()=>{ modalBody.innerHTML=`${navRow('Strikeout',true)}<button data-result="K" ${chip()}>Swinging<br><small>K</small></button><button data-result="˓" ${chip('col-span-2')}>Looking<br><small>˓</small></button>`; wireBack(S.out); wireResults(); };
  S.flyout=()=>{ modalBody.innerHTML=`${navRow('Fielder',true)}${FIELD_POS.map(p=>`<button data-result="F${p.n}" ${chip()}>${p.lbl}<br><small class="text-gray-400">F${p.n}</small></button>`).join('')}`; wireBack(S.out); wireResults(); };
  S.groundout=()=>{
    const seq=[];
    function draw(){
      modalBody.innerHTML=`${navRow('Tap fielders in order',true)}
        <div class="col-span-3 text-center font-bold text-xl mb-1 text-gray-800">${seq.length?seq.join('-'):'—'}</div>
        ${FIELD_POS.map(p=>`<button data-pos="${p.n}" ${chip()}>${p.lbl}<br><small class="text-gray-400">${p.n}</small></button>`).join('')}
        <button data-undo ${chip()}>Undo</button>
        <button data-confirm-seq ${chip('col-span-2 !bg-gray-900 !text-white')} ${!seq.length?'disabled':''}>Confirm</button>`;
      wireBack(S.out);
      modalBody.querySelectorAll('[data-pos]').forEach(b=>b.addEventListener('click',()=>{seq.push(b.dataset.pos);draw();}));
      modalBody.querySelector('[data-undo]').addEventListener('click',()=>{seq.pop();draw();});
      if(seq.length) modalBody.querySelector('[data-confirm-seq]').addEventListener('click',()=>selectResult(seq.join('-')));
    }
    draw();
  };
  S.error=()=>{ modalBody.innerHTML=`${navRow('Fielder who erred',true)}${FIELD_POS.map(p=>`<button data-result="E${p.n}" ${chip()}>${p.lbl}<br><small class="text-gray-400">E${p.n}</small></button>`).join('')}`; wireBack(renderCategoryScreen); wireResults(); };
  S.other=()=>{ modalBody.innerHTML=`${navRow('Other',true)}${['FC','SAC','SB','WP','PB'].map(c=>`<button data-result="${c}" ${chip()}>${c}</button>`).join('')}`; wireBack(renderCategoryScreen); wireResults(); };

  /* ── Runner tracking screen ─────────────────────────────────────────────── */
  function renderRunnerScreen() {
    const OUTCOMES = ['Safe','Out','Scored'];
    function runnerRow(base) {
      const active = !!mctx.runners[base];
      const outcome= mctx.runners[base] || '';
      return active ? `
        <div class="col-span-3 flex items-center gap-2 text-xs mt-1 pl-2">
          <span class="font-semibold text-gray-700 w-8">${base}</span>
          ${OUTCOMES.map(o=>`
            <button data-outcome="${base}:${o}"
              class="px-2 py-1 rounded-lg border text-xs font-semibold transition-colors
                     ${outcome===o ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}">
              ${o}
            </button>`).join('')}
        </div>` : '';
    }
    modalBody.innerHTML = `
      ${navRow(`Play details`, true)}
      <div class="col-span-3 mb-2">
        <p class="text-xs font-semibold text-gray-600 mb-2">Who was on base?</p>
        <div class="flex gap-2">
          ${['1B','2B','3B'].map(base=>`
            <button data-base-toggle="${base}"
              class="px-3 py-1.5 rounded-lg border text-xs font-bold transition-colors
                     ${mctx.runners[base]!==undefined ? 'bg-gray-900 text-white border-gray-900' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}">
              ${base}
            </button>`).join('')}
        </div>
      </div>
      <div id="runner-outcome-rows" class="col-span-3">
        ${['1B','2B','3B'].map(runnerRow).join('')}
      </div>
      <div class="col-span-3 flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
        <span class="text-xs font-semibold text-gray-600">Outs on play:</span>
        <div class="flex items-center gap-2">
          <button data-outs="-" class="w-7 h-7 rounded-full bg-gray-100 text-sm font-bold text-gray-700">−</button>
          <span id="outs-on-play" class="w-5 text-center font-bold text-gray-900">${mctx.outsOnPlay}</span>
          <button data-outs="+" class="w-7 h-7 rounded-full bg-gray-100 text-sm font-bold text-gray-700">+</button>
        </div>
      </div>
      <button data-next-count ${chip('col-span-3 !bg-gray-900 !text-white font-bold mt-2')}>Next → Count</button>
    `;
    wireBack(renderCategoryScreen);

    // Base toggles
    modalBody.querySelectorAll('[data-base-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const base = btn.dataset.baseToggle;
        if (mctx.runners[base] !== undefined) delete mctx.runners[base];
        else mctx.runners[base] = '';
        renderRunnerScreen();
      });
    });
    // Outcome buttons
    modalBody.querySelectorAll('[data-outcome]').forEach(btn => {
      btn.addEventListener('click', () => {
        const [base, out] = btn.dataset.outcome.split(':');
        mctx.runners[base] = out;
        renderRunnerScreen();
      });
    });
    // Outs stepper
    modalBody.querySelectorAll('[data-outs]').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.outs === '+' ? 1 : -1;
        mctx.outsOnPlay = Math.min(3, Math.max(1, mctx.outsOnPlay + d));
        document.getElementById('outs-on-play').textContent = mctx.outsOnPlay;
      });
    });
    modalBody.querySelector('[data-next-count]').addEventListener('click', renderCountScreen);
  }

  /* ── Count + confirm screen ─────────────────────────────────────────────── */
  function renderCountScreen() {
    modalBody.innerHTML = `
      ${navRow(`Result: ${mctx.result}`, true)}
      <div class="col-span-3 grid grid-cols-2 gap-4 mb-3">
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-2">Balls</p>
          <div class="flex items-center justify-center gap-3">
            <button data-c="b-" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">−</button>
            <span id="cnt-b" class="w-5 text-center font-bold">${mctx.count.b}</span>
            <button data-c="b+" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">+</button>
          </div>
        </div>
        <div class="text-center">
          <p class="text-xs text-gray-500 mb-2">Strikes</p>
          <div class="flex items-center justify-center gap-3">
            <button data-c="s-" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">−</button>
            <span id="cnt-s" class="w-5 text-center font-bold">${mctx.count.s}</span>
            <button data-c="s+" class="w-8 h-8 rounded-full bg-gray-100 font-bold text-gray-700">+</button>
          </div>
        </div>
      </div>
      <div class="col-span-3 flex items-center justify-between mb-3">
        <span class="text-xs font-semibold text-gray-600">Runs scored on play:</span>
        <div class="flex items-center gap-2">
          <button data-runs="-" class="w-7 h-7 rounded-full bg-gray-100 text-sm font-bold text-gray-700">−</button>
          <span id="runs-scored" class="w-5 text-center font-bold">${mctx.runsScored}</span>
          <button data-runs="+" class="w-7 h-7 rounded-full bg-gray-100 text-sm font-bold text-gray-700">+</button>
        </div>
      </div>
      <button data-confirm-final ${chip('col-span-3 !bg-gray-900 !text-white font-bold')}>Confirm At-Bat</button>
    `;
    wireBack(renderRunnerScreen);
    modalBody.querySelectorAll('[data-c]').forEach(btn => btn.addEventListener('click', () => {
      const [f,d] = [btn.dataset.c[0], btn.dataset.c[1]];
      mctx.count[f] = Math.min(f==='b'?3:2, Math.max(0, mctx.count[f]+(d==='+'?1:-1)));
      document.getElementById(`cnt-${f}`).textContent = mctx.count[f];
    }));
    modalBody.querySelectorAll('[data-runs]').forEach(btn => btn.addEventListener('click', () => {
      mctx.runsScored = Math.min(4, Math.max(0, mctx.runsScored + (btn.dataset.runs==='+'?1:-1)));
      document.getElementById('runs-scored').textContent = mctx.runsScored;
    }));
    modalBody.querySelector('[data-confirm-final]').addEventListener('click', confirmAtBat);
  }

  function wireBack(fn) {
    modalBody.querySelector('[data-back]')?.addEventListener('click', fn || renderCategoryScreen);
  }
  function wireResults() {
    modalBody.querySelectorAll('[data-result]').forEach(b=>b.addEventListener('click',()=>selectResult(b.dataset.result)));
  }
  function selectResult(r) { mctx.result=r; renderRunnerScreen(); }

  function confirmAtBat() {
    state.userEdits[mctx.key] = {
      result:mctx.result, count:{...mctx.count},
      battingOrder:mctx.player.battingOrder, inning:mctx.inning, team:mctx.team,
      runners:{...mctx.runners}, outsOnPlay:mctx.outsOnPlay, runsScored:mctx.runsScored,
    };
    closeModal();
    renderOffDefPanel();
    renderLinescore(); // TF: update linescore from user edits
  }

  /* ── Substitution flow ─────────────────────────────────────────────────── */
  function openSubstitutionScreen() {
    const team  = mctx.team;
    const bench = data.bench[team] || [];
    modalTitle.textContent = `Substitute — ${mctx.player.name}`;
    modalBody.innerHTML = `
      ${navRow('Choose incoming player', true)}
      <div class="col-span-3 text-xs text-gray-500 mb-1">Current: <strong>${mctx.player.name}</strong> (${mctx.player.positionAbbr})</div>
      ${bench.map(b=>`
        <button data-bench="${b.name}" data-bench-pos="${b.eligiblePositions[0]}"
          class="col-span-3 bg-gray-100 hover:bg-amber-100 rounded-xl py-2.5 px-3 text-left transition-colors cursor-pointer">
          <span class="font-semibold text-gray-900 text-sm">${b.name}</span>
          <span class="text-xs text-gray-500 ml-2">${b.eligiblePositions.join('/')} · ${b.bats}</span>
        </button>`).join('')}`;
    wireBack(renderCategoryScreen);
    modalBody.querySelectorAll('[data-bench]').forEach(btn=>btn.addEventListener('click',()=>renderSubActionScreen(btn.dataset.bench, btn.dataset.benchPos)));
  }

  function renderSubActionScreen(incomingName, incomingPos) {
    const team   = mctx.team;
    const outBo  = mctx.player.battingOrder;
    const lineup = data.lineups[team];
    modalTitle.textContent = `${incomingName} enters`;
    modalBody.innerHTML = `
      ${navRow('What happens to current player?', true)}
      <button data-sub-remove ${chip('col-span-3 !bg-red-50 !text-red-700 hover:!bg-red-100')}>
        Remove from game (${mctx.player.name} done)
      </button>
      <div class="col-span-3 text-[10px] text-gray-400 text-center my-1">— or move to another position —</div>
      ${lineup.filter(p=>p.battingOrder!==outBo).map(p=>`
        <button data-sub-move="${p.battingOrder}" ${chip('col-span-3 text-left !px-3 !text-xs')}>
          ↔ ${currentSlot(team,p.battingOrder).name} (${p.positionAbbr}) out → ${mctx.player.name} moves here
        </button>`).join('')}`;
    wireBack(openSubstitutionScreen);
    modalBody.querySelector('[data-sub-remove]')?.addEventListener('click',()=>applySubstitution(team,outBo,incomingName,incomingPos,null));
    modalBody.querySelectorAll('[data-sub-move]').forEach(btn=>btn.addEventListener('click',()=>applySubstitution(team,outBo,incomingName,incomingPos,+btn.dataset.subMove)));
  }

  function applySubstitution(team, outBo, inName, inPos, targetBo) {
    const hist = state.positionHistory[team];
    const outSlot = hist[outBo];
    const outPlayer = outSlot[outSlot.length-1];
    outPlayer.active = false;
    outSlot.push({ name:inName, positionAbbr:inPos, active:true });
    if (targetBo !== null) {
      const targetHist = hist[targetBo];
      targetHist[targetHist.length-1].active = false;
      targetHist.push({ name:outPlayer.name, positionAbbr:outPlayer.positionAbbr, active:true });
    }
    closeModal();
    renderOffDefPanel();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     LINESCORE — CSS Grid with inline styles only.
     No Tailwind classes, no table layout, no browser quirks.
     Column template: TEAM | 1–9 (equal 1fr) | R | H | E
  ══════════════════════════════════════════════════════════════════════════ */
  const LS_INN  = 9;  // always show 9 inning columns (standard MLB linescore)
  const LS_GRID = `54px repeat(${LS_INN},1fr) 28px 24px 24px`;
  const LS_ROW  = `display:grid;grid-template-columns:${LS_GRID};align-items:center;`;

  function renderLinescore() {
    const container = document.getElementById('linescore-container');
    if (!container) return;
    const { inn, tot } = state.mode === 'true-fan' ? computeTFLinescore() : computeWNLLinescore();

    const hdrCell = 'font-size:10px;font-weight:600;color:#9ca3af;text-align:center;padding:5px 0;';
    const dataCell= 'font-size:10px;font-weight:700;color:#1f2937;text-align:center;padding:5px 0;';
    const teamCell= 'font-size:10px;font-weight:700;color:#1f2937;text-align:left;padding:5px 0 5px 10px;background:#f9fafb;position:sticky;left:0;z-index:2;';
    const hdrTeam = 'font-size:10px;font-weight:600;color:#9ca3af;text-align:left;padding:5px 0 5px 10px;background:#f9fafb;position:sticky;left:0;z-index:2;';
    const totStyle= 'border-left:1px solid #d1d5db;font-size:11px;font-weight:800;color:#111827;text-align:center;padding:5px 0;';

    // Header — exactly LS_INN inning numbers
    const inningHeaders = Array.from({length:LS_INN},(_,i)=>i+1)
      .map(n=>`<div style="${hdrCell}">${n}</div>`).join('');

    // Data row — slice inn to exactly LS_INN elements so column count matches the template
    const teamRow = (side) => {
      const cells = inn[side].slice(0, LS_INN)
        .map(r=>`<div style="${dataCell}">${r||''}</div>`).join('');
      return `
        <div style="${LS_ROW}border-top:1px solid #e5e7eb;">
          <div style="${teamCell}">
            <div style="display:flex;align-items:center;gap:4px;">
              <img src="${LOGO[side]}" style="width:14px;height:14px;border-radius:50%;" alt="">
              <span>${ABBR[side]}</span>
            </div>
          </div>
          ${cells}
          <div style="${totStyle}">${tot[side].R}</div>
          <div style="${dataCell}">${tot[side].H}</div>
          <div style="${dataCell}">${tot[side].E}</div>
        </div>`;
    };

    container.innerHTML = `
      <div style="${LS_ROW}">
        <div style="${hdrTeam}">TEAM</div>
        ${inningHeaders}
        <div style="${hdrCell}border-left:1px solid #d1d5db;color:#6b7280;font-weight:700;">R</div>
        <div style="${hdrCell}color:#6b7280;font-weight:700;">H</div>
        <div style="${hdrCell}color:#6b7280;font-weight:700;">E</div>
      </div>
      ${teamRow('away')}
      ${teamRow('home')}
    `;
  }
  function computeWNLLinescore() {
    const inn = { away:Array(INNINGS).fill(0), home:Array(INNINGS).fill(0) };
    const tot = { away:{R:0,H:0,E:0}, home:{R:0,H:0,E:0} };
    data.playByPlay.slice(0, state.revealedIndex).forEach(ev => {
      const side = ev.half==='top' ? 'away' : 'home';
      inn[side][ev.inning-1] += ev.runsScoredOnPlay||0;
      tot[side].R += ev.runsScoredOnPlay||0;
      if (ev.category==='hit')   tot[side].H++;
      if (ev.category==='error') tot[side].E++;
    });
    return { inn, tot };
  }

  function computeTFLinescore() {
    const inn = { away:Array(INNINGS).fill(0), home:Array(INNINGS).fill(0) };
    const tot = { away:{R:0,H:0,E:0}, home:{R:0,H:0,E:0} };
    Object.values(state.userEdits).forEach(edit => {
      const side = edit.team;
      if (!side) return;
      inn[side][edit.inning-1] += edit.runsScored||0;
      tot[side].R += edit.runsScored||0;
      if (['1B','2B','3B','HR'].includes(edit.result)) tot[side].H++;
    });
    return { inn, tot };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     GAME CLOCK — WNL only, no pause, variable delay, auto-bounce
  ══════════════════════════════════════════════════════════════════════════ */
  let playTimer = null;

  function computeCurrentState() {
    const total = data.playByPlay.length;
    if (state.revealedIndex >= total) return { final:true, half:'top', inning:9, outs:3 };
    if (state.revealedIndex === 0)    return { final:false, half:'top', inning:1, outs:0 };
    const last = data.playByPlay[state.revealedIndex-1];
    if (last.outsAfter < 3) return { final:false, half:last.half, inning:last.inning, outs:last.outsAfter };
    const next = data.playByPlay[state.revealedIndex];
    return { final:false, half:next.half, inning:next.inning, outs:0 };
  }

  function isEndOfHalf() {
    if (!state.revealedIndex) return false;
    const last = data.playByPlay[state.revealedIndex-1];
    return last && last.outsAfter >= 3;
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

    // Auto-bounce: check if half-inning changed
    const cst = computeCurrentState();
    if (!cst.final && cst.half !== state.lastAutoHalf) {
      state.lastAutoHalf = cst.half;
      const battingTeam  = cst.half === 'top' ? 'away' : 'home';
      const pitchingTeam = cst.half === 'top' ? 'home' : 'away';
      if (state.section === 'offense-defense' && state.team !== battingTeam)  setTeam(battingTeam);
      if (state.section === 'pitching'        && state.team !== pitchingTeam) setTeam(pitchingTeam);
    }

    renderLinescore();
    renderStatus();
    if (state.section === 'offense-defense') renderOffDefPanel();
    if (state.section === 'pitching')         renderPitchingPanel();
  }

  function scheduleNext() {
    if (!state.isPlaying) return;
    const delay = isEndOfHalf() ? transMS() : abMS();
    playTimer = setTimeout(() => { tick(); scheduleNext(); }, delay);
  }

  function startPlayback() {
    if (state.mode !== 'watch-learn' || state.revealedIndex >= data.playByPlay.length) return;
    stopPlayback();
    state.isPlaying = true;
    scheduleNext();
  }

  function stopPlayback() {
    state.isPlaying = false;
    clearTimeout(playTimer);
    playTimer = null;
  }

  speedSelect.addEventListener('change', () => { if (state.isPlaying) { stopPlayback(); startPlayback(); } });

  document.getElementById('btn-reset').addEventListener('click', () => {
    stopPlayback();
    state.revealedIndex = START_IDX;
    state.lastAutoHalf = data.playByPlay[START_IDX]?.half || 'top';
    renderLinescore(); renderStatus(true);
    if (state.section) renderCurrentPanel();
    startPlayback();
  });

  document.getElementById('btn-save').addEventListener('click', () => {
    const btn = document.getElementById('btn-save');
    const orig = btn.textContent;
    btn.textContent = 'Saved ✓';
    setTimeout(()=>{ btn.textContent = orig; }, 1400);
  });

  /* ── Initial render + auto-init (removes all selection friction) ─────────── */
  renderLinescore();
  // Load immediately into the most compelling view — no clicks required.
  setMode('watch-learn');
  setTeam('away');
  selectSection('offense-defense');

})();
