// Local verification environment only; not part of the OpenMAIC patch.
// For these three real provider hosts, replace proxy-generated 198.18/15
// answers with live Google Public DNS answers. Keep the app's SSRF checks.
const dns = require('node:dns');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const original = dns.promises.lookup.bind(dns.promises);
const hosts = new Set(['api.openai.com', 'api.deepseek.com', 'tokendance.space']);
const cache = new Map();
async function publicRecords(host) {
  const cached = cache.get(host);
  if (cached && cached.expires > Date.now()) return cached.records;
  const answers = await Promise.all([1, 28].map(async (type) => {
    const { stdout } = await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '10',
      `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=${type}`]);
    const reply = JSON.parse(stdout);
    if (reply.Status !== 0) throw new Error(`Public DNS ${host}: status ${reply.Status}`);
    return (reply.Answer || []).filter(a => a.type === type).map(a => ({
      address: a.data, family: type === 1 ? 4 : 6, ttl: a.TTL,
    }));
  }));
  const records = answers.flat();
  if (!records.length) throw new Error(`Public DNS ${host}: no addresses`);
  cache.set(host, { records, expires: Date.now() + Math.max(1, Math.min(...records.map(a => a.ttl))) * 1000 });
  return records;
}
dns.promises.lookup = async (host, options) => {
  const actual = await original(host, options);
  const list = Array.isArray(actual) ? actual : [actual];
  if (!hosts.has(host) || !list.some(a => /^198\.(18|19)\./.test(a.address))) return actual;
  const family = typeof options === 'number' ? options : options?.family;
  const records = (await publicRecords(host)).filter(a => !family || a.family === family)
    .map(({ address, family }) => ({ address, family }));
  if (!records.length) throw new Error(`Public DNS ${host}: requested family unavailable`);
  return options?.all ? records : records[0];
};
