import { get } from 'node:https';
import { Readable } from 'node:stream';

// The two official IR feeds accept the standard HTTPS client while fetch receives a challenge.
export function nativeFetch(url, { headers = {}, signal } = {}, redirects = 3, request = get) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { 'Accept-Encoding': 'identity', ...headers }, signal }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (!redirects) { reject(new Error('Source redirect limit exceeded')); return; }
        try { resolve(nativeFetch(new URL(res.headers.location, url), { headers, signal }, redirects - 1, request)); }
        catch (error) { reject(error); }
        return;
      }
      const empty = [204, 205, 304].includes(res.statusCode);
      if (empty) res.resume();
      resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
  });
}
