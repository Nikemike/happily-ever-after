(function () {
  'use strict';
  // Live-only pieces: Admin login and logout, the RSVP list, guest photo review, and guest uploads.
  const $ = (id) => document.getElementById(id);
  const say = (el, text, bad) => { el.className = bad ? 'status bad' : 'status'; el.textContent = text; el.hidden = false; };
  async function call(method, url, body) {
    const r = await fetch(url, { method: method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || 'Something went wrong. Try again.');
    return out;
  }
  const when = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
  const mini = (label, danger, onClick) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = danger ? 'mini danger' : 'mini'; b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };

  /* ---------- login and logout ---------- */
  $('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('login-status'), button = $('login-submit');
    const password = $('login-password').value;
    if (!password) { say(status, 'Type the password first.', true); $('login-password').focus(); return; }
    button.disabled = true;
    try {
      await call('POST', '/api/login', { password: password });
      location.hash = 'admin';
      location.reload();
    } catch (error) {
      say(status, error.message, true);
      button.disabled = false;
    }
  });
  $('admin-logout').addEventListener('click', async () => {
    try { await call('POST', '/api/logout'); } catch (error) { /* the cookie is cleared either way */ }
    location.href = '/';
  });

  /* ---------- RSVPs ---------- */
  let rsvps = [], rsvpConfirm = null;
  function drawRsvps() {
    const yes = rsvps.filter((r) => r.attending === 'yes');
    const people = yes.reduce((n, r) => n + (Number(r.count) || 0), 0);
    const no = rsvps.length - yes.length;
    $('admin-rsvp-summary').textContent = rsvps.length
      ? rsvps.length + (rsvps.length === 1 ? ' reply' : ' replies') + ': ' + yes.length + ' coming (' + people + (people === 1 ? ' person' : ' people') + '), ' + no + ' can’t make it.'
      : 'No replies yet.';
    $('admin-rsvp-rows').replaceChildren(...rsvps.map((r) => {
      const li = document.createElement('li'); li.className = 'row';
      const what = document.createElement('div'); what.className = 'what';
      const strong = document.createElement('strong'); strong.textContent = r.name || 'No name';
      const span = document.createElement('span');
      span.textContent = (r.attending === 'yes' ? 'Coming, party of ' + r.count : 'Can’t make it') + ' · ' + when(r.updatedAt);
      what.append(strong, span);
      const acts = document.createElement('div'); acts.className = 'acts';
      if (rsvpConfirm === r.id) {
        acts.append(
          mini('Yes, delete', true, async () => {
            try { await call('DELETE', '/api/admin/rsvps/' + encodeURIComponent(r.id)); rsvpConfirm = null; loadRsvps(); }
            catch (error) { $('admin-rsvp-summary').textContent = error.message; }
          }),
          mini('Keep', false, () => { rsvpConfirm = null; drawRsvps(); })
        );
      } else {
        acts.append(mini('Delete', false, () => { rsvpConfirm = r.id; drawRsvps(); }));
      }
      li.append(what, acts);
      return li;
    }));
  }
  async function loadRsvps() {
    try { rsvps = await call('GET', '/api/admin/rsvps'); drawRsvps(); }
    catch (error) { $('admin-rsvp-summary').textContent = error.message; }
  }
  $('admin-rsvp-refresh').addEventListener('click', loadRsvps);

  /* ---------- guest photos (review) ---------- */
  let uploads = [], uploadConfirm = null;
  function drawUploads() {
    $('admin-upload-summary').textContent = uploads.length
      ? uploads.length + (uploads.length === 1 ? ' file' : ' files') + ' uploaded by guests.'
      : 'No guest photos yet.';
    $('admin-upload-grid').replaceChildren(...uploads.map((u) => {
      const fig = document.createElement('figure'); fig.className = 'thumb';
      if (/^image\//.test(u.type)) {
        const img = document.createElement('img');
        img.src = '/media/' + encodeURIComponent(u.id); img.alt = u.filename || 'Guest photo'; img.loading = 'lazy';
        fig.appendChild(img);
      } else {
        const a = document.createElement('a');
        a.href = '/media/' + encodeURIComponent(u.id); a.target = '_blank'; a.rel = 'noopener';
        a.className = 'video'; a.textContent = 'Video: ' + (u.filename || 'open');
        fig.appendChild(a);
      }
      const cap = document.createElement('figcaption');
      cap.textContent = (u.by ? u.by + ' · ' : '') + when(u.createdAt);
      const acts = document.createElement('div'); acts.className = 'acts';
      if (uploadConfirm === u.id) {
        acts.append(
          mini('Yes, delete', true, async () => {
            try { await call('DELETE', '/api/admin/uploads/' + encodeURIComponent(u.id)); uploadConfirm = null; loadUploads(); }
            catch (error) { $('admin-upload-summary').textContent = error.message; }
          }),
          mini('Keep', false, () => { uploadConfirm = null; drawUploads(); })
        );
      } else {
        acts.append(mini('Delete', false, () => { uploadConfirm = u.id; drawUploads(); }));
      }
      fig.append(cap, acts);
      return fig;
    }));
  }
  async function loadUploads() {
    try { uploads = await call('GET', '/api/admin/uploads'); drawUploads(); }
    catch (error) { $('admin-upload-summary').textContent = error.message; }
  }
  $('admin-upload-refresh').addEventListener('click', loadUploads);
  document.addEventListener('admin-enter', () => { loadRsvps(); loadUploads(); });

  /* ---------- guest upload form ---------- */
  const form = $('upload-form'), files = $('upload-files'), status = $('upload-status'), bar = $('upload-progress'), send = $('upload-send');
  (window.liveSession ? window.liveSession() : Promise.resolve({ uploads: false })).then((s) => {
    if (!s.uploads) { send.disabled = true; files.disabled = true; say(status, 'Photo uploads are not switched on yet.', false); }
  });
  function sendOne(file, name) {
    return new Promise((resolve, reject) => {
      const data = new FormData();
      data.append('name', name);
      data.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.value = Math.round((e.loaded / e.total) * 100); };
      xhr.onload = () => {
        let out = {}; try { out = JSON.parse(xhr.responseText); } catch (error) { /* keep the empty object */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(out); else reject(new Error(out.error || 'That upload did not go through.'));
      };
      xhr.onerror = () => reject(new Error('The connection dropped. Try again.'));
      xhr.send(data);
    });
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const list = Array.from(files.files || []);
    if (!list.length) { say(status, 'Choose at least one photo or video.', true); return; }
    const name = $('upload-name').value.trim();
    send.disabled = true; files.disabled = true; bar.hidden = false;
    let ok = 0; const failed = [];
    for (let i = 0; i < list.length; i++) {
      say(status, 'Uploading ' + (i + 1) + ' of ' + list.length + '…', false);
      bar.value = 0;
      try { await sendOne(list[i], name); ok++; } catch (error) { failed.push(list[i].name + ': ' + error.message); }
    }
    bar.hidden = true; send.disabled = false; files.disabled = false;
    if (ok) files.value = '';
    say(status, failed.length
      ? (ok ? ok + ' uploaded. ' : '') + 'These did not go through: ' + failed.join(' ')
      : 'Thank you! ' + ok + (ok === 1 ? ' file' : ' files') + ' uploaded.', failed.length > 0);
  });
})();
