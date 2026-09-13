/**
 * MIME walking and message shaping for the Gmail server.
 *
 * Split out of `index.js` so it can be imported and tested without starting a
 * server: importing the server module connects a transport as a side effect.
 *
 * The ported version returned the **first** non-empty child of the MIME tree.
 * For a multipart message with an inline image that could hand a model the
 * attachment's decoded bytes as the email body, and for `multipart/alternative`
 * it depended on the order Gmail happened to serialise the parts in rather than
 * on the MIME type. Both are fixed by collecting the tree first and then choosing
 * by preference.
 */

/** The headers worth returning for a message. */
export const METADATA_HEADERS = ["From", "To", "Cc", "Bcc", "Subject", "Date"];

/** How deep to walk before assuming something is wrong. */
const MAX_MIME_DEPTH = 10;

export function headerValue(headers, name) {
  const wanted = String(name).toLowerCase();
  const found = (headers ?? []).find(
    (header) => String(header?.name ?? "").toLowerCase() === wanted,
  );
  return found?.value ?? "";
}

/** Gmail returns base64url; Node's `base64url` decoder also tolerates plain base64. */
export function decodeBody(data) {
  if (!data) return "";
  try {
    return Buffer.from(String(data), "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** Decode the entities that actually show up in mail, including numeric ones. */
export function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => safeCodePoint(Number.parseInt(code, 16)));
}

/** `String.fromCodePoint` throws on an out-of-range number; a bad entity should not. */
function safeCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * HTML to readable text.
 *
 * `<script>` and `<style>` bodies are dropped whole — stripping tags alone would
 * leave their contents behind as text, which is both noise and a plausible place
 * to hide an instruction.
 */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? "")
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Flatten a MIME tree into the parts worth reading.
 *
 * Attachments are skipped explicitly, by filename or by
 * `Content-Disposition: attachment`.
 */
export function collectParts(payload, out = [], depth = 0) {
  if (!payload || depth > MAX_MIME_DEPTH) return out;
  const disposition = headerValue(payload.headers, "content-disposition");
  const isAttachment = Boolean(payload.filename) || /attachment/i.test(disposition);
  if (!isAttachment) out.push(payload);
  for (const part of payload.parts ?? []) collectParts(part, out, depth + 1);
  return out;
}

/**
 * The best available body: `text/plain` first, then HTML stripped to text, then
 * the snippet — which is the fallback the original's docstring promised and its
 * code did not implement.
 */
export function extractBody(payload, snippet = "") {
  const parts = collectParts(payload);
  const plain = parts.find((part) => part.mimeType === "text/plain" && part.body?.data);
  if (plain) return decodeBody(plain.body.data).trim();
  const html = parts.find((part) => part.mimeType === "text/html" && part.body?.data);
  if (html) return htmlToText(decodeBody(html.body.data));
  return String(snippet ?? "").trim();
}

/** One Gmail message resource to the shape the tools return. */
export function formatMessage(message, format = "metadata") {
  const headers = message?.payload?.headers ?? [];
  const summary = {
    id: message?.id ?? null,
    threadId: message?.threadId ?? null,
    labelIds: message?.labelIds ?? [],
    internalDate: message?.internalDate ?? null,
    snippet: message?.snippet ?? "",
    headers: {
      from: headerValue(headers, "from"),
      to: headerValue(headers, "to"),
      cc: headerValue(headers, "cc"),
      bcc: headerValue(headers, "bcc"),
      subject: headerValue(headers, "subject"),
      date: headerValue(headers, "date"),
    },
  };
  if (format === "full") summary.body = extractBody(message?.payload, message?.snippet);
  return summary;
}

/**
 * Build the RFC 5322 message Gmail's `send` expects, base64url encoded.
 *
 * The body is base64 encoded rather than inlined so that a body containing a
 * line that looks like a header cannot alter the message structure, and there is
 * no `From` header: Gmail always sends as the authenticated account.
 */
export function buildRawMessage({ to, subject, body }) {
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(String(body ?? ""), "utf8").toString("base64"),
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

/**
 * Which field carries a header injection, or null when none does.
 *
 * Interpolating a newline into a header lets a caller append `Bcc` or rewrite
 * the MIME structure, so a name with a line break is refused rather than
 * silently stripped — the caller should learn that its input was rejected.
 */
export function findHeaderInjection({ to, subject }) {
  if (/[\r\n]/.test(String(to ?? ""))) return "to";
  if (/[\r\n]/.test(String(subject ?? ""))) return "subject";
  return null;
}

/** A deliberately loose address check. Gmail is the real authority. */
export function looksLikeEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value ?? ""));
}
