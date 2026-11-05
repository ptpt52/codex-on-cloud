// The pinned SCTP stack advertises a receive window but does not enforce it
// before fragmented-message reassembly. Apply the same bound to every peer.
export function guardSCTP(sctp, valid, failed) {
  if (!sctp || typeof sctp.receiveDataChunk !== 'function') throw new Error('Unsupported SCTP transport');
  const receive = sctp.receiveDataChunk.bind(sctp);
  sctp.receiveDataChunk = chunk => {
    const streams = Object.values(sctp.inboundStreams), fragments = streams.reduce((total, stream) => total + stream.reassembly.length, 0);
    if (!valid() || streams.length >= 32 && !sctp.inboundStreams[chunk.streamId] || fragments >= 1024 ||
        chunk.userData.length > Math.min(sctp.advertisedRwnd, 1024 * 1024) || sctp.sackMisOrdered.size >= 2048 || sctp.sackDuplicates.length >= 1024) return failed();
    receive(chunk);
  };
}
