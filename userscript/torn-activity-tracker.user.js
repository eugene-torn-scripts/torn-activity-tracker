// ==UserScript==
// @name         Torn Activity Tracker
// @namespace    https://github.com/eugene-torn-scripts/torn-activity-tracker
// @version      2.21.7
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

    const VERSION = "2.21.7";
    const BACKEND_BASE = GM_getValue("backend_base", "https://torn-tat.duckdns.org");

    // Torn PDA exposes PDA_httpGet as a global; its presence is the canonical
    // "are we inside the PDA webview?" signal (same check SPA/BH/FAT use).
    // On-device probing settled the transport question:
    //   - GM_xmlhttpRequest hangs (8s+ timeout) in this PDA build — unusable.
    //   - native fetch() is CSP-blocked in the webview ("Load failed") — unusable.
    //   - PDA_httpGet(url, headers) [2-arg] resolves instantly to undefined: this
    //     build does NOT support the headers arg. The one-arg PDA_httpGet(url)
    //     works (real promise → {status, responseText}).
    // So in PDA we use the one-arg bridge and pass the API key as a ?k= query
    // param (BE accepts it as a bearer fallback). Desktop has no bridge and the
    // page CSP blocks cross-origin fetch, so desktop keeps GM_xmlhttpRequest.
    const IS_PDA = typeof PDA_httpGet === "function";
    const STORAGE_KEYS = { apiKey: "torn_api_key", userInfo: "torn_user_info", ffscouterKey: "ffscouter_key", debug: "tat_debug", hourGridIncludeIdle: "tat_hour_grid_include_idle", hourGridMetric: "tat_hour_grid_metric", hourGridCompareFaction: "tat_hour_grid_compare_faction", summaryIncludeIdle: "tat_summary_include_idle", compareColumns: "tat_compare_columns", watchlistCache: "tat_watchlist_cache", recruitFilters: "tat_recruit_filters", recruitColumns: "tat_recruit_columns" };

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

    // Push a plain diagnostic line (ms 0) into the same debug log perfTrack uses.
    function debugLog(label) {
        if (!GM_getValue(STORAGE_KEYS.debug)) return;
        perfLog.push({ ts: new Date().toISOString().slice(11, 19), label, ms: 0 });
        if (perfLog.length > MAX_PERF_LOG) perfLog.shift();
    }

    // Turn any thrown value into a short, human-readable cause for the log.
    // fetch() rejects with a TypeError (e.g. "Failed to fetch") when blocked by
    // CSP / cross-origin policy; GM onerror passes an object with error/statusText.
    function describeError(err) {
        if (err == null) return "unknown";
        if (err instanceof Error) return `${err.name}: ${err.message}`;
        if (typeof err === "object") {
            if (err.status != null && err.status !== 0) {
                return `HTTP ${err.status}${err.error ? " " + err.error : ""}`;
            }
            const bits = [err.error, err.statusText, err.message, err.readyState != null ? `rs=${err.readyState}` : null]
                .filter(Boolean);
            if (bits.length) return bits.join(" ");
            try { return JSON.stringify(err).slice(0, 140); } catch { return String(err); }
        }
        return String(err);
    }

    // One-time environment snapshot — the single most useful line for diagnosing
    // PDA vs desktop transport problems. Logged on the first backend request.
    let _envLogged = false;
    function logEnvOnce() {
        if (_envLogged) return;
        _envLogged = true;
        debugLog(`env: PDA=${IS_PDA} fetch=${typeof fetch} PDA_httpGet=${typeof PDA_httpGet} GM_xhr=${typeof GM_xmlhttpRequest} base=${BACKEND_BASE} v${VERSION}`);
        debugLog(`env: ua=${(navigator.userAgent || "").slice(0, 90)}`);
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
        const headers = {
            ...(body ? { "Content-Type": "application/json" } : {}),
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        };
        const t0 = performance.now();

        // PDA transport. Ruled out on-device (probe): GM_xmlhttpRequest hangs
        // (8s+), native fetch() is CSP-blocked ("Load failed"), and the two-arg
        // PDA_httpGet(url, headers) resolves instantly to undefined — this build
        // does NOT support the headers argument. So we use the proven one-arg
        // PDA_httpGet(url) / PDA_httpPost(url, headers, body) and send the API key
        // as a ?k= query param (the BE accepts it as a fallback to the bearer
        // header). Content-Type still rides PDA_httpPost's headers arg, which is
        // the original 3-arg form (unaffected by the GET-headers gap).
        if (IS_PDA) {
            const authedUrl = apiKey
                ? url + (url.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(apiKey)
                : url;
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (fn, arg) => { if (!settled) { settled = true; clearTimeout(watchdog); fn(arg); } };
                // Watchdog: if the bridge never settles, surface it instead of
                // hanging the UI forever (the old GM bug). 20s is well under the
                // perceived "stuck" threshold but long enough for a slow tunnel.
                const watchdog = setTimeout(() => {
                    perfTrack(`${method} ${path} → ERR[pda-timeout]`, t0);
                    finish(reject, { status: 0, error: "pda_timeout" });
                }, 20000);

                let bridge;
                try {
                    bridge = method === "GET"
                        ? PDA_httpGet(authedUrl)
                        : PDA_httpPost(authedUrl, { "Content-Type": "application/json" }, body ? JSON.stringify(body) : "");
                } catch (e) {
                    perfTrack(`${method} ${path} → ERR[pda-call] ${describeError(e)}`, t0);
                    finish(reject, { status: 0, error: "pda_call_threw", detail: describeError(e) });
                    return;
                }
                // Normalise: some builds may return undefined / a non-promise.
                // Promise.resolve(undefined) → res undefined → logged as a typed error.
                Promise.resolve(bridge).then((res) => {
                    if (settled) return;
                    if (res == null || typeof res !== "object") {
                        perfTrack(`${method} ${path} → ERR[pda-shape] returned typeof=${typeof bridge}, res=${typeof res}`, t0);
                        finish(reject, { status: 0, error: "pda_bad_shape" });
                        return;
                    }
                    const status = typeof res.status === "number" ? res.status : 0;
                    if (status === 0) {
                        perfTrack(`${method} ${path} → ERR[pda] ${describeError(res)}`, t0);
                        finish(reject, { status: 0, error: "network_error", detail: describeError(res) });
                        return;
                    }
                    perfTrack(`${method} ${path} → ${status}`, t0);
                    let data = {};
                    try { if (res.responseText) data = JSON.parse(res.responseText); } catch {}
                    if (status >= 200 && status < 300) finish(resolve, data);
                    else finish(reject, { status, ...data });
                }).catch((err) => {
                    perfTrack(`${method} ${path} → ERR[pda] ${describeError(err)}`, t0);
                    finish(reject, { status: 0, error: "network_error", detail: describeError(err) });
                });
            });
        }

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url,
                headers,
                data: body ? JSON.stringify(body) : undefined,
                onload: (res) => {
                    perfTrack(`${method} ${path} → ${res.status}`, t0);
                    let data = {};
                    try { if (res.responseText) data = JSON.parse(res.responseText); } catch {}
                    if (res.status >= 200 && res.status < 300) resolve(data);
                    else reject({ status: res.status, ...data });
                },
                onerror: (e) => { perfTrack(`${method} ${path} → ERR[gm] ${describeError(e)}`, t0); reject({ status: 0, error: "network_error" }); },
                ontimeout: () => { perfTrack(`${method} ${path} → ERR[gm] timeout`, t0); reject({ status: 0, error: "timeout" }); },
            });
        });
    }

    // Retry transient network errors. Torn PDA's GM_xmlhttpRequest sometimes
    // rejects with ERR 0ms under concurrent load — desktop is fine. Only retry
    // status 0 (no response); real HTTP errors (4xx/5xx) fall straight through.
    async function backendRequest(method, path, body) {
        logEnvOnce();
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
                // PDA: PDA_httpGet tunnels natively (GM is broken in 3.13.x and
                // FFScouter sends no CORS, so plain fetch is blocked there). The
                // key rides in the URL, so no headers are needed. Desktop: GM.
                const data = IS_PDA
                    ? await PDA_httpGet(url).then((res) => {
                        const parsed = JSON.parse(res.responseText);
                        if (Array.isArray(parsed)) return parsed;
                        throw parsed;
                    })
                    : await new Promise((resolve, reject) => {
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
.tat-grid-panels{display:flex;flex-direction:column;gap:16px;align-items:stretch}
.tat-grid-panel{min-width:0}
.tat-grid-panel-title{color:#ddd;font-size:13px;font-weight:600;margin:0 0 6px;padding:6px 10px;
  background:#252525;border:1px solid #333;border-radius:4px;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis}

/* Compare layout */
.tat-cmp-name{cursor:pointer}
.tat-cmp-name:hover{text-decoration:underline}

/* Recruit-tab column-toggle chips (SPA-style) */
.tat-col-chip{cursor:pointer;padding:3px 8px;border-radius:3px;user-select:none;display:inline-flex;align-items:center}
.tat-col-chip input{display:none}
.tat-col-chip:has(input:checked){background:#1a3a4a;border:1px solid #4fc3f7}
.tat-col-chip:has(input:checked) span{color:#4fc3f7}
.tat-col-chip:has(input:not(:checked)){background:#333;border:1px solid #444}
.tat-col-chip:has(input:not(:checked)) span{color:#888}
.tat-col-chip:hover{border-color:#888}

/* Combobox (watchlist candidate search) */
.tat-combobox{position:relative}
.tat-combobox-list{max-height:220px;overflow-y:auto;background:#252525;border:1px solid #444;border-radius:4px;
  position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:10}
.tat-combo-item{padding:6px 10px;cursor:pointer;color:#ddd;font-size:13px;border-bottom:1px solid #2a2a2a}
.tat-combo-item:last-child{border-bottom:none}
.tat-combo-item:hover{background:#333;color:#fff}

/* Hide number-input spinners inside the TAT panel — they steal width and
   no one uses them for filter values. */
#tat-panel input[type=number]::-webkit-inner-spin-button,
#tat-panel input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
#tat-panel input[type=number]{-moz-appearance:textfield;appearance:textfield}

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
        { id: "recruit", label: "Recruit" },
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
            case "recruit": await renderRecruit(el); break;
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

    // Store last-fetched data for CSV export and re-render on toggle
    let lastHourlyData = null;
    let lastHourlyFaction = null;
    let lastHourlyLabel = null;
    let lastHourlyDataCmp = null;
    let lastHourlyFactionCmp = null;
    let lastHourlyLabelCmp = null;
    // Wars overlapping the lookback window for each side. Each item:
    // { war_id, opponent_faction_id, started_at, ended_at, status }.
    let lastHourlyWars = null;
    let lastHourlyWarsCmp = null;

    async function renderHourGrid(el) {
        const userInfo = GM_getValue(STORAGE_KEYS.userInfo) || {};
        const factionId = userInfo.faction_id;
        if (!factionId) {
            el.innerHTML = emptyTabHTML(clockSVG, "No faction", "You must be in a faction to view activity data.");
            return;
        }

        const includeIdleInit = GM_getValue(STORAGE_KEYS.hourGridIncludeIdle, false) ? "checked" : "";
        const metricInit = GM_getValue(STORAGE_KEYS.hourGridMetric, "pct");
        const cmpInit = GM_getValue(STORAGE_KEYS.hourGridCompareFaction, "");
        el.innerHTML = `
            <div class="tat-grid-controls">
                <label>Faction:</label>
                <select id="tat-grid-faction">
                    <option value="${factionId}">My faction (${factionId})</option>
                </select>
                <label>Compare:</label>
                <select id="tat-grid-faction-cmp">
                    <option value="">— none —</option>
                </select>
                <label>Days:</label>
                <select id="tat-grid-days">
                    <option value="1">1</option>
                    <option value="3">3</option>
                    <option value="7" selected>7</option>
                    <option value="14">14</option>
                    <option value="30">30</option>
                </select>
                <label>Show:</label>
                <select id="tat-grid-metric">
                    <option value="pct"${metricInit === "pct" ? " selected" : ""}>Percentage</option>
                    <option value="count"${metricInit === "count" ? " selected" : ""}>Users</option>
                </select>
                <label style="margin-left:8px;cursor:pointer;display:inline-flex;align-items:center;gap:4px" title="Include idle members in the heatmap percentage">
                    <input type="checkbox" id="tat-grid-include-idle" ${includeIdleInit}>
                    Include idle
                </label>
            </div>
            <div class="tat-legend">
                <span>Peace:</span>
                <span class="tat-legend-box" style="background:#1a1a2e"></span> 0%
                <span class="tat-legend-box" style="background:#1a3a2e"></span> 25%
                <span class="tat-legend-box" style="background:#2e7d32"></span> 50%
                <span class="tat-legend-box" style="background:#4caf50"></span> 75%
                <span class="tat-legend-box" style="background:#69f0ae"></span> 100%
                <span style="margin-left:12px">War:</span>
                <span class="tat-legend-box" style="background:#2e1f1a"></span> 0%
                <span class="tat-legend-box" style="background:#5a3416"></span> 25%
                <span class="tat-legend-box" style="background:#bf6a0f"></span> 50%
                <span class="tat-legend-box" style="background:#ed8c12"></span> 75%
                <span class="tat-legend-box" style="background:#ffa726"></span> 100%
                <span style="margin-left:12px;color:#666">All times TCT (UTC)</span>
                <button class="tat-btn tat-btn-export" id="tat-export-hourly" style="margin-left:auto" disabled>Export CSV</button>
            </div>
            <div id="tat-grid-container"><div class="tat-status">Loading activity data...</div></div>
        `;

        const labelById = new Map();
        labelById.set(String(factionId), `My faction (${factionId})`);

        // Populate watchlist factions into dropdowns
        try {
            const watchlist = await fetchWatchlistCached();
            const selA = document.getElementById("tat-grid-faction");
            const selB = document.getElementById("tat-grid-faction-cmp");
            for (const f of watchlist) {
                const label = `${f.name || "Faction"} (${f.faction_id})`;
                labelById.set(String(f.faction_id), label);
                const optA = document.createElement("option");
                optA.value = f.faction_id;
                optA.textContent = label;
                selA.appendChild(optA);
                const optB = document.createElement("option");
                optB.value = f.faction_id;
                optB.textContent = label;
                selB.appendChild(optB);
            }
            if (cmpInit && selB.querySelector(`option[value="${cmpInit}"]`)) {
                selB.value = cmpInit;
            }
        } catch { /* ignore */ }

        const loadGrid = () => {
            const selA = document.getElementById("tat-grid-faction");
            const selB = document.getElementById("tat-grid-faction-cmp");
            const primary = Number(selA.value);
            const cmpRaw = selB.value;
            const compare = cmpRaw ? Number(cmpRaw) : null;
            const days = Number(document.getElementById("tat-grid-days").value);
            const labelA = labelById.get(String(primary)) || `Faction ${primary}`;
            const labelB = compare ? (labelById.get(String(compare)) || `Faction ${compare}`) : null;
            fetchAndRenderGrid(primary, compare, days, labelA, labelB);
        };

        document.getElementById("tat-grid-faction").addEventListener("change", loadGrid);
        document.getElementById("tat-grid-faction-cmp").addEventListener("change", (e) => {
            GM_setValue(STORAGE_KEYS.hourGridCompareFaction, e.target.value);
            loadGrid();
        });
        document.getElementById("tat-grid-days").addEventListener("change", loadGrid);
        document.getElementById("tat-grid-metric").addEventListener("change", (e) => {
            GM_setValue(STORAGE_KEYS.hourGridMetric, e.target.value);
            renderAllHourlyGrids();
        });
        document.getElementById("tat-grid-include-idle").addEventListener("change", (e) => {
            GM_setValue(STORAGE_KEYS.hourGridIncludeIdle, e.target.checked);
            renderAllHourlyGrids();
        });
        document.getElementById("tat-export-hourly").addEventListener("click", () => {
            if (!lastHourlyData || lastHourlyData.length === 0) return;
            const buildRows = (fid, rows) => rows.map((r) => {
                const d = new Date(r.hour);
                const total = r.total_members;
                const pctOnlineOrIdle = total > 0 ? Math.round(((r.online + r.idle) / total) * 100) : 0;
                const base = [
                    d.toISOString().slice(0, 10),
                    d.getUTCHours(),
                    total, r.online, r.idle,
                    total - r.online - r.idle,
                    r.pct_online,
                    pctOnlineOrIdle,
                ];
                return fid == null ? base : [fid, ...base];
            });
            if (lastHourlyFactionCmp && lastHourlyDataCmp && lastHourlyDataCmp.length) {
                const headers = ["faction_id", "date_utc", "hour_utc", "total_members", "online", "idle", "offline", "pct_online", "pct_online_or_idle"];
                const rows = [
                    ...buildRows(lastHourlyFaction, lastHourlyData),
                    ...buildRows(lastHourlyFactionCmp, lastHourlyDataCmp),
                ];
                downloadCSV(`activity-hourly-${lastHourlyFaction}-vs-${lastHourlyFactionCmp}.csv`, headers, rows);
            } else {
                const headers = ["date_utc", "hour_utc", "total_members", "online", "idle", "offline", "pct_online", "pct_online_or_idle"];
                downloadCSV(`activity-hourly-${lastHourlyFaction}.csv`, headers, buildRows(null, lastHourlyData));
            }
        });
        loadGrid();
    }

    async function fetchAndRenderGrid(factionId, compareId, days, labelA, labelB) {
        const container = document.getElementById("tat-grid-container");
        const exportBtn = document.getElementById("tat-export-hourly");
        if (!container) return;
        container.innerHTML = `<div class="tat-status">Loading...</div>`;
        if (exportBtn) exportBtn.disabled = true;
        lastHourlyData = null;
        lastHourlyDataCmp = null;
        lastHourlyWars = null;
        lastHourlyWarsCmp = null;
        lastHourlyFaction = factionId;
        lastHourlyFactionCmp = compareId;
        lastHourlyLabel = labelA;
        lastHourlyLabelCmp = labelB;

        const fetchHourly = (id) => backendRequest("GET", `/v1/activity/hourly?faction=${id}&days=${days}`);
        // Wars endpoint is new (added 2.17.0). Older BE returns 404 — swallow
        // and treat as "no wars" so the heatmap still renders.
        const fetchWars = (id) => backendRequest("GET", `/v1/activity/wars?faction=${id}&days=${days}`)
            .catch(() => []);

        let dataA, dataB, warsA, warsB;
        try {
            if (compareId) {
                [dataA, warsA, dataB, warsB] = await Promise.all([
                    fetchHourly(factionId), fetchWars(factionId),
                    fetchHourly(compareId), fetchWars(compareId),
                ]);
            } else {
                [dataA, warsA] = await Promise.all([fetchHourly(factionId), fetchWars(factionId)]);
            }
        } catch (err) {
            container.innerHTML = `<div class="tat-status" style="color:#ef5350">Failed to load: ${err.error || err.status}</div>`;
            return;
        }

        if ((!dataA || dataA.length === 0) && (!dataB || dataB.length === 0)) {
            container.innerHTML = `<div class="tat-status">No activity data yet. The tracker polls every 30 minutes — check back soon.</div>`;
            return;
        }

        lastHourlyData = dataA || [];
        lastHourlyDataCmp = dataB || null;
        lastHourlyWars = warsA || [];
        lastHourlyWarsCmp = warsB || null;
        if (exportBtn) exportBtn.disabled = !(lastHourlyData && lastHourlyData.length);
        renderAllHourlyGrids();
    }

    function renderAllHourlyGrids() {
        const container = document.getElementById("tat-grid-container");
        if (!container) return;
        const hasCompare = !!lastHourlyDataCmp;

        // Single scroll container wraps both panels so the two heatmaps slide
        // horizontally together (matches the Weekday Avg tab pattern). The
        // inner div min-width forces overflow on narrow screens.
        if (hasCompare) {
            container.className = "tat-grid-wrap";
            container.innerHTML = `
                <div class="tat-grid-panels">
                    <div class="tat-grid-panel">
                        <div class="tat-grid-panel-title" title="${escapeAttr(lastHourlyLabel || "")}">${escapeHtml(lastHourlyLabel || "")}</div>
                        <div id="tat-grid-pane-a"></div>
                    </div>
                    <div class="tat-grid-panel">
                        <div class="tat-grid-panel-title" title="${escapeAttr(lastHourlyLabelCmp || "")}">${escapeHtml(lastHourlyLabelCmp || "")}</div>
                        <div id="tat-grid-pane-b"></div>
                    </div>
                </div>
            `;
            renderHourlyGridInto(document.getElementById("tat-grid-pane-a"), lastHourlyData, lastHourlyWars);
            renderHourlyGridInto(document.getElementById("tat-grid-pane-b"), lastHourlyDataCmp, lastHourlyWarsCmp);
        } else {
            container.className = "tat-grid-wrap";
            renderHourlyGridInto(container, lastHourlyData, lastHourlyWars);
        }
    }

    // Group hourly rows into { dayKey -> [24 rows] } and return {byDay, sortedDays}
    function groupHourlyByDay(data) {
        const byDay = new Map();
        for (const row of data) {
            const d = new Date(row.hour);
            const dateKey = d.toISOString().slice(0, 10);
            const hour = d.getUTCHours();
            if (!byDay.has(dateKey)) byDay.set(dateKey, new Array(24).fill(null));
            byDay.get(dateKey)[hour] = row;
        }
        return { byDay, sortedDays: [...byDay.keys()].sort().reverse() };
    }

    function rowStats(row, includeIdle) {
        const total = row.total_members;
        const activeCount = includeIdle ? row.online + row.idle : row.online;
        const pct = includeIdle
            ? (total > 0 ? Math.round((activeCount / total) * 100) : 0)
            : row.pct_online;
        return { total, activeCount, pct };
    }

    // Each war is an interval [started_at, ended_at ?? now]. Returns a function
    // (cellStartMs) => true when the one-hour cell starting at cellStartMs
    // overlaps any war in the list.
    function buildWarMatcher(wars) {
        if (!Array.isArray(wars) || wars.length === 0) return () => false;
        const nowMs = Date.now();
        const intervals = wars
            .map((w) => {
                const start = w.started_at ? new Date(w.started_at).getTime() : null;
                const end = w.ended_at ? new Date(w.ended_at).getTime() : nowMs;
                return start != null ? [start, end] : null;
            })
            .filter(Boolean);
        if (intervals.length === 0) return () => false;
        return (cellStartMs) => {
            const cellEnd = cellStartMs + 3600_000;
            for (const [s, e] of intervals) {
                if (cellStartMs < e && cellEnd > s) return true;
            }
            return false;
        };
    }

    function renderHourlyGridInto(paneEl, data, wars) {
        if (!paneEl) return;
        if (!data || data.length === 0) {
            paneEl.innerHTML = `<div class="tat-status">No data.</div>`;
            return;
        }
        const includeIdle = !!document.getElementById("tat-grid-include-idle")?.checked;
        const metric = document.getElementById("tat-grid-metric")?.value || "pct";
        const { byDay, sortedDays } = groupHourlyByDay(data);
        const isWar = buildWarMatcher(wars);

        let html = `<table class="tat-grid"><thead><tr><th></th>`;
        for (let h = 0; h < 24; h++) html += `<th>${String(h).padStart(2, "0")}</th>`;
        html += `</tr></thead><tbody>`;

        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        for (const dateKey of sortedDays) {
            const dow = dayNames[new Date(dateKey + "T00:00:00Z").getUTCDay()];
            html += `<tr><td class="tat-day-label">${dow} ${dateKey.slice(5)}</td>`;
            const hours = byDay.get(dateKey);
            const dayStartMs = new Date(dateKey + "T00:00:00Z").getTime();
            for (let h = 0; h < 24; h++) {
                const row = hours[h];
                const war = isWar(dayStartMs + h * 3600_000);
                if (!row) {
                    const bg = war ? "#2e1f1a" : "#111";
                    html += `<td class="tat-cell" style="background:${bg};color:#444">-</td>`;
                } else {
                    const { total, activeCount, pct } = rowStats(row, includeIdle);
                    const bg = war ? heatColorWar(pct) : heatColor(pct);
                    const textColor = pct > 50 ? "#111" : "#ddd";
                    const label = includeIdle ? "online+idle" : "online";
                    const ctx = war ? " (war)" : "";
                    const title = metric === "count"
                        ? `${activeCount}/${total} ${label} (${pct}%)${ctx}`
                        : `${pct}% ${label} (${activeCount}/${total})${ctx}`;
                    const display = metric === "count" ? String(activeCount) : String(pct);
                    html += `<td class="tat-cell" style="background:${bg};color:${textColor}" title="${title}">${display}</td>`;
                }
            }
            html += `</tr>`;
        }

        html += `</tbody></table>`;
        paneEl.innerHTML = html;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }

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

    // Amber ramp for war hours — same intensity scale as the green ramp, just
    // a different hue so wartime cells are immediately distinguishable from
    // peacetime activity without obscuring the cell value.
    function heatColorWar(pct) {
        if (pct <= 0) return "#2e1f1a";
        if (pct <= 15) return "#3d2818";
        if (pct <= 30) return "#5a3416";
        if (pct <= 45) return "#8a4d10";
        if (pct <= 60) return "#bf6a0f";
        if (pct <= 75) return "#ed8c12";
        if (pct <= 90) return "#ffa726";
        return "#ffcc80";
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
                    <option value="1">1</option>
                    <option value="3">3</option>
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

    // Compare-tab columns. `available(ctx)` gates whether a column can be
    // shown at all (e.g. BS only when FFScouter returned data; war-specific
    // stats only when the BE included them). Visible columns are persisted
    // in STORAGE_KEYS.compareColumns and toggleable via the chip row.
    const COMPARE_COLS = [
        { id: "name", label: "Name", fixed: true, align: "left",
          tooltip: "Member name — click to open a per-user activity heatmap below the table.",
          sortVal: (m) => (m.name || "").toLowerCase(),
          cell: (m, ctx) => `<td style="${ctx.bgStyle}text-align:left;color:#ccc;max-width:120px;overflow:hidden;text-overflow:ellipsis" class="tat-cmp-name" data-uid="${m.user_id}" data-name="${m.name || m.user_id}" data-side="${ctx.side}">${m.name || m.user_id}</td>` },
        { id: "bs", label: "BS", default: true,
          tooltip: "Battle stats estimate from FFScouter. Requires an FFScouter key in settings.",
          available: (ctx) => ctx.hasBs,
          sortVal: (m, ctx) => parseBS(ctx.bsMap.get(m.user_id)?.bs),
          cell: (m, ctx) => {
              const bs = ctx.bsMap.get(m.user_id);
              return `<td style="${ctx.bgStyle}color:#ffb74d;font-size:11px">${bs?.bs || "—"}</td>`;
          } },
        { id: "hours_online", label: "On", default: true,
          tooltip: "Hours the member was observed online during the selected day window.",
          sortVal: (m) => m.hours_online ?? 0,
          cell: (m, ctx) => `<td style="${ctx.bgStyle}">${m.hours_online}h</td>` },
        { id: "pct_online", label: "%", default: true,
          tooltip: "Share of observed hours where the member was online (online / observed).",
          sortVal: (m) => m.pct_online ?? 0,
          cell: (m, ctx) => `<td style="${ctx.bgStyle}color:${m.pct_online > 50 ? "#4caf50" : "#ccc"}">${m.pct_online}%</td>` },
        { id: "activity_min_per_day", label: "Act min/d", default: true,
          tooltip: "Average minutes online per day, derived from activity_time growth between the oldest and latest personalstats snapshots we have for this member within the selected window. Hover for actual data span. '—' = no personalstats data (very inactive, very new, or not yet enumerated).",
          available: (ctx) => ctx.hasActMinPerDay,
          sortVal: (m) => m.activity_min_per_day ?? -1,
          cell: (m, ctx) => m.activity_min_per_day != null
              ? `<td style="${ctx.bgStyle}" title="${Math.round(m.activity_window_days || 0)}d window">${m.activity_min_per_day}</td>`
              : `<td style="${ctx.bgStyle}color:#666">—</td>` },
        { id: "xanax_since_war", label: "Xan/war", default: true,
          tooltip: "Xanax taken since this war was declared. Torn updates daily at 00:00 TCT — current values refresh once per day.",
          available: (ctx) => ctx.hasWarStats,
          sortVal: (m) => m.xanax_since_war ?? -1,
          cell: (m, ctx) => `<td style="${ctx.bgStyle}color:#ce93d8">${m.xanax_since_war != null ? m.xanax_since_war : "—"}</td>` },
        { id: "overdoses_since_war", label: "OD/war", default: true,
          tooltip: "Overdoses since this war was declared. Torn's API counts all drugs together — there is no xanax-specific overdose stat.",
          available: (ctx) => ctx.hasWarStats,
          sortVal: (m) => m.overdoses_since_war ?? -1,
          cell: (m, ctx) => `<td style="${ctx.bgStyle}color:${m.overdoses_since_war > 0 ? "#ef5350" : "#aaa"}">${m.overdoses_since_war != null ? m.overdoses_since_war : "—"}</td>` },
    ];

    function loadCompareColumns() {
        const stored = GM_getValue(STORAGE_KEYS.compareColumns);
        const out = {};
        for (const col of COMPARE_COLS) {
            if (col.fixed) { out[col.id] = true; continue; }
            if (stored && typeof stored === "object" && col.id in stored) {
                out[col.id] = !!stored[col.id];
            } else {
                out[col.id] = !!col.default;
            }
        }
        return out;
    }

    function saveCompareColumns(visible) {
        GM_setValue(STORAGE_KEYS.compareColumns, visible);
    }

    /**
     * Render both faction tables side-by-side in a single scroll container.
     * Shared sort state, synced by design (one DOM structure).
     */
    function renderCompareTables(leftData, rightData, container, leftBsMap, rightBsMap) {
        if (!container) return;

        const hasRight = Array.isArray(rightData);
        let sortCol = container._sortCol || "pct_online";
        let sortDir = container._sortDir ?? -1;
        let visibleCols = loadCompareColumns();

        function buildCtx(bsMap, side, bgStyle) {
            const lbs = leftBsMap || new Map();
            const rbs = rightBsMap || new Map();
            const hasBs = lbs.size > 0 || (hasRight && rbs.size > 0);
            const hasWarStats = leftData.some((m) => m.xanax_since_war != null || m.overdoses_since_war != null)
                || (hasRight && rightData.some((m) => m.xanax_since_war != null || m.overdoses_since_war != null));
            const hasActMinPerDay = leftData.some((m) => m.activity_min_per_day != null)
                || (hasRight && rightData.some((m) => m.activity_min_per_day != null));
            return { bsMap: bsMap || new Map(), side, bgStyle: bgStyle || "", hasBs, hasWarStats, hasActMinPerDay };
        }

        function availableCols() {
            const probe = buildCtx(null, null, "");
            return COMPARE_COLS.filter((c) => !c.available || c.available(probe));
        }

        function visibleColDefs() {
            return availableCols().filter((c) => visibleCols[c.id]);
        }

        function sortData(data, bsMap) {
            const col = COMPARE_COLS.find((c) => c.id === sortCol);
            const ctx = { bsMap: bsMap || new Map() };
            const getter = col?.sortVal || ((m) => m[sortCol]);
            return [...data].sort((a, b) => {
                let va = getter(a, ctx), vb = getter(b, ctx);
                if (typeof va === "string") va = va.toLowerCase();
                if (typeof vb === "string") vb = vb.toLowerCase();
                return va < vb ? -1 * sortDir : va > vb ? 1 * sortDir : 0;
            });
        }

        function renderColToggle() {
            const wrap = container.parentElement?.querySelector("[data-tat-cmp-col-toggle]");
            if (!wrap) return;
            const togglable = availableCols().filter((c) => !c.fixed);
            if (togglable.length === 0) { wrap.style.display = "none"; return; }
            wrap.style.display = "flex";
            wrap.innerHTML = `<span style="color:#888;align-self:center;margin-right:4px">Columns:</span>` +
                togglable.map((c) => {
                    const checked = visibleCols[c.id] ? "checked" : "";
                    const title = c.tooltip ? ` title="${escapeAttr(c.tooltip)}"` : "";
                    return `<label class="tat-col-chip"${title}><input type="checkbox" data-col="${c.id}" ${checked}><span>${c.label}</span></label>`;
                }).join("");
            wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                cb.addEventListener("change", () => {
                    visibleCols[cb.dataset.col] = cb.checked;
                    saveCompareColumns(visibleCols);
                    // If the sort column just got hidden, fall back to a visible one.
                    const vis = visibleColDefs();
                    if (!vis.some((c) => c.id === sortCol)) {
                        sortCol = vis.find((c) => c.id !== "name")?.id || "name";
                        container._sortCol = sortCol;
                    }
                    render();
                });
            });
        }

        function render() {
            const cols = visibleColDefs();
            const lbs = leftBsMap || new Map();
            const rbs = rightBsMap || new Map();
            const sortedL = sortData(leftData, lbs);
            const sortedR = hasRight ? sortData(rightData, rbs) : [];
            const maxRows = Math.max(sortedL.length, sortedR.length);

            function thRow(side) {
                let h = "";
                for (const c of cols) {
                    const cls = c.id === sortCol ? (sortDir === 1 ? " sort-asc" : " sort-desc") : "";
                    h += `<th data-col="${c.id}" data-side="${side}" class="${cls}" style="${c.align ? "text-align:" + c.align : ""}">${c.label}</th>`;
                }
                return h;
            }

            function memberCells(m, bsMap, side, selected) {
                if (!m) return `<td colspan="${cols.length}"></td>`;
                const isSel = selected && selected.has(m.user_id);
                const bg = isSel ? (side === "left" ? "#1a4a5a" : "#5a1a2a") : "";
                const bgStyle = bg ? `background:${bg};` : "";
                const ctx = buildCtx(bsMap, side, bgStyle);
                return cols.map((c) => c.cell(m, ctx)).join("");
            }

            const selL = container._selLeft instanceof Set ? container._selLeft : new Set();
            const selR = container._selRight instanceof Set ? container._selRight : new Set();

            // Preserve scroll position across re-renders so toggling a selection
            // doesn't snap the table back to the top.
            const prevScrollEl = container.querySelector("[data-tat-cmp-scroll]");
            const prevScrollTop = prevScrollEl ? prevScrollEl.scrollTop : 0;

            let html;
            if (hasRight) {
                html = `<div data-tat-cmp-scroll style="overflow-y:auto;max-height:280px">
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
                html = `<div data-tat-cmp-scroll style="overflow-y:auto;max-height:280px">
                    <table class="tat-grid" style="font-size:12px;table-layout:fixed">
                    <thead><tr>${thRow("left")}</tr></thead><tbody>`;
                for (let i = 0; i < sortedL.length; i++) {
                    html += `<tr style="cursor:pointer">${memberCells(sortedL[i], lbs, "left", selL)}</tr>`;
                }
                html += `</tbody></table></div>`;
            }
            container.innerHTML = html;
            const newScrollEl = container.querySelector("[data-tat-cmp-scroll]");
            if (newScrollEl && prevScrollTop) newScrollEl.scrollTop = prevScrollTop;

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

            renderColToggle();
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
                    <option value="1">1</option>
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

        // Persist across reloads. Selections clear per-side only when that side's
        // faction changes — changing days alone keeps everything.
        const selectedLeft = new Map();
        const selectedRight = new Map();
        let lastLeftId = null, lastRightId = null;
        let lastSortCol = "pct_online", lastSortDir = -1;

        // Chosen baseline date for the Xan/war + OD/war columns. null = let
        // the BE pick the default (= earliest available, "war declared").
        // Reset whenever the right-side faction changes so opening a new
        // opponent doesn't carry over a date from the prior comparison.
        let currentSinceDate = null;

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

            // Capture sort state from the previous render before discarding the container.
            const prevTables = document.getElementById("tat-cmp-tables");
            if (prevTables) {
                if (prevTables._sortCol) lastSortCol = prevTables._sortCol;
                if (prevTables._sortDir != null) lastSortDir = prevTables._sortDir;
            }

            // Per-side selection clears only when that side's faction changes.
            // Changing factions also clears the chosen baseline date so the
            // new comparison starts on its own war's default.
            if (lastLeftId !== null && leftId !== lastLeftId) {
                selectedLeft.clear();
                currentSinceDate = null;
            }
            if (rightId !== lastRightId) {
                selectedRight.clear();
                currentSinceDate = null;
            }
            lastLeftId = leftId;
            lastRightId = rightId;

            container.innerHTML = `<div class="tat-status">${rightId ? "Loading both factions..." : "Loading your faction..."}</div>`;
            if (exportBtn) exportBtn.disabled = true;
            compareData = null;
            const userCmpEl = document.getElementById("tat-user-compare");
            // Hide the heatmap section only when nothing remains selected — otherwise
            // keep prior heatmaps visible while data refetches with the new day range.
            if (!selectedLeft.size && !selectedRight.size) {
                userCmpEl.style.display = "none";
                userCmpEl.innerHTML = "";
            }
            resetUserCompareCache();

            let leftResp, rightResp, leftWars = [], rightWars = [];
            try {
                const sinceParam = currentSinceDate ? `&since=${encodeURIComponent(currentSinceDate)}` : "";
                // /wars is best-effort: older BE returns 404 and we still render the rest.
                const warsCall = (id) => backendRequest("GET", `/v1/activity/wars?faction=${id}&days=${days}`).catch(() => []);
                if (rightId) {
                    [leftResp, rightResp, leftWars, rightWars] = await Promise.all([
                        backendRequest("GET", `/v1/activity/members?faction=${leftId}&days=${days}${sinceParam}`),
                        backendRequest("GET", `/v1/activity/members?faction=${rightId}&days=${days}${sinceParam}`),
                        warsCall(leftId), warsCall(rightId),
                    ]);
                } else {
                    [leftResp, leftWars] = await Promise.all([
                        backendRequest("GET", `/v1/activity/members?faction=${leftId}&days=${days}${sinceParam}`),
                        warsCall(leftId),
                    ]);
                    rightResp = null;
                }
            } catch (err) {
                container.innerHTML = `<div class="tat-status" style="color:#ef5350">Failed: ${err.error || err.status}</div>`;
                return;
            }

            // BE now wraps members + meta. Unwrap defensively in case any
            // future build serves only the members array.
            const leftData  = Array.isArray(leftResp)  ? leftResp  : (leftResp?.members  || []);
            const rightData = rightResp == null ? null
                : (Array.isArray(rightResp) ? rightResp : (rightResp?.members || []));
            const leftMeta  = Array.isArray(leftResp)  ? {} : (leftResp?.meta || {});
            // Adopt the BE's chosen default as the current selection so the
            // dropdown shows what the response was actually computed against.
            if (currentSinceDate == null) currentSinceDate = leftMeta.default_since_date ?? null;

            compareData = { left: leftData, right: rightData };
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
                hintHTML = `<div style="color:#888;font-size:12px;margin-bottom:12px">Click member names to view their heatmaps. Pick any number from either side; click again to deselect.</div>`;
            } else {
                summaryHTML = `
                    <div style="margin-bottom:16px;text-align:center">
                        <div style="background:#252525;border:1px solid #333;border-radius:8px;padding:12px;display:inline-block;min-width:220px">
                            <div style="color:#4fc3f7;font-size:24px;font-weight:700">${lAvgPct}%</div>
                            <div style="color:#aaa;font-size:12px;margin-top:2px">${leftData.length} members &middot; ${lOnline}h total</div>
                        </div>
                    </div>`;
                hintHTML = `<div style="color:#888;font-size:12px;margin-bottom:12px">Click member names to view their heatmaps (multi-select supported). Select an opponent above to compare factions side-by-side.</div>`;
            }

            const colToggleHTML = `<div data-tat-cmp-col-toggle style="display:flex;flex-wrap:wrap;gap:4px;margin:0 0 10px;font-size:11px"></div>`;

            // War-stat dropdown + banner are surfaced only when the BE
            // indicates an active war for this faction (deltas non-null on
            // at least one row, OR meta lists an active refresh hour with
            // no available dates yet).
            const hasWarColumns = leftData.some((m) => m.xanax_since_war != null)
                || (rightData && rightData.some((m) => m.xanax_since_war != null));
            const availableDates = Array.isArray(leftMeta.available_since_dates) ? leftMeta.available_since_dates : [];
            const refreshHour = Number.isFinite(leftMeta.refresh_utc_hour) ? leftMeta.refresh_utc_hour : null;
            const isWarPaired = hasWarColumns || availableDates.length > 0;

            const refreshHourStr = refreshHour != null ? String(refreshHour).padStart(2, "0") + ":00 TCT" : "the daily refresh hour";

            let warBannerHTML = "";
            let sinceControlHTML = "";
            if (isWarPaired) {
                warBannerHTML = `
                <div style="background:#1f2a33;border-left:3px solid #4fc3f7;color:#bbb;padding:8px 12px;margin:0 0 10px;font-size:12px;line-height:1.5;border-radius:3px">
                    <b style="color:#4fc3f7">Heads up:</b> <b style="color:#ddd">Xan/war</b> and <b style="color:#ddd">OD/war</b>
                    refresh once a day at <b style="color:#ddd">${refreshHourStr}</b>, after Torn publishes its daily
                    personalstats snapshot. Deltas may show <b>0</b> until tomorrow's snapshot rolls over.
                    <b style="color:#ddd">OD/war</b> counts overdoses across all drugs (Torn doesn't expose a xanax-specific stat).
                </div>`;
                if (availableDates.length === 0) {
                    sinceControlHTML = `
                        <div style="color:#aaa;font-size:12px;margin:0 0 10px">
                            No war-stats data collected yet — check after <b style="color:#ddd">${refreshHourStr}</b>.
                        </div>`;
                } else {
                    const opts = availableDates.map((d, i) => {
                        const label = i === 0 ? `Since ${d} (war declared)` : `Since ${d}`;
                        const selected = d === currentSinceDate ? " selected" : "";
                        return `<option value="${d}"${selected}>${label}</option>`;
                    }).join("");
                    sinceControlHTML = `
                        <div style="display:flex;align-items:center;gap:8px;margin:0 0 10px;font-size:12px;color:#aaa">
                            <label for="tat-cmp-since">Xan/war &amp; OD/war baseline:</label>
                            <select id="tat-cmp-since" style="background:#252525;border:1px solid #444;color:#ddd;padding:4px 6px;border-radius:4px;font-size:12px">${opts}</select>
                        </div>`;
                }
            }

            container.innerHTML = `${summaryHTML}${hintHTML}${warBannerHTML}${sinceControlHTML}${colToggleHTML}<div id="tat-cmp-tables"></div>`;

            const sinceSel = document.getElementById("tat-cmp-since");
            if (sinceSel) {
                sinceSel.addEventListener("change", () => {
                    currentSinceDate = sinceSel.value;
                    fetchAndRenderCompare(leftId, rightId, days);
                });
            }

            const tablesContainer = document.getElementById("tat-cmp-tables");
            // Seed persisted state onto the freshly created container.
            tablesContainer._sortCol = lastSortCol;
            tablesContainer._sortDir = lastSortDir;
            tablesContainer._selLeft = new Set(selectedLeft.keys());
            tablesContainer._selRight = new Set(selectedRight.keys());
            renderCompareTables(leftData, rightData, tablesContainer, null, null);

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

            // Per-user heatmaps on name click — multi-select on each side; click again to deselect.
            // selectedLeft/selectedRight live in the renderCompare scope so they persist
            // across reloads triggered by the days/factions filters.
            tablesContainer.addEventListener("click", (e) => {
                const nameCell = e.target.closest(".tat-cmp-name");
                if (!nameCell) return;
                const uid = Number(nameCell.dataset.uid);
                const name = nameCell.dataset.name;
                const side = nameCell.dataset.side;

                const sel = side === "left" ? selectedLeft : selectedRight;
                const selSet = side === "left" ? tablesContainer._selLeft : tablesContainer._selRight;
                if (sel.has(uid)) {
                    sel.delete(uid);
                    selSet.delete(uid);
                } else {
                    sel.set(uid, { uid, name });
                    selSet.add(uid);
                }
                if (tablesContainer._render) tablesContainer._render();
                loadUserCompare([...selectedLeft.values()], [...selectedRight.values()], days, leftWars, rightWars, leftId, rightId);
            });

            // If selections survived a reload (e.g. days filter changed), refresh heatmaps.
            if (selectedLeft.size || selectedRight.size) {
                loadUserCompare([...selectedLeft.values()], [...selectedRight.values()], days, leftWars, rightWars, leftId, rightId);
            }
        }

        load();
    }

    // Per-user heatmap cache for the Compare tab. Reset by resetUserCompareCache()
    // when factions/days change so we never serve stale data.
    const userHoursCache = new Map();
    const userWarStatsCache = new Map(); // key = `${uid}:${factionId}:${days}`
    let loadUserCompareToken = 0;
    function resetUserCompareCache() {
        userHoursCache.clear();
        userWarStatsCache.clear();
        loadUserCompareToken++;
    }

    async function loadUserCompare(leftUsers, rightUsers, days, leftWars, rightWars, leftFactionId, rightFactionId) {
        const container = document.getElementById("tat-user-compare");
        if (!leftUsers.length && !rightUsers.length) {
            container.style.display = "none";
            container.innerHTML = "";
            return;
        }
        container.style.display = "block";

        const myToken = ++loadUserCompareToken;
        const tagged = [
            ...leftUsers.map((u) => ({ ...u, factionId: leftFactionId, side: "left" })),
            ...rightUsers.map((u) => ({ ...u, factionId: rightFactionId, side: "right" })),
        ];
        const missingHours = tagged.filter((u) => !userHoursCache.has(u.uid));
        const warStatsKey = (uid, fid) => `${uid}:${fid}:${days}`;
        const missingStats = tagged.filter((u) => u.factionId && !userWarStatsCache.has(warStatsKey(u.uid, u.factionId)));

        // Only show a loading placeholder on the first paint (empty container).
        // Subsequent clicks keep the prior heatmaps visible while new data fetches —
        // prevents the section from collapsing and jumping the page.
        if ((missingHours.length || missingStats.length) && !container.innerHTML.trim()) {
            container.innerHTML = `<div class="tat-status" style="margin-top:16px">Loading heatmaps...</div>`;
        }

        if (missingHours.length || missingStats.length) {
            try {
                const hourFetches = missingHours.map((u) =>
                    backendRequest("GET", `/v1/activity/user-hourly?user=${u.uid}&days=${days}`)
                        .then((hours) => ({ uid: u.uid, hours }))
                );
                // /user-war-stats is new (added 2.18.0). Older BE 404s — swallow so the
                // heatmap still renders without the stats line.
                const statFetches = missingStats.map((u) =>
                    backendRequest("GET", `/v1/activity/user-war-stats?user=${u.uid}&faction=${u.factionId}&days=${days}`)
                        .catch(() => null)
                        .then((stats) => ({ key: warStatsKey(u.uid, u.factionId), stats }))
                );
                const [hourResults, statResults] = await Promise.all([
                    Promise.all(hourFetches),
                    Promise.all(statFetches),
                ]);
                if (myToken !== loadUserCompareToken) return; // superseded by a newer click
                for (const { uid, hours } of hourResults) userHoursCache.set(uid, hours);
                for (const { key, stats } of statResults) userWarStatsCache.set(key, stats);
            } catch (err) {
                if (myToken !== loadUserCompareToken) return;
                container.innerHTML = `<div class="tat-status" style="color:#ef5350;margin-top:16px">Failed to load user data.</div>`;
                return;
            }
        }
        if (myToken !== loadUserCompareToken) return;

        const allDates = new Set();
        const buildMap = (uid) => {
            const m = new Map();
            for (const row of (userHoursCache.get(uid) || [])) {
                const d = new Date(row.hour);
                const dateKey = d.toISOString().slice(0, 10);
                const hour = d.getUTCHours();
                allDates.add(dateKey);
                if (!m.has(dateKey)) m.set(dateKey, new Array(24).fill(null));
                m.get(dateKey)[hour] = row;
            }
            return m;
        };

        const leftMaps = leftUsers.map((u) => buildMap(u.uid));
        const rightMaps = rightUsers.map((u) => buildMap(u.uid));
        const total = leftUsers.length + rightUsers.length;
        const sortedDates = [...allDates].sort().reverse();
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

        function fmtHrMin(min) {
            const m = Math.round(min);
            const h = Math.floor(m / 60);
            const r = m % 60;
            return h > 0 ? `${h}h ${r}m` : `${r}m`;
        }

        function userHeatmapHTML(name, color, dataMap, isWar, stats) {
            // stats = BE /user-war-stats payload: { war_total_min, metric_simple_min,
            // metric_estimated_min, has_stats_data, war_days_count }. Render only if
            // there were wars in the window.
            let statsHTML = "";
            if (stats && stats.war_total_min > 0) {
                const total = `<span style="color:#ddd">${fmtHrMin(stats.war_total_min)}</span>`;
                let activityPart;
                if (stats.has_stats_data && stats.metric_simple_min != null) {
                    const simple = `<span style="color:#ddd">${fmtHrMin(stats.metric_simple_min)}</span> (${stats.metric_simple_min}min)`;
                    const expPart = stats.metric_estimated_min != null
                        ? ` &middot; <span title="Experimental: simple activity weighted by hourly active_minutes distribution across war hours. See &quot;Granularity&quot; in docs." style="color:#bbb">~${fmtHrMin(stats.metric_estimated_min)} (${stats.metric_estimated_min}min) (exp.)</span>`
                        : "";
                    activityPart = `War-day activity: ${simple}${expPart}`;
                } else {
                    activityPart = `<span style="color:#777" title="No personalstats history within this war window — wars older than 2026-05-10 pre-date our collection start.">activity: —</span>`;
                }
                statsHTML = `<span style="color:#888;font-size:11px;margin-left:8px">` +
                    `War total: ${total} &middot; ${activityPart}` +
                    `</span>`;
            }
            let html = `<div style="margin-bottom:4px"><span style="color:${color};font-weight:600">${name}</span>${statsHTML}</div>`;
            html += `<table class="tat-grid" style="font-size:11px"><thead><tr><th></th>`;
            for (let h = 0; h < 24; h++) html += `<th>${String(h).padStart(2, "0")}</th>`;
            html += `</tr></thead><tbody>`;

            for (const dateKey of sortedDates) {
                const dow = dayNames[new Date(dateKey + "T00:00:00Z").getUTCDay()];
                html += `<tr><td class="tat-day-label">${dow} ${dateKey.slice(5)}</td>`;
                const hours = dataMap.get(dateKey) || new Array(24).fill(null);
                const dayStartMs = new Date(dateKey + "T00:00:00Z").getTime();
                for (let h = 0; h < 24; h++) {
                    const row = hours[h];
                    const war = isWar(dayStartMs + h * 3600_000);
                    if (!row) {
                        const bg = war ? "#2e1f1a" : "#111";
                        html += `<td class="tat-cell" style="background:${bg};color:#444">-</td>`;
                    } else {
                        const status = row.active > 0 ? "ON" : row.idle > 0 ? "idl" : "off";
                        // Swap the green/brown/dark-blue ramp for the amber palette
                        // during war hours — matches the Hour Grid tab's treatment.
                        const bg = row.active > 0
                            ? (war ? "#bf6a0f" : "#2e7d32")
                            : row.idle > 0
                                ? (war ? "#5a3416" : "#5d4037")
                                : (war ? "#2e1f1a" : "#1a1a2e");
                        const fg = row.active > 0
                            ? (war ? "#ffcc80" : "#69f0ae")
                            : row.idle > 0
                                ? (war ? "#ed8c12" : "#ffab91")
                                : (war ? "#5a3416" : "#555");
                        const title = war ? `${status} (war)` : status;
                        html += `<td class="tat-cell" style="background:${bg};color:${fg}" title="${title}">${status}</td>`;
                    }
                }
                html += `</tr>`;
            }
            html += `</tbody></table>`;
            return html;
        }

        const isWarLeft = buildWarMatcher(leftWars);
        const isWarRight = buildWarMatcher(rightWars);

        function sideHTML(users, maps, color, sideTitle, isWar, factionId) {
            if (!users.length) return "";
            const header = sideTitle
                ? `<h4 style="color:${color};font-size:13px;margin:0 0 8px;font-weight:600">${sideTitle}</h4>`
                : "";
            const items = users.map((u, i) => {
                const stats = factionId ? userWarStatsCache.get(warStatsKey(u.uid, factionId)) : null;
                return `<div class="tat-grid-wrap" style="margin-bottom:12px">${userHeatmapHTML(u.name, color, maps[i], isWar, stats)}</div>`;
            }).join("");
            return `<div style="margin-bottom:16px">${header}${items}</div>`;
        }

        const bothSides = leftUsers.length && rightUsers.length;
        let title;
        if (bothSides) title = `User Comparison (${leftUsers.length} vs ${rightUsers.length})`;
        else if (total === 1) title = `Activity: ${(leftUsers[0] || rightUsers[0]).name}`;
        else title = `Activity: ${total} users`;

        container.innerHTML = `
            <div style="margin-top:16px;padding-top:16px;border-top:1px solid #333">
                <h3 style="color:#fff;font-size:15px;margin:0 0 12px">${title}</h3>
                ${sideHTML(leftUsers, leftMaps, "#4fc3f7", bothSides ? "My faction" : "", isWarLeft, leftFactionId)}
                ${sideHTML(rightUsers, rightMaps, "#ef5350", bothSides ? "Opponent" : "", isWarRight, rightFactionId)}
                <div class="tat-legend" style="margin-top:8px">
                    <span>Peace:</span>
                    <span class="tat-legend-box" style="background:#2e7d32"></span> Online
                    <span class="tat-legend-box" style="background:#5d4037"></span> Idle
                    <span class="tat-legend-box" style="background:#1a1a2e"></span> Offline
                    <span style="margin-left:12px">War:</span>
                    <span class="tat-legend-box" style="background:#bf6a0f"></span> Online
                    <span class="tat-legend-box" style="background:#5a3416"></span> Idle
                    <span class="tat-legend-box" style="background:#2e1f1a"></span> Offline
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
                    await backendRequest("POST", "/v1/settings/rate-limit", { rate_limit: Number(rateSlider.value) });
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
                const checkUrl = `https://ffscouter.com/api/v1/check-key?key=${encodeURIComponent(key)}`;
                // PDA: PDA_httpGet (GM broken in 3.13.x, FFScouter has no CORS). Desktop: GM.
                const res = IS_PDA
                    ? await PDA_httpGet(checkUrl).then((r) => JSON.parse(r.responseText))
                    : await new Promise((resolve, reject) => {
                        GM_xmlhttpRequest({
                            method: "GET",
                            url: checkUrl,
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

    // ── Recruit tab ──────────────────────────────────────────

    // Parse a human-shorthand magnitude ("10m", "3b", "1.5t") into a plain
    // integer. Used by filter specs whose values can grow into the billions —
    // typing all the zeros is painful. Empty or unparseable input → "".
    function parseShorthand(s) {
        if (s == null) return "";
        const trimmed = String(s).trim().toLowerCase().replace(/[\s,_]/g, "");
        if (trimmed === "") return "";
        const m = trimmed.match(/^([\d.]+)([kmbtq]?)$/);
        if (!m) {
            const n = Number(trimmed);
            return isFinite(n) && n >= 0 ? n : "";
        }
        const num = parseFloat(m[1]);
        if (!isFinite(num) || num < 0) return "";
        const mult = { "": 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 }[m[2]];
        return Math.round(num * mult);
    }

    // Stat-min filters: id used in querystring + label. The window dropdown
    // (`windowDays`) controls how far back the rate columns look. Lifetime
    // counters (RW hits, BS estimate) and the donator boolean are window-
    // independent but live next to these for layout convenience.
    const RECRUIT_STAT_FILTERS = [
        { id: "minXanaxPerDay",         label: "Xanax/d",         width: 70, step: "0.1",
          tooltip: "Minimum xanax taken per day, averaged over the chosen window." },
        { id: "minRefillsEnergyPerDay", label: "Refills E/d",     width: 80, step: "0.1",
          tooltip: "Minimum energy refills used per day, averaged over the chosen window." },
        { id: "minRwHitsPerWeek",       label: "RW hits/wk",      width: 80, step: "0.1",
          tooltip: "Minimum ranked-war hits per week, averaged over the chosen window." },
        { id: "minActivityMinPerDay",   label: "Activity min/day", width: 90, step: "1",
          tooltip: "Minimum average minutes online per day, derived from activity_time growth over the chosen window." },
        { id: "minRankedWarHits",       label: "RW hits",         width: 70,
          tooltip: "Minimum lifetime ranked-war hits." },
        { id: "minNetworthGrowthPct",   label: "Net Δ%/wk",       width: 80, step: "0.1",
          tooltip: "Minimum networth growth as a percentage, normalised to a 7-day rate. Can be negative." },
        { id: "minBsEstimate",          label: "BS",              width: 110,
          inputType: "text", placeholder: "1k, 2m, 3b",
          parser: parseShorthand,
          tooltip: "Minimum battle stats estimate (from FFScouter). Accepts shorthand: 1k = 1 000, 10m = 10 000 000, 3b = 3 000 000 000, 4t = 4 trillion." },
    ];

    const RECRUIT_DEFAULTS = {
        maxLastActionDays: 7,
        windowDays: 30,
        maxLevel: 100,
        minAge: "",
        factionStatus: "none",
        donatorOnly: false,
        search: "",
        sort: "level",
        sortDir: "desc",
        offset: 0,
        limit: 50,
        // Stat mins start empty so they don't filter anything by default
        ...Object.fromEntries(RECRUIT_STAT_FILTERS.map((f) => [f.id, ""])),
    };

    // Column definitions. `fixed` columns are always shown (Name).
    // `default` controls initial visibility. `sortKey` matches the backend's
    // `sort` enum (null = not sortable). `tooltip` is surfaced on the chip
    // toggle so users know what each metric means without scrolling docs.
    const RECRUIT_COLS = [
        { id: "name",         label: "Name",         fixed: true,    sortKey: "username",        align: "left",
          tooltip: "Player name — click to open the Torn profile.",
          render: (u) => `<a href="https://www.torn.com/profiles.php?XID=${u.user_id}" target="_blank" style="color:#4fc3f7;text-decoration:none">${escapeHtml(u.username || "?")}</a>` },
        { id: "id",           label: "ID",           default: false, sortKey: null,
          tooltip: "Numeric Torn user ID.",
          render: (u) => `<span style="color:#888">${u.user_id}</span>` },
        { id: "lvl",          label: "Lvl",          default: true,  sortKey: "level",
          tooltip: "Player level.",
          render: (u) => u.level ?? "—" },
        { id: "faction",      label: "Faction",      default: true,  sortKey: null,
          tooltip: "Current faction ID (click for faction profile). Dash = no faction.",
          render: (u) => u.faction_id
              ? `<a href="https://www.torn.com/factions.php?step=profile&ID=${u.faction_id}" target="_blank" style="color:#8ecae6;text-decoration:none">${u.faction_id}</a>`
              : `<span style="color:#666">—</span>` },
        { id: "last_action",  label: "Last action",  default: true,  sortKey: "last_action",
          tooltip: "Time since the player was last seen taking any action in Torn.",
          render: (u) => fmtDaysAgo(u.last_action_at) },
        { id: "age",          label: "Age",          default: false, sortKey: "age",
          tooltip: "Account age in days, from signup to now.",
          render: (u) => u.age_in_days != null ? `${u.age_in_days}d` : "—" },
        { id: "stats_age",    label: "Stats fresh",  default: false, sortKey: null,
          tooltip: "How long ago we last polled this player's personalstats. Older = rates below may be staler.",
          render: (u) => u.stats_refreshed_at ? fmtDaysAgo(u.stats_refreshed_at) : `<span style="color:#666">—</span>` },
        { id: "play_h",       label: "Play (h)",     default: false, sortKey: "activity_time",
          tooltip: "Lifetime total hours active in Torn.",
          render: (u) => u.activity_time_sec != null ? fmtCompactNum(Math.round(u.activity_time_sec / 3600)) : "—" },
        { id: "activity_min_per_day", label: "Activity min/day", default: true, sortKey: "activity_min_per_day",
          tooltip: "Average minutes online per day, derived from activity_time growth over the chosen window. Hover to see the actual data window length (a new user may have less than the chosen window).",
          render: (u) => u.activity_min_per_day != null
              ? `<span title="${Math.round(u.activity_window_days || 0)}d window">${Math.round(u.activity_min_per_day)}</span>`
              : `<span style="color:#666">—</span>` },
        { id: "donator",      label: "Donator d",    default: false, sortKey: "donator_days",
          tooltip: "Lifetime total days as a donator.",
          render: (u) => u.donator_days != null ? String(u.donator_days) : "—" },
        { id: "xanax_per_day", label: "Xanax/d",    default: true,  sortKey: "xanax_per_day",
          tooltip: "Xanax taken per day, averaged over the past ~7 days from snapshot history.",
          render: (u) => fmtRate(u.xanax_per_day) },
        { id: "xanax_total",  label: "Xanax (tot)",  default: false, sortKey: null,
          tooltip: "Lifetime total xanax taken.",
          render: (u) => fmtCompactNum(u.xanax_used) },
        { id: "refills_e_per_day", label: "Refills E/d", default: true, sortKey: "refills_energy_per_day",
          tooltip: "Energy refills used per day, averaged over the past ~7 days from snapshot history.",
          render: (u) => fmtRate(u.refills_energy_per_day) },
        { id: "refills_e_total", label: "Refills E (tot)", default: false, sortKey: null,
          tooltip: "Lifetime total energy refills used.",
          render: (u) => fmtCompactNum(u.refills_energy) },
        { id: "rw_hits",      label: "RW hits",      default: true,  sortKey: "ranked_war_hits",
          tooltip: "Lifetime total ranked-war hits.",
          render: (u) => fmtCompactNum(u.ranked_war_hits) },
        { id: "rw_hits_per_week", label: "RW hits/wk", default: true, sortKey: "rw_hits_per_week",
          tooltip: "Ranked-war hits per week, averaged over the chosen window.",
          render: (u) => fmtRate(u.rw_hits_per_week) },
        { id: "raid_hits",    label: "Raid hits",    default: false, sortKey: "raid_hits",
          tooltip: "Lifetime total raid hits.",
          render: (u) => fmtCompactNum(u.raid_hits) },
        { id: "rw_wins",      label: "RW wins",      default: false, sortKey: "ranked_war_wins",
          tooltip: "Lifetime total ranked wars won.",
          render: (u) => u.ranked_war_wins != null ? String(u.ranked_war_wins) : "—" },
        { id: "atk_won",      label: "Atks won",     default: false, sortKey: null,
          tooltip: "Lifetime total attacks won (PvP).",
          render: (u) => fmtCompactNum(u.attacks_won) },
        { id: "atk_lost",     label: "Atks lost",    default: false, sortKey: null,
          tooltip: "Lifetime total attacks lost (PvP).",
          render: (u) => fmtCompactNum(u.attacks_lost) },
        { id: "elo",          label: "ELO",          default: false, sortKey: "elo",
          tooltip: "Current attack ELO rating.",
          render: (u) => u.elo != null ? String(u.elo) : "—" },
        { id: "networth",     label: "Networth",     default: true,  sortKey: "networth",
          tooltip: "Current total networth.",
          render: (u) => fmtMoney(u.networth) },
        { id: "networth_growth", label: "Net Δ%/wk", default: true,  sortKey: "networth_growth_pct",
          tooltip: "Networth change as a percentage, normalised to a 7-day rate.",
          render: (u) => fmtPct(u.networth_growth_pct) },
        { id: "bs",           label: "BS",           default: true,  sortKey: "bs_estimate",
          tooltip: "Battle stats estimate (from FFScouter).",
          render: (u) => u.bs_estimate_human || (u.bs_estimate != null ? fmtCompactNum(u.bs_estimate) : "—") },
    ];

    function loadRecruitFilters() {
        const stored = GM_getValue(STORAGE_KEYS.recruitFilters);
        if (!stored || typeof stored !== "object") return { ...RECRUIT_DEFAULTS };
        const merged = { ...RECRUIT_DEFAULTS, ...stored, offset: 0 };
        // Old installs may have stored factionStatus="specific" — backend no
        // longer accepts that value.
        if (!["any", "none", "not_mine"].includes(merged.factionStatus)) {
            merged.factionStatus = RECRUIT_DEFAULTS.factionStatus;
        }
        // Sort keys for removed columns (xanax/refills_energy totals,
        // attacks_won, fair_fight) would 400 the backend — fall back to default.
        const validSorts = new Set(
            RECRUIT_COLS.map((c) => c.sortKey).filter(Boolean).concat(["level"]),
        );
        if (!validSorts.has(merged.sort)) merged.sort = RECRUIT_DEFAULTS.sort;
        // Active window options trimmed in 2.15.3: 30d/90d/1y were removed
        // because the stats-refresh gate is 7 days — anything wider returned
        // mostly stale ghosts with frozen metrics. Stored values outside the
        // current set fall back to the default (7d).
        if (!new Set([3, 7, 14]).has(merged.maxLastActionDays)) {
            merged.maxLastActionDays = RECRUIT_DEFAULTS.maxLastActionDays;
        }
        return merged;
    }

    function saveRecruitFilters(f) {
        // Don't persist offset — paging always starts fresh on reopen
        const out = {
            maxLastActionDays: f.maxLastActionDays,
            windowDays: f.windowDays,
            maxLevel: f.maxLevel,
            minAge: f.minAge,
            factionStatus: f.factionStatus,
            donatorOnly: f.donatorOnly,
            search: f.search,
            sort: f.sort,
            sortDir: f.sortDir,
            limit: f.limit,
        };
        for (const sf of RECRUIT_STAT_FILTERS) out[sf.id] = f[sf.id];
        GM_setValue(STORAGE_KEYS.recruitFilters, out);
    }

    function loadRecruitColumns() {
        const stored = GM_getValue(STORAGE_KEYS.recruitColumns);
        const out = {};
        for (const col of RECRUIT_COLS) {
            if (col.fixed) { out[col.id] = true; continue; }
            if (stored && typeof stored === "object" && col.id in stored) {
                out[col.id] = !!stored[col.id];
            } else {
                out[col.id] = !!col.default;
            }
        }
        return out;
    }

    function saveRecruitColumns(visible) {
        GM_setValue(STORAGE_KEYS.recruitColumns, visible);
    }

    function fmtDaysAgo(ts) {
        if (!ts) return "—";
        const sec = (Date.now() - new Date(ts).getTime()) / 1000;
        if (sec < 60) return `${Math.floor(sec)}s ago`;
        if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
        if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
        const days = Math.floor(sec / 86400);
        return `${days}d ago`;
    }

    function fmtMonthYear(ts) {
        if (!ts) return "—";
        const d = new Date(ts);
        return d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
    }

    function fmtCompactNum(n) {
        if (n == null) return "—";
        const abs = Math.abs(n);
        if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "b";
        if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
        if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
        return String(n);
    }

    function fmtMoney(n) {
        if (n == null) return "—";
        return "$" + fmtCompactNum(n);
    }

    // Per-day rates can be fractional. Show 1 decimal under 10, integer above.
    function fmtRate(n) {
        if (n == null) return "—";
        const abs = Math.abs(n);
        if (abs >= 10) return fmtCompactNum(Math.round(n));
        return n.toFixed(1);
    }

    // Signed 7-day growth percentage — coloured so green/red signals the trend.
    function fmtPct(n) {
        if (n == null) return "—";
        const sign = n > 0 ? "+" : "";
        const color = n > 0 ? "#4caf50" : n < 0 ? "#ef5350" : "#aaa";
        return `<span style="color:${color}">${sign}${n.toFixed(1)}%</span>`;
    }

    async function renderRecruit(el) {
        let filters = loadRecruitFilters();
        let visibleCols = loadRecruitColumns();

        // Force a high-contrast colour on filter inputs/selects so a user-
        // entered value is visually distinct from the dim placeholder text.
        const inputStyle = "font-size:13px;color:#fff;background:#1a2329;border:1px solid #2a3640;border-radius:3px;padding:3px 6px";
        const inputStyleNum = `${inputStyle};`;

        // Build stat-filter inputs HTML once. Filters with `parser` accept
        // human shorthand (10m, 3b, …) and use a text input with a custom
        // placeholder showing example values.
        const statFiltersHTML = RECRUIT_STAT_FILTERS.map((sf) => {
            const type = sf.inputType || "number";
            const placeholder = sf.placeholder || "min";
            const numAttrs = type === "number"
                ? `min="0" ${sf.step ? `step="${sf.step}"` : ""}`
                : "";
            return `
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888"${sf.tooltip ? ` title="${escapeAttr(sf.tooltip)}"` : ""}>
                    ${sf.label}
                    <input type="${type}" id="tat-rec-${sf.id}" ${numAttrs}
                           placeholder="${escapeAttr(placeholder)}" value="${escapeAttr(filters[sf.id] ?? "")}"
                           style="${inputStyleNum};width:${sf.width}px">
                </label>
            `;
        }).join("");

        el.innerHTML = `
            <div class="tat-grid-controls" style="row-gap:8px;align-items:flex-end">
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888" title="Maximum player level (1–100). Defaults to 100 (no upper bound).">Max level
                    <input type="number" id="tat-rec-max-level" min="1" max="100" placeholder="100" value="${filters.maxLevel}" style="${inputStyle};width:70px">
                </label>
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888" title="Minimum account age in days since signup. Leave blank for no minimum.">Min age (d)
                    <input type="number" id="tat-rec-min-age" min="0" placeholder="—" value="${filters.minAge}" style="${inputStyle};width:80px">
                </label>
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888" title="Show only players whose last action falls within this window. Uses our derived last-active signal (≤24h fresh for tracked users), falling back to weekly HoF data for untracked ones.">Active
                    <select id="tat-rec-active" style="${inputStyle}">
                        <option value="1"${filters.maxLastActionDays === 1 ? " selected" : ""}>1d</option>
                        <option value="3"${filters.maxLastActionDays === 3 ? " selected" : ""}>3d</option>
                        <option value="7"${filters.maxLastActionDays === 7 ? " selected" : ""}>7d</option>
                        <option value="14"${filters.maxLastActionDays === 14 ? " selected" : ""}>14d</option>
                        <option value="30"${filters.maxLastActionDays === 30 ? " selected" : ""}>30d</option>
                    </select>
                </label>
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888" title="How far back the rate columns (Xanax/d, Refills/d, RW hits/wk, Activity min/day, Donator) look when computing averages. Wider = more stable but slower to react to recent change.">Window
                    <select id="tat-rec-window" style="${inputStyle}">
                        <option value="1"${filters.windowDays === 1 ? " selected" : ""}>1 day</option>
                        <option value="3"${filters.windowDays === 3 ? " selected" : ""}>3 days</option>
                        <option value="7"${filters.windowDays === 7 ? " selected" : ""}>1 week</option>
                        <option value="14"${filters.windowDays === 14 ? " selected" : ""}>2 weeks</option>
                        <option value="30"${filters.windowDays === 30 ? " selected" : ""}>1 month</option>
                    </select>
                </label>
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888" title="Faction membership filter. None = unfactioned only. Not mine = exclude your own faction's members. Any = no restriction.">Faction
                    <select id="tat-rec-faction-status" style="${inputStyle}">
                        <option value="none"${filters.factionStatus === "none" ? " selected" : ""}>None</option>
                        <option value="not_mine"${filters.factionStatus === "not_mine" ? " selected" : ""}>Not mine</option>
                        <option value="any"${filters.factionStatus === "any" ? " selected" : ""}>Any</option>
                    </select>
                </label>
                <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:#bbb;padding-bottom:5px" title="Show only players whose donator_days counter grew within the chosen window — i.e. they're currently a Torn donator.">
                    <input type="checkbox" id="tat-rec-donator-only" ${filters.donatorOnly ? "checked" : ""}>
                    Donator
                </label>
                <label style="display:inline-flex;flex-direction:column;font-size:11px;color:#888" title="Match by username (case-insensitive substring) or numeric Torn user ID.">Search
                    <input type="text" id="tat-rec-search" placeholder="name or id" value="${escapeAttr(filters.search || "")}" style="${inputStyle};width:140px">
                </label>
                ${statFiltersHTML}
                <button class="tat-btn tat-btn-primary" id="tat-rec-apply" style="padding:6px 14px;font-size:13px">Apply</button>
                <button class="tat-btn tat-btn-export" id="tat-rec-reset" style="padding:6px 10px;font-size:12px" title="Reset all filters">Reset</button>
            </div>

            <div id="tat-rec-col-toggle" style="display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 10px;font-size:11px"></div>

            <div style="background:#1f2a33;border-left:3px solid #4fc3f7;color:#bbb;padding:8px 12px;margin:0 0 10px;font-size:12px;line-height:1.5;border-radius:3px">
                <b style="color:#4fc3f7">Heads up:</b> the
                <b style="color:#ddd">Xanax/d</b>, <b style="color:#ddd">Refills E/d</b>,
                <b style="color:#ddd">RW hits/wk</b>, <b style="color:#ddd">Activity min/day</b>,
                <b style="color:#ddd">Net Δ%/wk</b>, and <b style="color:#ddd">Donator</b> filter
                are calculated over the <b>Window</b> dropdown (default 1 month).
                Each user's snapshot closest to that window's start is the baseline,
                bounded by our 30-day retention. Users we just discovered may show
                <span style="color:#888">—</span> until two snapshots accumulate.
                Hover any column chip or filter for a description.
            </div>

            <div id="tat-rec-status" class="tat-status">Loading candidates...</div>
            <div class="tat-grid-wrap">
                <table class="tat-grid" id="tat-rec-table" style="display:none">
                    <thead><tr id="tat-rec-thead-row"></tr></thead>
                    <tbody id="tat-rec-tbody"></tbody>
                </table>
            </div>
            <div id="tat-rec-pager" style="display:flex;justify-content:space-between;align-items:center;margin-top:12px;color:#888;font-size:12px"></div>
        `;

        // Build the column-toggle chip row
        function renderColToggle() {
            const wrap = document.getElementById("tat-rec-col-toggle");
            wrap.innerHTML = `<span style="color:#888;align-self:center;margin-right:4px">Columns:</span>` +
                RECRUIT_COLS.filter((c) => !c.fixed).map((c) => {
                    const checked = visibleCols[c.id] ? "checked" : "";
                    const title = c.tooltip ? ` title="${escapeAttr(c.tooltip)}"` : "";
                    return `<label class="tat-col-chip"${title}><input type="checkbox" data-col="${c.id}" ${checked}><span>${escapeHtml(c.label)}</span></label>`;
                }).join("");
            wrap.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
                cb.addEventListener("change", () => {
                    visibleCols[cb.dataset.col] = cb.checked;
                    saveRecruitColumns(visibleCols);
                    renderTableShape();
                });
            });
        }

        function visibleColDefs() {
            return RECRUIT_COLS.filter((c) => visibleCols[c.id]);
        }

        function renderTableShape() {
            const cols = visibleColDefs();
            const headerRow = document.getElementById("tat-rec-thead-row");
            headerRow.innerHTML = cols.map((c) => {
                const sortAttr = c.sortKey ? ` data-col="${c.sortKey}"` : "";
                const align = c.align === "left" ? ' style="text-align:left"' : "";
                let cls = "";
                if (c.sortKey && filters.sort === c.sortKey) cls = filters.sortDir === "asc" ? "sort-asc" : "sort-desc";
                return `<th${sortAttr}${align}${cls ? ` class="${cls}"` : ""}>${escapeHtml(c.label)}</th>`;
            }).join("");

            // Re-bind sort clicks
            headerRow.querySelectorAll("th[data-col]").forEach((th) => {
                th.onclick = () => {
                    const col = th.dataset.col;
                    if (filters.sort === col) {
                        filters.sortDir = filters.sortDir === "asc" ? "desc" : "asc";
                    } else {
                        filters.sort = col;
                        filters.sortDir = col === "username" ? "asc" : "desc";
                    }
                    filters.offset = 0;
                    saveRecruitFilters(filters);
                    fetchAndRender();
                };
            });

            // Repaint body if we already have data cached
            if (lastUsers) renderBody(lastUsers);
        }

        let lastUsers = null;

        function renderBody(users) {
            const cols = visibleColDefs();
            const tbody = document.getElementById("tat-rec-tbody");
            tbody.innerHTML = users.map((u) => {
                const cells = cols.map((c) => {
                    const align = c.align === "left" ? ' style="text-align:left"' : "";
                    return `<td${align}>${c.render(u)}</td>`;
                }).join("");
                return `<tr>${cells}</tr>`;
            }).join("");
        }

        // Submit on Enter from any input/select in the controls bar
        el.querySelector(".tat-grid-controls").addEventListener("keydown", (e) => {
            if (e.key === "Enter") document.getElementById("tat-rec-apply").click();
        });

        async function fetchAndRender() {
            const status = document.getElementById("tat-rec-status");
            const table = document.getElementById("tat-rec-table");
            status.textContent = "Loading candidates...";
            table.style.display = "none";

            const params = new URLSearchParams({
                maxLastActionDays: String(filters.maxLastActionDays),
                windowDays: String(filters.windowDays),
                maxLevel: String(filters.maxLevel),
                factionStatus: filters.factionStatus,
                offset: String(filters.offset),
                limit: String(filters.limit),
                sort: filters.sort,
                sortDir: filters.sortDir,
            });
            if (filters.minAge !== "" && filters.minAge != null) params.set("minAge", String(filters.minAge));
            if (filters.donatorOnly) params.set("donatorOnly", "true");
            if (filters.search && filters.search.trim()) params.set("search", filters.search.trim());
            for (const sf of RECRUIT_STAT_FILTERS) {
                const raw = filters[sf.id];
                if (raw === "" || raw == null) continue;
                const v = sf.parser ? sf.parser(raw) : raw;
                if (v === "" || v == null) continue;
                params.set(sf.id, String(v));
            }

            let data;
            try {
                data = await backendRequest("GET", `/v1/recruitment/candidates?${params}`);
            } catch (err) {
                status.innerHTML = `<span style="color:#ef5350">Failed to load candidates: ${escapeHtml(err.error || err.message || "unknown error")}</span>`;
                return;
            }

            const users = data.users || [];
            lastUsers = users;
            if (users.length === 0) {
                status.textContent = data.total === 0
                    ? "No users match these filters."
                    : "No more results on this page.";
                document.getElementById("tat-rec-pager").innerHTML = "";
                return;
            }

            renderTableShape();
            renderBody(users);

            status.textContent = `${data.total} matching users · showing ${filters.offset + 1}–${filters.offset + users.length}`;
            table.style.display = "";

            // Pager
            const pager = document.getElementById("tat-rec-pager");
            const hasPrev = filters.offset > 0;
            const hasNext = filters.offset + users.length < data.total;
            pager.innerHTML = `
                <div>Page ${Math.floor(filters.offset / filters.limit) + 1} of ${Math.max(1, Math.ceil(data.total / filters.limit))}</div>
                <div style="display:flex;gap:6px">
                    <button class="tat-btn tat-btn-export" id="tat-rec-prev" ${hasPrev ? "" : "disabled"}>← Prev</button>
                    <button class="tat-btn tat-btn-export" id="tat-rec-next" ${hasNext ? "" : "disabled"}>Next →</button>
                </div>
            `;
            document.getElementById("tat-rec-prev").addEventListener("click", () => {
                if (!hasPrev) return;
                filters.offset = Math.max(0, filters.offset - filters.limit);
                fetchAndRender();
            });
            document.getElementById("tat-rec-next").addEventListener("click", () => {
                if (!hasNext) return;
                filters.offset += filters.limit;
                fetchAndRender();
            });
        }

        function readNum(id, fallback) {
            const raw = document.getElementById(id).value;
            return raw === "" ? "" : Number(raw);
        }

        document.getElementById("tat-rec-apply").addEventListener("click", () => {
            const maxLvl = Number(document.getElementById("tat-rec-max-level").value) || RECRUIT_DEFAULTS.maxLevel;
            filters.maxLevel = Math.max(1, Math.min(100, maxLvl));

            filters.minAge = readNum("tat-rec-min-age");

            filters.maxLastActionDays = Number(document.getElementById("tat-rec-active").value) || 7;
            filters.windowDays = Number(document.getElementById("tat-rec-window").value) || 30;
            filters.factionStatus = document.getElementById("tat-rec-faction-status").value;
            filters.donatorOnly = document.getElementById("tat-rec-donator-only").checked;
            filters.search = document.getElementById("tat-rec-search").value || "";

            for (const sf of RECRUIT_STAT_FILTERS) {
                // For filters with a parser, store the user's raw text so it
                // roundtrips on reload. Parsing is deferred to fetch time.
                if (sf.parser) {
                    filters[sf.id] = document.getElementById(`tat-rec-${sf.id}`).value.trim();
                } else {
                    filters[sf.id] = readNum(`tat-rec-${sf.id}`);
                }
            }

            filters.offset = 0;
            saveRecruitFilters(filters);
            fetchAndRender();
        });

        document.getElementById("tat-rec-reset").addEventListener("click", () => {
            filters = { ...RECRUIT_DEFAULTS };
            saveRecruitFilters(filters);
            renderRecruit(el);
        });

        renderColToggle();
        await fetchAndRender();
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
                ${adminCard("Snapshots", `~${s.activity_snapshots.total_rows.toLocaleString()} rows · ${s.activity_snapshots.distinct_users.toLocaleString()} users · ${s.activity_snapshots.distinct_factions} factions`
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

            <div style="background:#252525;border:1px solid #333;border-radius:8px;padding:10px 14px;margin-bottom:16px">
                <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px">Activity Data Source (you only)</div>
                <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
                    <select id="tat-activity-source" style="background:#1c1c1c;border:1px solid #444;color:#ddd;padding:4px 8px;border-radius:4px;font-size:13px">
                        <option value="legacy">Legacy (hourly snapshots)</option>
                        <option value="new">New (5-min bitmap store)</option>
                    </select>
                    <span id="tat-activity-source-status" style="color:#888;font-size:12px"></span>
                </div>
                <div style="color:#666;font-size:11px;margin-top:6px">
                    Switches only your reads between the two stores. Everyone else stays on Legacy.
                    New store: ~${(s.activity_daily?.total_rows ?? 0).toLocaleString()} rows ·
                    write ${s.activity_daily?.write_enabled ? "on" : "off"} ·
                    ${s.activity_daily?.retention_days ?? "?"}d retention.
                </div>
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
        loadActivitySourceToggle();

        document.getElementById("tat-log-level").addEventListener("change", loadAdminLogs);
        document.getElementById("tat-log-refresh").addEventListener("click", loadAdminLogs);
    }

    // Activity-source toggle (admin only). Reads/writes the per-user setting on
    // the backend; changing it flips ONLY this user between the legacy hourly
    // store and the new 5-minute bitmap store. Everyone else is unaffected.
    async function loadActivitySourceToggle() {
        const sel = document.getElementById("tat-activity-source");
        const status = document.getElementById("tat-activity-source-status");
        if (!sel) return;
        try {
            const cur = await backendRequest("GET", "/v1/admin/activity-source");
            sel.value = cur.source === "new" ? "new" : "legacy";
        } catch {
            if (status) status.textContent = "(failed to load current source)";
        }
        sel.addEventListener("change", async () => {
            const source = sel.value;
            if (status) status.textContent = "Saving…";
            sel.disabled = true;
            try {
                await backendRequest("POST", "/v1/admin/activity-source", { source });
                if (status) status.textContent = `Now reading: ${source === "new" ? "New (5-min)" : "Legacy"}. Reopen a tab to see it.`;
            } catch (err) {
                if (status) status.textContent = `Failed: ${err.error || err.status || "error"}`;
            } finally {
                sel.disabled = false;
            }
        });
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
            render();
            // Torn's SPA swaps the footer DOM on navigation, taking our buttons
            // with it. Keep observing indefinitely and re-render whenever the
            // ref button is back but our buttons are gone. Throttled via rAF.
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
