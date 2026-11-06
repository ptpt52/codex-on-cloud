export const SERIAL_BAUDS = Object.freeze([1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]);
export function serialConfig(value) {
  const invalid = () => { throw Object.assign(Error('串口参数无效：请填写 COM1 等名称或 /dev/cu.*、/dev/ttyUSB* 等设备路径，并选择支持的通信参数'), { status: 400 }); };
  if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'baud,dataBits,dtr,parity,path,rts,stopBits') return invalid();
  if (typeof value.path !== 'string' || value.path.length > 192 || !/^(COM[1-9][0-9]{0,3}|\/dev\/(?:cu\.[A-Za-z0-9._-]+|tty(?:USB|ACM|S)[0-9]+|tty\.[A-Za-z0-9._-]+|serial\/by-id\/[A-Za-z0-9._:-]+))$/.test(value.path)) return invalid();
  if (!SERIAL_BAUDS.includes(value.baud) || ![5, 6, 7, 8].includes(value.dataBits) || !['none', 'odd', 'even'].includes(value.parity) || ![1, 2].includes(value.stopBits) || typeof value.dtr !== 'boolean' || typeof value.rts !== 'boolean') return invalid();
  return { path: value.path, baud: value.baud, dataBits: value.dataBits, parity: value.parity, stopBits: value.stopBits, dtr: value.dtr, rts: value.rts };
}
