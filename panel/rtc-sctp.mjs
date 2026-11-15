// The pinned SCTP stack advertises a receive window but does not enforce it
// before fragmented-message reassembly. Apply the same bound to every peer.
// Chromium may split a bounded file window into thousands of small DATA
// fragments while repairing a packet gap. Keep a separate metadata budget
// with room beyond the sparse-TSN bound, independently of the 1 MiB byte cap.
const MAX_FRAGMENTS = 4096;
export function guardSCTP(sctp, valid, failed) {
  if (!sctp || typeof sctp.receiveDataChunk !== 'function') throw new Error('Unsupported SCTP transport');
  const receive = sctp.receiveDataChunk.bind(sctp);
  sctp.receiveDataChunk = chunk => {
    const streams = Object.values(sctp.inboundStreams), fragments = streams.reduce((total, stream) => total + stream.reassembly.length, 0);
    if (!valid() || streams.length >= 32 && !sctp.inboundStreams[chunk.streamId] || fragments >= MAX_FRAGMENTS ||
        chunk.userData.length > Math.min(sctp.advertisedRwnd, 1024 * 1024) || sctp.sackDuplicates.length >= 1024) return failed();
    if (sctp.sackMisOrdered.size >= 2048) {
      if (!Number.isInteger(chunk.tsn) || !Number.isInteger(sctp.lastReceivedTsn)) return failed();
      const distance = (chunk.tsn - sctp.lastReceivedTsn) >>> 0;
      // Bound sparse tracking without terminating unrelated streams after a
      // lost packet. Continue SACKs, admit duplicates and the next missing TSN,
      // and let native SCTP retransmit discarded later packets. No app replay.
      if (distance > 1 && distance < 0x80000000 && !sctp.sackMisOrdered.has(chunk.tsn)) {
        sctp.sackNeeded = true; sctp.sackImmediate = true; return;
      }
    }
    receive(chunk);
  };
}
