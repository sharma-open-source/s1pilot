/** Design tokens (docs/design.md §2.1) and report styles, inlined into the HTML report. */
export const REPORT_CSS = `
:root{--bg-app:#F4F4F1;--surface:#FFFFFF;--surface-subtle:#F7F7F5;--surface-muted:#EFEFEC;--border:#D9D9D4;--border-input:#CFCFCA;--divider:#E4E4E0;--divider-row:#EDEDE9;--text:#1C1C1A;--text-strong-2:#2E2E2B;--text-secondary:#4A4A45;--text-muted:#5A5A55;--primary:#1F4FC4;--primary-soft:#E8EEFB;--primary-text:#1A3F9E;--success:#1F6B45;--success-soft:#E3F1E8;--danger:#A0281C;--danger-soft:#FBE7E4;--warning:#8A4B0A;--warning-soft:#FBEFD9;--flaky:#4E3889;--flaky-soft:#EEEAF8;--chart-2:#8C8C86;--track:#EDEDE9;
--sans:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;--mono:'IBM Plex Mono',ui-monospace,monospace}
*{box-sizing:border-box}
body{margin:0;background:var(--bg-app);color:var(--text);font:400 14px/1.5 var(--sans)}
main{max-width:1120px;margin:0 auto;padding:24px 16px}
h1{font-size:28px;font-weight:600;margin:0 0 4px}
h2{font-size:16px;font-weight:600;margin:0 0 12px}
.meta{color:var(--text-secondary);font-size:13px;margin:0 0 20px;overflow-wrap:anywhere}
.mono{font-family:var(--mono)}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}
.tile{flex:1 1 160px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px}
.tile .n{font:600 28px/1.2 var(--mono)}
.tile .l{font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted)}
.filters{display:none;gap:8px;margin-bottom:12px}
.js .filters{display:flex;flex-wrap:wrap}
.filters button{min-height:44px;padding:0 16px;border:1px solid var(--border-input);background:var(--surface);color:var(--text);border-radius:8px;font:500 14px var(--sans);cursor:pointer}
.filters button[aria-pressed=true]{background:var(--primary-soft);color:var(--primary-text);border-color:var(--primary)}
.filters button:focus-visible,summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
details.case{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:12px}
details.case[hidden]{display:none}
summary{cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 16px;min-height:44px}
.key{font:600 13px var(--mono)}
.dur{margin-left:auto;font:400 12px var(--mono);color:var(--text-muted)}
.body{border-top:1px solid var(--divider);padding:12px 16px}
.pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600}
.pill-passed{background:var(--success-soft);color:var(--success)}
.pill-failed{background:var(--danger-soft);color:var(--danger)}
.pill-needs-review{background:var(--warning-soft);color:var(--warning)}
.pill-flaky{background:var(--flaky-soft);color:var(--flaky)}
.pill-blocked,.pill-skipped{background:var(--surface-muted);color:var(--text-strong-2)}
.step{border-bottom:1px solid var(--divider-row);padding:10px 0}
.step:last-child{border-bottom:0}
.step-h{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.box{background:var(--surface-subtle);border:1px solid var(--divider);border-radius:8px;padding:8px 12px;margin-top:8px;font-size:13px;overflow-wrap:anywhere}
.box b{font-size:12px;font-weight:500;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);display:block}
.fail{color:var(--danger)}
ul.asr{list-style:none;margin:4px 0 0;padding:0}
ul.asr li{padding:2px 0}
.bar{display:flex;align-items:center;gap:8px;font:400 12px var(--mono);margin:2px 0}
.bar .lab{flex:0 1 200px;overflow-wrap:anywhere}
.bar .track{flex:1 1 120px;height:8px;background:var(--track);border-radius:4px;overflow:hidden}
.bar .fill{display:block;height:100%;background:var(--chart-2)}
.bar.sel .fill{background:var(--primary)}
.bar .pct{flex:0 0 52px;text-align:right}
.shots{display:flex;gap:8px;overflow-x:auto;margin-top:8px}
.shots img{height:120px;border:1px solid var(--border);border-radius:6px}
.shots a{font:400 12px var(--mono);color:var(--primary-text)}
.empty{color:var(--text-muted)}
`;

/** Tiny progressive-enhancement script: filter buttons only appear when JS runs. */
export const REPORT_JS = `
(function(){
document.documentElement.className+=' js';
var btns=document.querySelectorAll('.filters button');
function apply(f){
btns.forEach(function(b){b.setAttribute('aria-pressed',String(b.getAttribute('data-filter')===f));});
document.querySelectorAll('details.case').forEach(function(d){
var v=d.getAttribute('data-verdict');
d.hidden=!(f==='all'||(f==='failed'&&(v==='failed'||v==='blocked'))||(f==='review'&&v==='needs-review'));});}
btns.forEach(function(b){b.addEventListener('click',function(){apply(b.getAttribute('data-filter'));});});
})();
`;
