// The key the public lost-and-found rate limit counts under, for one client
// address (server.js, clientAddress). Pure, so it can be tested on its own.
//
// An IPv4 address is its own key. An IPv6 client is not one address but a
// whole prefix: a residential or hosting customer is routinely handed a /64,
// 2^64 addresses it can send from at will, so a bucket per full address is
// unlimited buckets. The key is the first 64 bits. An IPv4-mapped address
// (::ffff:a.b.c.d, which is how a dual-stack socket reports an IPv4 caller) is
// that IPv4 address, so the same host does not get a second bucket by arriving
// in the other spelling. Brackets, a port and a zone (as a proxy may write
// them) are stripped first. Anything that is not an address is kept as
// written: it is not ours to guess at, and the caller bounds its length.
const net = require('node:net');

function stripDecorations(value) {
  let s = String(value).trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(s)) s = s.slice(0, s.lastIndexOf(':'));
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  return s;
}

// Eight 16-bit groups of a valid IPv6 address, :: expanded and an embedded
// dotted IPv4 tail turned into its two groups.
function ipv6Groups(address) {
  let text = address;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const o = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail, extra] = text.split('::');
  if (extra !== undefined) return null;
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right].map(g => parseInt(g, 16));
  return groups.length === 8 && groups.every(Number.isInteger) ? groups : null;
}

function rateLimitKey(value) {
  if (typeof value !== 'string') return value;
  const address = stripDecorations(value);
  if (net.isIPv4(address)) return address;
  if (net.isIPv6(address)) {
    const g = ipv6Groups(address);
    if (g) {
      if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
        return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
      }
      return `${g.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`;
    }
  }
  return value;
}

module.exports = { rateLimitKey };
