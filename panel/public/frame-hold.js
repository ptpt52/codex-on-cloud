// A viewport-sized picture, at most 4096 × 4096 pixels, never desktop history.
export function createFrameHold(viewport) {
  const picture = document.createElement('canvas'); picture.id = 'handoff-picture'; picture.hidden = true; picture.setAttribute('aria-hidden', 'true');
  document.body.append(picture);
  let timer, deadline = 0;
  function clear() { clearTimeout(timer); timer = undefined; picture.hidden = true; picture.width = picture.height = 0; }
  return {
    capture(canvas) {
      if (!canvas?.width || !canvas?.height) return;
      const rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) return;
      clear();
      const scale = Math.min(2, devicePixelRatio || 1, 4096 / innerWidth, 4096 / innerHeight);
      picture.width = Math.ceil(innerWidth * scale); picture.height = Math.ceil(innerHeight * scale);
      const ctx = picture.getContext('2d'); ctx.scale(scale, scale); ctx.fillStyle = '#222222'; ctx.fillRect(0, 0, innerWidth, innerHeight);
      ctx.drawImage(canvas, rect.left, rect.top, rect.width, rect.height); picture.hidden = false;
      // Always release the picture, even when a successor never paints.
      timer = setTimeout(clear, 8000);
    },
    painted(canvas) {
      if (picture.hidden) return;
      deadline = performance.now() + 5000;
      const check = () => {
        if (picture.hidden) return;
        try {
          const ctx = canvas?.getContext('2d');
          if (canvas?.width && canvas?.height && [0.1, 0.5, 0.9].some(p => ctx.getImageData(Math.floor(canvas.width * p), Math.floor(canvas.height * p), 1, 1).data[3])) return clear();
        } catch { return clear(); }
        if (performance.now() >= deadline) return clear();
        timer = setTimeout(check, 100);
      };
      clearTimeout(timer); timer = setTimeout(check, 0);
    }, clear,
  };
}
