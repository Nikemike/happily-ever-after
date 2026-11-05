(function () {
  'use strict';
  // Public gallery on the Photos tab: everyone's photos and videos, newest first. Only the
  // location-free copies the server makes are shown; originals stay in Admin.
  const $ = (id) => document.getElementById(id);
  const section = $('photos'), grid = $('gallery-grid'), status = $('gallery-status'), more = $('gallery-more');
  const viewer = $('viewer'), media = $('viewer-media'), caption = $('viewer-caption');
  const PAGE = 48;
  let photos = [], shown = PAGE, current = -1, timer = null, loading = false;

  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const url = (p, size) => '/photo/' + encodeURIComponent(p.id) + '/' + size;

  function draw() {
    status.textContent = photos.length
      ? photos.length + (photos.length === 1 ? ' photo or video so far.' : ' photos and videos so far.')
      : 'No photos yet. Be the first to add one!';
    const list = photos.slice(0, shown);
    // Keep tiles that are already on screen so images do not reload on every refresh.
    const have = new Map([...grid.children].map((el) => [el.dataset.id, el]));
    const tiles = list.map((p, i) => {
      let b = have.get(p.id);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button'; b.className = 'tile'; b.dataset.id = p.id;
        const img = document.createElement('img');
        img.src = url(p, 'thumb'); img.loading = 'lazy'; img.alt = '';
        b.appendChild(img);
        if (p.kind === 'video') { const v = document.createElement('span'); v.className = 'play'; v.textContent = '▶'; b.appendChild(v); }
        b.setAttribute('aria-label', (p.kind === 'video' ? 'Video' : 'Photo') + (p.by ? ' shared by ' + p.by : ''));
      }
      b.onclick = () => open(photos.indexOf(p));
      return b;
    });
    grid.replaceChildren(...tiles);
    more.hidden = photos.length <= shown;
  }

  async function load() {
    if (loading) return;
    loading = true;
    try {
      const r = await fetch('/api/photos', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      photos = await r.json();
      draw();
    } catch (error) {
      if (!photos.length) status.textContent = 'The photos could not load. Try again in a moment.';
    }
    loading = false;
  }

  function show(i) {
    const p = photos[i];
    if (!p) return;
    current = i;
    let el;
    if (p.kind === 'video') {
      el = document.createElement('video');
      el.controls = true; el.playsInline = true; el.preload = 'metadata';
      el.poster = url(p, 'thumb'); el.src = url(p, 'view');
    } else {
      el = document.createElement('img');
      el.src = url(p, 'view'); el.alt = p.by ? 'Photo shared by ' + p.by : 'Party photo';
    }
    media.replaceChildren(el);
    caption.textContent = (p.by ? 'Shared by ' + p.by + ' · ' : '') + when(p.at) + ' · ' + (i + 1) + ' of ' + photos.length;
    $('viewer-download').href = url(p, 'view') + '?download=1';
    $('viewer-prev').disabled = i === 0;
    $('viewer-next').disabled = i === photos.length - 1;
  }
  function open(i) {
    show(i);
    if (!viewer.open) viewer.showModal();
  }
  function close() {
    media.replaceChildren();
    if (viewer.open) viewer.close();
  }
  $('viewer-prev').addEventListener('click', () => show(current - 1));
  $('viewer-next').addEventListener('click', () => show(current + 1));
  $('viewer-close').addEventListener('click', close);
  viewer.addEventListener('close', () => media.replaceChildren());
  viewer.addEventListener('click', (e) => { if (e.target === viewer) close(); });
  viewer.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' && current > 0) show(current - 1);
    if (e.key === 'ArrowRight' && current < photos.length - 1) show(current + 1);
  });
  more.addEventListener('click', () => { shown += PAGE; draw(); });

  // Load when the Photos tab is open, and check for new photos every minute while it is.
  function sync() {
    clearInterval(timer);
    if (section.hidden) return;
    load();
    timer = setInterval(() => { if (!document.hidden && !viewer.open) load(); }, 60000);
  }
  new MutationObserver(sync).observe(section, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('photos-uploaded', () => { setTimeout(load, 4000); setTimeout(load, 15000); });
  sync();
})();
