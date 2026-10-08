/**
 * grpc-web over fetch, framed by hand (no grpc-web library): one request
 * frame out, the raw response body back.
 */

export interface GrpcWebCall {
  /** headers added to the grpc-web ones */
  headers?: Record<string, string>;
  /** refuse a response body past this size, before it is all read */
  maxBytes?: number;
  /** sees the response headers once the status is ok, before the body is read */
  onHeaders?: (headers: Headers) => void;
  signal?: AbortSignal;
}

/** a message in one uncompressed grpc-web data frame */
export const grpcWebFrame = (msg: Uint8Array): Uint8Array<ArrayBuffer> => {
  const body = new Uint8Array(5 + msg.length);
  body[0] = 0; // not compressed
  body[1] = (msg.length >> 24) & 0xff;
  body[2] = (msg.length >> 16) & 0xff;
  body[3] = (msg.length >> 8) & 0xff;
  body[4] = msg.length & 0xff;
  body.set(msg, 5);
  return body;
};

/** the response body, read no further than `maxBytes` */
const readCapped = async (resp: Response, method: string, maxBytes: number) => {
  if (maxBytes === Infinity || !resp.body) {
    return new Uint8Array(await resp.arrayBuffer());
  }
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > maxBytes) {
      void reader.cancel();
      throw new Error(`gRPC ${method}: response over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/**
 * POST one grpc-web request to `${baseUrl}/${service}/${method}` and read the
 * whole response body, frames and trailer intact. A non-ok HTTP status throws
 * with `httpStatus` set.
 */
export const grpcWebFetch = async (
  baseUrl: string,
  service: string,
  method: string,
  msg: Uint8Array,
  { headers, maxBytes = Infinity, onHeaders, signal }: GrpcWebCall = {},
): Promise<{ resp: Response; body: Uint8Array }> => {
  const resp = await fetch(`${baseUrl}/${service}/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      Accept: 'application/grpc-web+proto',
      'x-grpc-web': '1',
      ...headers,
    },
    body: grpcWebFrame(msg),
    signal,
  });
  if (!resp.ok) {
    throw Object.assign(new Error(`gRPC ${method}: HTTP ${resp.status}`), {
      httpStatus: resp.status,
    });
  }
  onHeaders?.(resp.headers);
  return { resp, body: await readCapped(resp, method, maxBytes) };
};

/**
 * The message of a unary grpc-web response: its first data frame. A trailer
 * (in the body, or a trailers-only response in the headers) with a non-zero
 * status throws with `grpcStatus` set; a zero-status trailer with no data is
 * an empty message.
 */
export const grpcWebUnaryMessage = (
  resp: Response,
  buf: Uint8Array,
  method: string,
  serverUrl: string,
): Uint8Array => {
  if (buf.length < 5) {
    // check HTTP headers for grpc-status (trailer-only response)
    const grpcStatus = resp.headers.get('grpc-status');
    const grpcMessage = resp.headers.get('grpc-message');
    if (grpcStatus && grpcStatus !== '0') {
      throw Object.assign(
        new Error(`gRPC ${method}: ${decodeURIComponent(grpcMessage ?? `status ${grpcStatus}`)}`),
        { grpcStatus: Number(grpcStatus) },
      );
    }
    throw new Error(`gRPC ${method}: empty response from ${serverUrl}`);
  }

  const flags = buf[0]!;

  // if first frame is a trailer frame (flags & 0x80), parse grpc-status from it
  if (flags & 0x80) {
    const trailerLen = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
    const trailerText = new TextDecoder().decode(buf.subarray(5, 5 + trailerLen));
    const statusMatch = /grpc-status:\s*(\d+)/.exec(trailerText);
    const messageMatch = /grpc-message:\s*(.+)/.exec(trailerText);
    const status = statusMatch?.[1] ?? '0';
    if (status !== '0') {
      const msg = messageMatch?.[1]?.trim();
      throw Object.assign(
        new Error(`gRPC ${method}: ${decodeURIComponent(msg ?? `status ${status}`)}`),
        { grpcStatus: Number(status) },
      );
    }
    // status 0 but no data frame - treat as empty success
    return new Uint8Array(0);
  }

  // extract first data frame (unary RPCs only)
  const len = (buf[1]! << 24) | (buf[2]! << 16) | (buf[3]! << 8) | buf[4]!;
  return buf.subarray(5, 5 + len);
};
