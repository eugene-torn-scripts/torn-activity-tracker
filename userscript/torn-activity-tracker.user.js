// ==UserScript==
// @name         Torn Activity Tracker
// @namespace    https://github.com/eugene-torn-scripts/torn-activity-tracker
// @version      2.4.8
// @description  Faction member activity heatmap for ranked war scouting. Compares your faction's activity history vs the opponent.
// @author       lannav
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      torn-tat.duckdns.org
// @connect      ffscouter.com
// @connect      *
// @license      GPL-3.0-or-later
// @downloadURL  https://update.greasyfork.org/scripts/573936/Torn%20Activity%20Tracker.user.js
// @updateURL    https://update.greasyfork.org/scripts/573936/Torn%20Activity%20Tracker.meta.js
// @run-at       document-end
// ==/UserScript==

/*
 * Torn Activity Tracker
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
 * Source: https://github.com/eugene-torn-scripts/torn-activity-tracker
 */

/* eslint-disable no-undef */

(function () {
    "use strict";

    const VERSION = "2.4.8";
    const BACKEND_BASE = GM_getValue("backend_base", "https://torn-tat.duckdns.org");
    const STORAGE_KEYS = { apiKey: "torn_api_key", userInfo: "torn_user_info", ffscouterKey: "ffscouter_key", debug: "tat_debug", hourGridIncludeIdle: "tat_hour_grid_include_idle", summaryIncludeIdle: "tat_summary_include_idle", compareMobileCol: "tat_compare_mobile_col", watchlistCache: "tat_watchlist_cache" };

    // ═══════════════════════════════════════════════════════════
    //  Performance tracker
    // ═══════════════════════════════════════════════════════════

    const perfLog = [];
    const MAX_PERF_LOG = 50;

    function perfTrack(label, startTime) {
        if (!GM_getValue(STORAGE_KEYS.debug)) return;
        const ms = Math.round(performance.now() - startTime);
        perfLog.push({ ts: new Date().toISOString().slice(11, 19), label, ms });
        if (perfLog.length > MAX_PERF_LOG) perfLog.shift();
    }

    // Long task observer — detects >50ms main-thread blocks
    try {
        const longTaskObs = new PerformanceObserver((list) => {
            if (!GM_getValue(STORAGE_KEYS.debug)) return;
            for (const entry of list.getEntries()) {
                const ms = Math.round(entry.duration);
                if (ms > 50) {
                    perfLog.push({ ts: new Date().toISOString().slice(11, 19), label: `long-task (${entry.name})`, ms });
                    if (perfLog.length > MAX_PERF_LOG) perfLog.shift();
                }
            }
        });
        longTaskObs.observe({ type: "longtask", buffered: false });
    } catch { /* PerformanceObserver longtask not supported */ }

    // ═══════════════════════════════════════════════════════════
    //  Backend client
    // ═══════════════════════════════════════════════════════════

    function _backendRequestOnce(method, path, body) {
        const apiKey = GM_getValue(STORAGE_KEYS.apiKey);
        const url = `${BACKEND_BASE}${path}`;
        const t0 = performance.now();
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers: {
                    ...(body ? { "Content-Type": "application/json" } : {}),
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                },
                data: body ? JSON.stringify(body) : undefined,
                onload: (res) => {
                    perfTrack(`${method} ${path} → ${res.status}`, t0);
                    let data = {};
                    try { if (res.responseText) data = JSON.parse(res.responseText); } catch {}
                    if (res.status >= 200 && res.status < 300) resolve(data);
                    else reject({ status: res.status, ...data });
                },
                onerror: () => { perfTrack(`${method} ${path} → ERR`, t0); reject({ status: 0, error: "network_error" }); },
            });
        });
    }

    // Retry transient network errors. Torn PDA's GM_xmlhttpRequest sometimes
    // rejects with ERR 0ms under concurrent load — desktop is fine. Only retry
    // status 0 (no response); real HTTP errors (4xx/5xx) fall straight through.
    async function backendRequest(method, path, body) {
        const backoffs = [0, 300, 800];
        let lastErr;
        for (let attempt = 0; attempt < backoffs.length; attempt++) {
            if (backoffs[attempt] > 0) {
                await new Promise((r) => setTimeout(r, backoffs[attempt]));
            }
            try {
                return await _backendRequestOnce(method, path, body);
            } catch (err) {
                lastErr = err;
                if (err.status !== 0) throw err;
            }
        }
        throw lastErr;
    }

    // Watchlist fetch with local cache fallback. PDA sometimes fails the
    // initial /v1/watchlist call and the dropdowns end up empty; falling
    // back to the last successful response keeps the UI usable.
    async function fetchWatchlistCached() {
        try {
            const list = await backendRequest("GET", "/v1/watchlist");
            GM_setValue(STORAGE_KEYS.watchlistCache, list);
            return list;
        } catch (err) {
            const cached = GM_getValue(STORAGE_KEYS.watchlistCache);
            if (Array.isArray(cached)) return cached;
            throw err;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  FFScouter client
    // ═══════════════════════════════════════════════════════════

    /**
     * Fetch battle stats for an array of user IDs from FFScouter.
     * Returns a Map<userId, { bs_estimate_human, fair_fight }>.
     */
    async function fetchBattleStats(userIds) {
        const key = GM_getValue(STORAGE_KEYS.ffscouterKey);
        if (!key || userIds.length === 0) return new Map();

        const results = new Map();
        // FFScouter allows up to 205 targets per request
        for (let i = 0; i < userIds.length; i += 200) {
            const chunk = userIds.slice(i, i + 200);
            const url = `https://ffscouter.com/api/v1/get-stats?key=${encodeURIComponent(key)}&targets=${chunk.join(",")}`;
            try {
                const data = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url,
                        onload: (res) => {
                            try {
                                const parsed = JSON.parse(res.responseText);
                                if (Array.isArray(parsed)) resolve(parsed);
                                else reject(parsed);
                            } catch { reject({ error: "parse_error" }); }
                        },
                        onerror: (e) => reject(e),
                    });
                });
                for (const p of data) {
                    results.set(p.player_id, {
                        bs: p.bs_estimate_human,
                        ff: p.fair_fight != null ? p.fair_fight.toFixed(2) : null,
                    });
                }
            } catch { /* ignore FFScouter errors */ }
        }
        return results;
    }

    // ═══════════════════════════════════════════════════════════
    //  Auth helpers
    // ═══════════════════════════════════════════════════════════

    function hasValidUserInfo(info) {
        return !!(info && typeof info === "object" && info.torn_user_id);
    }

    function isAuthenticated() {
        // Require BOTH a stored key AND a valid userInfo object. An apiKey-only
        // state ("Unknown user" in the UI) can happen on Torn PDA or after
        // interrupted registration where GM_setValue(apiKey) lands but the
        // register response / GM_setValue(userInfo) never does — or when a
        // reinstall preserves old GM storage across versions. recoverAuthIfNeeded
        // heals this by re-registering with the stored key before we gate.
        return Boolean(GM_getValue(STORAGE_KEYS.apiKey))
            && hasValidUserInfo(GM_getValue(STORAGE_KEYS.userInfo));
    }

    /**
     * If apiKey is stored but userInfo is missing/malformed, try to restore
     * userInfo by re-registering (POST /v1/auth/register is idempotent —
     * server-side MERGE). If the stored key is invalid, clear both so the
     * auth screen shows instead of the "Unknown user" main UI.
     *
     * @returns {Promise<boolean>}  true if state was healed (or already healthy)
     */
    async function recoverAuthIfNeeded() {
        const apiKey = GM_getValue(STORAGE_KEYS.apiKey);
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo);
        if (!apiKey) return false;                    // not auth'd, let caller show auth screen
        if (hasValidUserInfo(userInfo)) return true;  // healthy
        try {
            const info = await backendRequest("POST", "/v1/auth/register", { api_key: apiKey });
            GM_setValue(STORAGE_KEYS.userInfo, info);
            return true;
        } catch {
            GM_deleteValue(STORAGE_KEYS.apiKey);
            GM_deleteValue(STORAGE_KEYS.userInfo);
            return false;
        }
    }

    async function register(apiKey) {
        GM_setValue(STORAGE_KEYS.apiKey, apiKey);
        try {
            const info = await backendRequest("POST", "/v1/auth/register", { api_key: apiKey });
            GM_setValue(STORAGE_KEYS.userInfo, info);
            return info;
        } catch (err) {
            GM_deleteValue(STORAGE_KEYS.apiKey);
            throw err;
        }
    }

    async function logout() {
        // Use POST /v1/auth/logout instead of DELETE /v1/auth/me. Torn PDA's
        // GM_xmlhttpRequest silently rewrites DELETE to GET on some installs,
        // so logout would silently no-op on mobile. Backend accepts both.
        try { await backendRequest("POST", "/v1/auth/logout"); } catch { /* ignore */ }
        GM_deleteValue(STORAGE_KEYS.apiKey);
        GM_deleteValue(STORAGE_KEYS.userInfo);
    }

    // ═══════════════════════════════════════════════════════════
    //  CSS
    // ═══════════════════════════════════════════════════════════

    function injectCSS() {
        if (document.getElementById("tat-style")) return;
        const style = document.createElement("style");
        style.id = "tat-style";
        style.textContent = `
/* Overlay & Panel */
#tat-overlay{display:none;position:fixed;inset:0;z-index:999998;background:rgba(0,0,0,.7)}
#tat-panel{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:999999;
  background:#1a1a1a;border:1px solid #444;border-radius:10px;overflow:hidden;resize:both;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#ddd;font-size:14px;
  width:840px;max-width:100vw;max-height:88vh;min-width:340px;min-height:300px;
  flex-direction:column}
#tat-panel *{box-sizing:border-box;color:inherit}

/* Dark scrollbars */
#tat-panel ::-webkit-scrollbar{width:6px;height:6px}
#tat-panel ::-webkit-scrollbar-track{background:#1a1a1a}
#tat-panel ::-webkit-scrollbar-thumb{background:#444;border-radius:3px}
#tat-panel ::-webkit-scrollbar-thumb:hover{background:#555}
#tat-panel{scrollbar-color:#444 #1a1a1a;scrollbar-width:thin}

#tat-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;
  background:#222;border-bottom:1px solid #444}
#tat-header h2{margin:0;font-size:17px;color:#fff}
#tat-header .tat-ver{color:#666;font-size:12px;margin-left:8px}
#tat-close{background:none;border:none;color:#999;font-size:22px;cursor:pointer;padding:4px 8px}
#tat-close:hover{color:#fff}

#tat-tabs{display:flex;background:#252525;border-bottom:1px solid #444;overflow-x:auto;flex-shrink:0}
.tat-tab{padding:10px 20px;cursor:pointer;color:#999!important;border-bottom:2px solid transparent;
  white-space:nowrap;font-size:14px;transition:all .15s}
.tat-tab:hover{color:#ccc!important;background:#2a2a2a}
.tat-tab.active{color:#4fc3f7!important;border-bottom-color:#4fc3f7}

#tat-content{padding:16px;overflow-y:auto;overflow-x:hidden;flex:1;min-height:0}

/* Sortable table headers */
.tat-grid th[data-col]{cursor:pointer;user-select:none}
.tat-grid th[data-col]:hover{color:#fff!important}
.tat-grid th[data-col]::after{content:" \\21C5";color:#555;font-size:10px}
.tat-grid th[data-col].sort-asc::after{content:" \\25B2";color:#4fc3f7;font-size:10px}
.tat-grid th[data-col].sort-desc::after{content:" \\25BC";color:#4fc3f7;font-size:10px}

/* Auth screen */
.tat-auth{max-width:460px;margin:0 auto;text-align:center}
.tat-auth h3{font-size:18px;color:#fff;margin:20px 0 8px}
.tat-auth p{color:#aaa;font-size:13px;line-height:1.6;margin:6px 0}
.tat-auth-input{width:100%;padding:10px 12px;background:#252525;border:1px solid #444;color:#ddd;
  border-radius:6px;font-size:15px;margin:12px 0 8px;text-align:center;letter-spacing:1px}
.tat-auth-input:focus{border-color:#4fc3f7;outline:none}
.tat-auth-btn{width:100%;padding:10px;border:none;border-radius:6px;cursor:pointer;font-size:15px;
  font-weight:600;background:#4fc3f7;color:#111!important;margin:4px 0;transition:background .15s}
.tat-auth-btn:hover{background:#29b6f6}
.tat-auth-btn:disabled{opacity:.5;cursor:not-allowed}
.tat-auth-error{color:#ef5350;font-size:13px;margin:8px 0;min-height:20px}
.tat-disclaimer{background:#252525;border:1px solid #333;border-radius:8px;padding:12px 14px;
  text-align:left;margin:16px 0 8px;font-size:12px;color:#999;line-height:1.6}
.tat-disclaimer strong{color:#ccc}
.tat-disclaimer-toggle{color:#4fc3f7;cursor:pointer;font-size:12px;border:none;background:none;
  padding:0;text-decoration:underline}
.tat-disclaimer-full{display:none;margin-top:10px;padding-top:10px;border-top:1px solid #333}

/* Utility */
.tat-empty{text-align:center;color:#888;padding:40px 0;font-size:14px}
.tat-empty svg{opacity:.3;margin-bottom:12px}
.tat-btn{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:600;color:#ddd}
.tat-btn-danger{background:#ef5350;color:#fff!important}.tat-btn-danger:hover{background:#f44336}
.tat-btn-primary{background:#4fc3f7;color:#111!important}.tat-btn-primary:hover{background:#29b6f6}
.tat-btn-export{background:#333;color:#ccc!important;font-size:12px;padding:5px 12px}
.tat-btn-export:hover{background:#444;color:#fff!important}
.tat-status{padding:8px 12px;background:#252525;border-radius:4px;color:#999;font-size:13px;margin:8px 0}
.tat-user-badge{display:inline-flex;align-items:center;gap:6px;background:#252525;border:1px solid #333;
  border-radius:6px;padding:6px 12px;font-size:13px;color:#ccc;margin-bottom:16px}
.tat-user-badge strong{color:#4fc3f7}

/* Hour grid heatmap */
.tat-grid-wrap{overflow-x:auto}
.tat-chart-wrap{overflow-x:auto}
.tat-grid{border-collapse:collapse;font-size:12px;width:100%}
.tat-grid th,.tat-grid td{padding:4px 6px;text-align:center;border:1px solid #333;white-space:nowrap}
.tat-grid th{color:#999;font-weight:600;background:#222;position:sticky;top:0}
.tat-grid td.tat-cell{min-width:28px;font-variant-numeric:tabular-nums;font-size:11px;color:#fff}
.tat-grid .tat-day-label{text-align:right;color:#aaa;font-size:12px;background:#1a1a1a;min-width:80px}
.tat-legend{display:flex;align-items:center;gap:4px;font-size:11px;color:#888;margin:8px 0}
.tat-legend-box{width:14px;height:14px;border-radius:2px;border:1px solid #444}
.tat-grid-controls{display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap}
.tat-grid-controls select,.tat-grid-controls input{background:#252525;border:1px solid #444;color:#ddd;
  padding:5px 8px;border-radius:4px;font-size:13px}
.tat-grid-controls label{color:#aaa;font-size:13px}

/* Compare layout */
.tat-cmp-name{cursor:pointer}
.tat-cmp-name:hover{text-decoration:underline}
.tat-mobile-col-picker{display:none}

/* Combobox (watchlist candidate search) */
.tat-combobox{position:relative}
.tat-combobox-list{max-height:220px;overflow-y:auto;background:#252525;border:1px solid #444;border-radius:4px;
  position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:10}
.tat-combo-item{padding:6px 10px;cursor:pointer;color:#ddd;font-size:13px;border-bottom:1px solid #2a2a2a}
.tat-combo-item:last-child{border-bottom:none}
.tat-combo-item:hover{background:#333;color:#fff}

/* Mobile */
@media(max-width:768px){
  #tat-panel{width:100vw!important;max-width:100vw;min-width:0;border-radius:0;top:0;left:0;
    transform:none;max-height:100vh;height:100vh}
  #tat-content{padding:10px}
  .tat-tab{padding:8px 12px;font-size:13px}
  .tat-grid{font-size:10px}
  .tat-grid th,.tat-grid td{padding:2px 3px}
  .tat-grid td.tat-cell{min-width:18px;font-size:10px}
  .tat-grid .tat-day-label{min-width:52px;font-size:10px}
  .tat-mobile-col-picker{display:flex!important;align-items:center;gap:6px;margin-bottom:8px;
    color:#aaa;font-size:12px;flex-wrap:wrap}
  .tat-mobile-col-picker select{background:#252525;border:1px solid #444;color:#ddd;
    padding:4px 6px;border-radius:4px;font-size:12px}
}
`;
        document.head.appendChild(style);
    }

    // ═══════════════════════════════════════════════════════════
    //  UI
    // ═══════════════════════════════════════════════════════════

    const BASE_TABS = [
        { id: "hourly", label: "Hour Grid" },
        { id: "weekday", label: "Weekday Avg" },
        { id: "compare", label: "Compare" },
        { id: "settings", label: "Settings" },
    ];

    function getTabs() {
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo) || {};
        const tabs = [...BASE_TABS];
        if (userInfo.is_admin) tabs.push({ id: "admin", label: "Admin" });
        return tabs;
    }

    let activeTab = "hourly";
    let panelOpen = false;

    function createPanel() {
        if (document.getElementById("tat-panel")) return;
        injectCSS();

        const overlay = document.createElement("div");
        overlay.id = "tat-overlay";
        document.body.appendChild(overlay);

        const panel = document.createElement("div");
        panel.id = "tat-panel";
        panel.innerHTML = `
            <div id="tat-header">
                <h2>Activity Tracker <span class="tat-ver">v${VERSION}</span>
                    <span style="color:#888;font-size:11px;font-weight:400;margin-left:10px">
                        Like the script? Send a Xanax to
                        <a href="https://www.torn.com/profiles.php?XID=4192025" target="_blank"
                           style="color:#cc3333;text-decoration:none">eugene_s [4192025]</a>
                    </span>
                </h2>
                <button id="tat-close">&times;</button>
            </div>
            <div id="tat-tabs"></div>
            <div id="tat-content"></div>
        `;
        document.body.appendChild(panel);

        overlay.addEventListener("click", () => togglePanel(false));
        document.getElementById("tat-close").addEventListener("click", () => togglePanel(false));
        document.getElementById("tat-tabs").addEventListener("click", (e) => {
            const tab = e.target.closest(".tat-tab");
            if (tab) {
                activeTab = tab.dataset.tab;
                renderTabs();
                const content = document.getElementById("tat-content");
                content.scrollTop = 0;
                renderContent();
            }
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && panelOpen) togglePanel(false);
        });
    }

    async function togglePanel(show) {
        createPanel();
        panelOpen = show;
        document.getElementById("tat-panel").style.display = show ? "flex" : "none";
        document.getElementById("tat-overlay").style.display = show ? "block" : "none";
        if (!show) return;

        // Heal any apiKey-without-userInfo state (stale install, interrupted
        // register, PDA storage quirk) before deciding auth vs main UI.
        if (GM_getValue(STORAGE_KEYS.apiKey) && !hasValidUserInfo(GM_getValue(STORAGE_KEYS.userInfo))) {
            const el = document.getElementById("tat-content");
            if (el) el.innerHTML = `<div class="tat-status">Restoring session…</div>`;
            await recoverAuthIfNeeded();
        }

        renderTabs();
        renderContent();
    }

    function renderTabs() {
        const tabsEl = document.getElementById("tat-tabs");
        if (!isAuthenticated()) {
            tabsEl.innerHTML = "";
            return;
        }
        const tabs = getTabs();
        tabsEl.innerHTML = tabs.map((t) =>
            `<div class="tat-tab${t.id === activeTab ? " active" : ""}" data-tab="${t.id}">${t.label}</div>`
        ).join("");
    }

    async function renderContent() {
        const el = document.getElementById("tat-content");
        if (!isAuthenticated()) {
            renderAuthScreen(el);
            return;
        }
        const t0 = performance.now();
        switch (activeTab) {
            case "hourly": await renderHourGrid(el); break;
            case "weekday": await renderWeekdayAvg(el); break;
            case "compare": await renderCompare(el); break;
            case "settings": renderSettings(el); break;
            case "admin": await renderAdmin(el); break;
        }
        perfTrack(`render:${activeTab} (${document.getElementById("tat-panel")?.querySelectorAll("*").length || 0} DOM nodes)`, t0);
    }

    // ── Auth screen ─────────────────────────────────────────────

    function renderAuthScreen(el) {
        el.innerHTML = `
            <div class="tat-auth">
                <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
                     stroke="#4fc3f7" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
                <h3>Connect your Torn account</h3>
                <p>Paste your <strong>public API key</strong> from
                    <a href="https://www.torn.com/preferences.php#tab=api" target="_blank"
                       style="color:#4fc3f7">Torn Settings &rarr; API</a>
                    to start tracking faction activity.
                </p>
                <input type="text" class="tat-auth-input" id="tat-key-input"
                       placeholder="Enter your API key" maxlength="20" autocomplete="off" spellcheck="false">
                <div class="tat-auth-error" id="tat-auth-error"></div>
                <button class="tat-auth-btn" id="tat-auth-submit">Connect</button>

                <div class="tat-disclaimer">
                    <strong>Privacy notice</strong><br>
                    Your Torn public API key is encrypted at rest on our server and used only to fetch faction
                    activity data on your behalf, capped at 20 calls per minute (Torn allows 100). It is never
                    shared, exported, or used for anything else. You can remove it instantly via Settings.
                    <br><br>
                    <button class="tat-disclaimer-toggle" id="tat-disclaimer-more">Read full disclaimer</button>
                    <div class="tat-disclaimer-full" id="tat-disclaimer-full">
                        <strong>What's stored:</strong> Your encrypted API key, Torn ID, name, faction, and your watchlist.<br><br>
                        <strong>What's collected globally:</strong> Anonymous activity observations (online/idle/offline status)
                        of all polled faction members. This data is shared across all users to build the activity heatmap.<br><br>
                        <strong>Removal:</strong> Go to Settings &rarr; click "Remove my account". Your encrypted key and
                        personal data are deleted immediately. Shared activity observations are retained.<br><br>
                        <strong>Terms:</strong> Torn's API Terms of Service apply. This tool is not affiliated with Torn.<br><br>
                        <strong>Contact:</strong> Any Torn player may request removal of their activity data by contacting
                        the developer.
                    </div>
                </div>
            </div>
        `;

        const input = document.getElementById("tat-key-input");
        const btn = document.getElementById("tat-auth-submit");
        const errEl = document.getElementById("tat-auth-error");

        btn.addEventListener("click", () => doRegister(input, btn, errEl));
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") doRegister(input, btn, errEl);
        });

        document.getElementById("tat-disclaimer-more").addEventListener("click", () => {
            const full = document.getElementById("tat-disclaimer-full");
            const toggle = document.getElementById("tat-disclaimer-more");
            const visible = full.style.display === "block";
            full.style.display = visible ? "none" : "block";
            toggle.textContent = visible ? "Read full disclaimer" : "Hide full disclaimer";
        });
    }

    async function doRegister(input, btn, errEl) {
        const key = input.value.trim();
        if (!key || key.length < 10) {
            errEl.textContent = "API key must be at least 10 characters.";
            return;
        }
        btn.disabled = true;
        btn.textContent = "Connecting...";
        errEl.textContent = "";
        try {
            await register(key);
            renderTabs();
            renderContent();
        } catch (err) {
            errEl.textContent = err.message || err.error || `Registration failed (${err.status})`;
            btn.disabled = false;
            btn.textContent = "Connect";
        }
    }

    // ── Empty tab placeholders (v0.5+) ──────────────────────────

    function emptyTabHTML(icon, title, subtitle) {
        return `
            <div class="tat-empty">
                ${icon}
                <div style="font-size:16px;color:#ccc;margin-bottom:4px">${title}</div>
                <div>${subtitle}</div>
            </div>
        `;
    }

    const clockSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`;
    const chartSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>`;
    const usersSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

    // ── CSV export utility ────────────────────────────────────

    function downloadCSV(filename, headers, rows) {
        const escape = (v) => {
            const s = String(v ?? "");
            return s.includes(",") || s.includes('"') || s.includes("\n")
                ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const lines = [headers.map(escape).join(",")];
        for (const row of rows) lines.push(row.map(escape).join(","));
        const blob = new Blob([lines.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
    }

    // Store last-fetched data for CSV export
    let lastHourlyData = null;
    let lastHourlyFaction = null;

    async function renderHourGrid(el) {
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo) || {};
        const factionId = userInfo.faction_id;
        if (!factionId) {
            el.innerHTML = emptyTabHTML(clockSVG, "No faction", "You must be in a faction to view activity data.");
            return;
        }

        const includeIdleInit = GM_getValue(STORAGE_KEYS.hourGridIncludeIdle, false) ? "checked" : "";
        el.innerHTML = `
            <div class="tat-grid-controls">
                <label>Faction:</label>
                <select id="tat-grid-faction">
                    <option value="${factionId}">My faction (${factionId})</option>
                </select>
                <label>Days:</label>
                <select id="tat-grid-days">
                    <option value="3">3</option>
                    <option value="7" selected>7</option>
                    <option value="14">14</option>
                    <option value="30">30</option>
                </select>
                <label style="margin-left:8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" title="Include idle members in the heatmap percentage">
                    <input type="checkbox" id="tat-grid-include-idle" ${includeIdleInit}>
                    Include idle
                </label>
            </div>
            <div class="tat-legend">
                <span>Activity:</span>
                <span class="tat-legend-box" style="background:#1a1a2e"></span> 0%
                <span class="tat-legend-box" style="background:#1a3a2e"></span> 25%
                <span class="tat-legend-box" style="background:#2e7d32"></span> 50%
                <span class="tat-legend-box" style="background:#4caf50"></span> 75%
                <span class="tat-legend-box" style="background:#69f0ae"></span> 100%
                <span style="margin-left:12px;color:#666">All times TCT (UTC)</span>
                <button class="tat-btn tat-btn-export" id="tat-export-hourly" style="margin-left:auto" disabled>Export CSV</button>
            </div>
            <div id="tat-grid-container" class="tat-grid-wrap"><div class="tat-status">Loading activity data...</div></div>
        `;

        // Populate watchlist factions into dropdown
        try {
            const watchlist = await fetchWatchlistCached();
            const sel = document.getElementById("tat-grid-faction");
            for (const f of watchlist) {
                const opt = document.createElement("option");
                opt.value = f.faction_id;
                opt.textContent = `${f.name || "Faction"} (${f.faction_id})`;
                sel.appendChild(opt);
            }
        } catch { /* ignore */ }

        const loadGrid = () => {
            const selFaction = Number(document.getElementById("tat-grid-faction").value);
            const selDays = Number(document.getElementById("tat-grid-days").value);
            fetchAndRenderGrid(selFaction, selDays);
        };

        document.getElementById("tat-grid-faction").addEventListener("change", loadGrid);
        document.getElementById("tat-grid-days").addEventListener("change", loadGrid);
        document.getElementById("tat-grid-include-idle").addEventListener("change", (e) => {
            GM_setValue(STORAGE_KEYS.hourGridIncludeIdle, e.target.checked);
            if (lastHourlyData) renderHourlyGrid(lastHourlyData);
        });
        document.getElementById("tat-export-hourly").addEventListener("click", () => {
            if (!lastHourlyData || lastHourlyData.length === 0) return;
            const headers = ["date_utc", "hour_utc", "total_members", "online", "idle", "offline", "pct_online", "pct_online_or_idle"];
            const rows = lastHourlyData.map((r) => {
                const d = new Date(r.hour);
                const total = r.total_members;
                const pctOnlineOrIdle = total > 0 ? Math.round(((r.online + r.idle) / total) * 100) : 0;
                return [
                    d.toISOString().slice(0, 10),
                    d.getUTCHours(),
                    total, r.online, r.idle,
                    total - r.online - r.idle,
                    r.pct_online,
                    pctOnlineOrIdle,
                ];
            });
            downloadCSV(`activity-hourly-${lastHourlyFaction}.csv`, headers, rows);
        });
        loadGrid();
    }

    async function fetchAndRenderGrid(factionId, days) {
        const container = document.getElementById("tat-grid-container");
        const exportBtn = document.getElementById("tat-export-hourly");
        if (!container) return;
        container.innerHTML = `<div class="tat-status">Loading...</div>`;
        if (exportBtn) exportBtn.disabled = true;
        lastHourlyData = null;
        lastHourlyFaction = factionId;

        let data;
        try {
            data = await backendRequest("GET", `/v1/activity/hourly?faction=${factionId}&days=${days}`);
        } catch (err) {
            container.innerHTML = `<div class="tat-status" style="color:#ef5350">Failed to load: ${err.error || err.status}</div>`;
            return;
        }

        if (!data || data.length === 0) {
            container.innerHTML = `<div class="tat-status">No activity data yet. The tracker polls every 30 minutes — check back soon.</div>`;
            return;
        }

        lastHourlyData = data;
        if (exportBtn) exportBtn.disabled = false;
        renderHourlyGrid(data);
    }

    function renderHourlyGrid(data) {
        const container = document.getElementById("tat-grid-container");
        if (!container) return;
        const includeIdle = !!document.getElementById("tat-grid-include-idle")?.checked;

        // Group data by date (YYYY-MM-DD) → hour (0-23)
        const byDay = new Map();
        for (const row of data) {
            const d = new Date(row.hour);
            const dateKey = d.toISOString().slice(0, 10);
            const hour = d.getUTCHours();
            if (!byDay.has(dateKey)) byDay.set(dateKey, new Array(24).fill(null));
            byDay.get(dateKey)[hour] = row;
        }

        // Sort dates descending (newest first)
        const sortedDays = [...byDay.keys()].sort().reverse();

        // Build table
        let html = `<table class="tat-grid"><thead><tr><th></th>`;
        for (let h = 0; h < 24; h++) html += `<th>${String(h).padStart(2, "0")}</th>`;
        html += `</tr></thead><tbody>`;

        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        for (const dateKey of sortedDays) {
            const dow = dayNames[new Date(dateKey + "T00:00:00Z").getUTCDay()];
            html += `<tr><td class="tat-day-label">${dow} ${dateKey.slice(5)}</td>`;
            const hours = byDay.get(dateKey);
            for (let h = 0; h < 24; h++) {
                const row = hours[h];
                if (!row) {
                    html += `<td class="tat-cell" style="background:#111;color:#444">-</td>`;
                } else {
                    const total = row.total_members;
                    const pct = includeIdle
                        ? (total > 0 ? Math.round(((row.online + row.idle) / total) * 100) : 0)
                        : row.pct_online;
                    const bg = heatColor(pct);
                    const textColor = pct > 50 ? "#111" : "#ddd";
                    const title = includeIdle
                        ? `${pct}% online+idle (${row.online} online + ${row.idle} idle / ${total})`
                        : `${pct}% online (${row.online}/${total})`;
                    html += `<td class="tat-cell" style="background:${bg};color:${textColor}" title="${title}">${pct}</td>`;
                }
            }
            html += `</tr>`;
        }

        html += `</tbody></table>`;
        container.innerHTML = html;
    }

    function heatColor(pct) {
        if (pct <= 0) return "#1a1a2e";
        if (pct <= 15) return "#1a2a2e";
        if (pct <= 30) return "#1a3a2e";
        if (pct <= 45) return "#1e5e2e";
        if (pct <= 60) return "#2e7d32";
        if (pct <= 75) return "#4caf50";
        if (pct <= 90) return "#69f0ae";
        return "#a5d6a7";
    }

    let lastSummaryData = null;
    let lastSummaryDataOpp = null;
    let lastSummaryFaction = null;
    let lastSummaryFactionOpp = null;
    let lastSummaryFactionLabel = null;
    let lastSummaryFactionOppLabel = null;
    let lastSummaryDays = null;

    async function renderWeekdayAvg(el) {
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo) || {};
        const factionId = userInfo.faction_id;
        if (!factionId) {
            el.innerHTML = emptyTabHTML(chartSVG, "No faction", "You must be in a faction to view activity data.");
            return;
        }

        const includeIdleInit = GM_getValue(STORAGE_KEYS.summaryIncludeIdle, false) ? "checked" : "";
        el.innerHTML = `
            <div class="tat-grid-controls">
                <label>My faction:</label>
                <select id="tat-summary-faction">
                    <option value="${factionId}">My faction (${factionId})</option>
                </select>
                <label style="font-weight:700;color:#666">vs</label>
                <select id="tat-summary-faction-opp">
                    <option value="">(none)</option>
                </select>
                <label>Days:</label>
                <select id="tat-summary-days">
                    <option value="7">7</option>
                    <option value="14" selected>14</option>
                    <option value="30">30</option>
                </select>
                <label style="margin-left:8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" title="Include idle members in the average percentage">
                    <input type="checkbox" id="tat-summary-include-idle" ${includeIdleInit}>
                    Include idle
                </label>
                <button class="tat-btn tat-btn-export" id="tat-export-summary" style="margin-left:auto" disabled>Export CSV</button>
            </div>
            <div id="tat-summary-container" class="tat-status">Loading...</div>
        `;

        try {
            const watchlist = await fetchWatchlistCached();
            const sel = document.getElementById("tat-summary-faction");
            const selOpp = document.getElementById("tat-summary-faction-opp");
            for (const f of watchlist) {
                const tag = f.source === "war" ? "[WAR] " : "";
                const label = `${tag}${f.name || "Faction"} (${f.faction_id})`;
                const optA = document.createElement("option");
                optA.value = f.faction_id;
                optA.textContent = label;
                sel.appendChild(optA);
                const optB = document.createElement("option");
                optB.value = f.faction_id;
                optB.textContent = label;
                selOpp.appendChild(optB);
            }
        } catch { /* ignore */ }

        const labelOf = (selectEl) => {
            const opt = selectEl.options[selectEl.selectedIndex];
            return opt ? opt.textContent : "";
        };

        const load = () => {
            const factionSel = document.getElementById("tat-summary-faction");
            const oppSel = document.getElementById("tat-summary-faction-opp");
            const f = Number(factionSel.value);
            const opp = oppSel.value ? Number(oppSel.value) : null;
            const d = Number(document.getElementById("tat-summary-days").value);
            fetchAndRenderSummary(f, opp, d, labelOf(factionSel), opp ? labelOf(oppSel) : null);
        };

        document.getElementById("tat-summary-faction").addEventListener("change", load);
        document.getElementById("tat-summary-faction-opp").addEventListener("change", load);
        document.getElementById("tat-summary-days").addEventListener("change", load);
        document.getElementById("tat-summary-include-idle").addEventListener("change", (e) => {
            GM_setValue(STORAGE_KEYS.summaryIncludeIdle, e.target.checked);
            if (lastSummaryData) renderWeekdaySummary();
        });
        document.getElementById("tat-export-summary").addEventListener("click", () => {
            if (!lastSummaryData || lastSummaryData.length === 0) return;
            const headers = ["faction", "hour_of_day_utc", "avg_pct_online", "avg_pct_online_or_idle", "days_sampled", "total_observations"];
            const rows = [];
            for (const r of lastSummaryData) {
                rows.push([lastSummaryFaction, r.hour_of_day, r.avg_pct_online, r.avg_pct_online_or_idle ?? "", r.days_sampled, r.total_observations]);
            }
            if (lastSummaryDataOpp) {
                for (const r of lastSummaryDataOpp) {
                    rows.push([lastSummaryFactionOpp, r.hour_of_day, r.avg_pct_online, r.avg_pct_online_or_idle ?? "", r.days_sampled, r.total_observations]);
                }
            }
            const suffix = lastSummaryFactionOpp ? `-vs-${lastSummaryFactionOpp}` : "";
            downloadCSV(`activity-summary-${lastSummaryFaction}${suffix}.csv`, headers, rows);
        });
        load();
    }

    async function fetchAndRenderSummary(factionId, oppId, days, factionLabel, oppLabel) {
        const container = document.getElementById("tat-summary-container");
        const exportBtn = document.getElementById("tat-export-summary");
        if (!container) return;
        container.innerHTML = `Loading...`;
        if (exportBtn) exportBtn.disabled = true;
        lastSummaryData = null;
        lastSummaryDataOpp = null;
        lastSummaryFaction = factionId;
        lastSummaryFactionOpp = oppId;
        lastSummaryFactionLabel = factionLabel;
        lastSummaryFactionOppLabel = oppLabel;
        lastSummaryDays = days;

        let data, oppData = null;
        try {
            if (oppId) {
                [data, oppData] = await Promise.all([
                    backendRequest("GET", `/v1/activity/summary?faction=${factionId}&days=${days}`),
                    backendRequest("GET", `/v1/activity/summary?faction=${oppId}&days=${days}`),
                ]);
            } else {
                data = await backendRequest("GET", `/v1/activity/summary?faction=${factionId}&days=${days}`);
            }
        } catch (err) {
            container.innerHTML = `<span style="color:#ef5350">Failed to load: ${err.error || err.status}</span>`;
            return;
        }

        if (!data || data.length === 0) {
            container.innerHTML = `No summary data yet. Check back after a few hours of tracking.`;
            return;
        }

        lastSummaryData = data;
        lastSummaryDataOpp = oppData && oppData.length ? oppData : null;
        if (exportBtn) exportBtn.disabled = false;
        renderWeekdaySummary();
    }

    function renderWeekdaySummary() {
        const container = document.getElementById("tat-summary-container");
        if (!container) return;
        const data = lastSummaryData;
        const oppData = lastSummaryDataOpp;
        const days = lastSummaryDays;
        if (!data) return;

        const includeIdleRequested = !!document.getElementById("tat-summary-include-idle")?.checked;
        // Graceful fallback: old backends don't return avg_pct_online_or_idle.
        const combined = oppData ? [...data, ...oppData] : data;
        const hasIdleField = combined.some((r) => typeof r.avg_pct_online_or_idle === "number");
        const includeIdle = includeIdleRequested && hasIdleField;
        const pctOf = (row) => {
            if (!row) return 0;
            return includeIdle ? (row.avg_pct_online_or_idle ?? row.avg_pct_online) : row.avg_pct_online;
        };
        const labelSuffix = includeIdle ? "online + idle" : "online";

        // Shared Y-axis scale across both charts so they're directly comparable.
        const maxPct = Math.max(...combined.map((r) => pctOf(r)), 1);

        const chartHTML = (dataset, title, titleColor) => {
            let out = `<div style="color:${titleColor};font-size:12px;font-weight:700;margin-top:12px;margin-bottom:4px">${title}</div>`;
            out += `<div style="display:flex;align-items:flex-end;gap:2px;height:180px;margin:0;padding-bottom:24px;position:relative">`;
            for (let h = 0; h < 24; h++) {
                const row = dataset.find((r) => r.hour_of_day === h);
                const pct = pctOf(row);
                const barH = Math.max((pct / maxPct) * 150, 2);
                const bg = heatColor(pct);
                out += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
                    <div style="font-size:10px;color:#aaa;margin-bottom:2px">${pct}%</div>
                    <div style="width:100%;height:${barH}px;background:${bg};border-radius:2px 2px 0 0" title="${String(h).padStart(2,'0')}:00 — ${pct}% avg ${labelSuffix}"></div>
                    <div style="font-size:10px;color:#666;margin-top:4px;position:absolute;bottom:0">${String(h).padStart(2,'0')}</div>
                </div>`;
            }
            out += `</div>`;
            return out;
        };

        // Both charts share one horizontal-scroll container so they slide in sync on narrow screens.
        const myTitle = lastSummaryFactionLabel || `Faction ${lastSummaryFaction}`;
        let inner = chartHTML(data, myTitle, "#4fc3f7");
        if (oppData) {
            const oppTitle = lastSummaryFactionOppLabel || `Faction ${lastSummaryFactionOpp}`;
            inner += chartHTML(oppData, oppTitle, "#ef5350");
        }
        let html = `<div class="tat-chart-wrap"><div style="min-width:480px">${inner}</div></div>`;

        const stale = includeIdleRequested && !hasIdleField
            ? ` <span style="color:#cc3333">(backend hasn't been updated yet — showing online only)</span>`
            : "";
        html += `<div style="color:#666;font-size:12px;text-align:center;margin-top:4px">Hour of day (TCT/UTC) — average % ${labelSuffix} over ${days} days${stale}</div>`;
        container.innerHTML = html;
    }

    // ── Compare tab ─────────────────────────────────────────────

    const parseBS = (s) => {
        if (!s) return 0;
        const m = s.match(/([\d.]+)([kmbt]?)/i);
        if (!m) return 0;
        const v = parseFloat(m[1]);
        const u = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]?.toLowerCase()] || 1;
        return v * u;
    };

    /**
     * Render both faction tables side-by-side in a single scroll container.
     * Shared sort state, synced by design (one DOM structure).
     */
    function renderCompareTables(leftData, rightData, container, leftBsMap, rightBsMap) {
        if (!container) return;

        const hasRight = Array.isArray(rightData);
        let sortCol = container._sortCol || "pct_online";
        let sortDir = container._sortDir ?? -1;

        function sortData(data, bsMap) {
            return [...data].sort((a, b) => {
                let va = a[sortCol], vb = b[sortCol];
                if (sortCol === "bs") {
                    va = parseBS(bsMap.get(a.user_id)?.bs);
                    vb = parseBS(bsMap.get(b.user_id)?.bs);
                }
                if (typeof va === "string") va = (va || "").toLowerCase();
                if (typeof vb === "string") vb = (vb || "").toLowerCase();
                return va < vb ? -1 * sortDir : va > vb ? 1 * sortDir : 0;
            });
        }

        const ALL_COLS = {
            bs: { key: "bs", label: "BS" },
            hours_online: { key: "hours_online", label: "On" },
            pct_online: { key: "pct_online", label: "%" },
        };

        function render() {
            const lbs = leftBsMap || new Map();
            const rbs = rightBsMap || new Map();
            const hasBs = lbs.size > 0 || (hasRight && rbs.size > 0);
            const sortedL = sortData(leftData, lbs);
            const sortedR = hasRight ? sortData(rightData, rbs) : [];
            const maxRows = Math.max(sortedL.length, sortedR.length);

            const isMobile = window.innerWidth <= 768;
            let mobileCol = GM_getValue(STORAGE_KEYS.compareMobileCol) || (hasBs ? "bs" : "pct_online");
            if (mobileCol === "bs" && !hasBs) mobileCol = "pct_online";

            const cols = [{ key: "name", label: "Name", align: "left" }];
            if (isMobile) {
                cols.push(ALL_COLS[mobileCol]);
            } else {
                if (hasBs) cols.push(ALL_COLS.bs);
                cols.push(ALL_COLS.hours_online);
                cols.push(ALL_COLS.pct_online);
            }

            // Keep the sort column in sync with what's visible on mobile
            if (isMobile && sortCol !== "name" && sortCol !== mobileCol) sortCol = mobileCol;

            function thRow(side) {
                let h = "";
                for (const c of cols) {
                    const cls = c.key === sortCol ? (sortDir === 1 ? " sort-asc" : " sort-desc") : "";
                    h += `<th data-col="${c.key}" data-side="${side}" class="${cls}" style="${c.align ? "text-align:" + c.align : ""}">${c.label}</th>`;
                }
                return h;
            }

            function cellFor(m, bsMap, key, bgStyle, side) {
                if (key === "name") {
                    return `<td style="${bgStyle}text-align:left;color:#ccc;max-width:120px;overflow:hidden;text-overflow:ellipsis" class="tat-cmp-name" data-uid="${m.user_id}" data-name="${m.name || m.user_id}" data-side="${side}">${m.name || m.user_id}</td>`;
                }
                if (key === "bs") {
                    const bs = bsMap.get(m.user_id);
                    return `<td style="${bgStyle}color:#ffb74d;font-size:11px">${bs?.bs || "—"}</td>`;
                }
                if (key === "hours_online") {
                    return `<td style="${bgStyle}">${m.hours_online}h</td>`;
                }
                if (key === "pct_online") {
                    return `<td style="${bgStyle}color:${m.pct_online > 50 ? "#4caf50" : "#ccc"}">${m.pct_online}%</td>`;
                }
                return `<td style="${bgStyle}"></td>`;
            }

            function memberCells(m, bsMap, side, selected) {
                if (!m) return `<td colspan="${cols.length}"></td>`;
                const bg = selected === m.user_id ? (side === "left" ? "#1a4a5a" : "#5a1a2a") : "";
                const bgStyle = bg ? `background:${bg};` : "";
                return cols.map((c) => cellFor(m, bsMap, c.key, bgStyle, side)).join("");
            }

            const selL = container._selLeft;
            const selR = container._selRight;

            let html;
            if (hasRight) {
                html = `<div style="overflow-y:auto;max-height:280px">
                    <table class="tat-grid" style="font-size:12px;table-layout:fixed">
                    <thead><tr>
                        ${thRow("left")}
                        <th style="width:8px;background:#1a1a1a;border-left:2px solid #444;border-right:2px solid #444;padding:0"></th>
                        ${thRow("right")}
                    </tr></thead><tbody>`;
                for (let i = 0; i < maxRows; i++) {
                    html += `<tr style="cursor:pointer">
                        ${memberCells(sortedL[i], lbs, "left", selL)}
                        <td style="background:#1a1a1a;border-left:2px solid #333;border-right:2px solid #333;padding:0"></td>
                        ${memberCells(sortedR[i], rbs, "right", selR)}
                    </tr>`;
                }
                html += `</tbody></table></div>`;
            } else {
                html = `<div style="overflow-y:auto;max-height:280px">
                    <table class="tat-grid" style="font-size:12px;table-layout:fixed">
                    <thead><tr>${thRow("left")}</tr></thead><tbody>`;
                for (let i = 0; i < sortedL.length; i++) {
                    html += `<tr style="cursor:pointer">${memberCells(sortedL[i], lbs, "left", selL)}</tr>`;
                }
                html += `</tbody></table></div>`;
            }
            container.innerHTML = html;

            // Sort click — any header sorts both sides
            container.querySelectorAll("th[data-col]").forEach((th) => {
                th.addEventListener("click", () => {
                    const col = th.dataset.col;
                    if (sortCol === col) sortDir *= -1;
                    else { sortCol = col; sortDir = col === "name" ? 1 : -1; }
                    container._sortCol = sortCol;
                    container._sortDir = sortDir;
                    render();
                });
            });
        }

        container._render = render;
        container._setBS = (lbs, rbs) => { leftBsMap = lbs; rightBsMap = rbs; render(); };
        render();
    }

    async function renderCompare(el) {
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo) || {};
        const factionId = userInfo.faction_id;
        if (!factionId) {
            el.innerHTML = emptyTabHTML(usersSVG, "No faction", "You must be in a faction to compare.");
            return;
        }

        el.innerHTML = `
            <div class="tat-grid-controls">
                <label>My faction:</label>
                <select id="tat-cmp-left"><option value="${factionId}">My faction (${factionId})</option></select>
                <label style="font-weight:700;color:#666">vs</label>
                <select id="tat-cmp-right"><option value="">Select opponent...</option></select>
                <label>Days:</label>
                <select id="tat-cmp-days">
                    <option value="3">3</option>
                    <option value="7" selected>7</option>
                    <option value="14">14</option>
                    <option value="30">30</option>
                </select>
                <button class="tat-btn tat-btn-export" id="tat-export-compare" style="margin-left:auto" disabled>Export CSV</button>
            </div>
            <div id="tat-compare-container"><div class="tat-status">Select an opponent faction to compare.</div></div>
            <div id="tat-user-compare" style="display:none"></div>
        `;

        // Populate dropdowns from watchlist only (war opponents are auto-added to watchlist)
        try {
            const watchlist = await fetchWatchlistCached();
            const leftSel = document.getElementById("tat-cmp-left");
            const rightSel = document.getElementById("tat-cmp-right");
            for (const f of watchlist) {
                const tag = f.source === "war" ? "[WAR] " : "";
                for (const sel of [leftSel, rightSel]) {
                    const opt = document.createElement("option");
                    opt.value = f.faction_id;
                    opt.textContent = `${tag}${f.name || "Faction"} (${f.faction_id})`;
                    sel.appendChild(opt);
                }
            }
        } catch { /* ignore */ }

        let compareData = null;

        const load = () => {
            const left = Number(document.getElementById("tat-cmp-left").value);
            const rightRaw = Number(document.getElementById("tat-cmp-right").value);
            const right = rightRaw || null;
            const days = Number(document.getElementById("tat-cmp-days").value);
            fetchAndRenderCompare(left, right, days);
        };

        document.getElementById("tat-cmp-left").addEventListener("change", load);
        document.getElementById("tat-cmp-right").addEventListener("change", load);
        document.getElementById("tat-cmp-days").addEventListener("change", load);
        document.getElementById("tat-export-compare").addEventListener("click", () => {
            if (!compareData) return;
            const headers = ["faction", "user_id", "name", "position", "hours_online", "hours_idle", "hours_observed", "pct_online"];
            const rows = [];
            for (const m of compareData.left) rows.push(["my", m.user_id, m.name, m.position, m.hours_online, m.hours_idle, m.hours_observed, m.pct_online]);
            for (const m of compareData.right) rows.push(["opponent", m.user_id, m.name, m.position, m.hours_online, m.hours_idle, m.hours_observed, m.pct_online]);
            downloadCSV("activity-compare.csv", headers, rows);
        });

        async function fetchAndRenderCompare(leftId, rightId, days) {
            const container = document.getElementById("tat-compare-container");
            const exportBtn = document.getElementById("tat-export-compare");
            container.innerHTML = `<div class="tat-status">${rightId ? "Loading both factions..." : "Loading your faction..."}</div>`;
            if (exportBtn) exportBtn.disabled = true;
            compareData = null;
            document.getElementById("tat-user-compare").style.display = "none";

            let leftData, rightData;
            try {
                if (rightId) {
                    [leftData, rightData] = await Promise.all([
                        backendRequest("GET", `/v1/activity/members?faction=${leftId}&days=${days}`),
                        backendRequest("GET", `/v1/activity/members?faction=${rightId}&days=${days}`),
                    ]);
                } else {
                    leftData = await backendRequest("GET", `/v1/activity/members?faction=${leftId}&days=${days}`);
                    rightData = null;
                }
            } catch (err) {
                container.innerHTML = `<div class="tat-status" style="color:#ef5350">Failed: ${err.error || err.status}</div>`;
                return;
            }

            compareData = { left: leftData || [], right: rightData || [] };
            if (exportBtn) exportBtn.disabled = false;

            const lOnline = leftData.reduce((s, m) => s + m.hours_online, 0);
            const lAvgPct = leftData.length ? Math.round(leftData.reduce((s, m) => s + m.pct_online, 0) / leftData.length) : 0;

            let summaryHTML, hintHTML;
            if (rightData) {
                const rOnline = rightData.reduce((s, m) => s + m.hours_online, 0);
                const rAvgPct = rightData.length ? Math.round(rightData.reduce((s, m) => s + m.pct_online, 0) / rightData.length) : 0;
                summaryHTML = `
                    <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;margin-bottom:16px;text-align:center">
                        <div style="background:#252525;border:1px solid #333;border-radius:8px;padding:12px">
                            <div style="color:#4fc3f7;font-size:24px;font-weight:700">${lAvgPct}%</div>
                            <div style="color:#aaa;font-size:12px;margin-top:2px">${leftData.length} members &middot; ${lOnline}h total</div>
                        </div>
                        <div style="display:flex;align-items:center;color:#555;font-size:18px;font-weight:700">vs</div>
                        <div style="background:#252525;border:1px solid #333;border-radius:8px;padding:12px">
                            <div style="color:#ef5350;font-size:24px;font-weight:700">${rAvgPct}%</div>
                            <div style="color:#aaa;font-size:12px;margin-top:2px">${rightData.length} members &middot; ${rOnline}h total</div>
                        </div>
                    </div>`;
                hintHTML = `<div style="color:#888;font-size:12px;margin-bottom:12px">Click a member name to view their heatmap. Select one from each side to compare.</div>`;
            } else {
                summaryHTML = `
                    <div style="margin-bottom:16px;text-align:center">
                        <div style="background:#252525;border:1px solid #333;border-radius:8px;padding:12px;display:inline-block;min-width:220px">
                            <div style="color:#4fc3f7;font-size:24px;font-weight:700">${lAvgPct}%</div>
                            <div style="color:#aaa;font-size:12px;margin-top:2px">${leftData.length} members &middot; ${lOnline}h total</div>
                        </div>
                    </div>`;
                hintHTML = `<div style="color:#888;font-size:12px;margin-bottom:12px">Click a member name to view their heatmap. Select an opponent above to compare factions side-by-side.</div>`;
            }

            const currentMobileCol = GM_getValue(STORAGE_KEYS.compareMobileCol)
                || (GM_getValue(STORAGE_KEYS.ffscouterKey) ? "bs" : "pct_online");
            const mobileColPickerHTML = `
                <div class="tat-mobile-col-picker">
                    <label>Show: Name +</label>
                    <select id="tat-cmp-mobile-col">
                        <option value="bs"${currentMobileCol === "bs" ? " selected" : ""}>BS</option>
                        <option value="hours_online"${currentMobileCol === "hours_online" ? " selected" : ""}>Online hours</option>
                        <option value="pct_online"${currentMobileCol === "pct_online" ? " selected" : ""}>Online %</option>
                    </select>
                </div>`;

            container.innerHTML = `${summaryHTML}${hintHTML}${mobileColPickerHTML}<div id="tat-cmp-tables"></div>`;

            const tablesContainer = document.getElementById("tat-cmp-tables");
            renderCompareTables(leftData, rightData, tablesContainer, null, null);

            const mobileColSel = document.getElementById("tat-cmp-mobile-col");
            if (mobileColSel) {
                mobileColSel.addEventListener("change", () => {
                    GM_setValue(STORAGE_KEYS.compareMobileCol, mobileColSel.value);
                    if (tablesContainer._render) tablesContainer._render();
                });
            }

            // Fetch battle stats from FFScouter (if key set)
            if (GM_getValue(STORAGE_KEYS.ffscouterKey)) {
                const allIds = rightData
                    ? [...leftData.map((m) => m.user_id), ...rightData.map((m) => m.user_id)]
                    : leftData.map((m) => m.user_id);
                fetchBattleStats(allIds).then((bsMap) => {
                    if (bsMap.size === 0) return;
                    const leftBs = new Map(), rightBs = new Map();
                    for (const m of leftData) { const v = bsMap.get(m.user_id); if (v) leftBs.set(m.user_id, v); }
                    if (rightData) {
                        for (const m of rightData) { const v = bsMap.get(m.user_id); if (v) rightBs.set(m.user_id, v); }
                    }
                    if (tablesContainer._setBS) tablesContainer._setBS(leftBs, rightBs);
                });
            }

            // Per-user heatmap on name click — renders instantly for one side, compares when both selected
            let selectedLeft = null, selectedRight = null;

            tablesContainer.addEventListener("click", (e) => {
                const nameCell = e.target.closest(".tat-cmp-name");
                if (!nameCell) return;
                const uid = Number(nameCell.dataset.uid);
                const name = nameCell.dataset.name;
                const side = nameCell.dataset.side;

                if (side === "left") {
                    selectedLeft = { uid, name };
                    tablesContainer._selLeft = uid;
                } else {
                    selectedRight = { uid, name };
                    tablesContainer._selRight = uid;
                }
                if (tablesContainer._render) tablesContainer._render();
                if (selectedLeft || selectedRight) loadUserCompare(selectedLeft, selectedRight, days);
            });
        }

        load();
    }

    async function loadUserCompare(leftUser, rightUser, days) {
        const container = document.getElementById("tat-user-compare");
        container.style.display = "block";

        const both = leftUser && rightUser;
        const loadingLabel = both
            ? `${leftUser.name} vs ${rightUser.name}`
            : (leftUser || rightUser).name;
        container.innerHTML = `<div class="tat-status" style="margin-top:16px">Loading heatmap${both ? "s" : ""} for ${loadingLabel}...</div>`;

        let leftHours = null, rightHours = null;
        try {
            const jobs = [];
            if (leftUser) jobs.push(backendRequest("GET", `/v1/activity/user-hourly?user=${leftUser.uid}&days=${days}`).then((r) => { leftHours = r; }));
            if (rightUser) jobs.push(backendRequest("GET", `/v1/activity/user-hourly?user=${rightUser.uid}&days=${days}`).then((r) => { rightHours = r; }));
            await Promise.all(jobs);
        } catch (err) {
            container.innerHTML = `<div class="tat-status" style="color:#ef5350;margin-top:16px">Failed to load user data.</div>`;
            return;
        }

        const allDates = new Set();
        const buildMap = (data) => {
            const m = new Map();
            for (const row of data) {
                const d = new Date(row.hour);
                const dateKey = d.toISOString().slice(0, 10);
                const hour = d.getUTCHours();
                allDates.add(dateKey);
                if (!m.has(dateKey)) m.set(dateKey, new Array(24).fill(null));
                m.get(dateKey)[hour] = row;
            }
            return m;
        };

        const leftMap = leftHours ? buildMap(leftHours) : null;
        const rightMap = rightHours ? buildMap(rightHours) : null;
        const sortedDates = [...allDates].sort().reverse();
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        function userHeatmapHTML(name, color, dataMap) {
            let html = `<div style="margin-bottom:4px"><span style="color:${color};font-weight:600">${name}</span></div>`;
            html += `<table class="tat-grid" style="font-size:11px"><thead><tr><th></th>`;
            for (let h = 0; h < 24; h++) html += `<th>${String(h).padStart(2, "0")}</th>`;
            html += `</tr></thead><tbody>`;

            for (const dateKey of sortedDates) {
                const dow = dayNames[new Date(dateKey + "T00:00:00Z").getUTCDay()];
                html += `<tr><td class="tat-day-label">${dow} ${dateKey.slice(5)}</td>`;
                const hours = dataMap.get(dateKey) || new Array(24).fill(null);
                for (let h = 0; h < 24; h++) {
                    const row = hours[h];
                    if (!row) {
                        html += `<td class="tat-cell" style="background:#111;color:#444">-</td>`;
                    } else {
                        const status = row.active > 0 ? "ON" : row.idle > 0 ? "idl" : "off";
                        const bg = row.active > 0 ? "#2e7d32" : row.idle > 0 ? "#5d4037" : "#1a1a2e";
                        const fg = row.active > 0 ? "#69f0ae" : row.idle > 0 ? "#ffab91" : "#555";
                        html += `<td class="tat-cell" style="background:${bg};color:${fg}" title="${status}">${status}</td>`;
                    }
                }
                html += `</tr>`;
            }
            html += `</tbody></table>`;
            return html;
        }

        const title = both
            ? `User Comparison: ${leftUser.name} vs ${rightUser.name}`
            : `Activity: ${(leftUser || rightUser).name}`;
        const heatmaps = [
            leftUser ? `<div class="tat-grid-wrap" style="margin-bottom:16px">${userHeatmapHTML(leftUser.name, "#4fc3f7", leftMap)}</div>` : "",
            rightUser ? `<div class="tat-grid-wrap">${userHeatmapHTML(rightUser.name, "#ef5350", rightMap)}</div>` : "",
        ].join("");

        container.innerHTML = `
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid #333">
                <h3 style="color:#fff;font-size:15px;margin:0 0 12px">${title}</h3>
                ${heatmaps}
                <div class="tat-legend" style="margin-top:8px">
                    <span class="tat-legend-box" style="background:#2e7d32"></span> Online
                    <span class="tat-legend-box" style="background:#5d4037"></span> Idle
                    <span class="tat-legend-box" style="background:#1a1a2e"></span> Offline/No data
                    <span style="margin-left:12px;color:#666">All times TCT (UTC)</span>
                </div>
            </div>
        `;
    }

    // ── Settings tab ────────────────────────────────────────────

    function renderSettings(el) {
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo) || {};
        el.innerHTML = `
            <div class="tat-user-badge">
                Logged in as <strong>${userInfo.name || "Unknown"}</strong>
                &nbsp;[${userInfo.torn_user_id || "?"}]
                &nbsp;&middot;&nbsp;Faction ${userInfo.faction_id || "None"}
            </div>

            <div style="margin-top:20px">
                <h3 style="color:#fff;font-size:15px;margin:0 0 8px">Watchlist</h3>
                <p style="color:#aaa;font-size:13px;margin:0 0 12px">
                    Factions on your watchlist appear in the Compare tab. War opponents are added automatically.
                    You can add up to 5 manual factions.
                </p>
                <div id="tat-watchlist" class="tat-status">Loading...</div>

                <div style="margin-top:12px;padding-top:12px;border-top:1px solid #333">
                    <div style="color:#ccc;font-size:13px;margin-bottom:8px">Add faction:</div>
                    <div style="display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap">
                        <div class="tat-combobox" style="flex:1;min-width:200px">
                            <input type="text" id="tat-wl-candidates-search" placeholder="Search candidates by name or ID..." autocomplete="off"
                                style="background:#252525;border:1px solid #444;color:#ddd;padding:6px 8px;border-radius:4px;font-size:13px;width:100%">
                            <div id="tat-wl-candidates-list" class="tat-combobox-list" style="display:none"></div>
                        </div>
                        <button class="tat-btn tat-btn-primary" id="tat-wl-add-candidate" style="padding:6px 14px;font-size:13px">Add</button>
                    </div>
                    <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
                        <input type="number" id="tat-wl-manual-id" placeholder="Or enter faction ID"
                            style="background:#252525;border:1px solid #444;color:#ddd;padding:6px 8px;border-radius:4px;font-size:13px;width:180px">
                        <button class="tat-btn tat-btn-primary" id="tat-wl-add-manual" style="padding:6px 14px;font-size:13px">Add</button>
                    </div>
                    <div id="tat-wl-status" style="min-height:20px;font-size:12px;margin-top:4px"></div>
                </div>
            </div>

            <div id="tat-rate-section" style="display:none;margin-top:24px;padding-top:16px;border-top:1px solid #333">
                <h3 style="color:#fff;font-size:15px;margin:0 0 8px">API Usage</h3>
                <p style="color:#aaa;font-size:13px;margin:0 0 8px">
                    How many Torn API calls per minute the backend can make with your key. Torn allows 100 total across all tools. Lower this if you use many other scripts.
                </p>
                <div style="display:flex;gap:12px;align-items:center">
                    <input type="range" id="tat-rate-limit" min="2" max="50" value="20"
                        style="flex:1;accent-color:#4fc3f7">
                    <span id="tat-rate-limit-val" style="color:#4fc3f7;font-weight:700;font-size:16px;min-width:40px;text-align:right">20</span>
                    <span style="color:#888;font-size:13px">/min</span>
                </div>
                <div id="tat-rate-status" style="min-height:18px;font-size:12px;margin-top:4px"></div>
            </div>

            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #333">
                <h3 style="color:#fff;font-size:15px;margin:0 0 8px">FFScouter Integration</h3>
                <p style="color:#aaa;font-size:13px;margin:0 0 8px">
                    Add your <a href="https://ffscouter.com" target="_blank" style="color:#4fc3f7">FFScouter</a> API key to see estimated battle stats in the Compare tab.
                </p>
                <div style="display:flex;gap:8px;align-items:center">
                    <input type="text" id="tat-ffs-key" placeholder="FFScouter API key" maxlength="16"
                        value="${GM_getValue(STORAGE_KEYS.ffscouterKey) ? "****************" : ""}"
                        style="background:#252525;border:1px solid #444;color:#ddd;padding:6px 8px;border-radius:4px;font-size:13px;width:200px;letter-spacing:1px">
                    <button class="tat-btn tat-btn-primary" id="tat-ffs-save" style="padding:6px 14px;font-size:13px">Save</button>
                    <button class="tat-btn" id="tat-ffs-clear" style="padding:6px 14px;font-size:13px;background:#333">Clear</button>
                </div>
                <div id="tat-ffs-status" style="min-height:18px;font-size:12px;margin-top:4px"></div>
            </div>

            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #333">
                <h3 style="color:#fff;font-size:15px;margin:0 0 8px">Debug</h3>
                <label style="display:flex;align-items:center;gap:8px;color:#aaa;font-size:13px;cursor:pointer">
                    <input type="checkbox" id="tat-debug-toggle" ${GM_getValue(STORAGE_KEYS.debug) ? "checked" : ""}>
                    Enable performance tracking
                </label>
                <div id="tat-perf-log" style="margin-top:8px"></div>
            </div>

            <div style="margin-top:24px;padding-top:16px;border-top:1px solid #333">
                <h3 style="color:#ef5350;font-size:15px;margin:0 0 8px">Danger zone</h3>
                <p style="color:#aaa;font-size:13px;margin:0 0 12px">
                    Remove your account and encrypted API key from the server. Activity data for other players is retained.
                </p>
                <button class="tat-btn tat-btn-danger" id="tat-logout">Remove my account</button>
            </div>
        `;

        // Rate limit slider
        const rateSlider = document.getElementById("tat-rate-limit");
        const rateVal = document.getElementById("tat-rate-limit-val");
        const rateStatus = document.getElementById("tat-rate-status");
        // Load current value — show section only if endpoint succeeds (faction members only)
        backendRequest("GET", "/v1/settings").then((s) => {
            document.getElementById("tat-rate-section").style.display = "block";
            rateSlider.value = s.rate_limit;
            rateVal.textContent = s.rate_limit;
        }).catch(() => {});
        rateSlider.addEventListener("input", () => { rateVal.textContent = rateSlider.value; });
        let rateTimeout = null;
        rateSlider.addEventListener("change", () => {
            clearTimeout(rateTimeout);
            rateStatus.innerHTML = `<span style="color:#aaa">Saving...</span>`;
            rateTimeout = setTimeout(async () => {
                try {
                    await backendRequest("PUT", "/v1/settings/rate-limit", { rate_limit: Number(rateSlider.value) });
                    rateStatus.innerHTML = `<span style="color:#4caf50">Saved!</span>`;
                } catch {
                    rateStatus.innerHTML = `<span style="color:#ef5350">Failed to save.</span>`;
                }
            }, 300);
        });

        // Debug toggle
        document.getElementById("tat-debug-toggle").addEventListener("change", (e) => {
            GM_setValue(STORAGE_KEYS.debug, e.target.checked);
            renderPerfLog();
        });
        renderPerfLog();

        // FFScouter key handlers
        document.getElementById("tat-ffs-key").addEventListener("focus", function () {
            if (this.value === "****************") this.value = "";
        });
        document.getElementById("tat-ffs-key").addEventListener("blur", function () {
            if (!this.value && GM_getValue(STORAGE_KEYS.ffscouterKey)) this.value = "****************";
        });
        document.getElementById("tat-ffs-save").addEventListener("click", async () => {
            const key = document.getElementById("tat-ffs-key").value.trim();
            const statusEl = document.getElementById("tat-ffs-status");
            if (!key || key.length !== 16) {
                statusEl.innerHTML = `<span style="color:#ef5350">Key must be 16 alphanumeric characters.</span>`;
                return;
            }
            statusEl.innerHTML = `<span style="color:#aaa">Validating...</span>`;
            try {
                const res = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: "GET",
                        url: `https://ffscouter.com/api/v1/check-key?key=${encodeURIComponent(key)}`,
                        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch { reject(); } },
                        onerror: reject,
                    });
                });
                if (res.is_registered) {
                    GM_setValue(STORAGE_KEYS.ffscouterKey, key);
                    document.getElementById("tat-ffs-key").value = "****************";
                    statusEl.innerHTML = `<span style="color:#4caf50">Saved! ${res.is_premium ? "Premium" : "Free"} account.</span>`;
                } else {
                    statusEl.innerHTML = `<span style="color:#ef5350">Key not registered with FFScouter. Sign up at ffscouter.com first.</span>`;
                }
            } catch {
                statusEl.innerHTML = `<span style="color:#ef5350">Could not validate key.</span>`;
            }
        });

        document.getElementById("tat-ffs-clear").addEventListener("click", () => {
            GM_deleteValue(STORAGE_KEYS.ffscouterKey);
            document.getElementById("tat-ffs-key").value = "";
            document.getElementById("tat-ffs-status").innerHTML = `<span style="color:#aaa">Cleared.</span>`;
        });

        document.getElementById("tat-logout").addEventListener("click", async () => {
            if (!confirm("Remove your account? Your API key will be deleted from the server.")) return;
            await logout();
            renderTabs();
            renderContent();
        });

        // Combobox search for candidate factions
        selectedCandidateId = null;
        const candSearch = document.getElementById("tat-wl-candidates-search");
        const candList = document.getElementById("tat-wl-candidates-list");
        candSearch.addEventListener("focus", () => { candList.style.display = "block"; renderCandidateList(); });
        candSearch.addEventListener("input", () => {
            candList.style.display = "block";
            selectedCandidateId = null;
            renderCandidateList();
        });
        candSearch.addEventListener("blur", () => { setTimeout(() => { candList.style.display = "none"; }, 200); });
        candList.addEventListener("click", (e) => {
            const item = e.target.closest("[data-fid]");
            if (!item) return;
            selectedCandidateId = Number(item.dataset.fid);
            candSearch.value = item.dataset.label;
            candList.style.display = "none";
        });

        // Add from candidate combobox
        document.getElementById("tat-wl-add-candidate").addEventListener("click", async () => {
            if (!selectedCandidateId) {
                document.getElementById("tat-wl-status").innerHTML = `<span style="color:#ef5350">Pick a candidate from the list first.</span>`;
                return;
            }
            await addToWatchlist(selectedCandidateId);
        });

        // Add manual faction ID
        document.getElementById("tat-wl-add-manual").addEventListener("click", async () => {
            const fid = Number(document.getElementById("tat-wl-manual-id").value);
            if (!fid || fid < 1) {
                document.getElementById("tat-wl-status").innerHTML = `<span style="color:#ef5350">Enter a valid faction ID.</span>`;
                return;
            }
            await addToWatchlist(fid);
        });
        document.getElementById("tat-wl-manual-id").addEventListener("keydown", async (e) => {
            if (e.key === "Enter") document.getElementById("tat-wl-add-manual").click();
        });

        loadWatchlist();
        loadCandidates();
    }

    async function addToWatchlist(factionId) {
        const statusEl = document.getElementById("tat-wl-status");
        statusEl.innerHTML = `<span style="color:#aaa">Adding...</span>`;
        try {
            await backendRequest("POST", "/v1/watchlist", { faction_id: factionId });
            statusEl.innerHTML = `<span style="color:#4caf50">Added!</span>`;
            const manualInput = document.getElementById("tat-wl-manual-id");
            if (manualInput) manualInput.value = "";
            const candSearch = document.getElementById("tat-wl-candidates-search");
            if (candSearch) candSearch.value = "";
            selectedCandidateId = null;
            loadWatchlist();
            loadCandidates();
        } catch (err) {
            statusEl.innerHTML = `<span style="color:#ef5350">${err.message || err.error || "Failed"}</span>`;
        }
    }

    function renderPerfLog() {
        const el = document.getElementById("tat-perf-log");
        if (!el) return;
        if (!GM_getValue(STORAGE_KEYS.debug) || perfLog.length === 0) {
            el.innerHTML = GM_getValue(STORAGE_KEYS.debug)
                ? `<span style="color:#666;font-size:12px">No events yet. Navigate tabs to generate log.</span>`
                : "";
            return;
        }
        const rows = [...perfLog].reverse();
        let html = `<div style="max-height:150px;overflow-y:auto;background:#111;border:1px solid #333;border-radius:4px;padding:6px;font-family:monospace;font-size:11px">`;
        for (const r of rows) {
            const color = r.ms > 500 ? "#ef5350" : r.ms > 200 ? "#ffb74d" : "#4caf50";
            html += `<div style="padding:1px 0"><span style="color:#666">${r.ts}</span> <span style="color:#aaa">${r.label}</span> <span style="color:${color}">${r.ms}ms</span></div>`;
        }
        html += `</div>`;
        el.innerHTML = html;
    }

    let watchlistContainer = null;

    async function loadWatchlist() {
        const container = document.getElementById("tat-watchlist");
        if (!container) return;

        // Re-attach click handler when container element changes (tab re-render)
        if (container !== watchlistContainer) {
            watchlistContainer = container;
            container.addEventListener("click", async (e) => {
                const btn = e.target.closest("[data-remove]");
                if (!btn || btn.disabled) return;
                const fid = btn.dataset.remove;
                btn.disabled = true;
                btn.textContent = "...";
                try {
                    // POST alias for DELETE — see deleteOwnAccount / removeWatchlistEntry
                    // in the backend. Torn PDA rewrites DELETE to GET on some builds.
                    await backendRequest("POST", `/v1/watchlist/${fid}/delete`);
                    await loadWatchlist();
                    loadCandidates();
                } catch {
                    btn.textContent = "Error";
                    btn.disabled = false;
                }
            });
        }

        try {
            const list = await fetchWatchlistCached();
            if (list.length === 0) {
                container.innerHTML = `<span style="color:#666">No factions on your watchlist.</span>`;
            } else {
                container.innerHTML = list.map((f) => {
                    const isWar = f.source === "war";
                    const tag = isWar ? `<span style="color:#ef5350;font-size:11px;margin-left:6px">[WAR]</span>` : "";
                    const removeBtn = isWar
                        ? `<span style="color:#666;font-size:11px">auto</span>`
                        : `<button class="tat-btn tat-btn-danger" style="padding:3px 10px;font-size:11px" data-remove="${f.faction_id}">Remove</button>`;
                    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid #2a2a2a">
                        <span style="font-size:13px">${f.name || "Faction"} [${f.faction_id}]${f.tag ? " " + f.tag : ""}${tag}</span>
                        ${removeBtn}
                    </div>`;
                }).join("");
            }
        } catch {
            container.innerHTML = `<span style="color:#ef5350">Failed to load watchlist.</span>`;
        }
    }

    let candidatesList = [];
    let selectedCandidateId = null;

    async function loadCandidates() {
        const search = document.getElementById("tat-wl-candidates-search");
        if (!search) return;
        try {
            candidatesList = await backendRequest("GET", "/v1/watchlist/candidates") || [];
        } catch {
            candidatesList = [];
        }
        renderCandidateList();
    }

    function renderCandidateList() {
        const list = document.getElementById("tat-wl-candidates-list");
        const search = document.getElementById("tat-wl-candidates-search");
        if (!list || !search) return;
        const q = search.value.trim().toLowerCase();
        const filtered = candidatesList.filter((f) => {
            if (!q) return true;
            const name = (f.name || "").toLowerCase();
            return name.includes(q) || String(f.faction_id).includes(q);
        });
        if (filtered.length === 0) {
            list.innerHTML = `<div style="padding:8px 10px;color:#666;font-size:12px">${candidatesList.length === 0 ? "No candidates available." : "No matches."}</div>`;
            return;
        }
        list.innerHTML = filtered.slice(0, 100).map((f) => {
            const label = `${f.name || "Faction"} (${f.faction_id})`;
            return `<div class="tat-combo-item" data-fid="${f.faction_id}" data-label="${label.replace(/"/g, "&quot;")}">${label}</div>`;
        }).join("");
    }

    // ── Admin tab ────────────────────────────────────────────

    async function renderAdmin(el) {
        el.innerHTML = `<div class="tat-status">Loading system stats...</div>`;

        let stats;
        try {
            stats = await backendRequest("GET", "/v1/admin/stats");
        } catch (err) {
            el.innerHTML = `<div class="tat-status" style="color:#ef5350">Access denied or failed: ${err.error || err.status}</div>`;
            return;
        }

        const s = stats;
        const divLabels = { 0: "Unranked", 1: "Bronze", 2: "Silver", 3: "Gold", 4: "Platinum", 5: "Diamond" };

        el.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
                ${adminCard("Users", `${s.users.active} active / ${s.users.total} total`)}
                ${adminCard("Factions", `${s.factions.alive} alive / ${s.factions.total} total (${s.factions.ranked} ranked)`)}
                ${adminCard("Poll Jobs", `${s.poll_jobs.total} total — ${s.poll_jobs.due_now} due, ${s.poll_jobs.in_flight} in-flight`
                    + `<br><span style="color:#ef5350">Hot: ${s.poll_jobs.hot}</span> · Warm: ${s.poll_jobs.warm} · <span style="color:#666">Cold: ${s.poll_jobs.cold}</span>`)}
                ${adminCard("Wars", `${s.wars.active} active / ${s.wars.total} total`)}
                ${adminCard("Snapshots", `${s.activity_snapshots.total_rows.toLocaleString()} rows · ${s.activity_snapshots.distinct_users.toLocaleString()} users · ${s.activity_snapshots.distinct_factions} factions`
                    + `<br><span style="color:#666">${s.activity_snapshots.oldest || "—"} → ${s.activity_snapshots.newest || "—"}</span>`)}
                ${adminCard("API Calls", `${s.api_calls.total} total · ${s.api_calls.last_hour} last hour · <span style="color:${s.api_calls.errors > 0 ? '#ef5350' : '#4caf50'}">${s.api_calls.errors} errors</span>`)}
                ${adminCard("Members Tracked", `${s.faction_members.toLocaleString()} roster entries`)}
                ${adminCard("Server", `CPU: ${s.server.load_avg.join(" / ")} (${s.server.cpu_count} cores)`
                    + `<br>RAM: ${s.server.mem_used_pct}% used (${s.server.mem_free_mb}MB free / ${s.server.mem_total_mb}MB)`
                    + `<br>Node heap: ${s.server.node_heap_mb}MB · Uptime: ${s.server.uptime_hours}h (process: ${s.server.process_uptime_hours}h)`)}
                ${adminCard("DB Storage", (() => {
                    const db = s.db_space;
                    if (!db || db.total_mb == null) return "Unable to query";
                    const color = db.used_pct > 80 ? "#ef5350" : db.used_pct > 50 ? "#ffb74d" : "#4caf50";
                    let h = `<span style="color:${color};font-weight:700">${db.total_mb} MB</span> / ${db.limit_mb} MB (${db.used_pct}%)`;
                    h += `<div style="background:#333;border-radius:3px;height:8px;margin:6px 0"><div style="background:${color};height:100%;width:${Math.min(db.used_pct, 100)}%;border-radius:3px"></div></div>`;
                    if (db.tables.length) h += db.tables.map((t) => `<span style="color:#888;font-size:11px">${t.table}: ${t.size_mb}MB</span>`).join(" · ");
                    return h;
                })())}
            </div>

            <h3 style="color:#fff;font-size:15px;margin:16px 0 8px">Factions by Division</h3>
            <div style="display:flex;gap:4px;align-items:flex-end;height:120px;margin-bottom:8px">
                ${s.factions.by_division.map((d) => {
                    const maxCnt = Math.max(...s.factions.by_division.map((x) => x.count));
                    const h = Math.max((d.count / maxCnt) * 100, 4);
                    const bg = ["#444", "#cd7f32", "#c0c0c0", "#ffd700", "#4fc3f7", "#b388ff"][d.division] || "#666";
                    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
                        <div style="font-size:10px;color:#aaa;margin-bottom:2px">${d.count}</div>
                        <div style="width:100%;height:${h}%;background:${bg};border-radius:3px 3px 0 0"></div>
                        <div style="font-size:10px;color:#888;margin-top:4px">${divLabels[d.division] || d.division}</div>
                    </div>`;
                }).join("")}
            </div>

            <h3 style="color:#fff;font-size:15px;margin:16px 0 8px">Registered Users</h3>
            <div id="tat-admin-users" class="tat-status">Loading...</div>

            <h3 style="color:#fff;font-size:15px;margin:16px 0 8px">Active Poll Jobs (top 50)</h3>
            <div id="tat-admin-jobs" class="tat-status">Loading...</div>

            <div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px">
                <h3 style="color:#fff;font-size:15px;margin:0">Server Logs</h3>
                <div style="display:flex;gap:8px;align-items:center">
                    <select id="tat-log-level" style="background:#252525;border:1px solid #444;color:#ddd;padding:4px 8px;border-radius:4px;font-size:12px">
                        <option value="all">All</option>
                        <option value="info">Info+</option>
                        <option value="warn" selected>Warn+</option>
                        <option value="error">Error only</option>
                    </select>
                    <button class="tat-btn tat-btn-export" id="tat-log-refresh" style="padding:4px 10px;font-size:12px">Refresh</button>
                </div>
            </div>
            <div id="tat-admin-logs" class="tat-status">Loading...</div>
        `;

        loadAdminUsers();
        loadAdminJobs();
        loadAdminLogs();

        document.getElementById("tat-log-level").addEventListener("change", loadAdminLogs);
        document.getElementById("tat-log-refresh").addEventListener("click", loadAdminLogs);
    }

    async function loadAdminLogs() {
        const container = document.getElementById("tat-admin-logs");
        const level = document.getElementById("tat-log-level")?.value || "warn";
        if (!container) return;
        try {
            const logs = await backendRequest("GET", `/v1/admin/logs?level=${level}&limit=100`);
            if (logs.length === 0) {
                container.innerHTML = `<span style="color:#666">No log entries at this level.</span>`;
                return;
            }
            const levelLabel = { 10: "TRACE", 20: "DEBUG", 30: "INFO", 40: "WARN", 50: "ERROR", 60: "FATAL" };
            const levelColor = { 10: "#666", 20: "#888", 30: "#4caf50", 40: "#ffb74d", 50: "#ef5350", 60: "#d32f2f" };
            let html = `<div style="max-height:300px;overflow:auto;background:#0e0e0e;border:1px solid #333;border-radius:4px;padding:8px;font-family:monospace;font-size:11px">`;
            for (const e of logs) {
                const ts = new Date(e.time).toISOString().slice(11, 23);
                const lvl = levelLabel[e.level] || e.level;
                const color = levelColor[e.level] || "#aaa";
                let extra = "";
                for (const k of Object.keys(e)) {
                    if (["time", "level", "msg", "pid", "hostname", "v"].includes(k)) continue;
                    const val = typeof e[k] === "object" ? JSON.stringify(e[k]) : e[k];
                    extra += ` <span style="color:#666">${k}=</span><span style="color:#aaa">${String(val).slice(0, 80)}</span>`;
                }
                html += `<div style="padding:2px 0;border-bottom:1px solid #1a1a1a">
                    <span style="color:#666">${ts}</span>
                    <span style="color:${color};font-weight:700;margin:0 6px">${lvl}</span>
                    <span style="color:#ddd">${e.msg || ""}</span>${extra}
                </div>`;
            }
            html += `</div>`;
            container.innerHTML = html;
        } catch {
            container.innerHTML = `<span style="color:#ef5350">Failed to load logs.</span>`;
        }
    }

    function adminCard(title, content) {
        return `<div style="background:#252525;border:1px solid #333;border-radius:8px;padding:10px 14px">
            <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">${title}</div>
            <div style="font-size:14px;margin-top:4px;color:#ccc">${content}</div>
        </div>`;
    }

    async function loadAdminUsers() {
        const container = document.getElementById("tat-admin-users");
        if (!container) return;
        try {
            const users = await backendRequest("GET", "/v1/admin/users");
            if (users.length === 0) {
                container.innerHTML = `<span style="color:#666">No registered users.</span>`;
                return;
            }
            const fmtTs = (ts) => {
                if (!ts) return "—";
                const d = new Date(ts);
                return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`;
            };
            let html = `<table class="tat-grid" style="font-size:12px">
                <thead><tr>
                    <th style="text-align:left">Name</th>
                    <th>ID</th>
                    <th>Faction</th>
                    <th>Key</th>
                    <th>Registered (UTC)</th>
                    <th>Last Seen (UTC)</th>
                </tr></thead><tbody>`;
            for (const u of users) {
                const keyColor = u.key_status === "active" ? "#4caf50" : "#ef5350";
                const profileUrl = `https://www.torn.com/profiles.php?XID=${u.torn_user_id}`;
                const factionCell = u.faction_id
                    ? `<a href="https://www.torn.com/factions.php?step=profile&ID=${u.faction_id}" target="_blank" style="color:#8ecae6;text-decoration:none">${u.faction_id}</a>`
                    : "—";
                html += `<tr>
                    <td style="text-align:left"><a href="${profileUrl}" target="_blank" style="color:#8ecae6;text-decoration:none">${u.name || "?"}</a></td>
                    <td>${u.torn_user_id}</td>
                    <td>${factionCell}</td>
                    <td style="color:${keyColor};font-weight:600">${u.key_status}</td>
                    <td style="color:#888">${fmtTs(u.registered_at)}</td>
                    <td style="color:#888">${fmtTs(u.last_seen_at)}</td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;
        } catch {
            container.innerHTML = `<span style="color:#ef5350">Failed to load users.</span>`;
        }
    }

    async function loadAdminJobs() {
        const container = document.getElementById("tat-admin-jobs");
        if (!container) return;
        try {
            const jobs = await backendRequest("GET", "/v1/admin/jobs?limit=50");
            if (jobs.length === 0) {
                container.innerHTML = `<span style="color:#666">No poll jobs.</span>`;
                return;
            }
            let html = `<table class="tat-grid" style="font-size:12px">
                <thead><tr>
                    <th style="text-align:left">Faction</th>
                    <th>Members</th>
                    <th>Div</th>
                    <th>Priority</th>
                    <th>Last Status</th>
                    <th>Last Polled</th>
                    <th>Due At</th>
                </tr></thead><tbody>`;
            const divLabels = { 0: "—", 1: "Brz", 2: "Slv", 3: "Gld", 4: "Plt", 5: "Dia" };
            const priLabels = { 1: "HOT", 5: "warm", 9: "cold" };
            const priColors = { 1: "#ef5350", 5: "#ccc", 9: "#666" };
            for (const j of jobs) {
                const polled = j.last_polled_at ? new Date(j.last_polled_at).toISOString().slice(11, 16) : "—";
                const due = j.due_at ? new Date(j.due_at).toISOString().slice(11, 16) : "—";
                html += `<tr>
                    <td style="text-align:left">${j.name || j.faction_id}</td>
                    <td>${j.members ?? "?"}</td>
                    <td>${divLabels[j.division] ?? j.division ?? "?"}</td>
                    <td style="color:${priColors[j.priority] || '#ccc'}">${priLabels[j.priority] || j.priority}</td>
                    <td style="color:${j.last_status === 'ok' ? '#4caf50' : j.last_status === 'error' ? '#ef5350' : '#888'}">${j.last_status || "—"}</td>
                    <td style="color:#888">${polled}</td>
                    <td>${due}</td>
                </tr>`;
            }
            html += `</tbody></table>`;
            container.innerHTML = html;
        } catch {
            container.innerHTML = `<span style="color:#ef5350">Failed to load jobs.</span>`;
        }
    }

    // ═══════════════════════════════════════════════════════════
    //  Shared footer menu (eugene-torn-scripts userscripts)
    //  — 1 script installed: its icon goes in the footer directly.
    //  — 2+ installed: a single 3-dots menu holds them all and
    //    expands a row above the footer on click.
    //  Idempotent and duplicated verbatim across scripts. The
    //  __eugFooterMenuLoaded guard ensures setup runs once per page.
    // ═══════════════════════════════════════════════════════════

    (function setupEugFooterMenu() {
        // Use the page's real window so scripts in different @grant sandboxes
        // share the same registry. SPA (@grant none) and TAT (@grant GM_*)
        // otherwise see isolated `window` objects and can't find each other.
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
            // Bottom-anchor the row above the menu button; clamp so first icon sits over the menu icon
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

        // Legacy standalone-button IDs from pre-shared-menu versions.
        // If a user has a mixed install (one script new, one old), the old
        // script creates its own button under one of these IDs. Nuke them
        // so the shared menu stays authoritative. Safe to add new IDs here.
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
            if (render()) return;
            const obs = new MutationObserver(() => { if (render()) obs.disconnect(); });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => obs.disconnect(), 30000);
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

    // ═══════════════════════════════════════════════════════════
    //  Boot
    // ═══════════════════════════════════════════════════════════

    function registerAndMount() {
        const W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
        W.registerEugeneScript({
            id: "tat",
            name: "Torn Activity Tracker",
            color: "#8b2020",
            colorDark: "#5c1010",
            hoverColor: "#a52a2a",
            iconSVG: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
                <defs><linearGradient id="tat_grad" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox">
                    <stop offset="0" stop-color="#ddd"/><stop offset="1" stop-color="#999"/>
                </linearGradient></defs>
                <g fill="url(#tat_grad)"><path d="M3 3h6v6H3V3zm0 8h6v6H3v-6zm0 8h6v2H3v-2zm8-16h10v2H11V3zm0 4h10v2H11V7zm0 4h10v2H11v-2zm0 4h10v2H11v-2zm0 4h10v2H11v-2z"/></g>
            </svg>`,
            onClick: () => togglePanel(!panelOpen),
        });
        W.mountEugeneFooterMenu();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", registerAndMount);
    } else {
        registerAndMount();
    }
})();
