export const styles = `
[data-dshmore-hidden] { display: none !important; }
.dshmore-inline-actions { display: inline-flex; align-items: center; gap: 10px; }
.dshmore-inline-button { width: 28px; height: 28px; color: var(--dsw-alias-label-tertiary); cursor: pointer; background: transparent; border: 0; border-radius: 28px; display: inline-flex; align-items: center; justify-content: center; padding: 6px; }
.dshmore-inline-button:hover { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-interactive-bg-hover); }
.dshmore-edit-modal { box-sizing: border-box; width: min(620px, calc(100vw - 32px)) !important; max-width: min(620px, calc(100vw - 32px)) !important; }
.dshmore-dialog-body { box-sizing: border-box; display: grid; gap: 12px; width: 100%; min-width: 0; overflow: hidden; }
.dshmore-message-preview { box-sizing: border-box; width: 100%; min-width: 0; max-height: 132px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; padding: 12px; border-radius: 10px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); font-size: 13px; line-height: 1.55; }
.dshmore-editor { box-sizing: border-box; display: block; width: 100%; min-width: 0; max-width: 100%; resize: vertical; min-height: 150px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; outline: none; padding: 12px; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); font: inherit; line-height: 1.55; overflow-x: hidden; overflow-wrap: anywhere; word-break: break-word; }
.dshmore-editor:focus { border-color: var(--dsw-alias-state-business-primary); }
.dshmore-warning { padding: 10px 12px; border: 1px solid rgba(220,138,40,.35); border-radius: 10px; background: rgba(220,138,40,.09); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dshmore-danger { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border-radius: 10px; background: rgba(208,58,58,.10); color: var(--dsw-alias-state-error-primary, rgb(220,90,90)); font-size: 12px; line-height: 1.5; }
.dshmore-error { padding: 10px 12px; border-radius: 10px; background: rgba(208,58,58,.10); color: var(--dsw-alias-state-error-primary, rgb(220,90,90)); font-size: 12px; line-height: 1.5; }
@media (max-width: 620px) { .dshmore-edit-modal { width: calc(100vw - 24px) !important; max-width: calc(100vw - 24px) !important; } }
.dshmore-action-contribution { display: inline-flex; align-items: center; order: var(--dshmore-action-order); }
.dshmore-config-card { box-sizing: border-box; list-style: none; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); overflow: hidden; transition: border-color .16s, background .16s; }
.dshmore-config-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.dshmore-config-card-open { border-color: var(--dsw-alias-label-dimmed); background: var(--dsw-alias-bg-layer-2); }
.dshmore-config-heading { appearance: none; box-sizing: border-box; width: 100%; color: inherit; font: inherit; text-align: left; cursor: pointer; background: transparent; border: 0; border-radius: 12px; display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.dshmore-config-heading:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.dshmore-config-heading-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 4px; }
.dshmore-config-heading-copy strong { color: var(--dsw-alias-label-primary); font-size: 15px; line-height: 1.4; }
.dshmore-config-heading-copy > span, .dshmore-config-copy span, .dshmore-config-note { color: var(--dsw-alias-label-tertiary); font-size: 13px; line-height: 1.5; }
.dshmore-config-chevron { flex: none; color: var(--dsw-alias-label-tertiary); }
.dshmore-config-chevron-open { transform: rotate(180deg); }
.dshmore-config-body { margin: 0 16px; padding-bottom: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
.dshmore-config-list { display: grid; }
.dshmore-config-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; cursor: pointer; }
.dshmore-config-row + .dshmore-config-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.dshmore-config-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dshmore-config-copy { min-width: 0; display: grid; gap: 2px; }
.dshmore-config-copy strong { color: var(--dsw-alias-label-primary); font-size: 13px; }
.dshmore-config-row input { width: 34px; height: 18px; flex: none; cursor: pointer; accent-color: var(--dsw-alias-state-business-primary); }
.dshmore-config-row input:disabled { cursor: default; opacity: .5; }
.dshmore-config-note, .dshmore-config-error { margin: 0; padding: 10px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
.dshmore-config-error { color: var(--dsw-alias-state-error-primary, rgb(220,90,90)); font-size: 12px; }
@media (prefers-reduced-motion: no-preference) { .dshmore-config-chevron { transition: transform .16s; } }
`
