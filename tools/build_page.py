"""Build public/index.html for the live site from the preview page (site/happily-ever-after.html).

The preview page is the design source. This swaps the preview-only parts for live ones:
RSVPs that save, an Admin login, the RSVP list and guest-photo review in Admin, and a real
photo upload form. Run: python3 -I tools/build_page.py <preview.html> <out.html>
"""
import sys, re, os
src, out = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
s = open(src, encoding='utf-8').read()

def rep(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, (old[:80], n)
    s = s.replace(old, new)

# ---------- styles ----------
rep('input[type="text"], input[type="number"], textarea {', 'input[type="text"], input[type="number"], input[type="password"], textarea {')
rep('  .photos .card { display: flex; flex-direction: column; align-items: center; gap: 18px; text-align: center; border-style: dashed; border-color: var(--line-strong); box-shadow: none; }',
    '''  .photos .card { display: flex; flex-direction: column; gap: 18px; }''')
rep('  .photos .card p { margin: 0; max-width: 42ch; }\n  .photos .tag { align-self: center; }', '''  .photos .card > p { margin: 0; }
  progress { width: 100%; height: 10px; accent-color: var(--leaf); }
  .login { padding-inline: clamp(20px, 6vw, 72px); padding-block: 8px 56px; }
  a.mini { display: inline-block; text-decoration: none; }
  .thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 14px; }
  .thumb { margin: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .thumb img, .thumb .video {
    display: flex; align-items: center; justify-content: center;
    width: 100%; aspect-ratio: 1 / 1; object-fit: cover;
    background: var(--field); border: 1px solid var(--line); overflow-wrap: anywhere;
    padding: 0; font-size: 0.8125rem; text-align: center; color: var(--monstera);
  }
  .thumb figcaption { font-size: 0.8125rem; opacity: 0.8; overflow-wrap: anywhere; }
  .sub-note { font-size: 0.9375rem; opacity: 0.85; }''')

# ---------- RSVP reply panel: saved for real ----------
rep('''      <div class="reply" id="rsvp-reply" hidden>
        <span class="tag">Preview</span>
        <p><strong>Nothing was saved.</strong> This page is a preview. On the live site, this reply goes to Katie and Michael:</p>
        <p class="summary" id="rsvp-summary"></p>''', '''      <div class="reply" id="rsvp-reply" hidden>
        <span class="tag">Saved</span>
        <p><strong>Thank you!</strong> Katie and Michael have your reply:</p>
        <p class="summary" id="rsvp-summary"></p>
        <p class="sub-note">Plans changed? Send it again with the same name and it replaces this one.</p>''')
rep('''        <div class="actions">
          <button class="button" type="submit" id="rsvp-send">Send RSVP</button>
        </div>''', '''        <p class="error" id="rsvp-send-error" hidden></p>
        <div class="actions">
          <button class="button" type="submit" id="rsvp-send">Send RSVP</button>
        </div>''')

# ---------- Photos tab: real upload form ----------
a = s.index('    <div class="card">\n      <p>Add your photos from the party')
b = s.index('  </section>', a)
s = s[:a] + '''    <div class="card">
      <p>Share your photos and videos from the party. Upload as many as you like, during the party or after.</p>
      <form id="upload-form" novalidate>
        <div class="field">
          <label class="q" for="upload-name">Your name (optional)</label>
          <input type="text" id="upload-name" maxlength="120" autocomplete="name">
        </div>
        <div class="field">
          <label class="q" for="upload-files">Photos and videos</label>
          <input type="file" id="upload-files" accept="image/*,video/*" multiple>
        </div>
        <progress id="upload-progress" max="100" value="0" hidden></progress>
        <p class="status" id="upload-status" hidden></p>
        <div class="actions">
          <button class="button" type="submit" id="upload-send">Upload</button>
        </div>
      </form>
    </div>
''' + s[b:]

# ---------- Admin: login view, logout, RSVP list, guest photos ----------
rep('''  <section class="admin" id="admin" aria-labelledby="admin-title" data-view="admin" hidden>''', '''  <section class="login" id="login" aria-labelledby="login-title" data-view="login" hidden>
    <header>
      <p class="eyebrow">Editors only</p>
      <h2 id="login-title">Admin</h2>
    </header>
    <div class="card">
      <form id="login-form" novalidate>
        <div class="field">
          <label class="q" for="login-password">Password</label>
          <input type="password" id="login-password" autocomplete="current-password">
        </div>
        <p class="status bad" id="login-status" hidden></p>
        <div class="actions">
          <button class="button" type="submit" id="login-submit">Log in</button>
        </div>
      </form>
    </div>
  </section>

  <section class="admin" id="admin" aria-labelledby="admin-title" data-view="admin" hidden>''')
rep('''    <button class="button quiet" type="button" id="admin-close">Back to the site</button>
''', '''    <div class="actions">
      <button class="button quiet" type="button" id="admin-close">Back to the site</button>
      <button class="button quiet" type="button" id="admin-logout">Log out</button>
    </div>

    <div class="card">
      <h3>RSVPs</h3>
      <p class="sub" id="admin-rsvp-summary">Loading replies.</p>
      <div class="actions">
        <button class="mini" type="button" id="admin-rsvp-refresh">Refresh</button>
        <a class="mini" href="/api/admin/rsvps.csv" download>Download spreadsheet</a>
      </div>
      <ul class="rows" id="admin-rsvp-rows"></ul>
    </div>

    <div class="card">
      <h3>Guest photos</h3>
      <p class="sub" id="admin-upload-summary">Loading photos.</p>
      <div class="actions">
        <button class="mini" type="button" id="admin-upload-refresh">Refresh</button>
      </div>
      <div class="thumbs" id="admin-upload-grid"></div>
    </div>
''')

# ---------- first script (RSVP form): save to the server ----------
first_start = s.index('<script>')
first_end = s.index('</script>', first_start) + len('</script>')
first = s[first_start:first_end]
old_submit = first[first.index("  form.addEventListener('submit', function (event) {"):first.index("  document.getElementById('rsvp-edit')")]
new_submit = '''  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var name = nameInput.value.trim();
    var answered = yes.checked || no.checked;
    var sendError = document.getElementById('rsvp-send-error');
    var send = document.getElementById('rsvp-send');
    nameError.hidden = name !== '';
    attendingError.hidden = answered;
    sendError.hidden = true;
    if (name === '') { nameInput.focus(); return; }
    if (!answered) { yes.focus(); return; }

    var n = clampCount(count.value);
    send.disabled = true;
    fetch('/api/rsvp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, attending: yes.checked ? 'yes' : 'no', count: n })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (out) {
        if (!r.ok) throw new Error(out.error || 'Your reply did not save. Try again in a moment.');
      });
    }).then(function () {
      var line = yes.checked
        ? name + ' \\u00b7 Coming \\u00b7 ' + (n === 1 ? 'Party of 1' : 'Party of ' + n)
        : name + ' \\u00b7 Can\\u2019t make it';
      document.getElementById('rsvp-summary').textContent = line;
      form.hidden = true;
      reply.hidden = false;
    }).catch(function (error) {
      sendError.textContent = error.message;
      sendError.hidden = false;
    }).then(function () { send.disabled = false; });
  });

'''
first_new = first.replace(old_submit, new_submit)
assert first_new != first
s = s[:first_start] + first_new + s[first_end:]

# ---------- store script: login view and an admin-enter signal ----------
rep("const VIEWS = ['home', 'story', 'logistics', 'dress', 'faq', 'know', 'rsvp', 'photos', 'admin'];",
    "const VIEWS = ['home', 'story', 'logistics', 'dress', 'faq', 'know', 'rsvp', 'photos', 'admin', 'login'];")
rep("    if (view === 'admin') return state.canEdit && !!state.db;\n",
    "    if (view === 'admin') return state.canEdit && !!state.db;\n    if (view === 'login') return !state.canEdit;\n")
rep("    Object.keys(LISTS).forEach(renderRows);\n  }\n  $('admin-close')",
    "    Object.keys(LISTS).forEach(renderRows);\n    document.dispatchEvent(new CustomEvent('admin-enter'));\n  }\n  $('admin-close')")
rep("    const wanted = location.hash.slice(1);\n", "    const wanted = location.hash.slice(1) || (location.pathname === '/admin' ? 'admin' : '');\n")
rep("    if (wanted === 'admin') go('admin', false);\n", "    if (wanted === 'admin' || wanted === 'login') go(state.canEdit ? 'admin' : 'login', false);\n")

# ---------- wrap as a full document and add the live scripts ----------
client = open(os.path.join(here, 'live-client.js'), encoding='utf-8').read().rstrip()
admin = open(os.path.join(here, 'live-admin.js'), encoding='utf-8').read().rstrip()
store_start = s.rindex('<script>')
s = s[:store_start] + '<script>\n' + client + '\n</script>\n\n' + s[store_start:].rstrip() + '\n\n<script>\n' + admin + '\n</script>\n'

head_end = s.index('</style>') + len('</style>')
head, body = s[:head_end], s[head_end:]
doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       '<meta name="robots" content="noindex, nofollow">\n'
       '<meta name="description" content="Katie &amp; Michael’s Happily Ever After Party. February 20, 2027, Naples, Florida.">\n'
       '<style>html{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n'
       + head + '\n</head>\n<body>' + body.rstrip() + '\n</body>\n</html>\n')
assert 'Nothing was saved' not in doc and 'Not switched on in this preview' not in doc
open(out, 'w', encoding='utf-8').write(doc)
print('built', out, len(doc), 'bytes')
