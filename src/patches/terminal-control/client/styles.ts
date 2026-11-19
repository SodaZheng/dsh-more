export const terminalControlStyles = `
.dshmore-terminal-control {
  --tc-text: var(--dsw-alias-label-primary, CanvasText);
  --tc-muted: var(--dsw-alias-label-secondary, color-mix(in srgb, var(--tc-text) 72%, transparent));
  --tc-line: var(--dsw-alias-border-l2, color-mix(in srgb, var(--tc-text) 16%, transparent));
  --tc-fill: var(--dsw-alias-bg-layer-2, color-mix(in srgb, var(--tc-text) 5%, transparent));
  --tc-accent: var(--dsw-alias-brand-primary, #4966b9);
  --tc-code: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  flex: none; min-width: 0; box-sizing: border-box; color: var(--tc-text);
  font: inherit; font-size: 12px; line-height: 1.45; text-align: start;
  padding: 7px 12px; border-bottom: 1px solid var(--tc-line);
}
.dshmore-terminal-control [hidden], .dshmore-terminal-control :is(.tc-status,.tc-approval):empty { display: none; }
.dshmore-terminal-control .tc-header { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
.dshmore-terminal-control label { display: inline-flex; gap: 7px; align-items: center; font-weight: 600; }
.dshmore-terminal-control .tc-symbol {
  display: grid; place-items: center; width: 22px; height: 20px; border-radius: 5px;
  background: var(--tc-fill); border: 1px solid var(--tc-line); font: 600 13px/1 var(--tc-code);
}
.dshmore-terminal-control button, .dshmore-terminal-control select {
  font: inherit; color: inherit; cursor: pointer; box-sizing: border-box;
}
.dshmore-terminal-control .tc-help {
  padding: 3px 2px; color: var(--tc-muted); border: 0; background: transparent; font-size: 11px;
}
.dshmore-terminal-control .tc-help:hover { color: var(--tc-text); text-decoration: underline; }
.dshmore-terminal-control .tc-choice { position: relative; margin-inline-start: auto; }
.dshmore-terminal-control select {
  appearance: none; border-radius: 6px; border: 1px solid var(--tc-line); padding: 3px 24px 3px 10px;
  background: var(--tc-fill); min-height: 26px; font-weight: 550;
}
.dshmore-terminal-control option { background-color: Canvas; color: CanvasText; }
.dshmore-terminal-control .tc-choice::after {
  content: ''; pointer-events: none; position: absolute; right: 10px; top: calc(50% - 4px);
  width: 5px; height: 5px; border: solid currentColor; border-width: 0 1px 1px 0; transform: rotate(45deg);
}
.dshmore-terminal-control :is(select,button,summary):focus-visible {
  outline: 2px solid var(--tc-accent); outline-offset: 2px;
}
.dshmore-terminal-control .tc-status { margin: 4px 0 1px; color: var(--tc-muted); overflow-wrap: anywhere; }
.dshmore-terminal-control .tc-example, .dshmore-terminal-control .tc-approval {
  margin-top: 7px; border-radius: 7px; padding: 8px 10px; background: var(--tc-fill);
}
.dshmore-terminal-control q { display: block; margin-top: 2px; user-select: text; }
.dshmore-terminal-control .tc-approval { border: 1px solid var(--tc-line); }
.dshmore-terminal-control .tc-approval strong { font-weight: 600; }
.dshmore-terminal-control pre {
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 8em; overflow: auto; margin: 6px 0 8px;
  font: 12px/1.5 var(--tc-code); user-select: text; text-align: left;
}
.dshmore-terminal-control .tc-actions { display: flex; justify-content: flex-end; gap: 6px; }
.dshmore-terminal-control .tc-actions button {
  min-height: 26px; padding: 3px 10px; border-radius: 5px; border: 1px solid var(--tc-line); background: transparent;
}
.dshmore-terminal-control .tc-actions .tc-allow { color: var(--dsw-alias-bg-layer-1, Canvas); background: var(--tc-text); border-color: var(--tc-text); }
.dshmore-terminal-control .tc-actions button:hover, .dshmore-terminal-control select:hover { border-color: var(--tc-muted); }
.dshmore-terminal-control .tc-history { margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--tc-line); }
.dshmore-terminal-control summary {
  display: flex; align-items: center; gap: 7px; list-style: none; cursor: pointer; color: var(--tc-muted); font-size: 11px;
}
.dshmore-terminal-control summary::-webkit-details-marker { display: none; }
.dshmore-terminal-control summary::before {
  content: ''; width: 5px; height: 5px; flex: none; border: solid currentColor; border-width: 1px 1px 0 0; transform: rotate(45deg);
}
.dshmore-terminal-control details[open] summary::before { transform: rotate(135deg); }
.dshmore-terminal-control summary > :first-child { flex: none; }
.dshmore-terminal-control .tc-latest { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dshmore-terminal-control .tc-command, .dshmore-terminal-control code { font: 11px/1.5 var(--tc-code); color: var(--tc-text); }
.dshmore-terminal-control time { font-variant-numeric: tabular-nums; color: var(--tc-muted); font-size: 10px; }
.dshmore-terminal-control summary time { margin-inline-start: auto; }
.dshmore-terminal-control ol { list-style: none; padding: 0; margin: 5px 0 0; max-height: 8em; overflow: auto; }
.dshmore-terminal-control li { display: grid; grid-template-columns: auto 1fr; gap: 10px; padding: 3px 0; align-items: baseline; }
.dshmore-terminal-control li span { overflow-wrap: anywhere; min-width: 0; }
`
