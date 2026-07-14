'use strict';

const REDACTED_CREDENTIAL = '[redacted-credential]';
const CREDENTIAL_MARKER = '\u0000crate-redacted-value\u0000';
const CREDENTIAL_KEYS = [
  'Authorization',
  'X-Figma-Token',
  'Cookie',
  'Set-Cookie',
  '(?:(?:access|refresh|id)[_-]?)?token',
  '(?:client[_-]?)?secret',
  'api[_-]?key',
  'auth(?:entication|orization|header)?',
  'sig(?:nature)?',
  'key',
  'password',
  'credentials?',
].join('|');
const HEADER_KEYS = 'Authorization|X-Figma-Token|Cookie|Set-Cookie';
const SENSITIVE_KEY_FRAGMENT =
  'token|secret|authorization|authentication|bearer|cookie|auth|password|credential|signature|api[_-]?key';

const compoundQuotedCredential = new RegExp(
  String.raw`(["'])[^"'\\\r\n]*(?:${SENSITIVE_KEY_FRAGMENT})[^"'\\\r\n]*\1\s*:\s*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*')`,
  'gi'
);
const compoundUnquotedCredential = new RegExp(
  String.raw`\b[A-Za-z0-9._-]*(?:${SENSITIVE_KEY_FRAGMENT})[A-Za-z0-9._-]*\b\s*[:=]\s*[^,;)}\]\r\n]+`,
  'gi'
);
// Delimiters and line breaks may appear in filenames, so redact the value tail.
const privatePathTail = /["'`]?(?:\/Users|\/Volumes|\/private\/(?:tmp|var)|\/tmp|\/var)\/[\s\S]*/i;

const quotedCredential = new RegExp(
  `(["']?)(?:${CREDENTIAL_KEYS})\\1\\s*:\\s*(?:"(?:\\\\.|[^"\\\\\\r\\n])*"|'(?:\\\\.|[^'\\\\\\r\\n])*')`,
  'gi'
);
const credentialHeader = new RegExp(
  `\\b(?:${HEADER_KEYS})\\b(?:\\s*[:=]\\s*|\\s+)[^\\r\\n]*`,
  'gi'
);
const unquotedCredential = new RegExp(
  `\\b(?:${CREDENTIAL_KEYS})\\b\\s*[:=]\\s*(?:Bearer\\s+)?[^\\s,;)}\\]]+`,
  'gi'
);

function redactUrlAndCredentialText(value) {
  return String(value)
    .replace(/\[redacted-credential\]/g, CREDENTIAL_MARKER)
    .replace(/(?:https?:\/\/|figma:\/\/)[^\s"'<>]+/gi, '[redacted-url]')
    .replace(compoundQuotedCredential, CREDENTIAL_MARKER)
    .replace(quotedCredential, CREDENTIAL_MARKER)
    .replace(credentialHeader, CREDENTIAL_MARKER)
    .replace(compoundUnquotedCredential, CREDENTIAL_MARKER)
    .replace(unquotedCredential, CREDENTIAL_MARKER)
    .replace(/\bBearer\s+[^\r\n]*/gi, CREDENTIAL_MARKER)
    .replace(/[A-Za-z0-9._-]*(token|secret|authorization|bearer|cookie|auth|password|credential|signature)[A-Za-z0-9._-]*/gi, '[redacted-sensitive]')
    .split(CREDENTIAL_MARKER)
    .join(REDACTED_CREDENTIAL);
}

function redactPrivatePathText(value) {
  return String(value).replace(privatePathTail, '[redacted-path]');
}

module.exports = { redactUrlAndCredentialText, redactPrivatePathText };
