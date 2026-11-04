import { isIP } from 'node:net';

function ipv6Value(address: string): bigint | undefined {
  let normalized = address.toLowerCase().split('%', 1)[0]!;
  if (normalized.includes('.')) {
    const separator = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(separator + 1);
    if (isIP(ipv4) !== 4) return undefined;
    const octets = ipv4.split('.').map(Number);
    const high = (octets[0]! << 8) | octets[1]!;
    const low = (octets[2]! << 8) | octets[3]!;
    normalized = `${normalized.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const zeros = 8 - left.length - right.length;
  if ((halves.length === 1 && zeros !== 0) || (halves.length === 2 && zeros < 1)) return undefined;
  const words = [...left, ...Array.from({ length: zeros }, () => '0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return undefined;
  return words.reduce((value, word) => (value << 16n) | BigInt(`0x${word}`), 0n);
}

/** True only for normalized local hostnames and addresses in the IPv4/IPv6 loopback ranges. */
export function isLoopbackHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  if (isIP(host) !== 6) return false;
  const value = ipv6Value(host);
  if (value === undefined) return false;
  if (value === 1n) return true;
  if (value >> 32n !== 0xffffn) return false;
  return Number((value & 0xffff_ffffn) >> 24n) === 127;
}
