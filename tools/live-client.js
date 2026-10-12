(function () {
  'use strict';
  // Stands in for the preview's shared store: the same calls, backed by this site's own API.
  let content = null, loading = null;
  const listeners = {}, docListeners = {};
  const codeFor = (status) => status === 401 || status === 403 ? 'not_granted'
    : status === 413 ? 'quota_exceeded' : status === 400 ? 'invalid_argument' : 'unavailable';
  const rows = (c) => (content && content[c]) || [];
  const strip = (row) => { const copy = Object.assign({}, row); delete copy.id; return copy; };
  const snap = (c) => {
    const list = rows(c);
    return { docs: list.map((row) => ({ id: row.id, exists: true, data: () => strip(row) })), size: list.length, empty: !list.length };
  };
  const dsnap = (c, id) => {
    const row = rows(c).find((r) => r.id === id);
    return row ? { id: id, exists: true, data: () => strip(row) } : { id: id, exists: false, data: () => undefined };
  };
  function emitAll() {
    Object.keys(listeners).forEach((c) => listeners[c].forEach((l) => l.next(snap(c))));
    Object.keys(docListeners).forEach((k) => { const [c, id] = k.split('/'); docListeners[k].forEach((l) => l.next(dsnap(c, id))); });
  }
  async function load() {
    const r = await fetch('/api/content', { cache: 'no-store' });
    if (!r.ok) throw { code: 'unavailable' };
    content = await r.json();
    emitAll();
  }
  function ensure() {
    if (!loading) {
      loading = load().catch((error) => {
        Object.values(listeners).concat(Object.values(docListeners)).forEach((ls) => ls.forEach((l) => l.error && l.error(error)));
      });
    }
    return loading;
  }
  async function send(method, url, body) {
    const r = await fetch(url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    if (!r.ok) throw { code: codeFor(r.status) };
    const out = await r.json().catch(() => ({}));
    await load();
    return out;
  }
  function docRef(c, id) {
    return {
      id: id, path: c + '/' + id,
      set: (data) => send('PUT', '/api/admin/' + c + '/' + encodeURIComponent(id), data).then(() => undefined),
      delete: () => send('DELETE', '/api/admin/' + c + '/' + encodeURIComponent(id)).then(() => undefined),
      onSnapshot(next, error) {
        (docListeners[c + '/' + id] = docListeners[c + '/' + id] || []).push({ next: next, error: error });
        if (content) setTimeout(() => next(dsnap(c, id)), 0); else ensure();
        return () => {};
      }
    };
  }
  const db = {
    collection: (c) => ({
      path: c,
      onSnapshot(next, error) {
        (listeners[c] = listeners[c] || []).push({ next: next, error: error });
        if (content) setTimeout(() => next(snap(c)), 0); else ensure();
        return () => {};
      },
      add: (data) => send('POST', '/api/admin/' + c, data).then((out) => docRef(c, out.id)),
      doc: (id) => docRef(c, id)
    }),
    doc: (p) => { const parts = p.split('/'); return docRef(parts[0], parts[1]); }
  };
  let session = null;
  const getSession = () => session || (session = fetch('/api/session', { cache: 'no-store' })
    .then((r) => r.json()).catch(() => ({ admin: false, uploads: false })));
  const user = { canEdit: async () => !!(await getSession()).admin, isOwner: async () => !!(await getSession()).admin };
  window.liveSession = getSession;
  window.claude = { use: async (name) => (name === 'db' ? db : name === 'user' ? user : null) };
})();
