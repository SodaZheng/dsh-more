export const fastModeStyles = `
.dshmore-fast-btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.3));
  background: var(--dsw-alias-interactive-bg-idle, rgba(128, 128, 128, 0.08));
  color: var(--dsw-alias-label-primary, inherit);
  cursor: pointer;
  transition: all 0.15s ease-in-out;
  user-select: none;
  white-space: nowrap;
  outline: none;
  margin-right: 6px;
  flex: none;
}

.dshmore-fast-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.18));
  border-color: var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.5));
}

.dshmore-fast-btn--active {
  background: rgba(245, 158, 11, 0.16) !important;
  color: #f59e0b !important;
  border-color: #f59e0b !important;
  box-shadow: 0 0 8px rgba(245, 158, 11, 0.3) !important;
  font-weight: 600;
}

.dshmore-fast-btn:disabled,
.dshmore-fast-btn--busy {
  opacity: 0.6;
  cursor: wait;
}

.dshmore-fast-btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  line-height: 1;
}

.dshmore-fast-btn-label {
  display: inline-block;
  line-height: 1;
}
`
