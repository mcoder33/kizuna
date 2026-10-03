// The native capture reads the rendered web field, including account preferences.
(() => {
  let last = '', timer;
  function sync() {
    const form = document.querySelector('#capture-form');
    const field = document.querySelector('#capture-input');
    const button = document.querySelector('#capture-submit');
    if (!form || !field || !button) return;
    const style = getComputedStyle(form), text = getComputedStyle(field);
    const action = getComputedStyle(button);
    const variable = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const colors = style.backgroundImage.match(/rgba?\([^)]*\)|#[\da-f]{3,8}/gi) || [style.backgroundColor];
    const snapshot = {
      theme: ['light', 'dark'].includes(document.documentElement.dataset.theme) ? document.documentElement.dataset.theme : 'system',
      dark: document.documentElement.dataset.theme === 'dark' ||
        (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches),
      surface: colors[0], surfaceEnd: colors[1] || colors[0],
      border: variable('--capture-line', variable('--n-92', style.borderTopColor)),
      focus: variable('--capture-focus-line', variable('--n-85', style.borderTopColor)),
      ink: text.color, caret: text.caretColor === 'auto' ? text.color : text.caretColor,
      placeholderColor: getComputedStyle(field, '::before').color,
      button: variable('--capture-button', action.backgroundColor),
      buttonHover: variable('--capture-button-hover', action.backgroundColor), buttonInk: action.color,
      muted: getComputedStyle(form.querySelector('.capture-foot') || form).color,
      radius: parseFloat(style.borderTopLeftRadius), padding: parseFloat(style.paddingTop),
      fontSize: parseFloat(text.fontSize), lineHeight: parseFloat(text.lineHeight),
      font: document.documentElement.dataset.font || 'sans',
      placeholder: field.dataset.placeholder || ''
    };
    const value = JSON.stringify(snapshot);
    if (value !== last) { last = value; window.webkit.messageHandlers.kizunaCaptureAppearance.postMessage(snapshot); }
  }
  const refresh = () => { sync(); clearTimeout(timer); timer = setTimeout(sync, 300); };
  new MutationObserver(refresh).observe(document.documentElement, {attributes: true});
  new MutationObserver(records => {
    if (records.some(r => r.target.id === 'capture-input' || [...r.addedNodes].some(n =>
      n.nodeType === 1 && (n.id === 'capture-form' || n.querySelector?.('#capture-form'))))) refresh();
  }).observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['data-placeholder']});
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  window.addEventListener('focus', refresh);
  window.addEventListener('pagent:resume', refresh);
  window.addEventListener('load', refresh);
  refresh();
})();
