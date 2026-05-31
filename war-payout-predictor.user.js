// ==UserScript==
// @name         War Payout Predictor
// @namespace    https://github.com/eugene-torn-scripts/war-payout-predictor
// @version      1.0.1
// @description  Predict the cash value of a Torn ranked-war cache from rank, win/loss, faction size and participation — formula reverse-engineered from ~9,700 recent wars. Desktop + Torn PDA.
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

    const VERSION = "1.0.1";

    // ════════════════════════════════════════════════════════════
    //  MODEL — fitted by multiplicative (log-linear) OLS on 9,699
    //  recent ranked-war faction-rows (forfeits & zero-reward rows
    //  excluded), all ending on/after 2025-05-31. R²=0.894, median
    //  prediction error 13%, within 1.5x for 88% of wars.
    //
    //    value($) = exp(INTERCEPT)
    //               × RANK_MULT[rank]              (relative to Gold I = 1)
    //               × exp(WON_COEF · won)          (win = ×2.29, loss = ×1)
    //               × enlisted ^ SIZE_EXP          (roster size, power law)
    //               × exp(PART_B1·p + PART_B2·p²)  (participation modifier)
    //
    //  where p = fraction of enlisted members who landed ≥10 war hits.
    //  Caches are valued at the market prices in CACHE_PRICES below, so
    //  the absolute $ scales with the live market (the multipliers don't).
    // ════════════════════════════════════════════════════════════

    const MODEL = {
        INTERCEPT: 17.1110,   // exp(17.111) ≈ $26.99m  (Gold I, loss, 1 member, 0% participation)
        WON_COEF: 0.8293,     // exp = ×2.29 win factor
        SIZE_EXP: 0.6457,     // value ∝ enlisted^0.65
        PART_B1: 3.3650,      // participation linear term
        PART_B2: -2.5533,     // participation quadratic term (concave; peaks ~p=0.66)
        FIT_ROWS: 9699,
        R2: 0.894,
        MEDIAN_ERR_PCT: 13,
        CUTOFF_LABEL: "2025-05-31",
    };

    // Rank → base multiplier, relative to Gold I = 1.000. Ordered low→high.
    const RANK_MULT = {
        "Unranked":     0.419,
        "Bronze":       0.425,
        "Bronze I":     0.465,
        "Bronze II":    0.531,
        "Bronze III":   0.560,
        "Silver":       0.599,
        "Silver I":     0.670,
        "Silver II":    0.757,
        "Silver III":   0.834,
        "Gold":         0.901,
        "Gold I":       1.000,
        "Gold II":      1.116,
        "Gold III":     1.230,
        "Platinum":     1.295,
        "Platinum I":   1.455,
        "Platinum II":  1.637,
        "Platinum III": 1.858,
        "Diamond":      2.191,
        "Diamond I":    2.401,
        "Diamond II":   2.638,
        "Diamond III":  3.127,
    };
    const RANK_ORDER = Object.keys(RANK_MULT);

    // Cache market prices used when fitting (current Torn item-market averages).
    // Shown in the Legend so users know the $ figures track the live market.
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

    // Returns { value, factors:{base,rank,win,size,part} } for the inputs.
    function predict({ rank, won, enlisted, p }) {
        const mult = RANK_MULT[rank] != null ? RANK_MULT[rank] : 1;
        const base = Math.exp(MODEL.INTERCEPT);
        const win = won ? Math.exp(MODEL.WON_COEF) : 1;
        const size = Math.pow(enlisted, MODEL.SIZE_EXP);
        const part = Math.exp(MODEL.PART_B1 * p + MODEL.PART_B2 * p * p);
        return {
            value: base * mult * win * size * part,
            factors: { base, rank: mult, win, size, part },
        };
    }

    function fmtMoney(n) {
        if (!isFinite(n) || n <= 0) return "$0";
        if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "b";
        if (n >= 1e6) return "$" + (n / 1e6).toFixed(0) + "m";
        if (n >= 1e3) return "$" + (n / 1e3).toFixed(0) + "k";
        return "$" + Math.round(n);
    }

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

#wpp-result{background:linear-gradient(180deg,#23210f,#1b1a12);border:1px solid #5a4d1f;
  border-left:4px solid #e8c24f;border-radius:6px;padding:16px;margin-top:4px}
#wpp-result .wpp-big{font-size:30px;font-weight:800;color:#f3d35b;line-height:1.1}
#wpp-result .wpp-range{color:#cdbb78;font-size:13px;margin-top:4px}
#wpp-result .wpp-note{color:#8a8268;font-size:11px;margin-top:8px;line-height:1.45}
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
        state: { rank: "Gold I", won: true, enlisted: 50, hitters: 25 },

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
      <label>Members with ≥10 war hits</label>
      <input class="wpp-input" id="wpp-hit" type="number" min="0" max="100" step="1" value="${s.hitters}">
      <span class="wpp-sub" id="wpp-pct"></span>
    </div>
  </div>
</div>
<div id="wpp-result"></div>`;

            const rankEl = c.querySelector("#wpp-rank");
            const enlEl = c.querySelector("#wpp-enl");
            const hitEl = c.querySelector("#wpp-hit");
            const winEl = c.querySelector("#wpp-win");
            const lossEl = c.querySelector("#wpp-loss");

            const recompute = () => {
                s.rank = rankEl.value;
                s.enlisted = clamp(parseInt(enlEl.value, 10) || 0, 1, 100);
                s.hitters = clamp(parseInt(hitEl.value, 10) || 0, 0, s.enlisted);
                this.renderResult(c.querySelector("#wpp-result"));
            };
            rankEl.addEventListener("change", recompute);
            enlEl.addEventListener("input", recompute);
            hitEl.addEventListener("input", recompute);
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
            const p = enl > 0 ? Math.min(1, s.hitters / enl) : 0;
            const { value, factors } = predict({ rank: s.rank, won: s.won, enlisted: enl, p });

            // Likely range: RMSE in log space ≈ 0.30 → roughly ÷/× 1.35 covers
            // the bulk of wars; unmodeled underdog/loss-streak bonuses widen the tail.
            const lo = value / 1.35, hi = value * 1.35;

            const pctEl = document.getElementById("wpp-pct");
            if (pctEl) pctEl.textContent = `participation p = ${(p * 100).toFixed(0)}%`;

            box.innerHTML = `
<div class="wpp-big">${fmtMoney(value)}</div>
<div class="wpp-range">predicted cache value · likely ${fmtMoney(lo)} – ${fmtMoney(hi)}</div>
<table class="wpp-breakdown">
  <tr><td>Base unit</td><td>${fmtMoney(factors.base)}</td></tr>
  <tr><td>× Rank (${s.rank})</td><td>×${factors.rank.toFixed(3)}</td></tr>
  <tr><td>× Result (${s.won ? "Win" : "Loss"})</td><td>×${factors.win.toFixed(2)}</td></tr>
  <tr><td>× Size (${enl} members)</td><td>×${factors.size.toFixed(2)}</td></tr>
  <tr><td>× Participation (${(p * 100).toFixed(0)}%)</td><td>×${factors.part.toFixed(2)}</td></tr>
  <tr class="total"><td>= Predicted faction cache</td><td>${fmtMoney(value)}</td></tr>
</table>
<div class="wpp-note">Faction-level gross cache value at current market prices. Most wars land within
  ±35% of this; unusual ones (big underdog or loss-streak bonus — not in the model) can be up to ~2× off.
  This is the <b>faction total</b>, not your personal cut.</div>`;
        },

        // ---- Legend tab -----------------------------------------------------
        renderLegend(c) {
            const rankRows = RANK_ORDER.map((r) =>
                `<tr class="${r === this.state.rank ? "hl" : ""}"><td>${r}</td><td class="num">×${RANK_MULT[r].toFixed(3)}</td></tr>`).join("");
            const priceRows = CACHE_PRICES.map((x) =>
                `<tr><td>${x.name}</td><td class="num">${fmtMoney(x.avg)}</td></tr>`).join("");

            c.innerHTML = `
<div class="wpp-legend">
  <p>This tool predicts the <b>gross cash value of the war cache</b> a faction receives when a ranked
     war ends. The formula was reverse-engineered by fitting <b>${MODEL.FIT_ROWS.toLocaleString()}</b>
     real, recent ranked-war reports (all ending on/after ${MODEL.CUTOFF_LABEL}) pulled from the Torn API.
     It explains <b>R²=${MODEL.R2}</b> of the variation; the median prediction lands within
     <b>${MODEL.MEDIAN_ERR_PCT}%</b> of the real payout.</p>

  <div class="wpp-legend-h">The formula</div>
  <p>Reward is <b>multiplicative</b> — each factor scales the total:</p>
  <p><code>value = BaseUnit × Rank × Win × Size × Participation</code></p>

  <div class="wpp-legend-h">1 · Rank <span class="wpp-pill">biggest lever</span></div>
  <p>Each tier is worth roughly <b>1.7× the one below</b>. Within a tier, divisions climb
     base → I → II → III, then you promote. Multiplier relative to Gold&nbsp;I (= 1.000):</p>
  <div class="wpp-tablewrap"><table class="wpp-table">
    <tr><th>Rank</th><th class="num">Multiplier</th></tr>${rankRows}
  </table></div>

  <div class="wpp-legend-h">2 · Win vs Loss</div>
  <p>Winning multiplies the cache by <b>×${Math.exp(MODEL.WON_COEF).toFixed(2)}</b>; losing is ×1.
     (Winners also tend to participate more, so observed win/loss gaps look even larger — but the
     <i>isolated</i> win factor is ~2.3×.)</p>

  <div class="wpp-legend-h">3 · Faction size</div>
  <p>Reward grows with enlisted members as a <b>power law</b>, <code>members^${MODEL.SIZE_EXP}</code> —
     <b>not</b> the often-quoted "+1% per member". Doubling your roster multiplies the cache by about
     <b>×${Math.pow(2, MODEL.SIZE_EXP).toFixed(2)}</b>. Examples vs. a 20-member faction:</p>
  <ul>
    <li>40 members → ×${(Math.pow(40, MODEL.SIZE_EXP) / Math.pow(20, MODEL.SIZE_EXP)).toFixed(2)}</li>
    <li>60 members → ×${(Math.pow(60, MODEL.SIZE_EXP) / Math.pow(20, MODEL.SIZE_EXP)).toFixed(2)}</li>
    <li>100 members → ×${(Math.pow(100, MODEL.SIZE_EXP) / Math.pow(20, MODEL.SIZE_EXP)).toFixed(2)}</li>
  </ul>

  <div class="wpp-legend-h">4 · Participation</div>
  <p>Measured as the <b>fraction of enlisted members who land ≥10 scoring war hits</b> (call it
     <code>p</code>). The modifier is <code>exp(${MODEL.PART_B1}·p − ${(-MODEL.PART_B2).toFixed(2)}·p²)</code>
     — it rises steeply, then <b>peaks around p ≈ 66%</b> and plateaus. Going from a near-dead faction to a
     well-participating one is worth up to <b>~×3</b>. Approximate effect:</p>
  <ul>
    <li>p = 10% → ×${Math.exp(MODEL.PART_B1 * 0.1 + MODEL.PART_B2 * 0.01).toFixed(2)}</li>
    <li>p = 35% → ×${Math.exp(MODEL.PART_B1 * 0.35 + MODEL.PART_B2 * 0.1225).toFixed(2)}</li>
    <li>p = 50% → ×${Math.exp(MODEL.PART_B1 * 0.5 + MODEL.PART_B2 * 0.25).toFixed(2)}</li>
    <li>p = 66% → ×${Math.exp(MODEL.PART_B1 * 0.66 + MODEL.PART_B2 * 0.4356).toFixed(2)} (peak)</li>
  </ul>

  <div class="wpp-legend-h">What's NOT in the model</div>
  <p>Two real bonuses can't be read from war reports, so they live in the ~${Math.round((1 - MODEL.R2) * 100)}%
     unexplained spread:</p>
  <ul>
    <li><b>Underdog bonus</b> — for being out-statted by the enemy (needs battle stats).</li>
    <li><b>Loss-streak bonus</b> — for winning after consecutive losses.</li>
  </ul>
  <p>Cache quantization (rewards come as whole caches) and market-price drift add the rest.</p>

  <div class="wpp-legend-h">Cache valuation</div>
  <p>Caches are valued at these Torn item-market averages (used when the formula was fitted). Your real
     $ moves with the live market, but the multipliers above don't:</p>
  <div class="wpp-tablewrap"><table class="wpp-table">
    <tr><th>Cache</th><th class="num">Avg price</th></tr>${priceRows}
  </table></div>
</div>`;
        },
    };

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

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
