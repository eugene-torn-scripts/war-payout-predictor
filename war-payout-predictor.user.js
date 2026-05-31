// ==UserScript==
// @name         War Payout Predictor
// @namespace    https://github.com/eugene-torn-scripts/war-payout-predictor
// @version      1.1.0
// @description  Predict the cash value of a Torn ranked-war cache from rank, win/loss, faction size, war score and participation — formula reverse-engineered from ~9,700 recent wars. Desktop + Torn PDA.
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

    const VERSION = "1.1.0";

    // ════════════════════════════════════════════════════════════
    //  MODEL — two multiplicative (log-linear) fits on 9,699 recent
    //  ranked-war faction-rows (forfeits & zero-reward rows excluded),
    //  all ending on/after 2025-05-31. Both are strictly monotonic:
    //  more of any input never lowers the predicted payout.
    //
    //  SCORE model (use when the war score is known — mid/post-war):
    //    value = exp(I) · RANK[rank] · exp(WON·won) · members^ENL · score^SCORE
    //    R²=0.922, median error 14%, within 1.5x for 91% of wars.
    //
    //  ROSTER model (pre-war planning, score unknown):
    //    value = exp(I) · RANK[rank] · exp(WON·won) · members^ENL · (p+ε)^PART
    //    R²=0.893, median error 15%.  p = fraction of enlisted with ≥10 hits.
    //
    //  Score is the strongest "effort" signal — it absorbs participation%
    //  (once score is known, participation% adds nothing), which is why the
    //  score model is more accurate. Participation still matters: it drives
    //  score. Caches are valued at CACHE_PRICES; absolute $ tracks the live
    //  market, the multipliers don't.
    // ════════════════════════════════════════════════════════════

    const FIT = { ROWS: 9699, CUTOFF: "2025-05-31" };
    const PART_EPS = 0.05;

    const SCORE_MODEL = {
        INT: 15.396978, WON: 0.560342, ENL: 0.232371, SCORE: 0.507741,
        R2: 0.922, ERR: 14,
        RANK: {
            "Unranked": 0.468, "Bronze": 0.498, "Bronze I": 0.548, "Bronze II": 0.625,
            "Bronze III": 0.654, "Silver": 0.640, "Silver I": 0.719, "Silver II": 0.810,
            "Silver III": 0.879, "Gold": 0.891, "Gold I": 1.000, "Gold II": 1.102,
            "Gold III": 1.206, "Platinum": 1.227, "Platinum I": 1.368, "Platinum II": 1.530,
            "Platinum III": 1.744, "Diamond": 1.914, "Diamond I": 2.048, "Diamond II": 2.252,
            "Diamond III": 2.881,
        },
    };

    const ROSTER_MODEL = {
        INT: 18.280073, WON: 0.804268, ENL: 0.678625, PART: 0.487226,
        R2: 0.893, ERR: 15,
        RANK: {
            "Unranked": 0.424, "Bronze": 0.431, "Bronze I": 0.471, "Bronze II": 0.543,
            "Bronze III": 0.573, "Silver": 0.605, "Silver I": 0.674, "Silver II": 0.765,
            "Silver III": 0.846, "Gold": 0.896, "Gold I": 1.000, "Gold II": 1.112,
            "Gold III": 1.232, "Platinum": 1.279, "Platinum I": 1.440, "Platinum II": 1.615,
            "Platinum III": 1.808, "Diamond": 2.145, "Diamond I": 2.296, "Diamond II": 2.574,
            "Diamond III": 3.037,
        },
    };

    const RANK_ORDER = Object.keys(ROSTER_MODEL.RANK);

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

    // If `score` > 0, uses the high-accuracy score model; otherwise falls back
    // to the roster model driven by participation `p` (fraction of enlisted
    // with ≥10 hits). Returns { value, model, factors }.
    function predict({ rank, won, enlisted, score, p }) {
        const enl = Math.max(1, enlisted);
        if (score && score > 0) {
            const m = SCORE_MODEL;
            const base = Math.exp(m.INT);
            const rankF = m.RANK[rank] != null ? m.RANK[rank] : 1;
            const winF = won ? Math.exp(m.WON) : 1;
            const sizeF = Math.pow(enl, m.ENL);
            const scoreF = Math.pow(score, m.SCORE);
            return {
                value: base * rankF * winF * sizeF * scoreF,
                model: "score",
                factors: { base, rank: rankF, win: winF, size: sizeF, score: scoreF },
            };
        }
        const m = ROSTER_MODEL;
        const base = Math.exp(m.INT);
        const rankF = m.RANK[rank] != null ? m.RANK[rank] : 1;
        const winF = won ? Math.exp(m.WON) : 1;
        const sizeF = Math.pow(enl, m.ENL);
        const partF = Math.pow(Math.min(1, p) + PART_EPS, m.PART);
        return {
            value: base * rankF * winF * sizeF * partF,
            model: "roster",
            factors: { base, rank: rankF, win: winF, size: sizeF, part: partF },
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
        state: { rank: "Gold I", won: true, enlisted: 50, hitters: 25, score: "" },

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
      <label>War score <span class="wpp-sub">your faction's — most accurate</span></label>
      <input class="wpp-input" id="wpp-score" type="number" min="0" step="1" placeholder="leave blank if unknown" value="${s.score}">
    </div>
    <div class="wpp-field">
      <label>Members with ≥10 war hits <span class="wpp-sub">(used only if score is blank)</span></label>
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
            const winEl = c.querySelector("#wpp-win");
            const lossEl = c.querySelector("#wpp-loss");

            const recompute = () => {
                s.rank = rankEl.value;
                s.enlisted = clamp(parseInt(enlEl.value, 10) || 0, 1, 100);
                s.hitters = clamp(parseInt(hitEl.value, 10) || 0, 0, s.enlisted);
                const sc = parseInt(scoreEl.value, 10);
                s.score = scoreEl.value === "" || !isFinite(sc) || sc < 0 ? "" : sc;
                this.renderResult(c.querySelector("#wpp-result"));
            };
            rankEl.addEventListener("change", recompute);
            enlEl.addEventListener("input", recompute);
            hitEl.addEventListener("input", recompute);
            scoreEl.addEventListener("input", recompute);
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
            const score = s.score === "" ? 0 : s.score;
            const { value, model, factors } = predict({ rank: s.rank, won: s.won, enlisted: enl, score, p });

            const lo = value / 1.35, hi = value * 1.35;
            const pctEl = document.getElementById("wpp-pct");
            if (pctEl) pctEl.textContent = `participation p = ${(p * 100).toFixed(0)}%`;

            const usingScore = model === "score";
            const pill = usingScore
                ? `<span class="wpp-modepill score">score model · ±${SCORE_MODEL.ERR}%</span>`
                : `<span class="wpp-modepill roster">roster model · ±${ROSTER_MODEL.ERR}%</span>`;

            const effortRow = usingScore
                ? `<tr><td>× Score (${Number(score).toLocaleString()})</td><td>×${factors.score.toFixed(1)}</td></tr>`
                : `<tr><td>× Participation (${(p * 100).toFixed(0)}%)</td><td>×${factors.part.toFixed(2)}</td></tr>`;

            box.innerHTML = `
<div class="wpp-big">${fmtMoney(value)}${pill}</div>
<div class="wpp-range">predicted cache value · likely ${fmtMoney(lo)} – ${fmtMoney(hi)}</div>
<table class="wpp-breakdown">
  <tr><td>Base unit</td><td>${fmtMoney(factors.base)}</td></tr>
  <tr><td>× Rank (${s.rank})</td><td>×${factors.rank.toFixed(3)}</td></tr>
  <tr><td>× Result (${s.won ? "Win" : "Loss"})</td><td>×${factors.win.toFixed(2)}</td></tr>
  <tr><td>× Size (${enl} members)</td><td>×${factors.size.toFixed(2)}</td></tr>
  ${effortRow}
  <tr class="total"><td>= Predicted faction cache</td><td>${fmtMoney(value)}</td></tr>
</table>
<div class="wpp-note">${usingScore
    ? `Using the <b>score model</b> (most accurate — ${SCORE_MODEL.R2 * 100}% R²). `
    : `No score entered → using the <b>roster model</b> for pre-war estimate (${ROSTER_MODEL.R2 * 100}% R²). Enter your war score for a sharper number. `}
  Faction-level gross cache value at current market prices; most wars land within ±35%.
  Unusual ones (big underdog or loss-streak bonus — not modelled) can be up to ~2× off.
  This is the <b>faction total</b>, not your personal cut.</div>`;
        },

        // ---- Legend tab -----------------------------------------------------
        renderLegend(c) {
            const rankRows = RANK_ORDER.map((r) =>
                `<tr class="${r === this.state.rank ? "hl" : ""}"><td>${r}</td>` +
                `<td class="num">×${ROSTER_MODEL.RANK[r].toFixed(3)}</td>` +
                `<td class="num">×${SCORE_MODEL.RANK[r].toFixed(3)}</td></tr>`).join("");
            const priceRows = CACHE_PRICES.map((x) =>
                `<tr><td>${x.name}</td><td class="num">${fmtMoney(x.avg)}</td></tr>`).join("");

            c.innerHTML = `
<div class="wpp-legend">
  <p>This tool predicts the <b>gross cash value of the war cache</b> a faction receives when a ranked
     war ends. The formula was reverse-engineered by fitting <b>${FIT.ROWS.toLocaleString()}</b> real,
     recent ranked-war reports (all ending on/after ${FIT.CUTOFF}) pulled from the Torn API.</p>

  <div class="wpp-legend-h">Two models</div>
  <p>Reward is <b>multiplicative</b> — each factor scales the total. There are two versions, and the
     calculator picks automatically:</p>
  <ul>
    <li><span class="wpp-pill">score</span> If you enter your <b>war score</b> — the most accurate
       (R²&nbsp;${SCORE_MODEL.R2}, median error ${SCORE_MODEL.ERR}%). Use during or after a war.
       <br><code>value = Base × Rank × Win × members^${SCORE_MODEL.ENL} × score^${SCORE_MODEL.SCORE}</code></li>
    <li><span class="wpp-pill">roster</span> If score is blank — a pre-war estimate
       (R²&nbsp;${ROSTER_MODEL.R2}, median error ${ROSTER_MODEL.ERR}%) driven by participation instead.
       <br><code>value = Base × Rank × Win × members^${ROSTER_MODEL.ENL} × (p+${PART_EPS})^${ROSTER_MODEL.PART}</code></li>
  </ul>

  <div class="wpp-legend-h">Score is the strongest signal</div>
  <p>War <b>score</b> (your faction's total) turned out to be the single best predictor of effort —
     it captures hit volume, not just headcount. Crucially, <b>once you know the score, the
     "fraction of members participating" adds nothing</b>: score already encodes it. So participation
     matters very much — but it matters <i>by producing score</i>. More participation → more score →
     bigger cache. There is no point where more participation lowers the payout.</p>

  <div class="wpp-legend-h">Rank <span class="wpp-pill">biggest lever</span></div>
  <p>Each tier is worth roughly <b>1.7× the one below</b>. Within a tier, divisions climb
     base → I → II → III, then you promote. Multiplier relative to Gold&nbsp;I (= 1.000):</p>
  <div class="wpp-tablewrap"><table class="wpp-table">
    <tr><th>Rank</th><th class="num">Roster model</th><th class="num">Score model</th></tr>${rankRows}
  </table></div>

  <div class="wpp-legend-h">Win vs Loss</div>
  <p>Winning multiplies the cache by <b>×${Math.exp(ROSTER_MODEL.WON).toFixed(2)}</b> in the roster model.
     In the score model the win bonus is smaller (<b>×${Math.exp(SCORE_MODEL.WON).toFixed(2)}</b>) because
     score already reflects most of the win/loss gap (winners score more) — this is the <i>pure</i> win
     bonus, holding score equal.</p>

  <div class="wpp-legend-h">Faction size</div>
  <p>Reward grows with enlisted members as a <b>power law</b> — <b>not</b> the often-quoted
     "+1% per member". In the roster model it's <code>members^${ROSTER_MODEL.ENL}</code>
     (doubling your roster ≈ ×${Math.pow(2, ROSTER_MODEL.ENL).toFixed(2)}); in the score model it's
     weaker (<code>members^${SCORE_MODEL.ENL}</code>) because score already carries much of the size effect.</p>

  <div class="wpp-legend-h">Participation (roster model only)</div>
  <p>Measured as the <b>fraction of enlisted who land ≥10 scoring war hits</b> (<code>p</code>). The
     modifier <code>(p+${PART_EPS})^${ROSTER_MODEL.PART}</code> rises steeply then flattens, and is
     <b>monotonically increasing</b> — more is always better. Approximate effect:</p>
  <ul>
    <li>p = 10% → ×${Math.pow(0.10 + PART_EPS, ROSTER_MODEL.PART).toFixed(2)}</li>
    <li>p = 35% → ×${Math.pow(0.35 + PART_EPS, ROSTER_MODEL.PART).toFixed(2)}</li>
    <li>p = 60% → ×${Math.pow(0.60 + PART_EPS, ROSTER_MODEL.PART).toFixed(2)}</li>
    <li>p = 100% → ×${Math.pow(1.00 + PART_EPS, ROSTER_MODEL.PART).toFixed(2)}</li>
  </ul>

  <div class="wpp-legend-h">What's NOT in the model</div>
  <p>Two real bonuses can't be read from war reports, so they sit in the unexplained spread:</p>
  <ul>
    <li><b>Underdog bonus</b> — for being out-statted by the enemy (needs battle stats).</li>
    <li><b>Loss-streak bonus</b> — for winning after consecutive losses.</li>
  </ul>
  <p>Cache quantization (rewards come as whole caches) and market-price drift add the rest.</p>

  <div class="wpp-legend-h">Cache valuation</div>
  <p>Caches are valued at these Torn item-market averages (used when the formula was fitted). Your real
     $ moves with the live market, but the multipliers don't:</p>
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
