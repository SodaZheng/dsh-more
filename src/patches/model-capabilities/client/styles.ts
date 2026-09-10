export const capabilitiesStyles = `
.dshmore-capabilities-button { box-sizing: border-box; width: 100%; min-height: 30px; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; background: transparent; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 6px; margin-top: 6px; padding: 5px 10px; font-size: 12px; line-height: 18px; text-align: left; overflow-wrap: anywhere; }
.dshmore-capabilities-button:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dshmore-capabilities-dialog, .dshmore-capabilities-fields { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.dshmore-capabilities-dialog { max-height: 65vh; overflow-y: auto; }
.dshmore-capabilities-field { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshmore-capabilities-fields select, .dshmore-capabilities-level input[type="text"] { box-sizing: border-box; min-width: 0; width: 100%; height: 32px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.dshmore-capabilities-fields :disabled { opacity: .55; cursor: default; }
.dshmore-capabilities-fields :focus-visible, .dshmore-capabilities-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dshmore-capabilities-levels { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; min-width: 0; }
.dshmore-capabilities-levels legend { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dshmore-capabilities-level { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(120px, 1.4fr); gap: 8px; align-items: center; min-height: 32px; }
.dshmore-capabilities-level label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshmore-capabilities-level input[type="checkbox"] { accent-color: var(--dsw-alias-state-business-primary); }
.dshmore-capabilities-level small { color: var(--dsw-alias-label-tertiary); }
.dshmore-capabilities-advanced { border-top: 1px solid var(--dsw-alias-border-l3); padding-top: 12px; }
.dshmore-capabilities-advanced summary { cursor: pointer; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dshmore-capabilities-advanced[open] summary { margin-bottom: 12px; }
.dshmore-capabilities-note { color: var(--dsw-alias-label-tertiary); margin: 0; font-size: 12px; line-height: 18px; }
.dshmore-capabilities-error { padding: 8px 10px; border-radius: 8px; background: rgba(208,58,58,.10); color: var(--dsw-alias-state-error-primary, rgb(220,90,90)); font-size: 12px; line-height: 18px; }
`
