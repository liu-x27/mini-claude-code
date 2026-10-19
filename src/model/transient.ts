/**
 * What broke, if a model call failed in a way worth making it again: the connection, not the
 * request. Undefined for anything else.
 *
 * Worth it:
 * - a stream that broke partway, which no SDK retries, since its response had already begun:
 *   undici's `terminated` (the socket closed under it), a reset or hung-up socket, or a stream
 *   that ended before its last event;
 * - an `overloaded_error` or `api_error` event in the middle of a stream, the in-stream form of
 *   a 529 or a 500;
 * - a connection the SDK could not make even after its own retries.
 *
 * Never an abort, and never an answer that carries an HTTP status: the SDK has already retried
 * those worth retrying (429, 5xx), and the rest (400, 401, 404…) would only fail the same way.
 *
 * Read from the error and the causes under it, by shape rather than by class: the Anthropic SDK
 * rewraps undici's error (`AnthropicError: terminated`, caused by it), the OpenAI SDK passes it
 * through as it is, and a ModelClient of someone else's may do either.
 */
export function transientFailure(err: unknown): string | undefined {
  const chain = causes(err);
  const [top] = chain;
  if (!top || chain.some(isAbort) || chain.some((e) => typeof e.status === "number")) return undefined;

  if (top.type === "overloaded_error" || top.type === "api_error") return `the endpoint sent ${top.type} partway through the reply`;
  if (/^APIConnection(Timeout)?Error$/.test(top.constructor?.name ?? "")) return `could not connect (${details(chain)})`;
  if (chain.some((e) => (typeof e.code === "string" && SOCKET_CODES.has(e.code)) || BROKEN.test(e.message ?? ""))) {
    return `the stream broke off (${details(chain)})`;
  }
  return undefined;
}

interface Link {
  constructor?: { name?: string };
  name?: string;
  message?: string;
  code?: unknown;
  status?: unknown;
  type?: unknown;
}

/** Codes Node and undici give a connection that failed or closed under a request. */
const SOCKET_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * Messages that say the same with no code: undici's `terminated`, Node's `socket hang up`, and the
 * Anthropic SDK's two for a stream that closed cleanly before its message_stop.
 */
const BROKEN = /^terminated$|socket hang up|stream ended without producing a Message|request ended without sending any chunks/i;

function causes(err: unknown): Link[] {
  const chain: Link[] = [];
  for (let e = err; e !== null && typeof e === "object" && chain.length < 8 && !chain.includes(e as Link); e = (e as { cause?: unknown }).cause) {
    chain.push(e as Link);
  }
  return chain;
}

function isAbort(e: Link): boolean {
  return e.name === "AbortError" || e.constructor?.name === "APIUserAbortError" || e.code === "ABORT_ERR" || e.code === "UND_ERR_ABORTED";
}

/** `terminated: other side closed` — each different message down the chain, once. */
function details(chain: Link[]): string {
  const messages = chain.map((e) => (e.message ?? "").trim().replace(/\.$/, "")).filter(Boolean);
  return [...new Set(messages)].join(": ").slice(0, 200) || "no message";
}
