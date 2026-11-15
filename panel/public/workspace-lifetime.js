// Fixed feature ownership, no operation queue. Policy and authentication stay
// in the workspace callbacks; restoring a page never replays a feature action.
export function createWorkspaceLifetime(target, { features, onHide, onShow }) {
  if (!Array.isArray(features) || features.length > 8) throw Error('工作区生命周期组件无效');
  const owned = [...features]; let disposed = false;
  const hide = event => { if (disposed) return; try { onHide(event); } finally { for (const feature of owned) feature.suspend(); } };
  const show = event => { if (!disposed) onShow(event); };
  target.addEventListener('pagehide', hide); target.addEventListener('pageshow', show);
  return { dispose() {
    if (disposed) return; disposed = true;
    target.removeEventListener('pagehide', hide); target.removeEventListener('pageshow', show);
    for (const feature of owned) feature.dispose();
  } };
}
