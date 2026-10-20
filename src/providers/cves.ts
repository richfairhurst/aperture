type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type CveRecord = {
  cveId: string;
  sourceId: string;
  title: string;
  description: string;
  publishedAt: string | null;
  modifiedAt: string | null;
  cvssScore: number | null;
  severity: "critical" | "high" | "medium" | "low" | "unknown";
  cvssVector: string | null;
  affectedProducts: string[];
  exploitability: string | null;
  mitigation: string | null;
  references: string[];
  raw: unknown;
};

export type CvePollResult = {
  vulnerabilities: CveRecord[];
  recordsFound: number;
  recordsSkipped: number;
  failures: string[];
};

export type CveDiagnostics = {
  lastRunAt: string | null;
  lastRunStatus: "completed" | "failed" | null;
  recordsFound: number;
  recordsStored: number;
  recordsSkipped: number;
  failures: string[];
};

export class CveClient {
  private readonly fetchImpl: FetchImplementation;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private diagnostics: CveDiagnostics = emptyDiagnostics();

  constructor(options: {
    endpoint: string;
    fetchImpl?: FetchImplementation;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    this.endpoint = options.endpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 20_000_000;
  }

  canPoll(now: Date, cadenceHours: number): boolean {
    if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) {
      throw new Error("CVE cadence must be positive");
    }
    if (!this.diagnostics.lastRunAt) return true;
    return (
      now.getTime() - Date.parse(this.diagnostics.lastRunAt) >=
      cadenceHours * 3_600_000
    );
  }

  async poll(
    queryWindowHours: number,
    now = new Date(),
  ): Promise<CvePollResult> {
    const result: CvePollResult = {
      vulnerabilities: [],
      recordsFound: 0,
      recordsSkipped: 0,
      failures: [],
    };
    try {
      const payload = await this.fetchPayload();
      const records = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.vulnerabilities)
          ? payload.vulnerabilities
          : [];
      result.recordsFound = records.length;
      for (const [index, value] of records.entries()) {
        try {
          const normalized = normalizeCve(value);
          if (
            !normalized ||
            !isWithinWindow(normalized.publishedAt, now, queryWindowHours)
          ) {
            result.recordsSkipped += 1;
            continue;
          }
          result.vulnerabilities.push(normalized);
        } catch (error) {
          result.recordsSkipped += 1;
          result.failures.push(
            `record ${index}: ${error instanceof Error ? error.message : "invalid vulnerability"}`,
          );
        }
      }
      this.diagnostics = {
        lastRunAt: now.toISOString(),
        lastRunStatus: "completed",
        recordsFound: result.recordsFound,
        recordsStored: result.vulnerabilities.length,
        recordsSkipped: result.recordsSkipped,
        failures: [...result.failures],
      };
      return result;
    } catch (error) {
      result.failures.push(
        error instanceof Error ? error.message : "CVE request failed",
      );
      this.diagnostics = {
        lastRunAt: now.toISOString(),
        lastRunStatus: "failed",
        recordsFound: 0,
        recordsStored: 0,
        recordsSkipped: 0,
        failures: [...result.failures],
      };
      return result;
    }
  }

  getDiagnostics(): CveDiagnostics {
    return { ...this.diagnostics, failures: [...this.diagnostics.failures] };
  }

  private async fetchPayload(): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "Aperture Intelligence Feed/1.0",
        },
      });
      if (!response.ok)
        throw new Error(`CIRCL request failed with status ${response.status}`);
      const bytes = await readResponseBytes(response, this.maxResponseBytes);
      try {
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch {
        throw new Error("CIRCL response was not valid JSON");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`CIRCL request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeCve(value: unknown): CveRecord | null {
  if (!isRecord(value)) return null;
  const cveId = findCveId(value);
  if (!cveId) return null;
  const cna = recordAt(value, "containers", "cna");
  const description =
    firstStringInArray(recordAt(cna, "descriptions"), "value") ??
    stringAt(value, "details") ??
    stringAt(value, "description") ??
    "No description provided.";
  const vector = findCvssVector(value);
  const score = findCvssScore(value) ?? scoreFromVector(vector);
  const severity = findSeverity(value, score);
  return {
    cveId,
    sourceId: stringAt(value, "id") ?? cveId,
    title:
      stringAt(cna, "title") ??
      stringAt(value, "title") ??
      stringAt(value, "summary") ??
      firstSentence(description),
    description,
    publishedAt:
      stringAt(value, "published") ??
      stringAt(recordAt(value, "cveMetadata"), "datePublished") ??
      stringAt(recordAt(value, "document", "tracking"), "initial_release_date"),
    modifiedAt:
      stringAt(value, "modified") ??
      stringAt(recordAt(value, "cveMetadata"), "dateUpdated"),
    cvssScore: score,
    severity,
    cvssVector: vector,
    affectedProducts: extractProducts(value),
    exploitability: vector ? describeVector(vector) : null,
    mitigation: extractMitigation(value),
    references: extractReferences(value),
    raw: value,
  };
}

function findCveId(value: Record<string, unknown>): string | null {
  const candidates = [
    stringAt(recordAt(value, "cveMetadata"), "cveId"),
    stringAt(value, "id"),
    ...(Array.isArray(value.aliases) ? value.aliases.filter(isString) : []),
  ];
  const strings = candidates.filter(isString);
  return (
    strings.find((candidate) => /^CVE-\d{4}-\d{4,}$/iu.test(candidate)) ??
    strings.find(Boolean) ??
    null
  );
}

function findCvssScore(value: Record<string, unknown>): number | null {
  const metrics = recordAt(recordAt(value, "containers"), "cna").metrics;
  if (Array.isArray(metrics)) {
    for (const metric of metrics) {
      if (!isRecord(metric)) continue;
      for (const key of ["cvssV4_0", "cvssV3_1", "cvssV3_0", "cvssV2"]) {
        const score = recordAt(metric, key).baseScore;
        if (typeof score === "number" && Number.isFinite(score)) return score;
      }
    }
  }
  for (const key of ["cvss", "cvssScore", "baseScore"]) {
    const score = value[key];
    if (typeof score === "number" && Number.isFinite(score)) return score;
  }
  return null;
}

function findCvssVector(value: Record<string, unknown>): string | null {
  const metrics = recordAt(recordAt(value, "containers"), "cna").metrics;
  if (Array.isArray(metrics)) {
    for (const metric of metrics) {
      if (!isRecord(metric)) continue;
      for (const key of ["cvssV4_0", "cvssV3_1", "cvssV3_0", "cvssV2"]) {
        const vector = stringAt(recordAt(metric, key), "vectorString");
        if (vector) return vector;
      }
    }
  }
  const severity = value.severity;
  if (Array.isArray(severity)) {
    const vector = severity.find(
      (item) => isRecord(item) && typeof item.score === "string",
    );
    return vector && isRecord(vector) ? stringAt(vector, "score") : null;
  }
  return null;
}

function findSeverity(
  value: Record<string, unknown>,
  score: number | null,
): CveRecord["severity"] {
  const metrics = recordAt(recordAt(value, "containers"), "cna").metrics;
  if (Array.isArray(metrics)) {
    for (const metric of metrics) {
      if (!isRecord(metric)) continue;
      for (const key of ["cvssV4_0", "cvssV3_1", "cvssV3_0", "cvssV2"]) {
        const severity = stringAt(recordAt(metric, key), "baseSeverity");
        if (severity) return severity.toLowerCase() as CveRecord["severity"];
      }
    }
  }
  if (score === null || score <= 0) return "unknown";
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  return "low";
}

function extractProducts(value: Record<string, unknown>): string[] {
  const products: string[] = [];
  const affected = value.affected;
  if (Array.isArray(affected)) {
    for (const item of affected) {
      if (!isRecord(item)) continue;
      const product = recordAt(item, "package");
      const name = stringAt(product, "name");
      const ecosystem = stringAt(product, "ecosystem");
      if (name) products.push(ecosystem ? `${ecosystem}: ${name}` : name);
      const vendor = stringAt(item, "vendor");
      const itemProduct = stringAt(item, "product");
      if (vendor && itemProduct) products.push(`${vendor} ${itemProduct}`);
    }
  }
  return [...new Set(products)];
}

function extractReferences(value: Record<string, unknown>): string[] {
  const refs = value.references;
  if (Array.isArray(refs)) {
    return refs.flatMap((ref) => {
      if (typeof ref === "string") return [ref];
      return isRecord(ref) && typeof ref.url === "string" ? [ref.url] : [];
    });
  }
  const cna = recordAt(recordAt(value, "containers"), "cna");
  const cnaRefs = cna.references;
  return Array.isArray(cnaRefs)
    ? cnaRefs.flatMap((ref) =>
        isRecord(ref) && typeof ref.url === "string" ? [ref.url] : [],
      )
    : [];
}

function extractMitigation(value: Record<string, unknown>): string | null {
  const containers = recordAt(value, "containers");
  const cna = recordAt(containers, "cna");
  for (const key of ["solutions", "workarounds"]) {
    const entries = cna[key];
    if (Array.isArray(entries)) {
      const text = entries.find(
        (entry) => isRecord(entry) && typeof entry.value === "string",
      );
      if (text && isRecord(text)) return text.value as string;
    }
  }
  return null;
}

function describeVector(vector: string): string | null {
  const parts = new Map(
    vector.split("/").map((part) => part.split(":", 2) as [string, string]),
  );
  const access = parts.get("AV");
  const privileges = parts.get("PR");
  if (!access && !privileges) return null;
  return [
    access ? `access ${access}` : null,
    privileges ? `privileges ${privileges}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function scoreFromVector(vector: string | null): number | null {
  if (!vector?.startsWith("CVSS:3.")) return null;
  const metrics = new Map(
    vector
      .split("/")
      .slice(1)
      .map((part) => part.split(":", 2) as [string, string]),
  );
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[metrics.get("AV") ?? ""];
  const ac = { L: 0.77, H: 0.44 }[metrics.get("AC") ?? ""];
  const pr =
    metrics.get("S") === "C"
      ? { N: 0.85, L: 0.68, H: 0.5 }[metrics.get("PR") ?? ""]
      : { N: 0.85, L: 0.62, H: 0.27 }[metrics.get("PR") ?? ""];
  const ui = { N: 0.85, R: 0.62 }[metrics.get("UI") ?? ""];
  const confidentiality = { H: 0.56, L: 0.22, N: 0 }[metrics.get("C") ?? ""];
  const integrity = { H: 0.56, L: 0.22, N: 0 }[metrics.get("I") ?? ""];
  const availability = { H: 0.56, L: 0.22, N: 0 }[metrics.get("A") ?? ""];
  if (
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    confidentiality === undefined ||
    integrity === undefined ||
    availability === undefined
  )
    return null;
  const impactSubScore =
    1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  const scopeChanged = metrics.get("S") === "C";
  const impact = scopeChanged
    ? 7.52 * (impactSubScore - 0.029) - 3.25 * (impactSubScore - 0.02) ** 15
    : 6.42 * impactSubScore;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return Math.ceil(raw * 10) / 10;
}

function isWithinWindow(
  value: string | null,
  now: Date,
  hours: number,
): boolean {
  if (!value) return false;
  const published = Date.parse(value);
  return (
    Number.isFinite(published) &&
    published >= now.getTime() - hours * 3_600_000 &&
    published <= now.getTime()
  );
}

function firstSentence(value: string): string {
  return value.split(/(?<=[.!?])\s+/u)[0]?.slice(0, 180) ?? value.slice(0, 180);
}

function firstStringInArray(value: unknown, key: string): string | null {
  if (!Array.isArray(value)) return null;
  const item = value.find(
    (candidate) => isRecord(candidate) && typeof candidate[key] === "string",
  );
  return item && isRecord(item) ? (item[key] as string) : null;
}

function recordAt(value: unknown, ...keys: string[]): Record<string, unknown> {
  let current = value;
  for (const key of keys)
    current = isRecord(current) ? current[key] : undefined;
  return isRecord(current) ? current : {};
}

function stringAt(value: Record<string, unknown>, key: string): string | null {
  return typeof value[key] === "string" && value[key].trim()
    ? value[key].trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function emptyDiagnostics(): CveDiagnostics {
  return {
    lastRunAt: null,
    lastRunStatus: null,
    recordsFound: 0,
    recordsStored: 0,
    recordsSkipped: 0,
    failures: [],
  };
}
import { readResponseBytes } from "../utils/response";
