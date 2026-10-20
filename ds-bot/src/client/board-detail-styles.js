export const BOARD_DETAIL_CSS = `
.bt-board-drawer{width:min(620px,100%);max-width:100%;flex-shrink:0}
.bt-board-drawer-header,.bt-board-drawer-foot{flex-shrink:0;min-width:0}
.bt-board-drawer-body{min-width:0;min-height:0;overflow-wrap:anywhere;overscroll-behavior:contain}
.bt-board-drawer-body>*{min-width:0;max-width:100%}
.bt-board-drawer-body .bt-set-section{margin:0 0 22px}
.bt-board-drawer-body .bt-set-card{min-width:0;max-width:100%}
.bt-board-detail-title{overflow-wrap:anywhere;font-size:21px}
.bt-board-drawer-body .bt-board-owners{flex-wrap:wrap}
.bt-board-drawer-body .bt-board-owner-name{min-width:0;overflow-wrap:anywhere}
.bt-board-drawer-body .bt-board-error{margin:12px 0}
.bt-board-drawer-foot .bt-board-detail-actions{min-width:0;max-width:100%}
.bt-board-section-note{padding:12px 16px;margin:0;color:var(--bt-ink-2);font-size:12px;line-height:1.6}
.bt-board-step-list,.bt-board-jobs{list-style:none;padding:0;margin:0}
.bt-board-step-list>li,.bt-board-result{padding:16px;min-width:0;font-size:13px}
.bt-board-step-list>li+li,.bt-board-jobs>li+li{border-top:1px solid var(--bt-line)}
.bt-board-item-heading{display:flex;align-items:flex-start;gap:8px;min-width:0;flex-wrap:wrap;line-height:1.6}
.bt-board-item-heading>strong,.bt-board-item-heading>span:not(.bt-board-status):not(.bt-board-step-number){flex:1;min-width:0;font-size:13px;font-weight:550;overflow-wrap:anywhere}
.bt-board-item-heading>svg{width:16px;height:20px;flex:none;color:var(--bt-ink-2)}
.bt-board-step-number{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;flex:none;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:11px;font-variant-numeric:tabular-nums}
.bt-board-step-owner{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:8px 0;color:var(--bt-ink-2);font-size:12px}
.bt-board-status{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:2px 7px;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:11px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-board-status svg{width:12px;height:12px;flex:none}
.bt-board-status[data-state=done],.bt-board-status[data-state=passed]{color:var(--bt-green)}
.bt-board-status[data-state=running]{color:var(--bt-accent);background:var(--bt-tag-bg)}
.bt-board-status[data-state=blocked],.bt-board-status[data-state=unknown],.bt-board-status[data-state=stopping],.bt-board-status[data-state=not-run]{color:var(--bt-star)}
.bt-board-status[data-state=failed]{color:var(--bt-danger)}
.bt-board-text{min-width:0;max-width:100%;margin:8px 0;color:var(--bt-ink-2);font-size:13px;line-height:1.7;overflow-wrap:anywhere}
.bt-board-text p,.bt-board-excerpt{margin:0 0 8px}
.bt-board-text>*{max-width:100%;min-width:0}
.bt-board-text pre{max-width:100%;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;overflow:auto}
.bt-board-text code,.bt-board-reference{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.bt-board-text img{max-width:100%;height:auto}
.bt-board-text table{display:block;max-width:100%;overflow-x:auto}
.bt-board-text a{overflow-wrap:anywhere}
.bt-board-text .bt-more{color:var(--bt-accent);font-size:12px;margin-top:2px}
.bt-board-source{min-width:0;max-width:100%;padding:10px 12px;border-radius:8px;background:var(--bt-main)}
.bt-board-reference{display:block;color:var(--bt-ink-2);font-size:11px;line-height:1.7;margin:0;max-width:100%}
.bt-board-disclosure{min-width:0;max-width:100%;font-size:12px}
.bt-board-disclosure>summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none;color:var(--bt-ink-2);padding:12px 0;min-width:0}
.bt-board-disclosure>summary::-webkit-details-marker{display:none}
.bt-board-disclosure>summary>svg{width:14px;height:14px;flex:none;color:var(--bt-ink-3);transition:transform .15s}
.bt-board-disclosure[open]>summary>svg{transform:rotate(90deg)}
.bt-board-disclosure>summary>span:not(.bt-board-section-count){min-width:0;overflow-wrap:anywhere}
.bt-board-section-count{margin-left:auto;font-size:11px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-board-disclosure-body{min-width:0;max-width:100%}
.bt-board-disclosure h4{font-size:12px;font-weight:550;color:var(--bt-ink);margin:14px 0 6px}
.bt-board-inline-disclosure{margin-top:8px}
.bt-board-inline-disclosure>summary{padding:4px 0;font-size:12px}
.bt-board-context,.bt-board-history{border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card);padding:0 16px;margin:0 0 22px}
.bt-board-context>.bt-board-disclosure-body,.bt-board-history>.bt-board-disclosure-body{padding-bottom:12px}
.bt-board-history>.bt-board-disclosure-body>.bt-board-disclosure{border-top:1px solid var(--bt-line)}
.bt-board-jobs>li{padding:10px 0}
.bt-set-card>.bt-board-jobs{padding:0 16px}
.bt-board-jobs .bt-board-item-heading>span:first-child{font-size:12px;font-weight:400;color:var(--bt-ink-2)}
.bt-board-history .bt-board-result{padding:12px 0}
.bt-board-decision{margin-top:20px}
.bt-board-decision .bt-board-text{font-size:13px}
.bt-board-decision .bt-board-text p{font-size:inherit}
.bt-board-decision .bt-board-answer{margin:12px 0}
.bt-board-answer textarea{min-width:0;max-width:100%}
@media(max-width:899px){
 .bt-board-drawer{width:100%}
 .bt-board-drawer-body{padding:18px 16px}
 .bt-board-drawer-foot{padding:12px 16px calc(12px + env(safe-area-inset-bottom))}
 .bt-board-detail-actions .bt-board-button{font-size:12px;padding:0 12px}
 .bt-board-detail-title{font-size:20px}
 .bt-board-step-list>li,.bt-board-result{padding:14px}
 .bt-board-item-heading>.bt-board-status{font-size:10px}
}
@media(prefers-reduced-motion:reduce){.bt-board-disclosure>summary>svg{transition:none}}
`
