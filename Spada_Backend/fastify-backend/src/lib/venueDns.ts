import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';

/**
 * The LAN resolver (192.168.0.1) answers Kalshi and Polymarket with 10.0.10.2.
 * Nothing listens there, so orderbook, candle, and price-stream calls die with
 * `connect ETIMEDOUT 10.0.10.2:443`. Public DNS returns the real addresses.
 * Every other host, including Supabase, still uses the system resolver.
 */
const publicResolver = new Resolver();
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

const systemLookup = dns.lookup.bind(dns);

function isVenueHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  return (
    host === 'kalshi.com' ||
    host.endsWith('.kalshi.com') ||
    host === 'polymarket.com' ||
    host.endsWith('.polymarket.com')
  );
}

export const venueLookup: dns.LookupFunction = (hostname, options, callback) => {
  const opts: dns.LookupOptions = typeof options === 'function' ? {} : options;
  const done = (typeof options === 'function' ? options : callback) as (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void;

  if (!isVenueHost(hostname)) {
    systemLookup(hostname, opts, done);
    return;
  }

  publicResolver
    .resolve4(hostname)
    .then((addresses) => {
      if (!addresses.length) {
        systemLookup(hostname, opts, done);
        return;
      }
      if (opts.all) {
        done(
          null,
          addresses.map((address) => ({ address, family: 4 }))
        );
        return;
      }
      done(null, addresses[0], 4);
    })
    .catch(() => {
      systemLookup(hostname, opts, done);
    });
};

// fetch() and the `ws` client both call dns.lookup when they connect.
dns.lookup = venueLookup;
