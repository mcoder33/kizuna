// Keep one vocabulary and one drawing across the day, cards, board and calendar.
export const IMPORTANCE = Object.freeze([
  { value: 'highest', label: 'Наивысшая', hint: 'Сделать прежде остальных' },
  { value: 'high', label: 'Высокая', hint: 'Важно продвинуть' },
  { value: 'normal', label: 'Обычная', hint: 'Без особого приоритета' },
  { value: 'low', label: 'Низкая', hint: 'Можно отложить' },
]);
export function importanceOf(value) {
  return IMPORTANCE.find(option => option.value === value) || IMPORTANCE[2];
}
export const FLAG = '<svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true"><path d="M4 15V3m0 1c4-3 6 3 10 0v7c-4 3-6-3-10 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 4c3-2 5 3 8 1v5c-3 2-5-3-8-1" fill="currentColor" opacity=".28"/></svg>';
export function importanceMark(value) {
  const mark = document.createElement('span');
  const option = importanceOf(value);
  mark.className = 'importance-mark';
  mark.dataset.importance = option.value;
  mark.setAttribute('aria-hidden', 'true');
  if (option.value !== 'normal') mark.innerHTML = FLAG;
  return mark;
}
let pickerId = 0;
export function importancePicker(value, { t, onChange, readOnly = false }) {
  const element = document.createElement('div');
  element.className = 'importance-property';
  const label = document.createElement('span');
  label.className = 'importance-label';
  label.textContent = t('Важность');
  const current = document.createElement('button');
  current.type = 'button';
  current.className = 'importance-current';
  const options = document.createElement('div');
  options.className = 'importance-options';
  options.id = `importance-options-${++pickerId}`;
  options.setAttribute('role', 'group');
  options.setAttribute('aria-label', t('Выбрать важность'));
  options.hidden = true;
  current.setAttribute('aria-controls', options.id);
  let selected = importanceOf(value).value, pending = false;
  const buttons = [];
  const close = (focus = false) => {
    options.hidden = true;
    current.setAttribute('aria-expanded', 'false');
    if (focus) current.focus();
  };
  const paint = () => {
    const option = importanceOf(selected);
    current.replaceChildren(importanceMark(selected), document.createTextNode(t(option.label)));
    const chevron = document.createElement('span');
    chevron.className = 'importance-chevron';
    chevron.textContent = '⌄';
    chevron.setAttribute('aria-hidden', 'true');
    current.append(chevron);
    current.setAttribute('aria-label', `${t('Важность')}: ${t(option.label)}`);
    current.disabled = pending || readOnly;
    for (const button of buttons) {
      button.disabled = pending || readOnly;
      button.setAttribute('aria-pressed', String(button.dataset.importance === selected));
    }
    element.setAttribute('aria-busy', String(pending));
  };
  const open = () => {
    if (pending || readOnly) return;
    options.hidden = false;
    current.setAttribute('aria-expanded', 'true');
    buttons.find(button => button.dataset.importance === selected)?.focus();
  };
  current.addEventListener('click', () => options.hidden ? open() : close(true));
  for (const option of IMPORTANCE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'importance-choice';
    button.dataset.importance = option.value;
    const copy = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'importance-name';
    name.textContent = t(option.label);
    const hint = document.createElement('small');
    hint.textContent = t(option.hint);
    copy.append(name, hint);
    const check = document.createElement('span');
    check.className = 'importance-check';
    check.textContent = '✓';
    check.setAttribute('aria-hidden', 'true');
    button.append(importanceMark(option.value), copy, check);
    // Safari does not focus buttons on pointer clicks. Keep the picker open
    // until the choice's click, rather than closing on the preceding blur.
    button.addEventListener('pointerdown', event => {
      if (event.button === 0 && event.isPrimary) event.preventDefault();
    });
    button.addEventListener('click', async () => {
      if (pending) return;
      if (selected === option.value) { close(true); return; }
      pending = true;
      paint();
      try {
        await onChange(option.value);
        selected = option.value;
        close();
      } catch {
        // The caller reports the save error. Keep the saved value and allow retry.
      } finally {
        pending = false; paint();
        if (element.isConnected) (options.hidden ? current : button).focus();
      }
    });
    options.append(button);
    buttons.push(button);
  }
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !options.hidden) {
      event.preventDefault(); event.stopPropagation(); close(true);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (options.hidden) { open(); return; }
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  });
  element.addEventListener('focusout', event => {
    if (event.relatedTarget && !element.contains(event.relatedTarget)) close();
  });
  element.append(label, current, options);
  close(); paint();
  return element;
}
