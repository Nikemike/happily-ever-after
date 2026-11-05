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
  const AGE = { keiki: 'Little Kahuna (kid)', adult: 'Big Kahuna (adult)', kupuna: 'Elder (senior)' };
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
  let rsvps = [], rsvpConfirm = null;
  function guestList(r) {
    const ul = document.createElement('ul'); ul.className = 'guest-list';
    r.guests.forEach((g) => {
      const li = document.createElement('li');
      if (g.photo && g.photo.id) {
        const a = document.createElement('a');
        a.href = '/rsvp-photo/' + encodeURIComponent(r.id) + '/' + encodeURIComponent(g.photo.id);
        a.target = '_blank'; a.rel = 'noopener';
        const img = document.createElement('img');
        img.src = a.href; img.alt = 'Photo of ' + (g.name || 'guest'); img.loading = 'lazy';
        a.appendChild(img); li.appendChild(a);
      } else {
        const none = document.createElement('div'); none.className = 'nophoto'; none.setAttribute('aria-hidden', 'true');
        li.appendChild(none);
      }
      const who = document.createElement('div'); who.className = 'who';
      const b = document.createElement('b'); b.textContent = g.name || 'No name';
      const small = document.createElement('small'); small.textContent = AGE[g.age] || 'Age group not given';
      who.append(b, small);
      if (g.comment) { const q = document.createElement('q'); q.textContent = g.comment; who.appendChild(q); }
      li.appendChild(who);
      ul.appendChild(li);
    });
    return ul;
  }
  function drawRsvps() {
    const yes = rsvps.filter((r) => r.attending === 'yes');
    const people = yes.reduce((n, r) => n + (Number(r.count) || 0), 0);
    const no = rsvps.length - yes.length;
    const ages = { adult: 0, keiki: 0, kupuna: 0 };
    let unlisted = 0;
    yes.forEach((r) => {
      const list = Array.isArray(r.guests) ? r.guests : [];
      list.forEach((g) => { if (g.age in ages) ages[g.age]++; });
      unlisted += Math.max(0, (Number(r.count) || 0) - list.length);
    });
    const split = [];
    if (ages.adult) split.push(plural(ages.adult, 'adult', 'adults'));
    if (ages.keiki) split.push(plural(ages.keiki, 'kid', 'kids'));
    if (ages.kupuna) split.push(plural(ages.kupuna, 'senior', 'seniors'));
    if (unlisted) split.push(unlisted + ' without an age group');
    $('admin-rsvp-summary').textContent = rsvps.length
      ? plural(rsvps.length, 'reply', 'replies') + ': ' + yes.length + ' coming (' + plural(people, 'person', 'people') +
        (split.length ? ': ' + split.join(', ') : '') + '), ' + no + ' can’t make it.'
      : 'No replies yet.';
    $('admin-rsvp-rows').replaceChildren(...rsvps.map((r) => {
      const li = document.createElement('li'); li.className = 'row';
      const what = document.createElement('div'); what.className = 'what';
      const strong = document.createElement('strong'); strong.textContent = r.name || 'No name';
      const span = document.createElement('span');
      span.textContent = (r.attending === 'yes' ? 'Coming, party of ' + r.count : 'Can’t make it') + ' · ' + when(r.updatedAt);
      what.append(strong, span);
      if (r.device && r.device.summary) {
        const dev = document.createElement('small'); dev.className = 'device-line';
        dev.textContent = 'Sent from ' + r.device.summary + (r.device.ip ? ' · IP ' + r.device.ip : '');
        what.appendChild(dev);
      }
      if (r.attending === 'yes' && Array.isArray(r.guests) && r.guests.length) what.appendChild(guestList(r));
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
  let uploads = [], uploadConfirm = null, deviceFilter = '', deviceConfirm = false, refreshTimer = null;
  const fullTime = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const mb = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB');
  function tag(label, value) {
    const div = document.createElement('div');
    const b = document.createElement('b'); b.textContent = label + ': ';
    div.append(b, document.createTextNode(value));
    return div;
  }
  function photoRow(u) {
    const li = document.createElement('li'); li.className = 'row photo-row';
    const link = document.createElement('a');
    link.className = 'photo-thumb'; link.href = '/media/' + encodeURIComponent(u.id); link.target = '_blank'; link.rel = 'noopener';
    link.title = 'Open the original file';
    const isVideo = /^video\//.test(u.type);
    const src = u.status === 'public' && u.thumb ? '/photo/' + encodeURIComponent(u.id) + '/thumb' : (!isVideo ? '/media/' + encodeURIComponent(u.id) : '');
    if (src) {
      const img = document.createElement('img'); img.src = src; img.alt = u.filename || 'Guest photo'; img.loading = 'lazy';
      link.appendChild(img);
    } else {
      link.textContent = isVideo ? 'Video' : 'File';
    }
    if (isVideo) { const badge = document.createElement('span'); badge.className = 'play'; badge.textContent = '▶'; link.appendChild(badge); }

    const what = document.createElement('div'); what.className = 'what tags';
    const head = document.createElement('strong');
    head.textContent = (u.by || 'No name given') + ' · ' + fullTime(u.createdAt);
    const state = document.createElement('div');
    state.className = 'state ' + (u.status || 'processing');
    state.textContent = u.status === 'public' ? 'In the public gallery (location removed)'
      : u.status === 'private' ? (u.reason || 'Not in the gallery.') : 'Making the location-free copy…';
    what.append(head, state);
    const d = u.device || null;
    if (d) {
      what.appendChild(tag('Device', d.summary + (d.screen ? ' · screen ' + d.screen : '')));
      if (d.ip) what.appendChild(tag('IP', d.ip + (d.forwardedFor && d.forwardedFor !== d.ip ? ' (forwarded for ' + d.forwardedFor + ')' : '')));
      if (d.id) {
        const idLine = tag('Device ID', d.id + ' ');
        if (deviceFilter !== d.id) idLine.appendChild(mini('Only this device', false, () => { deviceFilter = d.id; deviceConfirm = false; drawUploads(); }));
        what.appendChild(idLine);
      }
      const ua = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = 'Full browser details';
      const code = document.createElement('code'); code.textContent = d.userAgent || '(none sent)';
      ua.append(sum, code);
      what.appendChild(ua);
    } else {
      what.appendChild(tag('Device', 'not recorded (uploaded before device tagging)'));
    }
    const c = u.camera || {};
    if (c.model || c.taken) what.appendChild(tag('Camera', [c.model, c.lens && c.lens !== c.model ? c.lens : '', c.taken ? 'taken ' + c.taken : ''].filter(Boolean).join(' · ')));
    else if (u.status && u.status !== 'processing') what.appendChild(tag('Camera', 'no camera details in the file'));
    what.appendChild(tag('File', (u.filename || 'unnamed') + ' · ' + mb(u.size || 0)));

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
    li.append(link, what, acts);
    return li;
  }
  function drawUploads() {
    const shown = deviceFilter ? uploads.filter((u) => u.device && u.device.id === deviceFilter) : uploads;
    const inGallery = uploads.filter((u) => u.status === 'public').length;
    $('admin-upload-summary').textContent = uploads.length
      ? plural(uploads.length, 'file', 'files') + ' uploaded by guests, ' + inGallery + ' in the public gallery. Only you can see the details below.'
      : 'No guest photos yet.';
    const bar = $('admin-upload-filter');
    bar.hidden = !deviceFilter;
    if (deviceFilter) {
      const text = document.createElement('p');
      text.textContent = 'Showing ' + plural(shown.length, 'file', 'files') + ' from device ' + deviceFilter + '.';
      const acts = document.createElement('div'); acts.className = 'actions';
      acts.appendChild(mini('Show all', false, () => { deviceFilter = ''; deviceConfirm = false; drawUploads(); }));
      if (deviceConfirm) {
        acts.append(
          mini('Yes, delete all ' + shown.length, true, async () => {
            try { await call('POST', '/api/admin/uploads/delete-device', { device: deviceFilter }); deviceFilter = ''; deviceConfirm = false; loadUploads(); }
            catch (error) { $('admin-upload-summary').textContent = error.message; }
          }),
          mini('Keep', false, () => { deviceConfirm = false; drawUploads(); })
        );
      } else if (shown.length) {
        acts.appendChild(mini('Delete all ' + shown.length + ' from this device', true, () => { deviceConfirm = true; drawUploads(); }));
      }
      bar.replaceChildren(text, acts);
    }
    $('admin-upload-grid').replaceChildren(...shown.map(photoRow));
    clearTimeout(refreshTimer);
    if (uploads.some((u) => !u.status || u.status === 'processing')) refreshTimer = setTimeout(loadUploads, 5000);
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
  // iPhone HEIC photos: the server cannot read them, so send a JPEG copy the browser makes
  // (Safari can). The server re-encodes it and removes all location data before it is public.
  function heicPreview(file) {
    if (!/image\/hei[cf]/i.test(file.type || '') && !/\.hei[cf]$/i.test(file.name || '')) return Promise.resolve(null);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => resolve(b && b.size ? b : null), 'image/jpeg', 0.88);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  async function sendOne(file, name) {
    const device = window.heaDevice ? await window.heaDevice() : {};
    const preview = await heicPreview(file);
    return new Promise((resolve, reject) => {
      const data = new FormData();
      data.append('name', name);
      data.append('device', JSON.stringify(device));
      if (preview) data.append('preview', preview, 'preview.jpg');
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
      : 'Thank you! ' + ok + (ok === 1 ? ' file' : ' files') + ' uploaded. ' + (ok === 1 ? 'It shows' : 'They show') + ' in the gallery below in a minute.', failed.length > 0);
    if (ok) document.dispatchEvent(new CustomEvent('photos-uploaded'));
  });
})();
