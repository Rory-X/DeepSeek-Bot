// The two-column app tiles a settings page lists its services with: the IM page builds its
// platform cards from these classes, and the upstream connectors page used the same base.
// Our fork keeps its own connector cards, so the tile base lives here and ships with the
// shell styles: opening IM (or any page with tiles) directly must not depend on having
// visited Connectors first.
export const APP_TILE_CSS = `
.bt-apps{display:flex;flex-direction:column;gap:14px;container-type:inline-size}
.bt-app-bar{display:flex;align-items:center;gap:8px}
.bt-app-search{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:36px;padding:0 14px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-card);color:var(--bt-ink-3);cursor:text}
.bt-app-search:focus-within{border-color:var(--bt-line-2)}
.bt-app-search svg{flex:none;width:15px;height:15px}
.bt-app-search input{flex:1;min-width:0;border:0;outline:none;background:none;color:var(--bt-ink);font:inherit;font-size:13px}
.bt-app-search input::-webkit-search-cancel-button{display:none}
.bt-app-pill,.bt-app-summary{flex:none;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-card);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease}
.bt-app-pill:hover,.bt-app-summary:hover{background:var(--bt-hover)}
.bt-app-pill svg{width:14px;height:14px}
.bt-app-summary{padding:0 10px 0 6px;border-color:transparent;background:none;color:var(--bt-ink-2)}
.bt-app-summary svg{width:12px;height:12px}
.bt-app-stack{display:inline-flex}
.bt-app-stack .bt-app-icon{border-radius:6px;box-shadow:0 0 0 1.5px var(--bt-main)}
.bt-app-stack .bt-app-icon+.bt-app-icon{margin-left:-6px}
.bt-app-stack .bt-app-icon svg,.bt-app-stack .bt-connector-mono{width:13px;height:13px;font-size:9px}
.bt-app-chips{display:flex;flex-wrap:wrap;gap:6px}
.bt-app-chips button{height:28px;padding:0 12px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-app-chips button:hover{background:var(--bt-active)}
.bt-app-chips button[aria-pressed=true]{background:var(--bt-ink);color:var(--bt-main)}
.bt-app-section{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.bt-app-section-head{display:flex;align-items:center;justify-content:space-between;min-height:24px}
.bt-app-section-head h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
.bt-app-all{border:0;background:none;padding:2px 4px;color:var(--bt-ink-3);font:inherit;font-size:12px;cursor:pointer}
.bt-app-all:hover{color:var(--bt-ink)}
.bt-app-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:28px}
@container (max-width:520px){.bt-app-grid{grid-template-columns:minmax(0,1fr)}}
.bt-app{position:relative;display:flex;align-items:center;gap:10px;min-height:60px;border-radius:12px}
.bt-app-main{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.bt-app-icon{--bt-mark-ink:var(--bt-ink);flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 .5px var(--bt-line-2)}
.bt-app-icon svg{width:22px;height:22px}
.bt-app-text{min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-app-name{display:inline-flex;align-items:center;gap:6px;font-size:14px;line-height:20px;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-app-status{font-size:12px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-app[data-state=error] .bt-app-status,.bt-app[data-error] .bt-app-status{color:var(--bt-danger)}
.bt-app-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:72px;height:28px;padding:0 14px;border:0;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:13px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-app-btn:hover:not(:disabled){background:var(--bt-active)}
.bt-app-btn:disabled{opacity:.5;cursor:default}
.bt-app-btn svg{width:13px;height:13px}
.bt-app-btn-done{background:none;color:var(--bt-ink-2);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-app-icon svg{transition:filter .6s ease,opacity .6s ease}
.bt-app:not([data-state=ready]) .bt-app-icon svg{filter:grayscale(1);opacity:.5}
.bt-app[data-fresh] .bt-app-icon{animation:bt-app-pop .5s cubic-bezier(.3,1.5,.5,1)}
.bt-app[data-fresh]::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 28%,color-mix(in srgb,var(--bt-ink) 7%,transparent) 44%,color-mix(in srgb,var(--bt-ink) 2%,transparent) 50%,color-mix(in srgb,var(--bt-ink) 7%,transparent) 56%,transparent 72%);background-size:300% 100%;border-radius:inherit;animation:bt-app-shine .9s cubic-bezier(.25,.8,.3,1) both}
.bt-app[data-fresh] .bt-app-btn-done{animation:bt-app-done .4s ease-out}
@keyframes bt-app-pop{0%{transform:scale(.86)}55%{transform:scale(1.07)}100%{transform:scale(1)}}
@keyframes bt-app-shine{0%{background-position:100% 0}100%{background-position:0 0}}
@keyframes bt-app-done{0%{opacity:.4;transform:scale(.94)}100%{opacity:1;transform:none}}
.bt-app-empty{margin:24px 0;text-align:center;font-size:13px;color:var(--bt-ink-3)}
.bt-app-sub{display:flex;flex-direction:column;gap:12px}
.bt-app-sub-head{display:flex;align-items:center;gap:4px;margin-left:-6px}
.bt-app-sub-head h3{margin:0;font-size:14px;line-height:20px;font-weight:600}
.bt-app-about{margin:0 4px;font-size:13px;line-height:20px;color:var(--bt-ink-2)}
[data-bt-motion=off] .bt-app,[data-bt-motion=off] .bt-app *,[data-bt-motion=off] .bt-app::after{animation:none!important;transition:none!important}
@media (prefers-reduced-motion:reduce){.bt-app[data-fresh]::after,.bt-app[data-fresh] .bt-app-icon,.bt-app[data-fresh] .bt-app-btn-done{animation:none}}
`
