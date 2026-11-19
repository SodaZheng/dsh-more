import { APPROVAL_MS } from '../shared.js'

let nextControlId = 0

function confirmCommand(box: HTMLElement, text: string, signal: AbortSignal): Promise<boolean> {
  const doc = box.ownerDocument
  const label = doc.createElement('strong')
  label.textContent = '确认后发送到终端并按回车'
  const command = doc.createElement('pre')
  command.dir = 'ltr'
  command.textContent = text
  const allow = doc.createElement('button')
  allow.type = 'button'
  allow.className = 'tc-allow'
  allow.textContent = '允许这一次'
  const deny = doc.createElement('button')
  deny.type = 'button'
  deny.textContent = '拒绝'
  const actions = doc.createElement('div')
  actions.className = 'tc-actions'
  actions.append(deny, allow)
  box.replaceChildren(label, command, actions)
  return new Promise(resolve => {
    const done = (approved: boolean) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      box.replaceChildren()
      resolve(approved)
    }
    const cancel = () => done(false)
    const timer = setTimeout(cancel, APPROVAL_MS)
    allow.onclick = () => done(true)
    deny.onclick = cancel
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
  })
}

export function controlBar(doc: Document) {
  const bar = doc.createElement('section')
  bar.className = 'dshmore-terminal-control'
  bar.setAttribute('aria-label', '对话控制')
  const header = doc.createElement('div')
  header.className = 'tc-header'
  const label = doc.createElement('label')
  const mark = doc.createElement('span')
  mark.className = 'tc-symbol'
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = '›_'
  label.append(mark, '对话控制')

  const choice = doc.createElement('div')
  choice.className = 'tc-choice'
  const select = doc.createElement('select')
  select.id = 'dshmore-terminal-mode-' + ++nextControlId
  label.htmlFor = select.id
  for (const [value, text] of [['off', '关闭'], ['restricted', '受限控制'], ['full', '完全控制']] as const) {
    const option = doc.createElement('option')
    option.value = value
    option.textContent = text
    select.append(option)
  }
  select.title = '受限控制逐条确认命令；完全控制按当前终端权限直接输入。'
  choice.append(select)
  const help = doc.createElement('button')
  help.type = 'button'
  help.className = 'tc-help'
  help.textContent = '怎么用'
  const example = doc.createElement('div')
  example.id = select.id + '-help'
  example.className = 'tc-example'
  example.hidden = true
  const prompt = doc.createElement('q')
  prompt.textContent = '请在右侧终端执行 pwd，然后告诉我当前目录。'
  example.append('选择控制模式后，在当前对话中发送', prompt)
  help.setAttribute('aria-controls', example.id)
  help.setAttribute('aria-expanded', 'false')
  help.onclick = () => {
    example.hidden = !example.hidden
    help.setAttribute('aria-expanded', String(!example.hidden))
  }
  header.append(label, help, choice)
  const status = doc.createElement('div')
  status.className = 'tc-status'
  status.setAttribute('role', 'status')
  const box = doc.createElement('div')
  box.className = 'tc-approval'
  const history = doc.createElement('details')
  history.className = 'tc-history'
  const summary = doc.createElement('summary')
  const title = doc.createElement('span')
  title.textContent = '最近操作'
  const latest = doc.createElement('span')
  latest.className = 'tc-latest'
  const time = doc.createElement('time')
  summary.append(title, latest, time)
  const entries = doc.createElement('ol')
  history.hidden = true
  history.append(summary, entries)
  function record(action: string, command?: string): void {
    const now = new Date()
    time.dateTime = now.toISOString()
    time.textContent = now.toLocaleTimeString(undefined, { hour12: false })
    const row = doc.createElement('li')
    const detail = doc.createElement('span')
    detail.textContent = action
    if (command) {
      const code = doc.createElement('code')
      code.textContent = command
      detail.append(' ', code)
    }
    row.append(time.cloneNode(true), detail)
    latest.textContent = command ?? action
    latest.classList.toggle('tc-command', !!command)
    entries.prepend(row)
    if (entries.children.length > 8) entries.lastElementChild?.remove()
    history.hidden = false
  }
  bar.append(header, status, example, box, history)
  return { bar, select, status, record, confirm: (text: string, signal: AbortSignal) => confirmCommand(box, text, signal) }
}
