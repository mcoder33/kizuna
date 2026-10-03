const KEY = 'pagent.public-todo-intent';
const tokenPattern = /^[A-Za-z0-9_-]{24,128}$/;
export function rememberShare(token) {
  if (!tokenPattern.test(token)) return false;
  sessionStorage.setItem(KEY, JSON.stringify({ token, createdAt: Date.now() }));
  return true;
}
export function shareReturnPath() {
  try {
    const intent = JSON.parse(sessionStorage.getItem(KEY));
    if (tokenPattern.test(intent?.token) && Date.now() - intent.createdAt < 60 * 60 * 1000) return `/s/${intent.token}?resume=1`;
  } catch {}
  sessionStorage.removeItem(KEY);
  return '/';
}
export function forgetShare() { sessionStorage.removeItem(KEY); }
