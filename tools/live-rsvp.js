  // Live RSVP: one card per person coming. Name and age group are required;
  // a photo and a comment are optional. Inserted into the page's first script by build_page.py.
  var guestsField = document.getElementById('rsvp-guests-field');
  var guestList = document.getElementById('rsvp-guests');
  var addGuestButton = document.getElementById('rsvp-add-guest');
  var sendError = document.getElementById('rsvp-send-error');
  var send = document.getElementById('rsvp-send');
  var progress = document.getElementById('rsvp-progress');
  var MAX_GUESTS = 20;
  var AGES = [['keiki', 'Little Kahuna', 'kid'], ['adult', 'Big Kahuna', 'adult'], ['kupuna', 'Elder', 'senior']];
  var AGE_LABEL = { keiki: 'Little Kahuna', adult: 'Big Kahuna', kupuna: 'Elder' };
  var guests = [];
  var seq = 0;
  var photosOn = true;

  function renumber() {
    guests.forEach(function (g, i) {
      g.title.textContent = 'Paddler ' + (i + 1);
      g.remove.hidden = guests.length < 2;
    });
    addGuestButton.disabled = guests.length >= MAX_GUESTS;
    addGuestButton.textContent = guests.length >= MAX_GUESTS ? 'Canoe is full (' + MAX_GUESTS + ')' : '+ Add another paddler';
  }

  function addGuest(focus) {
    var n = ++seq;
    var li = document.createElement('li');
    li.className = 'guest';
    li.innerHTML =
      '<div class="guest-head"><strong class="guest-title"></strong>' +
      '<button type="button" class="mini guest-remove">Remove</button></div>' +
      '<div class="field"><label class="q" for="g' + n + '-name">Name</label>' +
      '<input type="text" id="g' + n + '-name" maxlength="120" autocomplete="off">' +
      '<p class="error" hidden>Add a name for this paddler.</p></div>' +
      '<fieldset class="field"><legend class="q">Age group</legend><div class="choices ages">' +
      AGES.map(function (a) {
        return '<label class="choice"><input type="radio" name="g' + n + '-age" value="' + a[0] + '"> ' +
          a[1] + ' <small>(' + a[2] + ')</small></label>';
      }).join('') +
      '</div><p class="error" hidden>Pick an age group.</p></fieldset>' +
      '<div class="field guest-photo-field"><label class="q" for="g' + n + '-photo">Snap of this paddler <span class="opt">(optional)</span></label>' +
      '<div class="guest-photo"><img alt="" hidden><input type="file" id="g' + n + '-photo" accept="image/*">' +
      '<button type="button" class="mini" hidden>Remove photo</button></div></div>' +
      '<div class="field"><label class="q" for="g' + n + '-comment">A fun or funny comment <span class="opt">(optional)</span></label>' +
      '<textarea id="g' + n + '-comment" maxlength="300" rows="2" placeholder="Signature dance move, go-to tiki drink, hidden talent…"></textarea></div>';

    var g = {
      li: li,
      file: null,
      touched: false,
      title: li.querySelector('.guest-title'),
      remove: li.querySelector('.guest-remove'),
      name: li.querySelector('input[type="text"]'),
      nameError: li.querySelectorAll('.error')[0],
      ages: Array.prototype.slice.call(li.querySelectorAll('input[type="radio"]')),
      ageError: li.querySelectorAll('.error')[1],
      photoField: li.querySelector('.guest-photo-field'),
      photo: li.querySelector('input[type="file"]'),
      preview: li.querySelector('.guest-photo img'),
      clearPhoto: li.querySelector('.guest-photo button'),
      comment: li.querySelector('textarea')
    };
    g.photoField.hidden = !photosOn;

    g.name.addEventListener('input', function () { g.touched = g.name.value !== ''; g.nameError.hidden = true; });
    g.ages.forEach(function (r) { r.addEventListener('change', function () { g.ageError.hidden = true; }); });
    g.photo.addEventListener('change', function () {
      var f = g.photo.files && g.photo.files[0];
      if (g.preview.src) URL.revokeObjectURL(g.preview.src);
      g.file = f || null;
      g.preview.hidden = !f;
      g.clearPhoto.hidden = !f;
      if (f) { g.preview.src = URL.createObjectURL(f); g.preview.alt = 'Chosen photo'; } else { g.preview.removeAttribute('src'); }
    });
    g.clearPhoto.addEventListener('click', function () {
      g.photo.value = '';
      g.photo.dispatchEvent(new Event('change'));
      g.photo.focus();
    });
    g.remove.addEventListener('click', function () {
      var i = guests.indexOf(g);
      if (i < 0 || guests.length < 2) return;
      if (g.preview.src) URL.revokeObjectURL(g.preview.src);
      guests.splice(i, 1);
      li.remove();
      renumber();
      (guests[i] || guests[i - 1]).name.focus();
    });

    guests.push(g);
    guestList.appendChild(li);
    if (guests.length === 1 && nameInput.value.trim()) g.name.value = nameInput.value.trim();
    renumber();
    if (focus) g.name.focus();
  }

  // The first paddler's name follows "Your name" until it is typed in directly.
  nameInput.addEventListener('input', function () {
    nameError.hidden = true;
    var first = guests[0];
    if (first && !first.touched) first.name.value = nameInput.value.trim();
  });
  function syncGuests() { guestsField.hidden = no.checked; }
  yes.addEventListener('change', function () { syncGuests(); attendingError.hidden = true; });
  no.addEventListener('change', function () { syncGuests(); attendingError.hidden = true; });
  addGuestButton.addEventListener('click', function () { if (guests.length < MAX_GUESTS) addGuest(true); });
  addGuest(false);
  syncGuests();

  // Hide the photo pickers if photo storage is not switched on (checked once the page has loaded).
  window.addEventListener('DOMContentLoaded', function () {
    if (!window.liveSession) return;
    window.liveSession().then(function (s) {
      photosOn = !!s.uploads;
      guests.forEach(function (g) { g.photoField.hidden = !photosOn; });
    });
  });

  // Phone photos are large: send a copy at most 1600 px on the long side.
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '')) return resolve(file);
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, 1600 / Math.max(w, h));
        if (!w || !h || (scale === 1 && file.size <= 1500000)) { URL.revokeObjectURL(url); return resolve(file); }
        var c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b && b.size ? b : file); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function post(data) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/rsvp');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable && e.total > 200000) { progress.hidden = false; progress.value = Math.round((e.loaded / e.total) * 100); }
      };
      xhr.onload = function () {
        var out = {};
        try { out = JSON.parse(xhr.responseText); } catch (error) { /* keep the empty object */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(out);
        else reject(new Error(out.error || 'Your reply did not save. Try again in a moment.'));
      };
      xhr.onerror = function () { reject(new Error('The connection dropped. Try again.')); };
      xhr.send(data);
    });
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = nameInput.value.trim();
    var answered = yes.checked || no.checked;
    nameError.hidden = name !== '';
    attendingError.hidden = answered;
    sendError.hidden = true;
    if (name === '') { nameInput.focus(); return; }
    if (!answered) { yes.focus(); return; }

    var coming = yes.checked;
    var firstBad = null;
    var list = [];
    if (coming) {
      guests.forEach(function (g) {
        var gname = g.name.value.trim();
        var picked = g.ages.filter(function (r) { return r.checked; })[0];
        g.nameError.hidden = gname !== '';
        g.ageError.hidden = !!picked;
        if (!firstBad && !gname) firstBad = g.name;
        if (!firstBad && !picked) firstBad = g.ages[0];
        list.push({ name: gname, age: picked ? picked.value : '', comment: g.comment.value.trim(), file: photosOn ? g.file : null });
      });
      if (firstBad) { firstBad.focus(); return; }
    }

    send.disabled = true;
    progress.value = 0;
    var payload = {
      name: name,
      attending: coming ? 'yes' : 'no',
      guests: list.map(function (g) { return { name: g.name, age: g.age, comment: g.comment }; })
    };
    var data = new FormData();
    data.append('data', JSON.stringify(payload));
    list.reduce(function (chain, g, i) {
      if (!g.file) return chain;
      return chain.then(function () {
        return shrink(g.file).then(function (blob) {
          var fname = blob === g.file ? (g.file.name || 'photo') : 'photo-' + (i + 1) + '.jpg';
          data.append('photo-' + i, blob, fname);
        });
      });
    }, Promise.resolve()).then(function () {
      return post(data);
    }).then(function () {
      var lines = coming
        ? [name + ' · Coming · ' + (list.length === 1 ? '1 paddler' : list.length + ' paddlers')].concat(list.map(function (g) {
            return g.name + ' — ' + AGE_LABEL[g.age] + (g.file ? ' · photo' : '') + (g.comment ? ' · “' + g.comment + '”' : '');
          }))
        : [name + ' · Can’t make it'];
      document.getElementById('rsvp-summary').textContent = lines.join('\n');
      form.hidden = true;
      reply.hidden = false;
    }).catch(function (error) {
      sendError.textContent = error.message;
      sendError.hidden = false;
    }).then(function () {
      send.disabled = false;
      progress.hidden = true;
    });
  });

