# Happily Ever After Party

Website for Katie & Michael's Happily Ever After Party, February 20, 2027, Naples, Florida.

One Node server (`server.js`) serves the page in `public/`, stores everything editable in Postgres,
saves RSVPs, and puts guest photo uploads in the Railway bucket. On first start with an empty
database it loads `seed.json` (the content written in the preview).

## Railway variables (on the web service)

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `ADMIN_PASSWORD` | The Admin login password |
| `SESSION_SECRET` | Long random string; signs the Admin login cookie |
| `BUCKET`, `ENDPOINT`, `REGION`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY` | References to the `photos` bucket |

Admin lives at `/admin`.

## Editing the page design

`public/index.html` is generated from the preview page (`tools/source/preview.html`) by
`tools/build_page.py`, which swaps the preview-only parts for live ones (saved RSVPs, Admin login,
RSVP list, guest uploads).

## Local run

```
npm install
ADMIN_PASSWORD=test SESSION_SECRET=dev LOCAL_UPLOAD_DIR=/tmp/uploads node server.js
```
Without `DATABASE_URL` it keeps data in memory.
