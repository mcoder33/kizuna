const PHRASES = [
  "Какая мысль зацепила?",
  "What thought caught your attention?",
  "どんな考えが心に引っかかりましたか？",
  "¿Qué idea te llamó la atención?",
  "Quelle idée a retenu votre attention ?",
];

// The prompt lives outside the editable field, so its animation never changes
// the user's text or caret position.
export function createCapturePrompt(field) {
  const editor = field.element;
  const prompt = document.createElement("span");
  prompt.className = "capture-prompt";
  prompt.setAttribute("aria-hidden", "true");
  editor.after(prompt);

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let timer;
  let running = false;
  let phraseIndex = 0;
  let letters = Array.from(PHRASES[0]);
  let length = letters.length;
  let erasing = true;

  function step() {
    if (erasing) {
      length -= 1;
      if (length === 0) {
        phraseIndex = (phraseIndex + 1) % PHRASES.length;
        letters = Array.from(PHRASES[phraseIndex]);
        erasing = false;
        timer = setTimeout(step, 450);
        prompt.textContent = "";
        return;
      }
      timer = setTimeout(step, 35);
    } else {
      length += 1;
      if (length === letters.length) {
        erasing = true;
        timer = setTimeout(step, 2200);
      } else {
        timer = setTimeout(step, 85);
      }
    }
    prompt.textContent = letters.slice(0, length).join("");
  }

  function sync() {
    const visible = editor.dataset.empty === "true"
      && !editor.matches(":focus-within")
      && editor.dataset.disabled !== "true"
      && !document.hidden
      && !reducedMotion.matches;
    editor.classList.toggle("capture-prompt-active", visible);
    prompt.classList.toggle("is-visible", visible);
    if (!visible) {
      clearTimeout(timer);
      timer = undefined;
      running = false;
      return;
    }
    if (running) return;
    running = true;
    phraseIndex = 0;
    letters = Array.from(PHRASES[0]);
    length = letters.length;
    erasing = true;
    prompt.textContent = PHRASES[0];
    timer = setTimeout(step, 2200);
  }

  editor.addEventListener("focusin", sync);
  editor.addEventListener("focusout", sync);
  document.addEventListener("visibilitychange", sync);
  reducedMotion.addEventListener("change", sync);
  sync();
  return { sync };
}
