/** Parses a dotted IPv4 literal, or returns undefined for anything else (hostnames, IPv6, bad octets). */
function ipv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((n) => n > 255)) return undefined;
  return octets as [number, number, number, number];
}

/**
 * True when `url` points outside the user's machine/network, so data leaves it.
 * False for `localhost`, `127.0.0.0/8`, `::1`, RFC 1918 (`10/8`, `172.16/12`, `192.168/16`) and `*.local`.
 * Anything unparseable counts as cloud (the safe default for data-policy warnings).
 */
export function isCloudEndpoint(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname;
  } catch {
    return true;
  }
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
  const ip = ipv4(host);
  if (!ip) return true;
  const [a, b] = ip;
  if (a === 127 || a === 10) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  return true;
}
