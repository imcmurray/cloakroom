// Core types for the Cloakroom sanitization engine.
// Everything here is pure data — no DOM, no Node APIs — so it runs identically
// in the browser, a Web Worker, a CLI, or a test runner.

export type EntityType =
  | 'IPV4'
  | 'IPV6'
  | 'EMAIL'
  | 'PHONE'
  | 'SSN'
  | 'CREDIT_CARD'
  | 'API_KEY'
  | 'AWS_KEY'
  | 'JWT'
  | 'UUID'
  | 'HASH'
  | 'MAC'
  | 'URL'
  | 'HOSTNAME'
  | 'PATH'
  | 'PERSON'
  | 'ORG'
  | 'CASE_NUMBER'
  | 'CASE_NAME'
  | 'CUSTOM';

/** A single hit produced by a detector, before placeholder assignment. */
export interface RawMatch {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  /** 0..1 — used to break ties when matches overlap. */
  confidence: number;
  detector: string;
}

/** original <-> placeholder relationship. This is the secret. Never leaves the client unencrypted. */
export interface MappingEntry {
  type: EntityType;
  original: string;
  placeholder: string;
  /** how many times this value occurred in the source. */
  count: number;
}

export interface AuditItem {
  type: EntityType;
  placeholder: string;
  detector: string;
  confidence: number;
  count: number;
  /** masked preview, e.g. "Ian M██████" — for the user-only audit panel. */
  preview: string;
}

export interface CustomTerm {
  value: string;
  type?: EntityType; // defaults to CUSTOM / ORG
}

export interface SanitizeOptions {
  /**
   * 'realistic' → format-preserving fakes drawn from reserved/test ranges
   *   (RFC 5737 IPs, example.com, 555-01xx, area-900 SSNs). Best for LLM quality.
   * 'token'     → opaque sentinels like «PERSON_1». Best for perfect reversal.
   */
  mode?: 'realistic' | 'token';
  /** Only these types are replaced. Omit = all built-ins. */
  enabledTypes?: EntityType[];
  /** Literal strings that must NEVER be replaced (e.g. "localhost", your own product name). */
  whitelist?: string[];
  /** User-declared sensitive literals (names, company, project codenames) matched verbatim. */
  customTerms?: CustomTerm[];
  /** Drop matches below this confidence. Default 0.5. */
  minConfidence?: number;
  /** Deterministic fakes across runs. Default derives from content. */
  seed?: number;
}

export interface SanitizeResult {
  sanitized: string;
  mapping: MappingEntry[];
  audit: AuditItem[];
}

/** One slice of a restored document: either untouched text or a re-inflated original. */
export interface RestoreSegment {
  text: string;
  restored: boolean;
  type?: EntityType;
}

/** Serializable bundle that can be AES-GCM encrypted into a "bridge file". */
export interface BridgeFile {
  v: 1;
  createdAt: string;
  mode: 'realistic' | 'token';
  mapping: MappingEntry[];
}
