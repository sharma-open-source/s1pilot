/** Binary screencast frame sent over `/ws/runs/:runId`. */
export interface ScreencastFrame {
  /** Case result (`caseResultId`) the frame belongs to. */
  resultId: string;
  /** Per-case frame counter, starting at 1. */
  seq: number;
  /** Viewport size in CSS pixels (the coordinate space of `observation.elements` boxes). */
  width: number;
  height: number;
  /** JPEG bytes. */
  data: Buffer;
}

/** Bytes before the result id: idLen u8, seq u32, width u16, height u16 (all big-endian). */
export const FRAME_HEADER_BYTES = 9;

/**
 * Encodes a frame as `[idLen u8][seq u32][width u16][height u16][resultId utf8][jpeg…]`.
 */
export function encodeFrame(frame: ScreencastFrame): Buffer {
  const id = Buffer.from(frame.resultId, 'utf8');
  if (id.length > 255) throw new RangeError('resultId is too long');
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt8(id.length, 0);
  header.writeUInt32BE(frame.seq >>> 0, 1);
  header.writeUInt16BE(Math.min(frame.width, 0xffff), 5);
  header.writeUInt16BE(Math.min(frame.height, 0xffff), 7);
  return Buffer.concat([header, id, frame.data]);
}

/** Inverse of {@link encodeFrame}. Throws on a truncated buffer. */
export function decodeFrame(buf: Buffer): ScreencastFrame {
  if (buf.length < FRAME_HEADER_BYTES) throw new RangeError('frame too short');
  const idLen = buf.readUInt8(0);
  const start = FRAME_HEADER_BYTES + idLen;
  if (buf.length < start) throw new RangeError('frame too short');
  return {
    resultId: buf.subarray(FRAME_HEADER_BYTES, start).toString('utf8'),
    seq: buf.readUInt32BE(1),
    width: buf.readUInt16BE(5),
    height: buf.readUInt16BE(7),
    data: buf.subarray(start),
  };
}
