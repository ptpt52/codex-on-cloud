const property = '_CODEX_CLOUD_FIXED_SIZE';
const valid = size => size && ['width', 'height'].every(key => Number.isInteger(size[key]) && size[key] >= 320 && size[key] <= 4096);

// One two-CARDINAL property (8 bytes) lives with the private X server, rather
// than with the manager or saved pending preferences. It vanishes with X.
export function createFixedSizeStore(run) {
  let reading;
  return {
    read() {
      if (reading) return reading;
      reading = (async () => {
        try {
          const text = await run('xprop', ['-root', property], { timeout: 500 });
          const match = text.match(/^_CODEX_CLOUD_FIXED_SIZE\(CARDINAL\) = (\d+), (\d+)\s*$/);
          const size = match && { width: Number(match[1]), height: Number(match[2]) };
          return valid(size) ? size : null;
        } catch { return null; }
      })().finally(() => { reading = undefined; });
      return reading;
    },
    async write(size) {
      if (!valid(size)) throw new Error('固定尺寸无效');
      await run('xprop', ['-root', '-f', property, '32c', '-set', property, `${size.width}, ${size.height}`], { timeout: 500 });
    },
  };
}
