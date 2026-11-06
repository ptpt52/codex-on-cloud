// x11vnc 0.9.13 skips X event initialization during its first 0.5 seconds with
// a new client. Allow that fixed startup window after the first decoded frame.
export const VNC_RESIZE_SETTLE = 650;

// noVNC 1.7.0 reports connect after ServerInit, before it has decoded pixels.
// Use the pinned decoder boundary once, then restore both original methods.
// One cancellable startup timer; no frame buffers or input are introduced.
export function afterFirstFrame(rfb, ready) {
  const rectangle = rfb._handleRect, update = rfb._framebufferUpdate;
  if (typeof rectangle !== 'function' || typeof update !== 'function') throw Error('Unsupported noVNC decoder');
  let pixels = false, timer;
  rfb._handleRect = function () {
    const encoding = this._FBU.encoding, width = this._FBU.width, height = this._FBU.height;
    const complete = rectangle.call(this);
    if (complete && (encoding >= 0 || encoding === -260) && width > 0 && height > 0) pixels = true;
    return complete;
  };
  rfb._framebufferUpdate = function () {
    const complete = update.call(this);
    if (complete && pixels) { this._handleRect = rectangle; this._framebufferUpdate = update; timer = setTimeout(ready, VNC_RESIZE_SETTLE); }
    return complete;
  };
  return () => { clearTimeout(timer); rfb._handleRect = rectangle; rfb._framebufferUpdate = update; };
}
