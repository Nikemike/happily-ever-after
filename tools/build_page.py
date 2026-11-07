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
  .sub-note { font-size: 0.9375rem; opacity: 0.85; }
  .field-hint { margin: 0; font-size: 0.9375rem; opacity: 0.82; }
  .guests { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px; }
  .guest {
    display: flex; flex-direction: column; gap: 18px;
    padding: 18px; border: 1.5px dashed var(--line-strong); border-radius: 6px; background: var(--paper);
  }
  .guest-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 34px; }
  .guest-title { font-size: 0.8125rem; letter-spacing: 0.18em; text-transform: uppercase; color: var(--thatch); }
  .ages .choice { flex: 1 1 150px; }
  .choice small, .opt { font-weight: 400; opacity: 0.75; }
  .guest textarea { min-height: 72px; }
  .guest-photo { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .guest-photo input { flex: 1 1 200px; min-width: 0; }
  .guest-photo img { width: 72px; height: 72px; object-fit: cover; border-radius: 4px; border: 1px solid var(--line); }
  .reply .summary { white-space: pre-line; }
  .guest-list { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .guest-list li { display: flex; align-items: flex-start; gap: 12px; }
  .guest-list a { flex: none; display: block; }
  .guest-list img, .guest-list .nophoto {
    flex: none; display: block; width: 56px; height: 56px; object-fit: cover;
    border-radius: 4px; border: 1px solid var(--line); background: var(--field);
  }
  .guest-list .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .guest-list b, .guest-list q { overflow-wrap: anywhere; }
  .guest-list small { font-size: 0.875rem; opacity: 0.8; }
  .guest-list q { font-style: italic; font-size: 0.9375rem; }
  .device-line { font-size: 0.8125rem; opacity: 0.75; overflow-wrap: anywhere; }
  .gallery-wrap { max-width: 1100px; margin: 48px auto 0; display: flex; flex-direction: column; gap: 14px; }
  .gallery-wrap h3 { margin: 0; text-align: center; font-family: var(--font-caps); font-weight: 600; font-size: 1.5rem; }
  .gallery { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  @media (min-width: 640px) { .gallery { grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; } }
  .tile {
    position: relative; display: block; padding: 0; border: 0; border-radius: 4px; overflow: hidden;
    aspect-ratio: 1 / 1; background: var(--field); cursor: zoom-in;
  }
  .tile img { display: block; width: 100%; height: 100%; object-fit: cover; transition: transform 200ms ease; }
  .tile:hover img { transform: scale(1.04); }
  .play {
    position: absolute; right: 8px; bottom: 8px; width: 30px; height: 30px; display: grid; place-items: center;
    border-radius: 50%; background: rgba(31, 61, 42, 0.78); color: #fff; font-size: 0.75rem; pointer-events: none;
  }
  .actions.center { justify-content: center; }
  dialog.viewer {
    width: min(1100px, calc(100vw - 24px)); max-width: none; max-height: calc(100vh - 24px); padding: 0; border: 0;
    border-radius: 6px; background: #12241a; color: #f1eee1; overflow: hidden;
  }
  dialog.viewer::backdrop { background: rgba(10, 20, 14, 0.85); }
  .viewer-media { display: flex; align-items: center; justify-content: center; background: #0c1811; min-height: 120px; }
  .viewer-media img, .viewer-media video { display: block; max-width: 100%; max-height: calc(100vh - 140px); object-fit: contain; }
  .viewer-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; padding: 12px 16px; }
  .viewer-bar p { margin: 0; font-size: 0.9375rem; overflow-wrap: anywhere; }
  .viewer .mini { background: transparent; color: #f1eee1; border-color: rgba(241, 238, 225, 0.45); }
  .viewer .mini:hover { background: rgba(241, 238, 225, 0.12); }
  .viewer .mini:disabled { opacity: 0.35; cursor: default; }
  .photo-row .photo-thumb {
    position: relative; flex: none; width: 96px; height: 96px; display: grid; place-items: center; overflow: hidden;
    border-radius: 4px; border: 1px solid var(--line); background: var(--field); color: var(--monstera);
    font-size: 0.8125rem; text-decoration: none;
  }
  .photo-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .photo-thumb .play { right: 6px; bottom: 6px; width: 24px; height: 24px; font-size: 0.625rem; }
  .row .tags { gap: 3px; font-size: 0.875rem; }
  .tags > div { overflow-wrap: anywhere; }
  .tags .state { font-weight: 700; }
  .tags .state.public { color: var(--leaf); }
  .tags .state.private { color: var(--hibiscus); }
  .tags .state.processing { color: var(--thatch); }
  .tags .mini { padding: 5px 9px; margin-left: 4px; font-size: 0.625rem; }
  .tags summary { cursor: pointer; opacity: 0.8; }
  .tags code { display: block; margin-top: 4px; font-size: 0.75rem; overflow-wrap: anywhere; opacity: 0.8; }
  .filter-bar { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; background: var(--field); border-radius: 4px; }
  .filter-bar p { margin: 0; font-weight: 700; overflow-wrap: anywhere; }''')

# ---------- RSVP reply panel: saved for real ----------
rep('''      <div class="reply" id="rsvp-reply" hidden>
        <span class="tag">Preview</span>
        <p><strong>Nothing was saved.</strong> This page is a preview. On the live site, this reply goes to Katie and Michael:</p>
        <p class="summary" id="rsvp-summary"></p>''', '''      <div class="reply" id="rsvp-reply" hidden>
        <span class="tag">Saved</span>
        <p><strong>Thank you!</strong> Katie and Michael have your reply:</p>
        <p class="summary" id="rsvp-summary"></p>
        <p class="sub-note">Plans changed? Send it again with the same name and it replaces this one. Photos you already sent stay put unless you pick new ones.</p>''')
rep('''        <div class="actions">
          <button class="button" type="submit" id="rsvp-send">Send RSVP</button>
        </div>''', '''        <progress id="rsvp-progress" max="100" value="0" hidden></progress>
        <p class="error" id="rsvp-send-error" hidden></p>
        <div class="actions">
          <button class="button" type="submit" id="rsvp-send">Send RSVP</button>
        </div>''')

# ---------- RSVP: one card per guest instead of a party-size stepper ----------
rep('''        <div class="field" id="rsvp-count-field">
          <label class="q" for="rsvp-count">How many in your party, counting you?</label>
          <div class="stepper">
            <button type="button" id="rsvp-count-down" aria-label="One fewer">&minus;</button>
            <input type="number" id="rsvp-count" name="count" min="1" max="20" value="1" inputmode="numeric">
            <button type="button" id="rsvp-count-up" aria-label="One more">+</button>
          </div>
        </div>''', '''        <fieldset class="field" id="rsvp-guests-field">
          <legend class="q">Who\u2019s in your canoe?</legend>
          <p class="field-hint">Everyone coming in your group, you included. A name and age group for each paddler, please. A photo or a comment is optional, but highly encouraged.</p>
          <ol class="guests" id="rsvp-guests"></ol>
          <div class="actions">
            <button class="button quiet" type="button" id="rsvp-add-guest">+ Add another paddler</button>
          </div>
        </fieldset>''')

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

    <div class="gallery-wrap" aria-labelledby="gallery-title">
      <h3 id="gallery-title">Everyone\u2019s photos</h3>
      <p class="hint" id="gallery-status">Loading photos.</p>
      <div class="gallery" id="gallery-grid"></div>
      <div class="actions center">
        <button class="button quiet" type="button" id="gallery-more" hidden>Show more</button>
      </div>
    </div>
''' + s[b:]

# full-size viewer, at page level so it can open over any tab
rep('<dialog class="pop" id="pop"', '''<dialog class="viewer" id="viewer" aria-label="Photo viewer">
  <div class="viewer-media" id="viewer-media"></div>
  <div class="viewer-bar">
    <p id="viewer-caption"></p>
    <div class="actions">
      <a class="mini" id="viewer-download" href="#">Download</a>
      <button class="mini" type="button" id="viewer-prev">Previous</button>
      <button class="mini" type="button" id="viewer-next">Next</button>
      <button class="mini" type="button" id="viewer-close">Close</button>
    </div>
  </div>
</dialog>

<dialog class="pop" id="pop"''')

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
      <div class="filter-bar" id="admin-upload-filter" hidden></div>
      <ul class="rows" id="admin-upload-grid"></ul>
    </div>
''')

# ---------- first script (RSVP form): save to the server ----------
first_start = s.index('<script>')
first_end = s.index('</script>', first_start) + len('</script>')
first = s[first_start:first_end]
rsvp_js = open(os.path.join(here, 'live-rsvp.js'), encoding='utf-8').read()
old_submit = first[first.index("  var countField = document.getElementById('rsvp-count-field');"):first.index("  document.getElementById('rsvp-edit')")]
new_submit = rsvp_js
first_new = first.replace(old_submit, new_submit)
assert first_new != first
s = s[:first_start] + first_new + s[first_end:]

# ---------- store script: login view and an admin-enter signal ----------
rep("const VIEWS = ['home', 'story', 'logistics', 'dress', 'faq', 'know', 'rsvp', 'registry', 'photos', 'admin'];",
    "const VIEWS = ['home', 'story', 'logistics', 'dress', 'faq', 'know', 'rsvp', 'registry', 'photos', 'admin', 'login'];")
rep("    if (view === 'admin') return state.canEdit && !!state.db;\n",
    "    if (view === 'admin') return state.canEdit && !!state.db;\n    if (view === 'login') return !state.canEdit;\n")
rep("    Object.keys(LISTS).forEach(renderRows);\n  }\n  $('admin-close')",
    "    Object.keys(LISTS).forEach(renderRows);\n    document.dispatchEvent(new CustomEvent('admin-enter'));\n  }\n  $('admin-close')")
rep("    const wanted = location.hash.slice(1);\n", "    const wanted = location.hash.slice(1) || (location.pathname === '/admin' ? 'admin' : '');\n")
rep("    if (wanted === 'admin') go('admin', false);\n", "    if (wanted === 'admin' || wanted === 'login') go(state.canEdit ? 'admin' : 'login', false);\n")

# ---------- wrap as a full document and add the live scripts ----------
client = open(os.path.join(here, 'live-client.js'), encoding='utf-8').read().rstrip()
admin = open(os.path.join(here, 'live-admin.js'), encoding='utf-8').read().rstrip()
gallery = open(os.path.join(here, 'live-gallery.js'), encoding='utf-8').read().rstrip()
store_start = s.rindex('<script>')
s = s[:store_start] + '<script>\n' + client + '\n</script>\n\n' + s[store_start:].rstrip() + '\n\n<script>\n' + admin + '\n</script>\n\n<script>\n' + gallery + '\n</script>\n'

head_end = s.index('</style>') + len('</style>')
head, body = s[:head_end], s[head_end:]
doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
       '<meta name="robots" content="noindex, nofollow">\n'
       '<meta name="description" content="Katie &amp; Michael’s Happily Ever After Party. February 20, 2027, Naples, Florida.">\n'
       '<style>html{color-scheme:light}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n'
       + head + '\n</head>\n<body>' + body.rstrip() + '\n</body>\n</html>\n')
assert 'rsvp-count' not in doc and 'clampCount' not in doc
assert 'Nothing was saved' not in doc and 'Not switched on in this preview' not in doc
open(out, 'w', encoding='utf-8').write(doc)
print('built', out, len(doc), 'bytes')
