// ==UserScript==
// @name         War Payout Predictor
// @namespace    https://github.com/eugene-torn-scripts/war-payout-predictor
// @version      2.0.1
// @description  Predict a Torn ranked-war cache payout using the wiki formula (rank base × win × +1%/member × ×0–3 participation from score-share), with constants fitted to ~9,700 recent wars. Desktop + Torn PDA.
// @author       lannav
// @match        https://www.torn.com/*
// @grant        none
// @license      GPL-3.0-or-later
// @downloadURL  https://update.greasyfork.org/scripts/580583/War%20Payout%20Predictor.user.js
// @updateURL    https://update.greasyfork.org/scripts/580583/War%20Payout%20Predictor.meta.js
// ==/UserScript==

/*
 * War Payout Predictor
 * Copyright (C) 2026 lannav
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details: https://www.gnu.org/licenses/gpl-3.0.html
 *
 * Source: https://github.com/eugene-torn-scripts/war-payout-predictor
 */

/* eslint-disable no-undef */

(function () {
    "use strict";

    const VERSION = "2.0.1";

    // ════════════════════════════════════════════════════════════
    //  MODEL — fitted on 9,699 recent ranked-war faction-rows (forfeits &
    //  zero-reward rows excluded), all ending on/after 2025-05-31, with the
    //  Torn-wiki structure imposed:
    //
    //    cache = BASE(rank) × 2^win × (1 + 0.01·(members−10)) × participation
    //
    //  • Win = ×2, loss = ×1            (wiki, fixed)
    //  • Size = +1% per member beyond 10 (wiki, fixed)
    //  • Participation modifier ×0…×3   (wiki) — anchored so a fully-dominant
    //    faction ≈ ×3 and a dominated one collapses toward ×0 (→ floor cache).
    //  • BASE(rank) is fitted (the dominant lever).
    //
    //  Participation is driven by SCORE-SHARE vs the opponent (the wiki's own
    //  description), which is what makes a blown-out faction hit the floor:
    //    SCORE model  (both scores known): share = own/(own+opp);
    //       partRaw = exp(A·ln s + B·ln²s); displayed ×0-3 = 3·partRaw/PART_MAX.
    //       R²=0.909, median error 17%.
    //  Pre-war (scores unknown) the ROSTER model estimates participation from the
    //  member-participation fraction p (≥10 hits): ×0-3 = 3·p^K. R²=0.831.
    //
    //  BAND = factor covering ~68% of wars. FLOOR = 1 Small Arms Cache. Caches
    //  valued at CACHE_PRICES; absolute $ tracks the live market, multipliers don't.
    // ════════════════════════════════════════════════════════════

    const FIT = { ROWS: 9699, CUTOFF: "2025-05-31" };
    const WIN_FACTOR = 2.0;          // wiki: win ×2, loss ×1
    const SIZE_PER_MEMBER = 0.01;    // wiki: +1% per member beyond 10
    const FLOOR = 115350226;         // 1 Small Arms Cache — never predict below this

    // SCORE model — participation from score-share. BASE values are anchored so
    // value = BASE × 2^win × sizeFactor × partD, with partD = 3·partRaw/PART_MAX.
    const SCORE_MODEL = {
        A: -0.240, B: -0.341, PART_MAX: 1.043,
        R2: 0.909, ERR: 17, BAND: 1.297,
        BASE: {
            "Unranked": 67152873, "Bronze": 81182543, "Bronze I": 87645728, "Bronze II": 99852131,
            "Bronze III": 109193544, "Silver": 122477374, "Silver I": 137802190, "Silver II": 158234098,
            "Silver III": 178040186, "Gold": 203123848, "Gold I": 223346555, "Gold II": 253048398,
            "Gold III": 283595165, "Platinum": 303008024, "Platinum I": 331904881, "Platinum II": 369430334,
            "Platinum III": 400922433, "Diamond": 606109042, "Diamond I": 675620682, "Diamond II": 764616037,
            "Diamond III": 821594251,
        },
    };

    // ROSTER model — pre-war estimate; participation from member fraction p (≥10 hits).
    const ROSTER_MODEL = {
        K: 0.356,
        R2: 0.831, ERR: 22, BAND: 1.393,
        BASE: {
            "Unranked": 78143994, "Bronze": 94439977, "Bronze I": 100772301, "Bronze II": 116959835,
            "Bronze III": 125172492, "Silver": 136837313, "Silver I": 151521875, "Silver II": 178215360,
            "Silver III": 198603735, "Gold": 220846236, "Gold I": 243357395, "Gold II": 279302934,
            "Gold III": 313678511, "Platinum": 326627190, "Platinum I": 356872554, "Platinum II": 404848475,
            "Platinum III": 453618748, "Diamond": 740272985, "Diamond I": 788307333, "Diamond II": 871427529,
            "Diamond III": 1065997054,
        },
    };

    const RANK_ORDER = Object.keys(SCORE_MODEL.BASE);

    // Cache market prices used when fitting (current Torn item-market averages).
    const CACHE_PRICES = [
        { name: "Small Arms Cache",  avg: 115350226 },
        { name: "Melee Cache",       avg: 172037496 },
        { name: "Medium Arms Cache", avg: 232999999 },
        { name: "Armor Cache",       avg: 355399997 },
        { name: "Heavy Arms Cache",  avg: 429142570 },
    ];

    // ════════════════════════════════════════════════════════════
    //  PREDICTION
    // ════════════════════════════════════════════════════════════

    // Wiki structure: cache = BASE(rank) × 2^win × (1+1%·(members−10)) × partMod(×0-3).
    // If both `score` and `oppScore` are known → SCORE model, participation from
    // score-share = own/(own+opp). Otherwise → ROSTER model, participation from the
    // member fraction p = n10/members (n10 = members with ≥10 hits). Floors at 1 cache.
    // Returns { value, model, factors, band, partMod, lowPart }.
    function predict({ rank, won, enlisted, score, oppScore, n10 }) {
        const enl = Math.max(1, enlisted);
        const winF = won ? WIN_FACTOR : 1;
        const sizeF = 1 + SIZE_PER_MEMBER * (enl - 10);
        const useShare = score > 0 && oppScore > 0;

        if (useShare) {
            const m = SCORE_MODEL;
            const base = m.BASE[rank] != null ? m.BASE[rank] : m.BASE["Gold I"];
            const share = score / (score + oppScore);
            const ls = Math.log(Math.max(share, 1e-4));
            // partMod peaks at share≈0.70; past that, dominance plateaus at the max
            // (×3) rather than dipping — monotonic and more intuitive.
            const lsPeak = -m.A / (2 * m.B);
            const partRaw = ls >= lsPeak ? m.PART_MAX : Math.exp(m.A * ls + m.B * ls * ls);
            const partMod = 3 * partRaw / m.PART_MAX;          // ×0…×3
            const value = Math.max(FLOOR, base * winF * sizeF * partMod);
            return {
                value, model: "score", band: m.BAND, partMod, share, lowPart: partMod < 0.6,
                factors: { base, win: winF, size: sizeF, part: partMod },
            };
        }
        const m = ROSTER_MODEL;
        const base = m.BASE[rank] != null ? m.BASE[rank] : m.BASE["Gold I"];
        const p = Math.min(1, n10 / enl);
        const partMod = 3 * Math.pow(p, m.K);                  // ×0…×3
        const value = Math.max(FLOOR, base * winF * sizeF * partMod);
        return {
            value, model: "roster", band: m.BAND, partMod, share: null, lowPart: partMod < 0.6,
            factors: { base, win: winF, size: sizeF, part: partMod },
        };
    }

    function fmtMoney(n) {
        if (!isFinite(n) || n <= 0) return "$0";
        if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "b";
        if (n >= 1e6) return "$" + (n / 1e6).toFixed(0) + "m";
        if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
        return "$" + Math.round(n);
    }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    // ════════════════════════════════════════════════════════════
    //  SHARED FOOTER MENU  (copied verbatim across eugene-torn-scripts;
    //  __eugFooterMenuLoaded guard ensures setup runs once per page.)
    // ════════════════════════════════════════════════════════════

    (function setupEugFooterMenu() {
        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        if (W.__eugFooterMenuLoaded) return;
        W.__eugFooterMenuLoaded = true;
        W.__eugeneScripts = W.__eugeneScripts || [];

        const ROW_ID = "eug-footer-row";

        function injectCSS() {
            if (document.getElementById("eug-footer-style")) return;
            const style = document.createElement("style");
            style.id = "eug-footer-style";
            style.textContent = `
[data-eug="menu"]{background:linear-gradient(to bottom,#444,#2a2a2a)!important}
[data-eug="menu"]:hover{background:linear-gradient(to bottom,#555,#333)!important}
#${ROW_ID}{display:none;position:fixed;padding:4px;
  background:rgba(20,20,20,0.96);border:1px solid #444;border-radius:6px;
  gap:4px;z-index:2147483647;white-space:nowrap;pointer-events:auto}
#${ROW_ID}.eug-open{display:flex;flex-direction:row}
`;
            document.head.appendChild(style);
        }

        function injectEntryCSS(entry) {
            if (!entry.color) return;
            const id = `eug-color-${entry.id}`;
            const existing = document.getElementById(id);
            const dark = entry.colorDark || "#222";
            const hover = entry.hoverColor || entry.color;
            const css = `
[data-eug-id="${entry.id}"]{background:linear-gradient(to bottom, ${entry.color}, ${dark})!important}
[data-eug-id="${entry.id}"]:hover{background:linear-gradient(to bottom, ${hover}, ${entry.color})!important}
`;
            if (existing) { existing.textContent = css; return; }
            const el = document.createElement("style");
            el.id = id;
            el.textContent = css;
            document.head.appendChild(el);
        }

        function findRefBtn() {
            return document.getElementById("notes_panel_button")
                || document.getElementById("people_panel_button");
        }

        function getRow() { return document.getElementById(ROW_ID); }
        function closeRow() { const r = getRow(); if (r) r.classList.remove("eug-open"); }

        function openRow(menuBtn) {
            const row = getRow();
            if (!row) return;
            const rect = menuBtn.getBoundingClientRect();
            row.classList.add("eug-open");
            const rowRect = row.getBoundingClientRect();
            const gap = 6;
            const centerX = rect.left + rect.width / 2;
            let left = centerX - rowRect.width / 2;
            const maxLeft = window.innerWidth - rowRect.width - 4;
            left = Math.max(4, Math.min(left, maxLeft));
            row.style.left = left + "px";
            row.style.bottom = (window.innerHeight - rect.top + gap) + "px";
        }

        function makeScriptBtn(entry, refBtn, role) {
            const iconClasses = refBtn.querySelector("svg")?.className?.baseVal || "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = refBtn.className;
            btn.title = entry.name;
            btn.setAttribute("data-eug", role);
            btn.setAttribute("data-eug-id", entry.id);
            const svg = (entry.iconSVG || "").replace(/<svg\b([^>]*)>/, (match, attrs) =>
                /\sclass\s*=/.test(attrs) ? match : `<svg${attrs} class="${iconClasses}">`);
            btn.innerHTML = svg;
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeRow();
                try { entry.onClick(); } catch { /* noop */ }
            });
            injectEntryCSS(entry);
            return btn;
        }

        function makeMenuBtn(refBtn) {
            const iconClasses = refBtn.querySelector("svg")?.className?.baseVal || "";
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = refBtn.className;
            btn.title = "My userscripts";
            btn.setAttribute("data-eug", "menu");
            btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" class="${iconClasses}">
                <defs><linearGradient id="eug_menu_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
                    <stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#999"/>
                </linearGradient></defs>
                <g fill="url(#eug_menu_grad)">
                    <circle cx="5" cy="12" r="2"/>
                    <circle cx="12" cy="12" r="2"/>
                    <circle cx="19" cy="12" r="2"/>
                </g>
            </svg>`;
            btn.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                const row = getRow();
                if (row && row.classList.contains("eug-open")) closeRow();
                else openRow(btn);
            });
            return btn;
        }

        const LEGACY_BUTTON_IDS = ["tat-footer-btn", "spa-footer-btn"];

        function render() {
            const refBtn = findRefBtn();
            if (!refBtn) return false;
            injectCSS();

            const parent = refBtn.parentNode;
            parent.querySelectorAll('[data-eug]').forEach((el) => el.remove());
            LEGACY_BUTTON_IDS.forEach((id) => {
                const el = document.getElementById(id);
                if (el) el.remove();
            });
            const oldRow = getRow();
            if (oldRow) oldRow.remove();

            const scripts = W.__eugeneScripts || [];
            if (scripts.length === 0) return true;

            if (scripts.length === 1) {
                parent.insertBefore(makeScriptBtn(scripts[0], refBtn, "solo"), refBtn);
            } else {
                const menuBtn = makeMenuBtn(refBtn);
                parent.insertBefore(menuBtn, refBtn);
                const row = document.createElement("div");
                row.id = ROW_ID;
                row.setAttribute("data-eug-row", "");
                for (const s of scripts) row.appendChild(makeScriptBtn(s, refBtn, "item"));
                document.body.appendChild(row);
            }
            return true;
        }

        function mount() {
            render();
            let pending = false;
            const obs = new MutationObserver(() => {
                if (pending) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    const refBtn = findRefBtn();
                    if (refBtn && !refBtn.parentNode.querySelector('[data-eug]')) render();
                });
            });
            obs.observe(document.body, { childList: true, subtree: true });
        }

        W.addEventListener("eugene-scripts-updated", render);
        document.addEventListener("click", (e) => {
            const row = getRow();
            if (!row || !row.classList.contains("eug-open")) return;
            const menuBtn = document.querySelector('[data-eug="menu"]');
            if (menuBtn && menuBtn.contains(e.target)) return;
            if (row.contains(e.target)) return;
            closeRow();
        });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRow(); });
        W.addEventListener("scroll", closeRow, { passive: true });
        W.addEventListener("resize", closeRow);

        W.registerEugeneScript = function (entry) {
            const list = W.__eugeneScripts;
            const i = list.findIndex((s) => s.id === entry.id);
            if (i >= 0) list[i] = entry;
            else list.push(entry);
            W.dispatchEvent(new CustomEvent("eugene-scripts-updated"));
        };
        W.mountEugeneFooterMenu = mount;
    })();

    // ════════════════════════════════════════════════════════════
    //  STYLES  (mobile/PDA-responsive — panel goes full-screen ≤640px)
    // ════════════════════════════════════════════════════════════

    function injectStyles() {
        if (document.getElementById("wpp-style")) return;
        const style = document.createElement("style");
        style.id = "wpp-style";
        style.textContent = `
#wpp-overlay{display:none;position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.7)}
#wpp-overlay.wpp-open{display:block}
#wpp-panel{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
  background:#1a1a1a;border:1px solid #444;border-radius:10px;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#ddd;font-size:14px;
  width:720px;max-width:calc(100vw - 16px);max-height:88vh;min-width:300px;flex-direction:column}
#wpp-panel.wpp-open{display:flex}
#wpp-panel *{box-sizing:border-box;color:inherit}
#wpp-panel ::-webkit-scrollbar{width:6px;height:6px}
#wpp-panel ::-webkit-scrollbar-track{background:#1a1a1a}
#wpp-panel ::-webkit-scrollbar-thumb{background:#444;border-radius:3px}
#wpp-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;
  background:#222;border-bottom:1px solid #444;flex-shrink:0;gap:8px}
#wpp-header h2{margin:0;font-size:17px;color:#fff;display:flex;align-items:center;flex-wrap:wrap}
#wpp-header .wpp-ver{color:#666;font-size:12px;margin-left:8px}
.wpp-tip{color:#888;font-size:11px;font-weight:400;margin-left:10px}
.wpp-tip a{color:#cc3333;text-decoration:none}
#wpp-close{background:none;border:none;color:#999;font-size:24px;cursor:pointer;padding:4px 10px;line-height:1;flex-shrink:0}
#wpp-close:hover{color:#fff}
#wpp-tabs{display:flex;background:#252525;border-bottom:1px solid #444;overflow-x:auto;flex-shrink:0}
.wpp-tab{padding:11px 22px;cursor:pointer;color:#999!important;border-bottom:2px solid transparent;
  white-space:nowrap;font-size:14px;transition:all .15s;background:none;border-top:none;border-left:none;border-right:none}
.wpp-tab:hover{color:#ccc!important;background:#2a2a2a}
.wpp-tab.active{color:#e8c24f!important;border-bottom-color:#e8c24f}
#wpp-content{padding:16px;overflow-y:auto;flex:1;min-height:0}

.wpp-section{margin-bottom:18px}
.wpp-section h3{margin:0 0 8px;font-size:14px;color:#eee}
.wpp-section p{color:#9a9a9a;font-size:12px;margin:4px 0;line-height:1.5}
.wpp-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.wpp-field{display:flex;flex-direction:column;gap:5px;margin-bottom:12px}
.wpp-field label{color:#bbb;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
.wpp-field .wpp-sub{color:#777;font-size:11px;text-transform:none;letter-spacing:0}
.wpp-input,.wpp-select{background:#252525;border:1px solid #444;color:#ddd;padding:8px 10px;border-radius:4px;font-size:15px;width:100%}
.wpp-input:focus,.wpp-select:focus{outline:none;border-color:#e8c24f}
.wpp-toggle{display:flex;border:1px solid #444;border-radius:4px;overflow:hidden}
.wpp-toggle button{flex:1;padding:9px 0;background:#252525;border:none;color:#999;cursor:pointer;font-size:14px;font-weight:600}
.wpp-toggle button.active{color:#111}
.wpp-toggle button.win.active{background:#4caf50}
.wpp-toggle button.loss.active{background:#ef5350;color:#fff}
.wpp-modepill{display:inline-block;margin-left:8px;padding:1px 8px;border-radius:8px;font-size:10px;font-weight:700;
  text-transform:uppercase;letter-spacing:.4px;vertical-align:middle}
.wpp-modepill.score{background:#15321f;color:#6fd38b}
.wpp-modepill.roster{background:#2a2440;color:#b9a4ff}

#wpp-result{background:linear-gradient(180deg,#23210f,#1b1a12);border:1px solid #5a4d1f;
  border-left:4px solid #e8c24f;border-radius:6px;padding:16px;margin-top:4px}
#wpp-result .wpp-big{font-size:30px;font-weight:800;color:#f3d35b;line-height:1.1}
#wpp-result .wpp-range{color:#cdbb78;font-size:13px;margin-top:4px}
#wpp-result .wpp-note{color:#8a8268;font-size:11px;margin-top:8px;line-height:1.45}
.wpp-lowhint{background:#2a1e10;border:1px solid #6b4f23;border-left:3px solid #d9a441;border-radius:4px;
  padding:7px 10px;margin-top:8px;color:#e6c483;font-size:12px;line-height:1.4}
.wpp-lowhint b{color:#f3d35b}
.wpp-breakdown{width:100%;border-collapse:collapse;margin-top:12px}
.wpp-breakdown td{padding:4px 0;font-size:12px;color:#cfc7a8;border-bottom:1px solid #332f1a}
.wpp-breakdown td:last-child{text-align:right;font-variant-numeric:tabular-nums;color:#efe3b0}
.wpp-breakdown tr.total td{border-bottom:none;padding-top:8px;font-weight:700;color:#f3d35b;font-size:13px}

.wpp-tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:8px 0 4px}
table.wpp-table{width:100%;border-collapse:collapse;font-size:13px}
.wpp-table th,.wpp-table td{padding:7px 12px;text-align:left;border-bottom:1px solid #333;color:#ddd;white-space:nowrap}
.wpp-table th{color:#999!important;font-weight:600;text-transform:uppercase;font-size:11px;background:#1f1f1f}
.wpp-table td.num,.wpp-table th.num{text-align:right;font-variant-numeric:tabular-nums}
.wpp-table tr.hl td{color:#e8c24f;font-weight:700}
.wpp-legend-h{color:#e8c24f;font-size:14px;margin:18px 0 6px;font-weight:700}
.wpp-legend-h:first-child{margin-top:0}
.wpp-legend p{color:#b3b3b3;font-size:13px;line-height:1.55;margin:6px 0}
.wpp-legend code{background:#2a2a2a;padding:1px 5px;border-radius:3px;font-size:12px;color:#e8c24f}
.wpp-legend ul{margin:6px 0;padding-left:20px;color:#b3b3b3;font-size:13px;line-height:1.55}
.wpp-pill{display:inline-block;padding:1px 7px;border-radius:8px;background:#3a3320;color:#e8c24f;font-size:11px;font-weight:700}

@media (max-width:640px){
  #wpp-panel{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;min-width:0;
    top:0;left:0;transform:none;border-radius:0;border:none}
  #wpp-content{padding:12px}
  .wpp-grid-2{grid-template-columns:1fr;gap:8px}
  #wpp-header h2{font-size:15px}
  #wpp-header .wpp-ver{margin-left:6px}
  .wpp-tab{padding:11px 16px}
  #wpp-result .wpp-big{font-size:25px}
  .wpp-table th,.wpp-table td{padding:6px 9px;font-size:12px}
}
`;
        document.head.appendChild(style);
    }

    // ════════════════════════════════════════════════════════════
    //  UI
    // ════════════════════════════════════════════════════════════

    const TIP = `<span class="wpp-tip">Like the script? Send a Xanax to
        <a href="https://www.torn.com/profiles.php?XID=4192025" target="_blank">eugene_s [4192025]</a></span>`;

    const UI = {
        built: false,
        state: { rank: "Gold I", won: true, enlisted: 50, hitters: 25, score: "", oppScore: "" },

        build() {
            if (this.built) return;
            injectStyles();

            const overlay = document.createElement("div");
            overlay.id = "wpp-overlay";

            const panel = document.createElement("div");
            panel.id = "wpp-panel";
            panel.innerHTML = `
<div id="wpp-header">
  <h2>War Payout Predictor <span class="wpp-ver">v${VERSION}</span>${TIP}</h2>
  <button id="wpp-close" title="Close">×</button>
</div>
<div id="wpp-tabs">
  <button class="wpp-tab active" data-tab="calc">Calculator</button>
  <button class="wpp-tab" data-tab="legend">How it works</button>
</div>
<div id="wpp-content"></div>`;

            overlay.addEventListener("click", () => this.toggle(false));
            panel.querySelector("#wpp-close").addEventListener("click", () => this.toggle(false));
            panel.querySelectorAll(".wpp-tab").forEach((t) =>
                t.addEventListener("click", () => this.showTab(t.dataset.tab)));

            document.body.appendChild(overlay);
            document.body.appendChild(panel);
            this.built = true;
            this.showTab("calc");
        },

        toggle(open) {
            this.build();
            const panel = document.getElementById("wpp-panel");
            const overlay = document.getElementById("wpp-overlay");
            const want = open != null ? open : !panel.classList.contains("wpp-open");
            panel.classList.toggle("wpp-open", want);
            overlay.classList.toggle("wpp-open", want);
        },

        showTab(tab) {
            document.querySelectorAll(".wpp-tab").forEach((t) =>
                t.classList.toggle("active", t.dataset.tab === tab));
            const c = document.getElementById("wpp-content");
            if (tab === "calc") this.renderCalc(c);
            else this.renderLegend(c);
        },

        // ---- Calculator tab -------------------------------------------------
        renderCalc(c) {
            const s = this.state;
            const opts = RANK_ORDER.map((r) =>
                `<option value="${r}"${r === s.rank ? " selected" : ""}>${r}</option>`).join("");
            c.innerHTML = `
<div class="wpp-section">
  <div class="wpp-grid-2">
    <div class="wpp-field">
      <label>Faction rank</label>
      <select class="wpp-select" id="wpp-rank">${opts}</select>
    </div>
    <div class="wpp-field">
      <label>War result</label>
      <div class="wpp-toggle">
        <button type="button" class="win${s.won ? " active" : ""}" id="wpp-win">Win</button>
        <button type="button" class="loss${!s.won ? " active" : ""}" id="wpp-loss">Loss</button>
      </div>
    </div>
    <div class="wpp-field">
      <label>Enlisted members <span class="wpp-sub">(10–100)</span></label>
      <input class="wpp-input" id="wpp-enl" type="number" min="10" max="100" step="1" value="${s.enlisted}">
    </div>
    <div class="wpp-field">
      <label>Your war score <span class="wpp-sub">for an in/post-war prediction</span></label>
      <input class="wpp-input" id="wpp-score" type="number" min="0" step="1" placeholder="leave blank for pre-war estimate" value="${s.score}">
    </div>
    <div class="wpp-field">
      <label>Opponent war score <span class="wpp-sub">needed for the accurate model</span></label>
      <input class="wpp-input" id="wpp-oppscore" type="number" min="0" step="1" placeholder="leave blank for pre-war estimate" value="${s.oppScore}">
    </div>
    <div class="wpp-field">
      <label>Members with ≥10 war hits <span class="wpp-sub">used for the pre-war estimate (no scores)</span></label>
      <input class="wpp-input" id="wpp-hit" type="number" min="0" max="100" step="1" value="${s.hitters}">
      <span class="wpp-sub" id="wpp-pct"></span>
    </div>
  </div>
</div>
<div id="wpp-result"></div>`;

            const rankEl = c.querySelector("#wpp-rank");
            const enlEl = c.querySelector("#wpp-enl");
            const hitEl = c.querySelector("#wpp-hit");
            const scoreEl = c.querySelector("#wpp-score");
            const oppEl = c.querySelector("#wpp-oppscore");
            const winEl = c.querySelector("#wpp-win");
            const lossEl = c.querySelector("#wpp-loss");

            const parseScore = (el) => {
                const n = parseInt(el.value, 10);
                return el.value === "" || !isFinite(n) || n < 0 ? "" : n;
            };
            const recompute = () => {
                s.rank = rankEl.value;
                s.enlisted = clamp(parseInt(enlEl.value, 10) || 0, 1, 100);
                s.hitters = clamp(parseInt(hitEl.value, 10) || 0, 0, s.enlisted);
                s.score = parseScore(scoreEl);
                s.oppScore = parseScore(oppEl);
                // The ≥10-hit field only drives the pre-war (roster) model; once both
                // scores are set, participation comes from score-share — grey it out.
                const scoresSet = s.score !== "" && s.oppScore !== "";
                hitEl.disabled = scoresSet;
                hitEl.style.opacity = scoresSet ? "0.45" : "1";
                this.renderResult(c.querySelector("#wpp-result"));
            };
            rankEl.addEventListener("change", recompute);
            enlEl.addEventListener("input", recompute);
            hitEl.addEventListener("input", recompute);
            scoreEl.addEventListener("input", recompute);
            oppEl.addEventListener("input", recompute);
            winEl.addEventListener("click", () => {
                s.won = true; winEl.classList.add("active"); lossEl.classList.remove("active"); recompute();
            });
            lossEl.addEventListener("click", () => {
                s.won = false; lossEl.classList.add("active"); winEl.classList.remove("active"); recompute();
            });
            this.renderResult(c.querySelector("#wpp-result"));
        },

        renderResult(box) {
            const s = this.state;
            const enl = Math.max(1, s.enlisted);
            const n10 = Math.min(s.hitters, enl);
            const p = enl > 0 ? Math.min(1, n10 / enl) : 0;
            const score = s.score === "" ? 0 : s.score;
            const oppScore = s.oppScore === "" ? 0 : s.oppScore;
            const { value, model, factors, band, partMod, share, lowPart } =
                predict({ rank: s.rank, won: s.won, enlisted: enl, score, oppScore, n10 });

            const lo = value / band, hi = value * band;
            const usingScore = model === "score";
            const partPct = usingScore ? (share * 100) : (p * 100);
            const pctEl = document.getElementById("wpp-pct");
            if (pctEl) pctEl.textContent = `participation = ${(p * 100).toFixed(0)}% of enlisted made ≥10 hits`;

            const pill = usingScore
                ? `<span class="wpp-modepill score">score model · ±${SCORE_MODEL.ERR}%</span>`
                : `<span class="wpp-modepill roster">roster model · ±${ROSTER_MODEL.ERR}%</span>`;

            const partLabel = usingScore
                ? `${partPct.toFixed(0)}% score-share`
                : `${partPct.toFixed(0)}% of members`;

            const lowHint = lowPart
                ? `<div class="wpp-lowhint">⚠ Participation modifier is only <b>×${partMod.toFixed(2)}</b>
                   (of a max ×3) — a dominated faction. These land near the <b>minimum</b> cache (~${fmtMoney(FLOOR)}).</div>`
                : "";

            box.innerHTML = `
<div class="wpp-big">${fmtMoney(value)}${pill}</div>
<div class="wpp-range">best estimate · ~⅔ of real wars fall in ${fmtMoney(lo)} – ${fmtMoney(hi)}</div>
${lowHint}
<table class="wpp-breakdown">
  <tr><td>Base (rank ${s.rank})</td><td>${fmtMoney(factors.base)}</td></tr>
  <tr><td>× Win/Loss (${s.won ? "Win" : "Loss"})</td><td>×${factors.win.toFixed(0)}</td></tr>
  <tr><td>× Size (${enl} members, +1%/mbr)</td><td>×${factors.size.toFixed(2)}</td></tr>
  <tr><td>× Participation (${partLabel})</td><td>×${factors.part.toFixed(2)} <span style="color:#8a8268">/3</span></td></tr>
  <tr class="total"><td>= Predicted faction cache</td><td>${fmtMoney(value)}</td></tr>
</table>
<div class="wpp-note">${usingScore
    ? `<b>Score model</b> (median error ${SCORE_MODEL.ERR}%): participation ×0–3 comes from your <b>score-share vs the opponent</b> — the wiki mechanic. `
    : `<b>Pre-war estimate</b> (roster model): enter both war scores for the accurate score-share model. Participation here is estimated from the ≥10-hit member fraction. `}
  Win ×2 / loss ×1 and +1%/member are the wiki's fixed factors; the base and participation curve are fitted.
  Unmodelled <b>underdog</b> / <b>loss-streak</b> bonuses and the lumpy whole-cache payout move individual wars
  further. Faction gross at market prices — not your personal cut.</div>`;
        },

        // ---- Legend tab -----------------------------------------------------
        renderLegend(c) {
            const scorePart = (sh) => 3 * Math.exp(SCORE_MODEL.A * Math.log(sh) + SCORE_MODEL.B * Math.log(sh) ** 2) / SCORE_MODEL.PART_MAX;
            const rosterPart = (p) => 3 * Math.pow(p, ROSTER_MODEL.K);
            const rankRows = RANK_ORDER.map((r) =>
                `<tr class="${r === this.state.rank ? "hl" : ""}"><td>${r}</td>` +
                `<td class="num">${fmtMoney(SCORE_MODEL.BASE[r])}</td></tr>`).join("");
            const priceRows = CACHE_PRICES.map((x) =>
                `<tr><td>${x.name}</td><td class="num">${fmtMoney(x.avg)}</td></tr>`).join("");

            c.innerHTML = `
<div class="wpp-legend">
  <p>This tool predicts the <b>gross cash value of the war cache</b> a faction receives when a ranked war
     ends. It uses the <b>official Torn-wiki formula structure</b>, with the constants fitted to
     <b>${FIT.ROWS.toLocaleString()}</b> real, recent war reports (ending on/after ${FIT.CUTOFF}).</p>

  <div class="wpp-legend-h">The formula <span class="wpp-pill">wiki</span></div>
  <p>Reward is <b>multiplicative</b>:</p>
  <p><code>cache = Base(rank) × 2^win × (1 + 1%·(members−10)) × Participation(×0–3)</code></p>
  <ul>
    <li><b>Win ×2 / loss ×1</b> — fixed (wiki).</li>
    <li><b>Size +1% per member</b> beyond the 10-member minimum — fixed (wiki).</li>
    <li><b>Participation modifier ×0–×3</b> — fitted curve (below).</li>
    <li><b>Base(rank)</b> — fitted; the dominant lever (table below).</li>
  </ul>

  <div class="wpp-legend-h">Participation ×0–×3 — from score-share</div>
  <p>The wiki says the ×0–×3 modifier comes from your <b>score relative to the opponent's</b>. That's why a
     blown-out faction collapses toward ×0 (and the minimum cache), while a dominant one approaches ×3.
     With both war scores entered (the <span class="wpp-pill">score</span> model, R²&nbsp;${SCORE_MODEL.R2}),
     share = your score ÷ (both scores):</p>
  <ul>
    <li>5% share (dominated) → <b>×${scorePart(0.05).toFixed(2)}</b></li>
    <li>25% share → ×${scorePart(0.25).toFixed(2)}</li>
    <li>50% share (even) → ×${scorePart(0.50).toFixed(2)}</li>
    <li>75%+ (dominant) → ×${scorePart(0.75).toFixed(2)} (≈ max)</li>
  </ul>
  <p>Pre-war, with no scores, the <span class="wpp-pill">roster</span> model (R²&nbsp;${ROSTER_MODEL.R2}) estimates
     it from the fraction of members who land ≥10 hits, as <code>3·p^${ROSTER_MODEL.K.toFixed(2)}</code>:
     10%→×${rosterPart(0.10).toFixed(2)}, 50%→×${rosterPart(0.50).toFixed(2)}, 100%→×${rosterPart(1).toFixed(2)}.</p>

  <div class="wpp-legend-h">Base by rank <span class="wpp-pill">biggest lever</span></div>
  <p>The base reward roughly doubles every couple of ranks. Within a tier, divisions climb base → I → II → III,
     then you promote. (Combine with ×2 win, the size factor, and ×0–3 participation.)</p>
  <div class="wpp-tablewrap"><table class="wpp-table">
    <tr><th>Rank</th><th class="num">Base reward</th></tr>${rankRows}
  </table></div>

  <div class="wpp-legend-h">Accuracy & the range</div>
  <p>The calculator shows a <b>best estimate</b> plus a range ≈⅔ of real wars fall inside
     (±${Math.round((SCORE_MODEL.BAND - 1) * 100)}% for the score model). It's wide on a multi-billion cache
     because the model explains ${(SCORE_MODEL.R2 * 100).toFixed(0)}% of the variation, not 100%: the cache is
     <b>lumpy</b> (whole caches; one Heavy Arms Cache ≈ $430m) and the bonuses below aren't modelled.
     Half of wars land within ${SCORE_MODEL.ERR}% of the estimate; ~95% within a factor of 2.</p>

  <div class="wpp-legend-h">What's NOT in the model</div>
  <p>Two wiki bonuses can't be read from war reports, so they sit in the spread:</p>
  <ul>
    <li><b>Underdog bonus</b> — for being out-statted by the enemy (needs battle stats).</li>
    <li><b>Loss-streak bonus</b> — for winning after consecutive losses.</li>
  </ul>

  <div class="wpp-legend-h">Cache valuation</div>
  <p>Caches are valued at these Torn item-market averages. Your real $ moves with the live market, but the
     multipliers don't:</p>
  <div class="wpp-tablewrap"><table class="wpp-table">
    <tr><th>Cache</th><th class="num">Avg price</th></tr>${priceRows}
  </table></div>
</div>`;
        },
    };

    // ════════════════════════════════════════════════════════════
    //  ICON + BOOTSTRAP
    // ════════════════════════════════════════════════════════════

    const WPP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
        <defs><linearGradient id="wpp_icon_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
            <stop offset="0" stop-color="#f3d35b"/><stop offset="1" stop-color="#b8902a"/>
        </linearGradient></defs>
        <g fill="url(#wpp_icon_grad)">
            <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"/>
            <path d="M12.9 11.2c-1.7-.4-2.2-.7-2.2-1.3 0-.6.6-1 1.5-1 .9 0 1.3.4 1.4 1h1.6c-.1-1.1-.8-1.9-1.9-2.1V6.5h-1.8v1.2c-1.2.2-2.1 1-2.1 2.2 0 1.5 1.2 2 2.9 2.4 1.5.4 1.8.8 1.8 1.4 0 .4-.3 1-1.6 1-1.1 0-1.6-.5-1.7-1.1H9.1c.1 1.2 1 1.9 2.2 2.1v1.2h1.8v-1.2c1.3-.2 2.2-1 2.2-2.3 0-1.8-1.6-2.4-2.6-2.6Z"/>
        </g>
    </svg>`;

    function main() {
        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        W.registerEugeneScript({
            id: "wpp",
            name: "War Payout Predictor",
            color: "#d4a93a",
            colorDark: "#7a5f1f",
            hoverColor: "#e8c24f",
            iconSVG: WPP_ICON_SVG,
            onClick: () => UI.toggle(true),
        });
        W.mountEugeneFooterMenu();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", main);
    } else {
        main();
    }
})();
