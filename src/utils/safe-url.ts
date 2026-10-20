export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

export function assertHttpUrl(value: string): string {
  const safe = safeHttpUrl(value);
  if (!safe) throw new Error("Only HTTP(S) URLs are allowed");
  return safe;
}

export function assertSafePublicUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP(S) URLs are allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "metadata.google.internal" ||
    isPrivateAddress(hostname)
  ) {
    throw new Error("Private or local URLs are not allowed");
  }

  return url;
}

function isPrivateAddress(hostname: string): boolean {
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPrivateIpv4(hostname);
  if (ipVersion !== 6) return false;

  const mappedIpv4 = ipv4FromMappedIpv6(hostname);
  if (mappedIpv4 && isPrivateIpv4(mappedIpv4)) return true;
  return (
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe8") ||
    hostname.startsWith("fe9") ||
    hostname.startsWith("fea") ||
    hostname.startsWith("feb")
  );
}

function ipv4FromMappedIpv6(hostname: string): string | null {
  if (!hostname.startsWith("::ffff:")) return null;
  const groups = hostname.slice("::ffff:".length).split(":");
  if (groups.length !== 2) return null;
  const values = groups.map((group) => Number.parseInt(group, 16));
  if (
    values.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 0xffff,
    )
  ) {
    return null;
  }
  return [
    values[0]! >> 8,
    values[0]! & 0xff,
    values[1]! >> 8,
    values[1]! & 0xff,
  ].join(".");
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [first, second = -1] = parts;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && second >= 18 && second <= 19)
  );
}
import { isIP } from "node:net";
