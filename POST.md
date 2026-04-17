# Torn Activity Tracker — Torn forum post

Paste the HTML below into a Torn forum post (Tools & Userscripts subforum). The
top paragraph marks it as a temp/beta thread — remove that block once you're
ready to move it to the public space.

Screenshots already point at real `editor.torn.com/...` URLs. The three
`PASTE_*_SCREENSHOT_URL_HERE` entries in the `href`s are hrefs only (the
`src` is already set) — replace them if you want the "click-to-enlarge"
links to point at the full-size image.

---

```html
<p style="text-align: center;">
  <span style="font-size: 22px;"
    ><strong
      >This is temp post, I'll move it to public space when collect enough history (around 2 weeks) and complete testing
      stage</strong
    ></span
  >
</p>
<p style="text-align: center;">&nbsp;</p>
<p style="text-align: center;">
  <span style="font-size: 22px;"><strong>📊 Torn Activity Tracker</strong></span> <br /><span style="font-size: 14px;"
    ><em>Strike when they're asleep</em></span
  >
</p>
<p>&nbsp;</p>
<p>
  Tired of starting a chain only to watch the enemy faction wake up and counter? Or wondering whether 8 PM is just
  <em>their</em> dead hour or <em>every</em> faction's dead hour? Same. Built a script that tracks when every member of
  any faction is actually online, hour by hour, going back 30 days &mdash; so you actually know when to push, when to
  turtle, and when their best hitters are asleep.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🎯 What it tracks</strong></span>
</p>
<p>&nbsp;</p>
<ul>
  <li>When every faction member is online &mdash; <strong>hour by hour, up to 30 days back</strong></li>
  <li>Auto-detects your <strong>ranked war opponent</strong> and starts tracking them immediately</li>
  <li>Side-by-side <strong>comparison heatmap</strong>: your faction vs theirs</li>
  <li>Per-member breakdown &mdash; who's the always-on sweat, who only shows up on weekends</li>
  <li>Optional <strong>FFScouter battle stats</strong> overlay so you know who hits hard <em>and</em> when</li>
  <li>Watchlist for factions you want to scout <strong>before</strong> declaring</li>
</ul>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚔️ Who is this for?</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Faction war leaders timing the push, chain organizers picking the best window, spies scouting potential matchmaking
  opponents, and anyone who's tired of guessing what time the enemy faction wakes up.
</p>
<p>&nbsp;</p>
<blockquote><strong>Stop pushing into a wall. Strike when they're asleep.</strong></blockquote>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🌡️ Hour Grid</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Color-coded heatmap: dates as rows, 24 hours as columns, % of members online each hour. Faction selector covers your
  own faction, your watchlist, and the auto-detected war opponent. Pick a 3 / 7 / 14 / 30 day window. Optional
  <strong>Include idle</strong> toggle counts idle members alongside online.
</p>
<p>&nbsp;</p>
<p>
  <a href="/PASTE_HOUR_GRID_SCREENSHOT_URL_HERE" target="_blank" rel="noopener"
    ><img
      src="https://editor.torn.com/4ed288ec-2e49-46a6-b8e5-9c27b380ed10-4192025.png"
      alt="4ed288ec-2e49-46a6-b8e5-9c27b380ed10-4192025.png"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🆚 Compare</strong></span>
</p>
<p>&nbsp;</p>
<ul>
  <li>Side-by-side <strong>faction member tables</strong> with synchronized scrolling</li>
  <li>Sort by hours online, % online, or estimated battle stats (FFScouter)</li>
  <li>Click a member on each side to open their <strong>personal activity heatmap</strong></li>
  <li>War opponent auto-appears in the dropdown the moment a war is detected</li>
</ul>
<p>&nbsp;</p>
<p>
  <a href="/PASTE_COMPARE_SCREENSHOT_URL_HERE" target="_blank" rel="noopener"
    ><img
      src="https://editor.torn.com/6b90950a-8120-4702-a886-2b9f8c28a7f1-4192025.png"
      alt="6b90950a-8120-4702-a886-2b9f8c28a7f1-4192025.png"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>📈 Weekday Avg</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Average % of members online by hour-of-day across the selected window. Spot recurring patterns at a glance &mdash;
  their reliable dead hours, their peak chain hours, and how those shift across factions.
</p>
<p>&nbsp;</p>
<p>
  <a href="/PASTE_WEEKDAY_AVG_SCREENSHOT_URL_HERE" target="_blank" rel="noopener"
    ><img
      src="https://editor.torn.com/9d7de320-9f1f-491b-af8e-89369f9e8bed-4192025.png"
      alt="9d7de320-9f1f-491b-af8e-89369f9e8bed-4192025.png"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🤖 Smart polling</strong></span>
</p>
<p>&nbsp;</p>
<ul>
  <li>A central backend polls Torn on your behalf at a polite <strong>20 calls/min</strong> (Torn allows 100)</li>
  <li>When multiple users watch the same faction, <strong>only one key polls</strong> &mdash; no wasted budget</li>
  <li>
    Spare API budget grows a <strong>shared activity dataset</strong> so fresh installs see useful data on day one
  </li>
  <li>Ranked war opponents get <strong>promoted to hot priority</strong> the moment a war is detected</li>
</ul>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>⚡ Setup &mdash; 30 seconds</strong></span>
</p>
<p>&nbsp;</p>
<ol>
  <li>Install the script (link below)</li>
  <li>Click the 📊 button in your footer bar</li>
  <li>Paste your <strong>Public</strong> API key &mdash; that's all this script needs</li>
  <li>Come back in ~30 minutes &mdash; the first activity snapshot drops on the next polling cycle</li>
</ol>
<p>&nbsp;</p>
<p>
  <a href="https://editor.torn.com/0f3eaa99-e2bb-4439-93c0-9577569a1301-4192025.png" target="_blank" rel="noopener"
    ><img
      src="https://editor.torn.com/0f3eaa99-e2bb-4439-93c0-9577569a1301-4192025.png"
      alt="0f3eaa99-e2bb-4439-93c0-9577569a1301-4192025.png"
  /></a>
</p>
<p>&nbsp;</p>
<p>
  <span style="font-size: 16px;"><strong>🔒 Privacy</strong></span>
</p>
<p>&nbsp;</p>
<p>
  Your API key is stored <strong>encrypted at rest</strong> (AES-256-GCM) on the backend and used <em>only</em> to fetch
  faction member data on your behalf, capped at 20 calls/minute. Never shared, never logged, never exported. Hit
  <strong>Remove account</strong> in Settings and your key, your watchlist, and everything tied to you is purged
  immediately.
</p>
<p>&nbsp;</p>
<hr />
<p>&nbsp;</p>
<p style="text-align: center;">
  <span style="font-size: 18px;">
    <strong
      ><a
        href="https://greasyfork.org/scripts/573936-torn-activity-tracker/code/Torn%20Activit%20%20%20y%20Tracker.user.js"
        target="_blank"
        rel="noopener"
        >⬇️ Install from Greasyfork</a
      ></strong
    >
  </span>
</p>
<p>&nbsp;</p>
<p style="text-align: center;">
  <em>Works with Tampermonkey, Violentmonkey, or compatible userscript managers.</em> <br /><em
    >Feedback and suggestions welcome &mdash; reply here or message me in-game.</em
  >
</p>
```
